import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { IdempotencyGuard } from '../utils/idempotency';

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const idempotencyGuard = new IdempotencyGuard(process.env.IDEMPOTENCY_TABLE!);

const VALID_FIELDS = new Set(['assessment', 'design', 'planning', 'implementation']);

export const handler = async (event: any) => {
  console.log('Progress event:', JSON.stringify(event));

  const { executed } = await idempotencyGuard.withIdempotency(event.id, async () => {
    const { sessionId, phase, completionPercentage } = event.detail;
    const projectsTable = process.env.PROJECTS_TABLE!;

    if (!VALID_FIELDS.has(phase)) {
      console.log(`Unknown phase: ${phase}, skipping`);
      return;
    }

    const getResult = await client.send(new GetCommand({
      TableName: projectsTable,
      Key: { id: sessionId },
    }));

    const current = getResult.Item?.progress || {};
    const assessment     = phase === 'assessment'     ? completionPercentage : (current.assessment || 0);
    const design         = phase === 'design'         ? completionPercentage : (current.design || 0);
    const planning       = phase === 'planning'       ? completionPercentage : (current.planning || 0);
    const implementation = phase === 'implementation' ? completionPercentage : (current.implementation || 0);

    const overall = Math.round((assessment + design + planning + implementation) / 4);

    let currentPhase = 'CREATED';
    if (implementation > 0)  currentPhase = implementation === 100 ? 'IMPLEMENTATION_COMPLETE' : 'IMPLEMENTATION_IN_PROGRESS';
    else if (planning > 0)   currentPhase = planning === 100 ? 'PLANNING_COMPLETE' : 'PLANNING_IN_PROGRESS';
    else if (design > 0)     currentPhase = design === 100 ? 'DESIGN_COMPLETE' : 'DESIGN_IN_PROGRESS';
    else if (assessment > 0) currentPhase = assessment === 100 ? 'ASSESSMENT_COMPLETE' : 'ASSESSMENT_IN_PROGRESS';

    await client.send(new UpdateCommand({
      TableName: projectsTable,
      Key: { id: sessionId },
      UpdateExpression: 'SET progress = :p, updatedAt = :now',
      ExpressionAttributeValues: {
        ':p': { overall, assessment, design, planning, implementation, currentPhase },
        ':now': new Date().toISOString(),
      },
    }));

    console.log(`Updated ${sessionId}: ${phase}=${completionPercentage}%, overall=${overall}%, currentPhase=${currentPhase}`);
  });

  if (!executed) {
    console.log('Skipping duplicate progress event:', event.id);
  }
};
