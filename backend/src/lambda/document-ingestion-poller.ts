/**
 * document-ingestion-poller
 *
 * Scheduled (rate(1 minute)) handler that drives non-terminal ingestion jobs to
 * completion independently of the browser:
 *   - queries the jobs-table GSI for rows still in a pollable status;
 *   - re-polls Bedrock for their current status (chunked <=10);
 *   - on SUCCESS: emits the assessment trigger EXACTLY ONCE (conditional write
 *     on `triggered = false`), swallowing the conditional-check race as a logged
 *     no-op;
 *   - on FAILED: persists the status/reason, emits a failure event + metric;
 *   - on age > MAX_AGE_MS: marks the row TIMEOUT;
 *   - otherwise: records the latest transient status.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import {
  POLLABLE_STATUSES,
  classifyStatus,
  normalizeTransientStatus,
  pollStatuses,
  emitAssessmentTrigger,
  emitIngestionFailed,
  isDocumentAbsent,
  startIngestion,
} from './document-ingestion-shared';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const cloudwatch = new CloudWatchClient({});

const STATUS_INDEX = 'status-index';
const DEFAULT_MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes
const DEFAULT_START_GRACE_MS = 2 * 60 * 1000; // 2 minutes
const START_MAX_ATTEMPTS = 3; // cap re-kicks of a stale STARTING row

interface JobRow {
  projectId: string;
  documentKey: string;
  fileName: string;
  size?: number;
  fileType?: string;
  status: string;
  statusReason?: string;
  triggered?: boolean;
  attempts?: number;
  createdAt: string;
  updatedAt?: string;
}

/** Query each pollable status partition on the GSI and dedupe by job key. */
async function loadNonTerminalJobs(tableName: string): Promise<JobRow[]> {
  const byKey = new Map<string, JobRow>();
  for (const status of POLLABLE_STATUSES) {
    let nextToken: Record<string, any> | undefined;
    do {
      const resp = await ddb.send(new QueryCommand({
        TableName: tableName,
        IndexName: STATUS_INDEX,
        KeyConditionExpression: '#status = :status',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':status': status },
        ExclusiveStartKey: nextToken,
      }));
      for (const item of (resp.Items ?? []) as JobRow[]) {
        byKey.set(`${item.projectId}#${item.documentKey}`, item);
      }
      nextToken = resp.LastEvaluatedKey;
    } while (nextToken);
  }
  return [...byKey.values()];
}

async function markSuccessAndTrigger(tableName: string, job: JobRow, status: string): Promise<void> {
  // Spec ordering: emit first, then claim with a conditional write. The
  // conditional write makes the persisted `triggered` flag exactly-once; a lost
  // race (another poller already flipped it) is swallowed as a logged no-op.
  await emitAssessmentTrigger(job.projectId, job.documentKey, job.fileName, job.size ?? 0, job.fileType ?? '');
  try {
    await ddb.send(new UpdateCommand({
      TableName: tableName,
      Key: { projectId: job.projectId, documentKey: job.documentKey },
      UpdateExpression: 'SET #status = :status, triggered = :true, updatedAt = :now',
      ConditionExpression: 'triggered = :false',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':status': status,
        ':true': true,
        ':false': false,
        ':now': new Date().toISOString(),
      },
    }));
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'ConditionalCheckFailedException') {
      console.log('poller: trigger already claimed by a concurrent poll, no-op', {
        documentKey: job.documentKey,
      });
      return;
    }
    console.error('poller: failed to persist trigger state', { documentKey: job.documentKey, err });
    throw err;
  }
}

async function markFailed(tableName: string, job: JobRow, status: string, reason: string | undefined, environment: string): Promise<void> {
  try {
    await ddb.send(new UpdateCommand({
      TableName: tableName,
      Key: { projectId: job.projectId, documentKey: job.documentKey },
      UpdateExpression: 'SET #status = :status, statusReason = :reason, updatedAt = :now',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':status': status, ':reason': reason ?? null, ':now': new Date().toISOString() },
    }));
  } catch (err) {
    console.error('poller: failed to persist FAILED status', { documentKey: job.documentKey, err });
    throw err;
  }
  await emitIngestionFailed(job.projectId, job.documentKey, job.fileName, status, reason);
  try {
    await cloudwatch.send(new PutMetricDataCommand({
      Namespace: 'Citadel/DocumentIngestion',
      MetricData: [{
        MetricName: 'IngestionFailed',
        Value: 1,
        Unit: 'Count',
        Dimensions: [{ Name: 'Environment', Value: environment }],
      }],
    }));
  } catch (err) {
    console.error('poller: failed to emit CloudWatch metric', { documentKey: job.documentKey, err });
  }
}

async function markTimeout(tableName: string, job: JobRow): Promise<void> {
  try {
    await ddb.send(new UpdateCommand({
      TableName: tableName,
      Key: { projectId: job.projectId, documentKey: job.documentKey },
      UpdateExpression: 'SET #status = :status, updatedAt = :now',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':status': 'TIMEOUT', ':now': new Date().toISOString() },
    }));
  } catch (err) {
    console.error('poller: failed to persist TIMEOUT status', { documentKey: job.documentKey, err });
    throw err;
  }
}

async function markTransient(tableName: string, job: JobRow, status: string): Promise<void> {
  try {
    await ddb.send(new UpdateCommand({
      TableName: tableName,
      Key: { projectId: job.projectId, documentKey: job.documentKey },
      UpdateExpression: 'SET #status = :status, attempts = if_not_exists(attempts, :zero) + :one, updatedAt = :now',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':status': normalizeTransientStatus(status),
        ':zero': 0,
        ':one': 1,
        ':now': new Date().toISOString(),
      },
    }));
  } catch (err) {
    console.error('poller: failed to persist transient status', { documentKey: job.documentKey, err });
    throw err;
  }
}

/**
 * Re-kick Bedrock ingestion for a stale STARTING row. The start Lambda can die
 * after the conditional jobs-row create but before/while calling startIngestion,
 * leaving a STARTING row whose document was never actually submitted. Re-start
 * is safe (idempotent — stable customDocumentIdentifier). The row is left
 * STARTING (still re-pollable) with `attempts` bumped so the START_MAX_ATTEMPTS
 * cap eventually stops the re-kicks and the row rides to TIMEOUT via MAX_AGE_MS.
 */
async function reKickStart(tableName: string, job: JobRow): Promise<void> {
  await startIngestion(job.projectId, job.documentKey);
  try {
    await ddb.send(new UpdateCommand({
      TableName: tableName,
      Key: { projectId: job.projectId, documentKey: job.documentKey },
      UpdateExpression: 'SET #status = :status, attempts = if_not_exists(attempts, :zero) + :one, updatedAt = :now',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':status': 'STARTING',
        ':zero': 0,
        ':one': 1,
        ':now': new Date().toISOString(),
      },
    }));
  } catch (err) {
    console.error('poller: failed to persist re-kick state', { documentKey: job.documentKey, err });
    throw err;
  }
}

export const handler = async (): Promise<{ processed: number }> => {
  const tableName = process.env.INGESTION_TABLE!;
  const environment = process.env.ENVIRONMENT ?? 'dev';
  const maxAgeMs = Number(process.env.MAX_AGE_MS ?? DEFAULT_MAX_AGE_MS);
  const startGraceMs = Number(process.env.START_GRACE_MS ?? DEFAULT_START_GRACE_MS);

  const jobs = await loadNonTerminalJobs(tableName);
  console.log('poller: non-terminal jobs', { count: jobs.length });
  if (jobs.length === 0) return { processed: 0 };

  const statusMap = await pollStatuses(jobs.map((j) => j.documentKey));
  const now = Date.now();

  for (const job of jobs) {
    // Isolate per-job failures so one bad row doesn't abort the whole sweep.
    try {
      const polled = statusMap.get(job.documentKey);
      const status = polled?.status ?? job.status;
      const disposition = classifyStatus(status);

      if (disposition === 'SUCCESS') {
        if (job.triggered) {
          console.log('poller: already triggered, skipping', { documentKey: job.documentKey });
          continue;
        }
        await markSuccessAndTrigger(tableName, job, status);
      } else if (disposition === 'FAILED') {
        await markFailed(tableName, job, status, polled?.statusReason, environment);
      } else {
        const createdMs = Date.parse(job.createdAt);
        const ageMs = Number.isNaN(createdMs) ? NaN : now - createdMs;
        if (!Number.isNaN(ageMs) && ageMs > maxAgeMs) {
          await markTimeout(tableName, job);
        } else if (
          job.status === 'STARTING' &&
          isDocumentAbsent(polled) &&
          !Number.isNaN(ageMs) &&
          ageMs > startGraceMs &&
          (job.attempts ?? 0) < START_MAX_ATTEMPTS
        ) {
          // Stale STARTING row past the grace window whose document is still
          // absent from the KB: ingestion likely never actually started. Re-kick
          // it (idempotent), capped by attempts so it can't loop forever.
          console.log('poller: re-kicking stale STARTING job', {
            documentKey: job.documentKey,
            attempts: job.attempts ?? 0,
          });
          await reKickStart(tableName, job);
        } else {
          await markTransient(tableName, job, status);
        }
      }
    } catch (err) {
      console.error('poller: job processing error', { documentKey: job.documentKey, err });
    }
  }

  return { processed: jobs.length };
};
