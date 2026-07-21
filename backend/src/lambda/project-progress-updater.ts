import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { IdempotencyGuard } from '../utils/idempotency';

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const idempotencyGuard = new IdempotencyGuard(process.env.IDEMPOTENCY_TABLE!);

const VALID_FIELDS = new Set(['assessment', 'design', 'planning', 'implementation']);

/** EventBridge fabrication-progress event slice this handler reads. */
interface ProgressUpdateEvent {
  id: string;
  detail: { sessionId: string; phase: string; completionPercentage: number };
}

type NestedUpdateOutcome = 'ok' | 'stale' | 'no_map';

/**
 * Freshly initialized progress map, mirroring project-resolver createProject.
 * Used only when a legacy project row is missing the map entirely.
 */
const INITIAL_PROGRESS = {
  overall: 0,
  assessment: 0,
  design: 0,
  planning: 0,
  implementation: 0,
  currentPhase: 'CREATED',
};

export const handler = async (event: ProgressUpdateEvent) => {
  console.log('Progress event:', JSON.stringify(event));

  const { executed } = await idempotencyGuard.withIdempotency(event.id, async () => {
    const { sessionId, phase, completionPercentage } = event.detail;
    const projectsTable = process.env.PROJECTS_TABLE!;

    if (!VALID_FIELDS.has(phase)) {
      console.log(`Unknown phase: ${phase}, skipping`);
      return;
    }

    // Fabricator failure convention: a failed agent build emits
    // completionPercentage = -1 (arbiter/fabricator/index.py
    // publish_intake_progress). Negative values are failure SIGNALS, not
    // progress — skip them entirely so a failure can neither regress the
    // segment nor write a bogus negative value. The last real progress
    // value simply stands.
    if (completionPercentage < 0) {
      console.log(`Ignoring negative progress signal: ${phase}=${completionPercentage}%`);
      return;
    }
    const pct = Math.min(100, completionPercentage);

    let currentPhase = 'CREATED';
    if (phase === 'implementation') currentPhase = pct === 100 ? 'IMPLEMENTATION_COMPLETE' : 'IMPLEMENTATION_IN_PROGRESS';
    else if (phase === 'planning')  currentPhase = pct === 100 ? 'PLANNING_COMPLETE' : 'PLANNING_IN_PROGRESS';
    else if (phase === 'design')    currentPhase = pct === 100 ? 'DESIGN_COMPLETE' : 'DESIGN_IN_PROGRESS';
    else if (phase === 'assessment') currentPhase = pct === 100 ? 'ASSESSMENT_COMPLETE' : 'ASSESSMENT_IN_PROGRESS';

    // Atomic monotonic update of the NESTED progress.<phase> attribute.
    //
    // ExpressionAttributeNames placeholders are atomic attribute names — a
    // dot inside a placeholder VALUE is literal, so a single placeholder
    // valued 'progress.<phase>' would write a junk TOP-LEVEL attribute named
    // "progress.implementation" instead of the nested field. The nested path
    // therefore needs TWO placeholders: #progress.#field.
    const attemptNestedUpdate = async (): Promise<NestedUpdateOutcome> => {
      try {
        await client.send(new UpdateCommand({
          TableName: projectsTable,
          Key: { id: sessionId },
          UpdateExpression: 'SET #progress.#field = :pct, #progress.#cpn = :cp, updatedAt = :now',
          // Monotonic: only advance progress, never regress. Prevents
          // concurrent/stale fabrication events from overwriting each other.
          ConditionExpression: 'attribute_not_exists(#progress.#field) OR #progress.#field < :pct',
          ExpressionAttributeNames: {
            '#progress': 'progress',
            '#field': phase,
            '#cpn': 'currentPhase',
          },
          ExpressionAttributeValues: {
            ':pct': pct,
            ':cp': currentPhase,
            ':now': new Date().toISOString(),
          },
        }));
        return 'ok';
      } catch (err: unknown) {
        if (err instanceof Error && err.name === 'ConditionalCheckFailedException') {
          return 'stale';
        }
        if (err instanceof Error && err.name === 'ValidationException') {
          // SET of a nested field under a missing `progress` map (or a
          // missing row) fails with "document path ... invalid".
          return 'no_map';
        }
        throw err;
      }
    };

    let outcome = await attemptNestedUpdate();

    if (outcome === 'no_map') {
      // Initialize the progress map — but ONLY on an existing project row;
      // never create skeleton rows for sessions with no project record.
      try {
        await client.send(new UpdateCommand({
          TableName: projectsTable,
          Key: { id: sessionId },
          UpdateExpression: 'SET #progress = :init, updatedAt = :now',
          ConditionExpression: 'attribute_exists(id) AND attribute_not_exists(#progress)',
          ExpressionAttributeNames: { '#progress': 'progress' },
          ExpressionAttributeValues: {
            ':init': INITIAL_PROGRESS,
            ':now': new Date().toISOString(),
          },
        }));
      } catch (err: unknown) {
        if (!(err instanceof Error && err.name === 'ConditionalCheckFailedException')) {
          throw err;
        }
        // Row missing (the retry below settles it) or the map appeared
        // concurrently — either way, retry decides.
      }
      outcome = await attemptNestedUpdate();
    }

    if (outcome === 'stale') {
      console.log(`Skipping stale progress: ${phase}=${pct}% (already higher)`);
      return;
    }
    if (outcome === 'no_map') {
      console.log(`No project row for ${sessionId}, skipping progress update`);
      return;
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
      UpdateExpression: 'SET #progress.#overall = :o',
      ExpressionAttributeNames: { '#progress': 'progress', '#overall': 'overall' },
      ExpressionAttributeValues: { ':o': overall },
    }));

    console.log(`Updated ${sessionId}: ${phase}=${pct}%, overall=${overall}%, currentPhase=${currentPhase}`);
  });

  if (!executed) {
    console.log('Skipping duplicate progress event:', event.id);
  }
};
