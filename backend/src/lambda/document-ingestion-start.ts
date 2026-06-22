/**
 * document-ingestion-start
 *
 * S3 ObjectCreated handler. When a document lands in the upload bucket this
 * Lambda:
 *   1. skips keys that are not real user uploads (generated design/planning
 *      artifacts, keys without a project prefix);
 *   2. idempotently creates an authoritative jobs row in the ingestion table;
 *   3. starts Bedrock ingestion;
 *   4. records the synchronously-returned status/reason on the row.
 *
 * This moves the upload->ingest step off the browser entirely: ingestion is
 * server-authoritative and is no longer initiated by any client mutation
 * (Bedrock ingestion is idempotent per documentKey).
 */

import { S3Event, S3EventRecord } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, UpdateCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { startIngestion, POLLABLE_STATUSES, classifyStatus, normalizeTransientStatus } from './document-ingestion-shared';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

/** Relative-path prefixes (after the projectId/) that are generated artifacts. */
const EXCLUDED_PREFIXES = ['design/', 'planning/'];

const EXTENSION_CONTENT_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  txt: 'text/plain',
  md: 'text/markdown',
};

interface ParsedKey {
  projectId: string;
  fileName: string;
}

/** Decode an S3 event object key (spaces are '+', other chars %XX-encoded). */
export function decodeS3Key(rawKey: string): string {
  return decodeURIComponent(rawKey.replace(/\+/g, ' '));
}

/**
 * Decide whether a key represents a user-uploaded document we should ingest.
 * Uploads are stored flat as `${projectId}/${fileName}`. Generated artifacts
 * live under `${projectId}/design/...` or `${projectId}/planning/...` and must
 * be skipped to avoid feeding the assessment its own outputs.
 */
export function shouldProcessKey(key: string): boolean {
  const slash = key.indexOf('/');
  if (slash <= 0) return false; // no project prefix, or leading slash
  const relative = key.slice(slash + 1);
  if (relative.length === 0) return false; // the prefix "folder" placeholder itself
  for (const prefix of EXCLUDED_PREFIXES) {
    if (relative.startsWith(prefix)) return false;
  }
  return true;
}

export function parseKey(key: string): ParsedKey {
  const slash = key.indexOf('/');
  return { projectId: key.slice(0, slash), fileName: key.slice(slash + 1) };
}

function inferFileType(fileName: string): string {
  const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
  return EXTENSION_CONTENT_TYPES[ext] ?? '';
}

/**
 * Start Bedrock ingestion and record the synchronously-returned status on the
 * jobs row. Shared by both the fresh-create path and the retry-reset path so
 * the ingest + status-update logic lives in exactly one place.
 *
 * ingest-start NEVER writes a non-pollable terminal status: the poller is the
 * single authority for SUCCESS/FAILED detection and the exactly-once assessment
 * trigger, and only re-polls rows in a POLLABLE status.
 *   - A genuine hard failure (classifyStatus === 'FAILED', e.g. FAILED /
 *     METADATA_UPDATE_FAILED) is persisted as-is with its statusReason.
 *   - Everything else (STARTING/IN_PROGRESS/PENDING/IGNORED/INDEXED/UNKNOWN/...)
 *     is normalized to a POLLABLE status with no statusReason.
 *     IngestKnowledgeBaseDocuments can synchronously return IGNORED (dedup) or
 *     even INDEXED; neither is written terminally because the poller owns
 *     INDEXED detection + the exactly-once trigger and only re-polls pollable
 *     rows.
 * A thrown exception, by contrast, IS a real failure and is persisted FAILED.
 */
async function runIngestion(tableName: string, projectId: string, documentKey: string): Promise<void> {
  try {
    const result = await startIngestion(projectId, documentKey);
    const now = new Date().toISOString();
    if (classifyStatus(result.status) === 'FAILED') {
      await ddb.send(new UpdateCommand({
        TableName: tableName,
        Key: { projectId, documentKey },
        UpdateExpression: 'SET #status = :status, statusReason = :reason, attempts = :one, updatedAt = :now',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':status': result.status,
          ':reason': result.statusReason ?? null,
          ':one': 1,
          ':now': now,
        },
      }));
    } else {
      // Non-failure synchronous status -> persist a pollable status, no reason.
      await ddb.send(new UpdateCommand({
        TableName: tableName,
        Key: { projectId, documentKey },
        UpdateExpression: 'SET #status = :status, attempts = :one, updatedAt = :now REMOVE statusReason',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':status': normalizeTransientStatus(result.status),
          ':one': 1,
          ':now': now,
        },
      }));
    }
  } catch (err) {
    // Persist the failure on the row so the poller/UI can see it; never swallow.
    console.error('ingest-start: startIngestion failed', { documentKey, err });
    try {
      await ddb.send(new UpdateCommand({
        TableName: tableName,
        Key: { projectId, documentKey },
        UpdateExpression: 'SET #status = :status, statusReason = :reason, updatedAt = :now',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':status': 'FAILED',
          ':reason': err instanceof Error ? err.message : String(err),
          ':now': new Date().toISOString(),
        },
      }));
    } catch (updateErr) {
      console.error('ingest-start: failed to persist ingestion failure', { documentKey, updateErr });
    }
  }
}

async function processRecord(record: S3EventRecord): Promise<void> {
  const tableName = process.env.INGESTION_TABLE!;
  const rawKey = record.s3?.object?.key;
  if (!rawKey) {
    console.warn('ingest-start: record without object key, skipping');
    return;
  }
  const documentKey = decodeS3Key(rawKey);

  if (!shouldProcessKey(documentKey)) {
    console.log('ingest-start: skipping non-upload key', { documentKey });
    return;
  }

  const { projectId, fileName } = parseKey(documentKey);
  const size = record.s3.object.size ?? 0;
  const fileType = inferFileType(fileName);
  const now = new Date().toISOString();

  // 1. Idempotently create the jobs row. On a conditional miss the row already
  //    exists; we then distinguish a genuine in-flight duplicate from a retry
  //    of a terminal/stale row (a previously FAILED/INDEXED document being
  //    re-uploaded must be re-ingested, not silently skipped).
  try {
    await ddb.send(new PutCommand({
      TableName: tableName,
      Item: {
        projectId,
        documentKey,
        fileName,
        size,
        fileType,
        status: 'STARTING',
        triggered: false,
        attempts: 0,
        createdAt: now,
        updatedAt: now,
      },
      ConditionExpression: 'attribute_not_exists(projectId) AND attribute_not_exists(documentKey)',
    }));
  } catch (err: any) {
    if (err?.name !== 'ConditionalCheckFailedException') {
      console.error('ingest-start: failed to create jobs row', { documentKey, err });
      throw err;
    }

    // Row already exists — inspect it to decide skip vs. retry.
    const existing = await ddb.send(new GetCommand({
      TableName: tableName,
      Key: { projectId, documentKey },
    }));
    const existingStatus = existing.Item?.status as string | undefined;

    // In-flight (STARTING/IN_PROGRESS/PENDING) => genuine duplicate S3 delivery.
    if (existingStatus && (POLLABLE_STATUSES as readonly string[]).includes(existingStatus)) {
      console.log('ingest-start: skipping in-flight duplicate', { documentKey, status: existingStatus });
      return;
    }

    // Terminal or stale (FAILED, INDEXED, TIMEOUT, missing, ...) => explicit
    // RETRY. Reset the row to STARTING, guarded on the status we just read so a
    // concurrent change is not clobbered, then re-run the shared ingest block.
    const statusGuardSet = existingStatus !== undefined;
    try {
      await ddb.send(new UpdateCommand({
        TableName: tableName,
        Key: { projectId, documentKey },
        UpdateExpression:
          'SET #status = :starting, triggered = :false, attempts = :zero, #size = :size, fileType = :fileType, updatedAt = :now REMOVE statusReason',
        ConditionExpression: statusGuardSet ? '#status = :expected' : 'attribute_not_exists(#status)',
        ExpressionAttributeNames: { '#status': 'status', '#size': 'size' },
        ExpressionAttributeValues: {
          ':starting': 'STARTING',
          ':false': false,
          ':zero': 0,
          ':size': size,
          ':fileType': fileType,
          ':now': now,
          ...(statusGuardSet ? { ':expected': existingStatus } : {}),
        },
      }));
    } catch (resetErr: any) {
      if (resetErr?.name === 'ConditionalCheckFailedException') {
        // Lost the race: another invocation already claimed/changed the row.
        console.log('ingest-start: reset lost race, another invocation handling retry', { documentKey });
        return;
      }
      console.error('ingest-start: failed to reset jobs row for retry', { documentKey, resetErr });
      throw resetErr;
    }
    console.log('ingest-start: reset terminal/stale row for retry', { documentKey, previousStatus: existingStatus ?? null });
  }

  // 2. Kick off Bedrock ingestion and record the returned status/reason. Shared
  //    by both the fresh-create path and the retry-reset path above.
  await runIngestion(tableName, projectId, documentKey);
}

export const handler = async (event: S3Event): Promise<void> => {
  console.log('ingest-start event:', JSON.stringify({ records: event.Records?.length ?? 0 }));
  for (const record of event.Records ?? []) {
    // Isolate per-record failures so one bad object doesn't drop the batch.
    try {
      await processRecord(record);
    } catch (err) {
      console.error('ingest-start: record processing error', err);
    }
  }
};
