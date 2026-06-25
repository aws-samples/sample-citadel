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

    // Atomic monotonic update: only advance progress, never regress.
    // This prevents concurrent fabrication events from overwriting each other.
    const phaseKey = `progress.${phase}`;

    let currentPhase = 'CREATED';
    if (phase === 'implementation') currentPhase = completionPercentage === 100 ? 'IMPLEMENTATION_COMPLETE' : 'IMPLEMENTATION_IN_PROGRESS';
    else if (phase === 'planning')  currentPhase = completionPercentage === 100 ? 'PLANNING_COMPLETE' : 'PLANNING_IN_PROGRESS';
    else if (phase === 'design')    currentPhase = completionPercentage === 100 ? 'DESIGN_COMPLETE' : 'DESIGN_IN_PROGRESS';
    else if (phase === 'assessment') currentPhase = completionPercentage === 100 ? 'ASSESSMENT_COMPLETE' : 'ASSESSMENT_IN_PROGRESS';

    try {
      await client.send(new UpdateCommand({
        TableName: projectsTable,
        Key: { id: sessionId },
        UpdateExpression: 'SET #phase = :pct, progress.currentPhase = :cp, updatedAt = :now',
        ConditionExpression: 'attribute_not_exists(#phase) OR #phase < :pct',
        ExpressionAttributeNames: { '#phase': phaseKey },
        ExpressionAttributeValues: {
          ':pct': completionPercentage,
          ':cp': currentPhase,
          ':now': new Date().toISOString(),
        },
      }));
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'ConditionalCheckFailedException') {
        console.log(`Skipping stale progress: ${phase}=${completionPercentage}% (already higher)`);
        return;
      }
      throw err;
    }

    // Recompute overall from the now-updated record
    const getResult = await client.send(new GetCommand({
      TableName: projectsTable,
      Key: { id: sessionId },
    }));
    const p = getResult.Item?.progress || {};
    const overall = Math.round(((p.assessment || 0) + (p.design || 0) + (p.planning || 0) + (p.implementation || 0)) / 4);
    await client.send(new UpdateCommand({
      TableName: projectsTable,
      Key: { id: sessionId },
      UpdateExpression: 'SET progress.overall = :o',
      ExpressionAttributeValues: { ':o': overall },
    }));

    console.log(`Updated ${sessionId}: ${phase}=${completionPercentage}%, overall=${overall}%, currentPhase=${currentPhase}`);
  });

  if (!executed) {
    console.log('Skipping duplicate progress event:', event.id);
  }
};
