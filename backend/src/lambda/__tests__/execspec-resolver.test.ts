/**
 * Unit tests for execspec-resolver Lambda.
 *
 * Covers:
 *   - createExecutionSpecification: permission gate, URI allowlist, validation,
 *     happy path returns DRAFT v1 with ISO-8601 createdAt.
 *   - submitExecutionSpecification: DRAFT → PENDING_REVIEW transition.
 *   - approveExecutionSpecification: architect-only, PENDING_REVIEW → APPROVED,
 *     emits governance.specification.approved with optimistic lock.
 *   - rejectExecutionSpecification: AUDIT-BEFORE-AUTH parity.
 *     CloudWatch-log audit (no dedicated table). Event emitted regardless of
 *     auth outcome.
 *   - reviseExecutionSpecification: REJECTED → DRAFT with version bump and
 *     re-validated narrativeS3Uri.
 *   - getExecutionSpecification / listExecutionSpecifications: GSI query path.
 *   - Property tests: URI allowlist validator (500 iters), audit-exists
 *     invariant on rejectExecutionSpecification.
 */
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { mockClient } from 'aws-sdk-client-mock';
import * as fc from 'fast-check';
import type { AuthContext, ExecutionSpecificationInput } from '../../types';

const ddbMock = mockClient(DynamoDBDocumentClient);
const ebMock = mockClient(EventBridgeClient);

// Env must be set before importing the module under test.
process.env.EXECUTION_SPECS_TABLE = 'citadel-execution-specifications-test';
process.env.EVENT_BUS_NAME = 'citadel-agents-test';

import {
  createExecutionSpecification,
  submitExecutionSpecification,
  approveExecutionSpecification,
  rejectExecutionSpecification,
  reviseExecutionSpecification,
  getExecutionSpecification,
  listExecutionSpecifications,
  isNarrativeUriAllowed,
  handler,
} from '../execspec-resolver';
import { __resetGovernanceNotifierForTest } from '../../utils/notifier-base';

const EXEC_SPECS_TABLE = 'citadel-execution-specifications-test';

// The architect role gains 'spec:approve' auth.ts edit.
// developer / project_manager do NOT hold spec:approve.
function authContextFor(
  role: 'architect' | 'developer' | 'project_manager',
): AuthContext {
  return {
    userId: `user-${role}`,
    username: role,
    groups: [],
    roles: [role],
  };
}

function validUri(projectId = 'proj-1', suffix = 'narrative.md'): string {
  return `s3://citadel-governance-transcripts-dev-123456789012-us-west-2/projects/${projectId}/${suffix}`;
}

function baseInput(overrides: Record<string, unknown> = {}): ExecutionSpecificationInput {
  return {
    projectId: 'proj-1',
    sourceAdrIds: ['adr-1'],
    structuredPayload: JSON.stringify({ modules: ['auth', 'billing'] }),
    narrativeS3Uri: validUri(),
    ...overrides,
  } as unknown as ExecutionSpecificationInput;
}

function existingSpec(overrides: Record<string, unknown> = {}) {
  return {
    specId: 'spec-1',
    projectId: 'proj-1',
    sourceAdrIds: ['adr-1'],
    structuredPayload: '{"modules":["auth"]}',
    narrativeS3Uri: validUri(),
    status: 'DRAFT',
    version: 1,
    createdAt: '2026-04-29T00:00:00.000Z',
    createdBy: 'user-architect',
    ...overrides,
  };
}

describe('execspec-resolver', () => {
  beforeEach(() => {
    ddbMock.reset();
    ebMock.reset();
    ebMock.on(PutEventsCommand).resolves({
      FailedEntryCount: 0,
      Entries: [{ EventId: 'evt-1' }],
    });
    __resetGovernanceNotifierForTest();
  });

  // ── createExecutionSpecification ──────────────────────────────────────

  describe('createExecutionSpecification', () => {
    test('1. happy path: returns DRAFT v1, createdAt ISO-8601, persists Put with ConditionExpression', async () => {
      ddbMock.on(PutCommand).resolves({});
      const auth = authContextFor('architect');

      const spec = await createExecutionSpecification(baseInput(), auth);

      expect(spec.status).toBe('DRAFT');
      expect(spec.version).toBe(1);
      expect(spec.createdBy).toBe('user-architect');
      expect(spec.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(spec.specId).toMatch(/^[0-9a-f-]{36}$/i);
      expect(spec.projectId).toBe('proj-1');
      expect(spec.sourceAdrIds).toEqual(['adr-1']);
      expect(spec.narrativeS3Uri).toBe(validUri());

      const puts = ddbMock.commandCalls(PutCommand);
      expect(puts).toHaveLength(1);
      expect(puts[0].args[0].input.TableName).toBe(EXEC_SPECS_TABLE);
      expect(puts[0].args[0].input.ConditionExpression).toBe(
        'attribute_not_exists(specId)',
      );
    });

    test('2. caller without spec:approve permission → UnauthorizedError, no PutCommand', async () => {
      ddbMock.on(PutCommand).resolves({});
      const auth = authContextFor('developer');

      await expect(
        createExecutionSpecification(baseInput(), auth),
      ).rejects.toThrow(/UnauthorizedError.*spec:approve/);
      expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    });

    test('3. attacker narrativeS3Uri s3://evil-bucket/x → ValidationError, no PutCommand', async () => {
      ddbMock.on(PutCommand).resolves({});
      const auth = authContextFor('architect');

      await expect(
        createExecutionSpecification(
          baseInput({ narrativeS3Uri: 's3://evil-bucket/x' }),
          auth,
        ),
      ).rejects.toThrow(/ValidationError.*narrativeS3Uri does not match allowlist/);
      expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    });

    test('4. empty sourceAdrIds → ValidationError', async () => {
      const auth = authContextFor('architect');
      await expect(
        createExecutionSpecification(baseInput({ sourceAdrIds: [] }), auth),
      ).rejects.toThrow(/ValidationError.*sourceAdrIds/);
      expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    });

    test('4b. non-array sourceAdrIds → ValidationError', async () => {
      const auth = authContextFor('architect');
      await expect(
        createExecutionSpecification(
          baseInput({ sourceAdrIds: 'not-an-array' }),
          auth,
        ),
      ).rejects.toThrow(/ValidationError.*sourceAdrIds/);
    });

    test('4c. missing structuredPayload → ValidationError', async () => {
      const auth = authContextFor('architect');
      await expect(
        createExecutionSpecification(
          baseInput({ structuredPayload: '' }),
          auth,
        ),
      ).rejects.toThrow(/ValidationError.*structuredPayload/);
    });
  });

  // ── Property test: URI validator (500 iterations) ─────────────────────

  describe('property: narrativeS3Uri allowlist (500 iters)', () => {
    test('5a. uris matching the allowlist template pass', () => {
      // Allowlist: s3://citadel-governance-transcripts-{env}-{account}-{region}/projects/{projectId}/...
      const envArb = fc.stringMatching(/^[a-z0-9-]{1,20}$/);
      const accountArb = fc.stringMatching(/^[0-9]{12}$/);
      const regionArb = fc.stringMatching(/^[a-z0-9-]{2,30}$/);
      const projectIdArb = fc.stringMatching(/^[a-zA-Z0-9-]{1,40}$/);
      const suffixArb = fc.stringMatching(/^[a-zA-Z0-9/._-]{1,60}$/);

      fc.assert(
        fc.property(
          envArb,
          accountArb,
          regionArb,
          projectIdArb,
          suffixArb,
          (env, account, region, projectId, suffix) => {
            const uri = `s3://citadel-governance-transcripts-${env}-${account}-${region}/projects/${projectId}/${suffix}`;
            return isNarrativeUriAllowed(uri) === true;
          },
        ),
        { numRuns: 500 },
      );
    });

    test('5b. random s3:// uris not matching the allowlist template fail', () => {
      // Generate arbitrary s3:// URIs that intentionally omit the required
      // citadel-governance-transcripts- prefix or the /projects/ segment.
      const bucketArb = fc.stringMatching(/^[a-z0-9-]{3,40}$/);
      const pathArb = fc.stringMatching(/^[a-zA-Z0-9/._-]{1,60}$/);
      fc.assert(
        fc.property(bucketArb, pathArb, (bucket, path) => {
          fc.pre(!bucket.startsWith('citadel-governance-transcripts-'));
          const uri = `s3://${bucket}/${path}`;
          return isNarrativeUriAllowed(uri) === false;
        }),
        { numRuns: 500 },
      );
    });

    test('5c. obvious attacker URIs fail', () => {
      expect(isNarrativeUriAllowed('s3://evil-bucket/x')).toBe(false);
      expect(isNarrativeUriAllowed('http://example.com/a')).toBe(false);
      expect(isNarrativeUriAllowed('')).toBe(false);
      expect(isNarrativeUriAllowed('s3://citadel-governance-transcripts-dev-1-us/not-projects/p/x')).toBe(false);
    });
  });

  // ── submitExecutionSpecification ──────────────────────────────────────

  describe('submitExecutionSpecification', () => {
    test('6. DRAFT → PENDING_REVIEW: happy path', async () => {
      const draft = existingSpec({ status: 'DRAFT', version: 1 });
      ddbMock.on(GetCommand).resolves({ Item: draft });
      ddbMock.on(UpdateCommand).resolves({
        Attributes: {
          ...draft,
          status: 'PENDING_REVIEW',
          version: 2,
          submittedAt: '2026-04-30T00:00:00.000Z',
        },
      });

      const auth = authContextFor('architect');
      const result = await submitExecutionSpecification('spec-1', auth);

      expect(result.status).toBe('PENDING_REVIEW');
      expect(result.version).toBe(2);
      const updates = ddbMock.commandCalls(UpdateCommand);
      expect(updates).toHaveLength(1);
      expect(updates[0].args[0].input.ConditionExpression).toMatch(/version/);
      expect(updates[0].args[0].input.ExpressionAttributeValues![':currentVersion']).toBe(1);
      expect(updates[0].args[0].input.ExpressionAttributeValues![':newVersion']).toBe(2);
    });

    test('6b. rejects caller without spec:approve permission', async () => {
      const auth = authContextFor('developer');
      await expect(
        submitExecutionSpecification('spec-1', auth),
      ).rejects.toThrow(/UnauthorizedError/);
      expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
    });
  });

  // ── approveExecutionSpecification ─────────────────────────────────────

  describe('approveExecutionSpecification', () => {
    test('7. architect on PENDING_REVIEW → APPROVED + governance.specification.approved', async () => {
      const pending = existingSpec({ status: 'PENDING_REVIEW', version: 2 });
      ddbMock.on(GetCommand).resolves({ Item: pending });
      ddbMock.on(UpdateCommand).resolves({
        Attributes: {
          ...pending,
          status: 'APPROVED',
          version: 3,
          approvedAt: '2026-04-30T00:00:00.000Z',
          approvedBy: 'user-architect',
        },
      });

      const auth = authContextFor('architect');
      const result = await approveExecutionSpecification('spec-1', auth);

      expect(result.status).toBe('APPROVED');
      expect(result.version).toBe(3);
      expect(result.approvedBy).toBe('user-architect');

      const updates = ddbMock.commandCalls(UpdateCommand);
      expect(updates).toHaveLength(1);
      expect(updates[0].args[0].input.ConditionExpression).toMatch(/version/);

      const ebCalls = ebMock.commandCalls(PutEventsCommand);
      expect(ebCalls).toHaveLength(1);
      const entry = ebCalls[0].args[0].input.Entries![0];
      expect(entry.DetailType).toBe('governance.specification.approved');
      const detail = JSON.parse(entry.Detail!);
      expect(detail.projectId).toBe('proj-1');
      expect(detail.specId).toBe('spec-1');
      expect(detail.approvedBy).toBe('user-architect');
      expect(detail.version).toBe(3);
    });

    test('8. non-architect (developer) → UnauthorizedError BEFORE state transition; zero UpdateCommand', async () => {
      // Even if the underlying spec is ready to approve, the auth gate fires
      // first. No DDB Get, no DDB Update, no EventBridge emission.
      const auth = authContextFor('developer');
      await expect(
        approveExecutionSpecification('spec-1', auth),
      ).rejects.toThrow(/UnauthorizedError.*spec:approve/);

      expect(
        ddbMock.commandCalls(UpdateCommand).filter(
          (c) => c.args[0].input.TableName === EXEC_SPECS_TABLE,
        ),
      ).toHaveLength(0);
      expect(ebMock.commandCalls(PutEventsCommand)).toHaveLength(0);
    });

    test('8b. project_manager (no spec:approve) → UnauthorizedError', async () => {
      const auth = authContextFor('project_manager');
      await expect(
        approveExecutionSpecification('spec-1', auth),
      ).rejects.toThrow(/UnauthorizedError.*spec:approve/);
    });

    test('16. optimistic-lock failure (stale version) on approve: ConditionalCheckFailedException propagates', async () => {
      const pending = existingSpec({ status: 'PENDING_REVIEW', version: 2 });
      ddbMock.on(GetCommand).resolves({ Item: pending });
      const ccf = new Error('The conditional request failed');
      ccf.name = 'ConditionalCheckFailedException';
      ddbMock.on(UpdateCommand).rejects(ccf);

      const auth = authContextFor('architect');
      await expect(
        approveExecutionSpecification('spec-1', auth),
      ).rejects.toThrow(/conditional/i);
    });

    test('approving a DRAFT directly (architect fast-path) → APPROVED allowed by matrix', async () => {
      // EXECSPEC_TRANSITIONS.actions.approve permits ['PENDING_REVIEW','DRAFT'].
      const draft = existingSpec({ status: 'DRAFT', version: 1 });
      ddbMock.on(GetCommand).resolves({ Item: draft });
      ddbMock.on(UpdateCommand).resolves({
        Attributes: { ...draft, status: 'APPROVED', version: 2 },
      });
      const auth = authContextFor('architect');
      // Transition matrix: DRAFT → APPROVED is NOT in transitions.DRAFT,
      // so LifecycleManager.validateTransition must reject. This asserts
      // the matrix, not the action list.
      await expect(
        approveExecutionSpecification('spec-1', auth),
      ).rejects.toThrow(/Invalid status transition.*DRAFT/);
    });
  });

  // ── rejectExecutionSpecification (AUDIT-BEFORE-AUTH) ──────────────────

  describe('rejectExecutionSpecification — audit-before-auth', () => {
    test('9. architect on PENDING_REVIEW → REJECTED, emits governance.specification.rejected with reason', async () => {
      const pending = existingSpec({ status: 'PENDING_REVIEW', version: 2 });
      ddbMock.on(GetCommand).resolves({ Item: pending });
      ddbMock.on(UpdateCommand).resolves({
        Attributes: {
          ...pending,
          status: 'REJECTED',
          version: 3,
          rejectedAt: '2026-04-30T00:00:00.000Z',
          rejectedBy: 'user-architect',
          rejectionReason: 'missing ADR citation',
        },
      });
      const auth = authContextFor('architect');
      const result = await rejectExecutionSpecification(
        'spec-1',
        'missing ADR citation',
        auth,
      );
      expect(result.status).toBe('REJECTED');
      expect(result.rejectionReason).toBe('missing ADR citation');

      const ebCalls = ebMock.commandCalls(PutEventsCommand);
      expect(ebCalls).toHaveLength(1);
      const entry = ebCalls[0].args[0].input.Entries![0];
      expect(entry.DetailType).toBe('governance.specification.rejected');
      const detail = JSON.parse(entry.Detail!);
      expect(detail.projectId).toBe('proj-1');
      expect(detail.specId).toBe('spec-1');
      expect(detail.reason).toBe('missing ADR citation');
      expect(detail.rejectedBy).toBe('user-architect');
    });

    test('10. developer denied: UnauthorizedError BUT event IS still emitted + audit-DENIED log line observable', async () => {
      // CloudWatch-log audit: structured log lines written PRE-auth
      // (phase=audit, authResult=PENDING) and POST-auth
      // (phase=audit-outcome, authResult=DENIED).
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      const pending = existingSpec({ status: 'PENDING_REVIEW', version: 2 });
      ddbMock.on(GetCommand).resolves({ Item: pending });
      ddbMock.on(UpdateCommand).resolves({});

      const auth = authContextFor('developer');
      await expect(
        rejectExecutionSpecification('spec-1', 'not convincing', auth),
      ).rejects.toThrow(/UnauthorizedError/);

      // No DDB update (permission denied).
      const updates = ddbMock.commandCalls(UpdateCommand).filter(
        (c) => c.args[0].input.TableName === EXEC_SPECS_TABLE,
      );
      expect(updates).toHaveLength(0);

      // Event IS emitted on denied path.
      const ebCalls = ebMock.commandCalls(PutEventsCommand);
      expect(ebCalls).toHaveLength(1);
      const entry = ebCalls[0].args[0].input.Entries![0];
      expect(entry.DetailType).toBe('governance.specification.rejected');
      const detail = JSON.parse(entry.Detail!);
      expect(detail.reason).toBe('not convincing');
      expect(detail.rejectedBy).toBe('user-developer');

      // Audit log lines present and ordered.
      const logPayloads = logSpy.mock.calls.map(
        (args) => args[0] as Record<string, unknown> | undefined,
      );
      // At least one line with phase='audit' and authResult='PENDING'.
      const pendingAudit = logPayloads.find(
        (p) => p && p.phase === 'audit' && p.authResult === 'PENDING',
      );
      expect(pendingAudit).toBeDefined();
      expect(pendingAudit!.specId).toBe('spec-1');
      expect(pendingAudit!.attemptedBy).toBe('user-developer');
      expect(pendingAudit!.reason).toBe('not convincing');

      const outcomeAudit = logPayloads.find(
        (p) => p && p.phase === 'audit-outcome' && p.authResult === 'DENIED',
      );
      expect(outcomeAudit).toBeDefined();
      expect(outcomeAudit!.attemptId).toBe(pendingAudit!.attemptId);

      logSpy.mockRestore();
    });

    test('11a. property: for every (role, status, reason) invocation, audit phase=audit PENDING log line appears', async () => {
      const roleArb = fc.constantFrom<'architect' | 'project_manager' | 'developer'>(
        'architect',
        'project_manager',
        'developer',
      );
      const statusArb = fc.constantFrom('DRAFT', 'PENDING_REVIEW', 'APPROVED', 'REJECTED');
      const reasonArb = fc.string({ minLength: 1, maxLength: 80 });

      await fc.assert(
        fc.asyncProperty(roleArb, statusArb, reasonArb, async (role, status, reason) => {
          ddbMock.reset();
          ebMock.reset();
          ebMock.on(PutEventsCommand).resolves({
            FailedEntryCount: 0,
            Entries: [{ EventId: 'evt' }],
          });
          __resetGovernanceNotifierForTest();

          const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
          ddbMock.on(GetCommand).resolves({ Item: existingSpec({ status, version: 1 }) });
          ddbMock.on(UpdateCommand).resolves({
            Attributes: existingSpec({ status: 'REJECTED', version: 2 }),
          });

          const auth = authContextFor(role);
          try {
            await rejectExecutionSpecification('spec-1', reason, auth);
          } catch {
            // Many combinations throw (denied, invalid transition) — that's fine.
          }

          const logPayloads = logSpy.mock.calls.map(
            (args) => args[0] as Record<string, unknown> | undefined,
          );
          const pendingAudit = logPayloads.find(
            (p) => p && p.phase === 'audit' && p.authResult === 'PENDING',
          );
          expect(pendingAudit).toBeDefined();
          expect(pendingAudit!.specId).toBe('spec-1');
          // Invariant: event emitted too (allowed AND denied branches both emit).
          // If the transition validation fails AFTER auth succeeds, the event is
          // still emitted before the transition check — asserted below when
          // auth is allowed; when denied it's emitted pre-throw.
          const ebCalls = ebMock.commandCalls(PutEventsCommand);
          // At least one emission unless the spec was loaded with a status
          // that causes a pre-audit failure (none in this test).
          expect(ebCalls.length).toBeGreaterThanOrEqual(1);

          logSpy.mockRestore();
        }),
        { numRuns: 100 },
      );
    });

    test('11b. rejecting an APPROVED spec (architect) → ValidationError from lifecycle guard, event still emitted with ALLOWED outcome', async () => {
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      const approved = existingSpec({ status: 'APPROVED', version: 3 });
      ddbMock.on(GetCommand).resolves({ Item: approved });
      const auth = authContextFor('architect');
      await expect(
        rejectExecutionSpecification('spec-1', 'reopen please', auth),
      ).rejects.toThrow(/Invalid status transition.*APPROVED/);

      // Event IS emitted — before the lifecycle check, matching parity.
      expect(ebMock.commandCalls(PutEventsCommand)).toHaveLength(1);

      const outcomeAudit = logSpy.mock.calls
        .map((a) => a[0] as Record<string, unknown> | undefined)
        .find((p) => p && p.phase === 'audit-outcome' && p.authResult === 'ALLOWED');
      expect(outcomeAudit).toBeDefined();
      logSpy.mockRestore();
    });
  });

  // ── reviseExecutionSpecification ──────────────────────────────────────

  describe('reviseExecutionSpecification', () => {
    test('12. happy path: REJECTED → DRAFT, version bumps, narrativeS3Uri revalidated', async () => {
      const rejected = existingSpec({ status: 'REJECTED', version: 3 });
      ddbMock.on(GetCommand).resolves({ Item: rejected });
      ddbMock.on(UpdateCommand).resolves({
        Attributes: {
          ...rejected,
          status: 'DRAFT',
          version: 4,
          structuredPayload: '{"modules":["auth","payments"]}',
          narrativeS3Uri: validUri('proj-1', 'narrative-v2.md'),
        },
      });

      const auth = authContextFor('architect');
      const result = await reviseExecutionSpecification(
        'spec-1',
        {
          structuredPayload: '{"modules":["auth","payments"]}',
          narrativeS3Uri: validUri('proj-1', 'narrative-v2.md'),
        },
        auth,
      );
      expect(result.status).toBe('DRAFT');
      expect(result.version).toBe(4);

      const updates = ddbMock.commandCalls(UpdateCommand);
      expect(updates).toHaveLength(1);
      expect(updates[0].args[0].input.ConditionExpression).toMatch(/version/);
    });

    test('13. revise with malformed narrativeS3Uri → ValidationError before DDB update', async () => {
      const rejected = existingSpec({ status: 'REJECTED', version: 3 });
      ddbMock.on(GetCommand).resolves({ Item: rejected });

      const auth = authContextFor('architect');
      await expect(
        reviseExecutionSpecification(
          'spec-1',
          {
            structuredPayload: '{}',
            narrativeS3Uri: 's3://wrong-bucket/projects/proj-1/x',
          },
          auth,
        ),
      ).rejects.toThrow(/ValidationError.*narrativeS3Uri does not match allowlist/);
      expect(
        ddbMock.commandCalls(UpdateCommand).filter(
          (c) => c.args[0].input.TableName === EXEC_SPECS_TABLE,
        ),
      ).toHaveLength(0);
    });

    test('13b. revise from non-REJECTED status → Invalid status transition', async () => {
      // PENDING_REVIEW → DRAFT is NOT in EXECSPEC_TRANSITIONS; only
      // REJECTED → DRAFT is. (DRAFT → DRAFT would be allowed by same-state
      // idempotence, so we must start from a status that genuinely lacks
      // the edge to DRAFT.)
      const pending = existingSpec({ status: 'PENDING_REVIEW', version: 2 });
      ddbMock.on(GetCommand).resolves({ Item: pending });
      const auth = authContextFor('architect');
      await expect(
        reviseExecutionSpecification(
          'spec-1',
          { structuredPayload: '{}', narrativeS3Uri: validUri() },
          auth,
        ),
      ).rejects.toThrow(/Invalid status transition/);
    });

    test('13c. revise without spec:approve → UnauthorizedError', async () => {
      const auth = authContextFor('developer');
      await expect(
        reviseExecutionSpecification(
          'spec-1',
          { structuredPayload: '{}', narrativeS3Uri: validUri() },
          auth,
        ),
      ).rejects.toThrow(/UnauthorizedError/);
    });
  });

  // ── listExecutionSpecifications / getExecutionSpecification ───────────

  describe('listExecutionSpecifications', () => {
    test('14. queries the project-index GSI with projectId key; returns [] when empty', async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [] });
      const items = await listExecutionSpecifications('proj-none');
      expect(items).toEqual([]);
      const calls = ddbMock.commandCalls(QueryCommand);
      expect(calls).toHaveLength(1);
      expect(calls[0].args[0].input.IndexName).toBe('project-index');
      expect(calls[0].args[0].input.KeyConditionExpression).toBe('projectId = :pid');
      expect(calls[0].args[0].input.ExpressionAttributeValues![':pid']).toBe('proj-none');
    });
  });

  describe('getExecutionSpecification', () => {
    test('15. returns null for unknown specId', async () => {
      ddbMock.on(GetCommand).resolves({});
      const res = await getExecutionSpecification('missing');
      expect(res).toBeNull();
    });

    test('15b. returns the spec when present', async () => {
      const existing = existingSpec();
      ddbMock.on(GetCommand).resolves({ Item: existing });
      const res = await getExecutionSpecification('spec-1');
      expect(res).toEqual(existing);
    });
  });

  // ── handler dispatch ──────────────────────────────────────────────────

  describe('handler dispatch', () => {
    function makeEvent(
      fieldName: string,
      args: Record<string, unknown>,
      role: 'architect' | 'developer' | 'project_manager' = 'architect',
    ) {
      return {
        info: { fieldName },
        arguments: args,
        identity: {
          sub: `user-${role}`,
          username: role,
          'custom:role': role,
        },
      };
    }

    test('createExecutionSpecification dispatch (architect, valid input)', async () => {
      ddbMock.on(PutCommand).resolves({});
      const result = (await handler(
        makeEvent('createExecutionSpecification', { input: baseInput() }),
      )) as { status: string; version: number };
      expect(result.status).toBe('DRAFT');
      expect(result.version).toBe(1);
    });

    test('getExecutionSpecification dispatch', async () => {
      ddbMock.on(GetCommand).resolves({ Item: existingSpec() });
      const result = (await handler(
        makeEvent('getExecutionSpecification', { specId: 'spec-1' }),
      )) as { specId: string };
      expect(result.specId).toBe('spec-1');
    });

    test('listExecutionSpecifications dispatch', async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [] });
      const result = await handler(
        makeEvent('listExecutionSpecifications', { projectId: 'proj-1' }),
      );
      expect(result).toEqual([]);
    });

    test('unknown field throws', async () => {
      await expect(handler(makeEvent('notAField', {}))).rejects.toThrow(
        /Unsupported field/,
      );
    });

    test('developer cannot create (UnauthorizedError)', async () => {
      await expect(
        handler(makeEvent('createExecutionSpecification', { input: baseInput() }, 'developer')),
      ).rejects.toThrow(/UnauthorizedError/);
    });
  });
});
