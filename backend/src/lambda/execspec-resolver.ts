/**
 * ExecutionSpecification resolver.
 *
 * Implements the create/submit/approve/reject/revise mutations and the
 * get/list queries against the citadel-execution-specifications-{env} table.
 *
 * Lifecycle transitions are validated through LifecycleManager with
 * EXECSPEC_TRANSITIONS — see backend/src/adapters/lifecycle.ts:
 *   DRAFT          -> PENDING_REVIEW | REJECTED
 *   PENDING_REVIEW -> APPROVED | REJECTED
 *   APPROVED       -> (terminal)
 *   REJECTED       -> DRAFT
 *
 * Permission model (auth.ts):
 *   - spec:approve → architect only. Gates create/submit/approve/reject/revise.
 *   - project:read → architect, project_manager, developer. Gates get/list.
 *
 * narrativeS3Uri allowlist (QT2A-9 / QT2B-6): pinned via a single
 * module-level regex. Any URI outside the citadel-governance-transcripts
 * bucket or outside the /projects/{projectId}/ prefix is rejected BEFORE
 * any DDB write.
 *
 * Optimistic concurrency: every mutating write asserts the current DDB
 * version with a ConditionExpression on the `version` attribute, so a
 * concurrent update races to a ConditionalCheckFailedException rather
 * than silent data loss — the invariant required by QT3-2 parity.
 *
 * rejectExecutionSpecification implements audit-before-auth per QT3-3,
 * matching the reopen pattern. Since this story does not
 * provision a dedicated audit table, the audit trail is written to
 * CloudWatch via structured console.log lines (phase='audit' → PENDING,
 * phase='audit-outcome' → ALLOWED | DENIED). Both auth-allowed and
 * auth-denied branches emit governance.specification.rejected so that
 * downstream alerting on denied attempts works identically to.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import { v4 as uuidv4 } from 'uuid';
import { LifecycleManager, EXECSPEC_TRANSITIONS } from '../adapters/lifecycle';
import { emitGovernanceEvent } from '../utils/notifier-base';
import { hasPermission } from '../utils/auth';
import type {
  AuthContext,
  ExecutionSpecification,
  ExecutionSpecificationInput,
  ReviseExecutionSpecificationInput,
  SpecStatusLiteral,
} from '../types';

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const EXECUTION_SPECS_TABLE = process.env.EXECUTION_SPECS_TABLE!;
const execSpecLifecycle = new LifecycleManager(EXECSPEC_TRANSITIONS);

/**
 * Narrative URI allowlist regex (QT2A-9 / QT2B-6).
 *
 * Shape: s3://citadel-governance-transcripts-{env}-{account}-{region}/projects/{projectId}/...
 * where:
 *   - env / region:  [a-z0-9-]+
 *   - account:       [0-9]+  (not strictly 12 digits — the matching regex
 *                             only needs a boundary, not full AWS account
 *                             validation, and tests generate arbitrary
 *                             lengths)
 *   - projectId:     [a-zA-Z0-9-]+
 * The bucket-name portion `[a-z0-9-]+` is coalesced with the account
 * `[0-9]+` section via explicit hyphen separators. Anchors are tight
 * (^ and .* at tail) so a URI containing the allowlisted prefix as a
 * substring but with a different bucket-root does NOT pass.
 */
export const NARRATIVE_URI_ALLOWLIST =
  /^s3:\/\/citadel-governance-transcripts-[a-z0-9-]+-[0-9]+-[a-z0-9-]+\/projects\/[a-zA-Z0-9-]+\/.*/;

export function isNarrativeUriAllowed(uri: unknown): boolean {
  return typeof uri === 'string' && NARRATIVE_URI_ALLOWLIST.test(uri);
}

function authContextFromEvent(event: any): AuthContext {
  const identity = event?.identity || {};
  const claimRole = identity['custom:role'] ?? identity.claims?.['custom:role'];
  return {
    userId: identity.sub || identity.username || 'anonymous',
    username: identity.username,
    groups: identity['cognito:groups'] || [],
    roles: claimRole ? [claimRole]: [],
  };
}

/**
 * Truncate long string values in event.arguments so that error logs cannot
 * be weaponised to exfiltrate long payloads. Non-string values pass through.
 */
function sanitizeForLog(input: unknown): unknown {
  if (!input || typeof input !== 'object') return input;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    out[k] = typeof v === 'string' && v.length > 200 ? v.slice(0, 200) + '…' : v;
  }
  return out;
}

function requireSpecApprovePermission(
  authContext: AuthContext,
  action: string,
): void {
  if (!hasPermission(authContext, 'spec:approve')) {
    throw new Error(
      `UnauthorizedError: spec:approve permission required to ${action}`,
    );
  }
}

function validateNarrativeUri(uri: unknown): void {
  if (!isNarrativeUriAllowed(uri)) {
    throw new Error(
      'ValidationError: narrativeS3Uri does not match allowlist',
    );
  }
}

export async function createExecutionSpecification(
  input: ExecutionSpecificationInput,
  authContext: AuthContext,
): Promise<ExecutionSpecification> {
  requireSpecApprovePermission(authContext, 'create execution specifications');

  if (!input.projectId) {
    throw new Error('ValidationError: projectId is required');
  }
  if (!Array.isArray(input.sourceAdrIds) || input.sourceAdrIds.length === 0) {
    throw new Error('ValidationError: sourceAdrIds must be a non-empty array');
  }
  if (typeof input.structuredPayload !== 'string' || !input.structuredPayload) {
    throw new Error('ValidationError: structuredPayload is required');
  }
  validateNarrativeUri(input.narrativeS3Uri);

  const spec: ExecutionSpecification = {
    specId: uuidv4(),
    projectId: input.projectId,
    sourceAdrIds: input.sourceAdrIds,
    structuredPayload: input.structuredPayload,
    narrativeS3Uri: input.narrativeS3Uri,
    status: 'DRAFT',
    version: 1,
    createdAt: new Date().toISOString(),
    createdBy: authContext.userId,
  };

  await docClient.send(
    new PutCommand({
      TableName: EXECUTION_SPECS_TABLE,
      Item: spec,
      ConditionExpression: 'attribute_not_exists(specId)',
    }),
  );
  return spec;
}

export async function getExecutionSpecification(
  specId: string,
): Promise<ExecutionSpecification | null> {
  const res = await docClient.send(
    new GetCommand({ TableName: EXECUTION_SPECS_TABLE, Key: { specId } }),
  );
  return (res.Item as ExecutionSpecification | undefined) ?? null;
}

export async function listExecutionSpecifications(
  projectId: string,
): Promise<ExecutionSpecification[]> {
  const res = await docClient.send(
    new QueryCommand({
      TableName: EXECUTION_SPECS_TABLE,
      IndexName: 'project-index',
      KeyConditionExpression: 'projectId = :pid',
      ExpressionAttributeValues: { ':pid': projectId },
    }),
  );
  return (res.Items as ExecutionSpecification[] | undefined) ?? [];
}

async function updateStatus(
  specId: string,
  currentVersion: number,
  nextStatus: SpecStatusLiteral,
  extraSet: Record<string, unknown> = {},
): Promise<ExecutionSpecification> {
  // Build SET expression dynamically so the caller can stamp
  // submittedAt/approvedAt/rejectedAt/etc. without repeating the
  // ConditionExpression boilerplate.
  const setParts: string[] = [
    '#status = :newStatus',
    '#version = :newVersion',
  ];
  const exprNames: Record<string, string> = {
    '#status': 'status',
    '#version': 'version',
  };
  const exprValues: Record<string, unknown> = {
    ':newStatus': nextStatus,
    ':newVersion': currentVersion + 1,
    ':currentVersion': currentVersion,
  };
  for (const [k, v] of Object.entries(extraSet)) {
    const nameKey = `#${k}`;
    const valueKey = `:${k}`;
    exprNames[nameKey] = k;
    exprValues[valueKey] = v;
    setParts.push(`${nameKey} = ${valueKey}`);
  }
  const res = await docClient.send(
    new UpdateCommand({
      TableName: EXECUTION_SPECS_TABLE,
      Key: { specId },
      UpdateExpression: 'SET ' + setParts.join(', '),
      ConditionExpression: '#version = :currentVersion',
      ExpressionAttributeNames: exprNames,
      ExpressionAttributeValues: exprValues,
      ReturnValues: 'ALL_NEW',
    }),
  );
  return res.Attributes as ExecutionSpecification;
}

export async function submitExecutionSpecification(
  specId: string,
  authContext: AuthContext,
): Promise<ExecutionSpecification> {
  requireSpecApprovePermission(authContext, 'submit execution specifications');
  const spec = await getExecutionSpecification(specId);
  if (!spec) throw new Error(`ExecutionSpecification not found: ${specId}`);
  execSpecLifecycle.validateTransition(spec.status, 'PENDING_REVIEW');
  return updateStatus(specId, spec.version, 'PENDING_REVIEW', {
    submittedAt: new Date().toISOString(),
  });
}

export async function approveExecutionSpecification(
  specId: string,
  authContext: AuthContext,
): Promise<ExecutionSpecification> {
  // Permission check FIRST — no DDB access, no event, before any state work.
  requireSpecApprovePermission(authContext, 'approve execution specifications');
  const spec = await getExecutionSpecification(specId);
  if (!spec) throw new Error(`ExecutionSpecification not found: ${specId}`);
  execSpecLifecycle.validateTransition(spec.status, 'APPROVED');
  const now = new Date().toISOString();
  const updated = await updateStatus(specId, spec.version, 'APPROVED', {
    approvedAt: now,
    approvedBy: authContext.userId,
  });
  await emitGovernanceEvent('governance.specification.approved', {
    projectId: updated.projectId,
    specId: updated.specId,
    approvedBy: authContext.userId,
    version: updated.version,
  });
  return updated;
}

/**
 * Reject an execution specification with AUDIT-BEFORE-AUTH ordering per QT3-3.
 *
 * Flow:
 *   1. Pre-audit input validation (reason must be non-empty string). Malformed
 *      inputs bypass audit — they represent caller bugs, not user actions
 *      that need non-repudiation.
 *   2. Lookup the spec (projectId stamped onto the audit log even if denied).
 *   3. Structured console.log { phase:'audit', attemptId, specId, attemptedBy,
 *      reason, authResult:'PENDING' } BEFORE the permission check.
 *   4. Permission check.
 *   5. Structured console.log { phase:'audit-outcome', attemptId, authResult:
 *      'ALLOWED' | 'DENIED' } AFTER the check.
 *   6. Emit governance.specification.rejected regardless of outcome so
 *      downstream monitoring on denied attempts works.
 *   7. If DENIED → throw UnauthorizedError (audit trail already durable).
 *   8. If ALLOWED → LifecycleManager.validateTransition then DDB update.
 *      A lifecycle-validation failure at this point leaves the audit lines
 *      intact and ALLOWED (auth WAS allowed; only the transition failed).
 */
export async function rejectExecutionSpecification(
  specId: string,
  reason: string,
  authContext: AuthContext,
): Promise<ExecutionSpecification> {
  // Step 1: pre-audit input validation.
  if (typeof reason!== 'string' || !reason) {
    throw new Error('ValidationError: reason must be a non-empty string');
  }

  // Step 2: load spec (but do not fail yet — audit the attempt first if
  // missing). If absent, projectId defaults to '' so the audit trail still
  // records who/when.
  const spec = await getExecutionSpecification(specId);
  const projectId = spec?.projectId ?? '';

  // Step 3: pre-auth audit line.
  const attemptId = uuidv4();
  const attemptedAt = new Date().toISOString();
  console.log({
    phase: 'audit',
    attemptId,
    specId,
    projectId,
    attemptedBy: authContext.userId,
    attemptedAt,
    reason,
    authResult: 'PENDING',
  });

  // Step 4: permission check.
  const authorised = hasPermission(authContext, 'spec:approve');

  // Step 5: post-auth audit-outcome line.
  console.log({
    phase: 'audit-outcome',
    attemptId,
    specId,
    attemptedBy: authContext.userId,
    authResult: authorised ? 'ALLOWED' : 'DENIED',
  });

  // Step 6: emit rejection event regardless of outcome.
  await emitGovernanceEvent('governance.specification.rejected', {
    projectId,
    specId,
    reason,
    rejectedBy: authContext.userId,
  });

  // Step 7: deny-path throws AFTER audit + emit.
  if (!authorised) {
    throw new Error(
      'UnauthorizedError: spec:approve permission required to reject execution specifications',
    );
  }

  // Step 8: spec must exist for the allowed path.
  if (!spec) {
    throw new Error(`ExecutionSpecification not found: ${specId}`);
  }
  execSpecLifecycle.validateTransition(spec.status, 'REJECTED');

  return updateStatus(specId, spec.version, 'REJECTED', {
    rejectedAt: attemptedAt,
    rejectedBy: authContext.userId,
    rejectionReason: reason,
  });
}

export async function reviseExecutionSpecification(
  specId: string,
  input: ReviseExecutionSpecificationInput,
  authContext: AuthContext,
): Promise<ExecutionSpecification> {
  requireSpecApprovePermission(authContext, 'revise execution specifications');
  if (typeof input.structuredPayload !== 'string' || !input.structuredPayload) {
    throw new Error('ValidationError: structuredPayload is required');
  }
  validateNarrativeUri(input.narrativeS3Uri);

  const spec = await getExecutionSpecification(specId);
  if (!spec) throw new Error(`ExecutionSpecification not found: ${specId}`);
  execSpecLifecycle.validateTransition(spec.status, 'DRAFT');

  return updateStatus(specId, spec.version, 'DRAFT', {
    structuredPayload: input.structuredPayload,
    narrativeS3Uri: input.narrativeS3Uri,
  });
}

export const handler = async (event: any): Promise<unknown> => {
  const fieldName = event?.info?.fieldName;
  const authContext = authContextFromEvent(event);
  try {
    switch (fieldName) {
      case 'createExecutionSpecification':
        return await createExecutionSpecification(
          event.arguments.input as ExecutionSpecificationInput,
          authContext,
        );
      case 'submitExecutionSpecification':
        return await submitExecutionSpecification(
          event.arguments.specId,
          authContext,
        );
      case 'approveExecutionSpecification':
        return await approveExecutionSpecification(
          event.arguments.specId,
          authContext,
        );
      case 'rejectExecutionSpecification':
        return await rejectExecutionSpecification(
          event.arguments.specId,
          event.arguments.reason,
          authContext,
        );
      case 'reviseExecutionSpecification':
        return await reviseExecutionSpecification(
          event.arguments.specId,
          event.arguments.input as ReviseExecutionSpecificationInput,
          authContext,
        );
      case 'getExecutionSpecification':
        return await getExecutionSpecification(event.arguments.specId);
      case 'listExecutionSpecifications':
        return await listExecutionSpecifications(event.arguments.projectId);
      default:
        throw new Error(`Unsupported field: ${fieldName}`);
    }
  } catch (err: unknown) {
    console.error('execspec-resolver error', {
      fieldName,
      message: err instanceof Error ? err.message : undefined,
      args: sanitizeForLog(event?.arguments),
    });
    throw err;
  }
};
