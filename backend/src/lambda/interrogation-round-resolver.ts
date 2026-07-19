/**
 * InterrogationRound resolver.
 *
 * Implements the startInterrogationRound / injectConstraints / stabiliseRound
 * mutations and getInterrogationRound / listInterrogationRounds queries
 * against the citadel-interrogation-rounds-{env} table. Transcripts are
 * persisted to the governance transcripts bucket as JSONL files, keyed
 * deterministically as `projects/{projectId}/rounds/{roundN}.jsonl`.
 *
 * Lifecycle transitions are validated via LifecycleManager with
 * ROUND_TRANSITIONS (see../adapters/lifecycle.ts).
 *
 * PII redaction:
 *   Every transcript line's `content` is run through redactPII
 *   BEFORE the S3 PutObject, so the persisted object can never contain the
 *   raw PII. redactPII is idempotent, so safe to invoke on already-sanitised
 *   content during retries.
 *
 * Transcript size guard (QT3-9):
 *   After the successful S3 write, if the sanitised JSONL body exceeds
 *   5 MiB we emit governance.round.transcript.overflow with {projectId,
 *   roundN, sizeBytes}. The write itself is NOT blocked — the event exists
 *   for downstream alerting and cost-control dashboards.
 *
 * Idempotency for stabiliseRound (mirrors lockADR in):
 *   If the current DDB row is already STABILISED we short-circuit BEFORE the
 *   S3 PutObject, the DDB UpdateCommand and the EventBridge emission. The
 *   caller receives the existing row as-is. This keeps retries free of
 *   duplicate S3 objects and duplicate governance.round.completed events.
 *
 * Permissions (QT2B-7 lazy registration):
 *   Mutations are gated on `adr:create` — per the spec, the existing
 *   architect/admin grant covers the advisory interrogation loop. Queries
 *   are gated on `project:read`.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { LifecycleManager, ROUND_TRANSITIONS } from '../adapters/lifecycle';
import { emitGovernanceEvent } from '../utils/notifier-base';
import { hasPermission } from '../utils/auth';
import { redactPII } from '../utils/redact-pii';
import type {
  AuthContext,
  GovernanceEventIdentity,
  GovernanceResolverEvent,
} from '../types';

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const s3Client = new S3Client({});

const ROUNDS_TABLE = process.env.INTERROGATION_ROUNDS_TABLE!;
const TRANSCRIPTS_BUCKET = process.env.GOVERNANCE_TRANSCRIPTS_BUCKET!;
const roundLifecycle = new LifecycleManager(ROUND_TRANSITIONS);

const FIVE_MIB = 5 * 1024 * 1024;

export type RoundStatusLiteral =
  | 'IN_PROGRESS'
  | 'AWAITING_CONSTRAINTS'
  | 'REVISED'
  | 'STABILISED';

export interface TranscriptMessage {
  role: string;
  content: string;
}

export interface InterrogationRound {
  projectId: string;
  roundN: number;
  transcriptS3Uri: string;
  status: RoundStatusLiteral;
  humanConstraints?: string[];
  revisedRecommendation?: string;
  startedAt: string;
  completedAt?: string;
  transcriptSizeBytes?: number;
}

/** Merged view of every argument this resolver's fields receive. */
interface InterrogationRoundResolverArguments {
  projectId: string;
  roundN: number;
  constraints: string[];
  transcript: TranscriptMessage[];
  stabilisedSummary: string;
}

type InterrogationRoundResolverEvent =
  GovernanceResolverEvent<InterrogationRoundResolverArguments>;

function authContextFromEvent(
  event: InterrogationRoundResolverEvent,
): AuthContext {
  const identity: GovernanceEventIdentity = event?.identity || {};
  const claimRole = identity['custom:role'] ?? identity.claims?.['custom:role'];
  return {
    userId: identity.sub || identity.username || 'anonymous',
    username: identity.username,
    groups: identity['cognito:groups'] || [],
    roles: claimRole? [claimRole] : [],
  };
}

function sanitizeForLog(input: unknown): unknown {
  if (!input || typeof input !== 'object') return input;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    out[k] = typeof v === 'string' && v.length > 200 ? v.slice(0, 200) + '…' : v;
  }
  return out;
}

/**
 * Derive the deterministic S3 URI for a (projectId, roundN) pair. Shape:
 *   s3://{bucket}/projects/{projectId}/rounds/{roundN}.jsonl
 * Exported indirectly (via the returned row) so the frontend can resolve
 * the object without a round-trip to the resolver just for the URI.
 */
function transcriptUriFor(projectId: string, roundN: number): string {
  return `s3://${TRANSCRIPTS_BUCKET}/projects/${projectId}/rounds/${roundN}.jsonl`;
}

function transcriptKeyFor(projectId: string, roundN: number): string {
  return `projects/${projectId}/rounds/${roundN}.jsonl`;
}

function validateRoundN(roundN: unknown): asserts roundN is number {
  if (
    typeof roundN !== 'number' ||
    !Number.isFinite(roundN) ||
    !Number.isInteger(roundN) ||
    roundN <= 0
  ) {
    throw new Error('ValidationError: roundN must be a positive integer');
  }
}

export async function startInterrogationRound(
  projectId: string,
  roundN: number,
  authContext: AuthContext,
): Promise<InterrogationRound> {
  if (!hasPermission(authContext, 'adr:create')) {
    throw new Error('UnauthorizedError: adr:create permission required');
  }
  validateRoundN(roundN);
  if (typeof projectId !== 'string' || projectId.length === 0) {
    throw new Error('ValidationError: projectId is required');
  }

  const row: InterrogationRound = {
    projectId,
    roundN,
    transcriptS3Uri: transcriptUriFor(projectId, roundN),
    status: 'IN_PROGRESS',
    startedAt: new Date().toISOString(),
  };

  // attribute_not_exists on BOTH key components ensures a retry on an
  // already-started round surfaces as ConditionalCheckFailedException
  // rather than silently overwriting an in-flight row.
  await docClient.send(
    new PutCommand({
      TableName: ROUNDS_TABLE,
      Item: row,
      ConditionExpression:
        'attribute_not_exists(projectId) AND attribute_not_exists(roundN)',
    }),
  );

  await emitGovernanceEvent('governance.round.started', {
    projectId,
    roundN,
  });

  return row;
}

export async function getInterrogationRound(
  projectId: string,
  roundN: number,
): Promise<InterrogationRound | null> {
  const res = await docClient.send(
    new GetCommand({ TableName: ROUNDS_TABLE, Key: { projectId, roundN } }),
  );
  return (res.Item as InterrogationRound | undefined) ?? null;
}

export async function listInterrogationRounds(
  projectId: string,
): Promise<InterrogationRound[]> {
  const res = await docClient.send(
    new QueryCommand({
      TableName: ROUNDS_TABLE,
      KeyConditionExpression: 'projectId = :pid',
      ExpressionAttributeValues: { ':pid': projectId },
    }),
  );
  return (res.Items as InterrogationRound[] | undefined) ?? [];
}

export async function injectConstraints(
  projectId: string,
  roundN: number,
  constraints: string[],
  authContext: AuthContext,
): Promise<InterrogationRound> {
  if (!hasPermission(authContext, 'adr:create')) {
    throw new Error('UnauthorizedError: adr:create permission required');
  }
  validateRoundN(roundN);
  if (!Array.isArray(constraints)) {
    throw new Error('ValidationError: constraints must be an array');
  }

  const current = await getInterrogationRound(projectId, roundN);
  if (!current) {
    throw new Error(`Interrogation round not found: ${projectId}/${roundN}`);
  }

  // Only IN_PROGRESS and REVISED rounds accept new constraints (per the
  // action matrix in ROUND_TRANSITIONS). STABILISED is terminal and will
  // throw 'Invalid status transition'.
  roundLifecycle.validateTransition(current.status, 'AWAITING_CONSTRAINTS');

  const res = await docClient.send(
    new UpdateCommand({
      TableName: ROUNDS_TABLE,
      Key: { projectId, roundN },
      UpdateExpression: 'SET #status = :newStatus, humanConstraints = :constraints',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':newStatus': 'AWAITING_CONSTRAINTS',
        ':constraints': constraints,
      },
      ReturnValues: 'ALL_NEW',
    }),
  );
  return res.Attributes as InterrogationRound;
}

/**
 * Finalise an interrogation round. Persists the sanitised transcript to S3
 * (JSONL), transitions the row to STABILISED, and emits
 * governance.round.completed. Large transcripts (>5 MiB after sanitisation)
 * also emit governance.round.transcript.overflow — the write itself is not
 * blocked.
 *
 * Idempotent early-return: if the existing row is already STABILISED we
 * return it unchanged with no S3, DDB, or EventBridge side-effects. This
 * mirrors lockADR in and keeps retries free of duplicate objects.
 */
export async function stabiliseRound(
  projectId: string,
  roundN: number,
  transcript: TranscriptMessage[],
  stabilisedSummary: string,
  authContext: AuthContext,
): Promise<InterrogationRound> {
  if (!hasPermission(authContext, 'adr:create')) {
    throw new Error('UnauthorizedError: adr:create permission required');
  }
  validateRoundN(roundN);
  if (!Array.isArray(transcript)) {
    throw new Error('ValidationError: transcript must be an array');
  }
  if (typeof stabilisedSummary !== 'string') {
    throw new Error('ValidationError: stabilisedSummary must be a string');
  }

  const current = await getInterrogationRound(projectId, roundN);
  if (!current) {
    throw new Error(`Interrogation round not found: ${projectId}/${roundN}`);
  }

  // Idempotent early-return mirrors lockADR. A retry of
  // stabiliseRound on an already-STABILISED row must not re-write S3 or
  // re-emit governance.round.completed.
  if (current.status === 'STABILISED') {
    return current;
  }

  roundLifecycle.validateTransition(current.status, 'STABILISED');

  // Sanitise transcript content BEFORE serialisation. redactPII is
  // idempotent (contract) so repeated application is safe.
  const sanitised = transcript.map((msg) => ({
    role: msg.role,
    content: redactPII(msg.content),
  }));
  const jsonl = sanitised.map((m) => JSON.stringify(m)).join('\n');
  const body = Buffer.from(jsonl, 'utf8');
  const sizeBytes = body.byteLength;

  await s3Client.send(
    new PutObjectCommand({
      Bucket: TRANSCRIPTS_BUCKET,
      Key: transcriptKeyFor(projectId, roundN),
      Body: body,
      ContentType: 'application/x-ndjson',
      ServerSideEncryption: 'aws:kms',
    }),
  );

  const completedAt = new Date().toISOString();
  const res = await docClient.send(
    new UpdateCommand({
      TableName: ROUNDS_TABLE,
      Key: { projectId, roundN },
      UpdateExpression:
        'SET #status = :newStatus, completedAt = :completedAt, transcriptSizeBytes = :sizeBytes, revisedRecommendation = :summary',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':newStatus': 'STABILISED',
        ':completedAt': completedAt,
        ':sizeBytes': sizeBytes,
        ':summary': stabilisedSummary,
      },
      ReturnValues: 'ALL_NEW',
    }),
  );

  await emitGovernanceEvent('governance.round.completed', {
    projectId,
    roundN,
  });

  // Emit overflow AFTER the successful write so observers always see the
  // completed event first. Do NOT block the write on size.
  if (sizeBytes > FIVE_MIB) {
    await emitGovernanceEvent('governance.round.transcript.overflow', {
      projectId,
      roundN,
      sizeBytes,
    });
  }

  return res.Attributes as InterrogationRound;
}

export const handler = async (event: InterrogationRoundResolverEvent): Promise<unknown> => {
  const fieldName = event?.info?.fieldName;
  const authContext = authContextFromEvent(event);
  try {
    switch (fieldName) {
      case 'startInterrogationRound':
        return await startInterrogationRound(
          event.arguments.projectId,
          event.arguments.roundN,
          authContext,
        );
      case 'injectConstraints':
        return await injectConstraints(
          event.arguments.projectId,
          event.arguments.roundN,
          event.arguments.constraints,
          authContext,
        );
      case 'stabiliseRound':
        return await stabiliseRound(
          event.arguments.projectId,
          event.arguments.roundN,
          event.arguments.transcript,
          event.arguments.stabilisedSummary,
          authContext,
        );
      case 'getInterrogationRound':
        return await getInterrogationRound(
          event.arguments.projectId,
          event.arguments.roundN,
        );
      case 'listInterrogationRounds':
        return await listInterrogationRounds(event.arguments.projectId);
      default:
        throw new Error(`Unsupported field: ${fieldName}`);
    }
  } catch (err: unknown) {
    console.error('interrogation-round-resolver error', {
      fieldName,
      message: err instanceof Error ? err.message : undefined,
      args: sanitizeForLog(event?.arguments),
    });
    throw err;
  }
};
