/**
 * Unit tests for adr-resolver Lambda.
 *
 * Covers:
 * - createADR: permission gate, validation, happy path with mandatory-only
 * and mandatory + QT1-6 optional (severity, affectsModules, reviewers).
 * - supersedeADR: happy path, cross-project rejection, optimistic-lock
 * ConditionalCheckFailedException propagation.
 * - lockADR: idempotent early-return on already-LOCKED; emits
 * governance.adr.locked with sourceRoundIds passthrough on first lock.
 * - getADR: returns null for unknown adrId.
 * - listADRsForProject: empty result + uses project-index.
 * - handler: dispatches on event.info.fieldName, surfaces AuthContext.
 * - Property tests: ADR_TRANSITIONS matrix via LifecycleManager;
 * createADR always returns status=PROPOSED and version=1.
 */
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { mockClient } from 'aws-sdk-client-mock';
import * as fc from 'fast-check';
import type { AuthContext } from '../../types';

const ddbMock = mockClient(DynamoDBDocumentClient);
const ebMock = mockClient(EventBridgeClient);

// Env must be set before importing the module under test.
process.env.ADRS_TABLE = 'citadel-adrs-test';
process.env.ADR_REOPEN_ATTEMPTS_TABLE = 'citadel-adr-reopen-attempts-test';
process.env.EVENT_BUS_NAME = 'citadel-agents-test';

import {
  createADR,
  getADR,
  listADRsForProject,
  lockADR,
  reopenADR,
  supersedeADR,
  handler,
  type ADRInput,
} from '../adr-resolver';
import { __resetGovernanceNotifierForTest } from '../../utils/notifier-base';
import { LifecycleManager, ADR_TRANSITIONS } from '../../adapters/lifecycle';

// Role-based AuthContext helper. The production auth.ts grants adr:create to
// the 'architect' role (landed in commit ffa887f). 'developer' has
// no ADR permissions.
function mockAuthContextFor(role: 'architect' | 'developer'): AuthContext {
  return {
    userId: `user-${role}`,
    username: role,
    groups: [],
    roles: [role],
  };
}

function baseInput(overrides: Record<string, unknown> = {}): ADRInput {
  return {
    projectId: 'proj-1',
    title: 'Use PostgreSQL over MySQL',
    decision: 'Adopt PostgreSQL 16 for all services.',
    reasoning: 'Stronger type system, JSONB support, mature RLS.',
    constraints: ['Must support RDS', 'Must support PITR'],
    alternativesConsidered: ['MySQL 8', 'Aurora Serverless'],
    revisitConditions: ['Team skills shift', 'Vendor contract change'],
    sourceRoundIds: ['round-1'],
    ...overrides,
  } as unknown as ADRInput;
}

describe('adr-resolver', () => {
  beforeEach(() => {
    ddbMock.reset();
    ebMock.reset();
    ebMock.on(PutEventsCommand).resolves({ FailedEntryCount: 0, Entries: [{ EventId: 'evt-1' }] });
    __resetGovernanceNotifierForTest();
  });

  // ── createADR ─────────────────────────────────────────────────────────

  describe('createADR', () => {
    test('happy path with mandatory + optional fields returns PROPOSED v1 ISO-8601 createdAt', async () => {
      ddbMock.on(PutCommand).resolves({});
      const auth = mockAuthContextFor('architect');
      const input = baseInput({
        severity: 'HIGH',
        affectsModules: ['billing', 'auth'],
        reviewers: ['user-2', 'user-3'],
      });

      const adr = await createADR(input, auth);

      expect(adr.status).toBe('PROPOSED');
      expect(adr.version).toBe(1);
      expect(adr.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(adr.createdBy).toBe('user-architect');
      expect(adr.adrId).toMatch(/^[0-9a-f-]{36}$/i);
      expect(adr.severity).toBe('HIGH');
      expect(adr.affectsModules).toEqual(['billing', 'auth']);
      expect(adr.reviewers).toEqual(['user-2', 'user-3']);
      expect(adr.sourceRoundIds).toEqual(['round-1']);

      const puts = ddbMock.commandCalls(PutCommand);
      expect(puts).toHaveLength(1);
      expect(puts[0].args[0].input.TableName).toBe('citadel-adrs-test');
      expect(puts[0].args[0].input.ConditionExpression).toBe('attribute_not_exists(adrId)');
    });

    test('happy path with only mandatory fields leaves optional fields undefined', async () => {
      ddbMock.on(PutCommand).resolves({});
      const auth = mockAuthContextFor('architect');

      const adr = await createADR(baseInput(), auth);

      expect(adr.status).toBe('PROPOSED');
      expect(adr.version).toBe(1);
      expect(adr.severity).toBeUndefined();
      expect(adr.affectsModules).toBeUndefined();
      expect(adr.reviewers).toBeUndefined();
      expect(adr.lockedAt).toBeUndefined();
      expect(adr.supersededBy).toBeUndefined();
    });

    test('rejects caller without adr:create permission and issues no PutCommand', async () => {
      ddbMock.on(PutCommand).resolves({});
      const auth = mockAuthContextFor('developer');

      await expect(createADR(baseInput(), auth)).rejects.toThrow(/UnauthorizedError/);
      expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    });

    test('rejects missing decision as ValidationError', async () => {
      const auth = mockAuthContextFor('architect');
      await expect(
        createADR(baseInput({ decision: '' }), auth)
      ).rejects.toThrow(/ValidationError.*decision/);
      expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    });

    test('rejects missing reasoning as ValidationError', async () => {
      const auth = mockAuthContextFor('architect');
      await expect(
        createADR(baseInput({ reasoning: '' }), auth)
      ).rejects.toThrow(/ValidationError.*reasoning/);
    });

    test('rejects non-array constraints as ValidationError', async () => {
      const auth = mockAuthContextFor('architect');
      await expect(
        createADR(baseInput({ constraints: 'not-an-array' }), auth)
      ).rejects.toThrow(/ValidationError.*array/);
    });
  });

  // ── lockADR ───────────────────────────────────────────────────────────

  describe('lockADR', () => {
    test('PROPOSED -> LOCKED emits governance.adr.locked with sourceRoundIds passthrough', async () => {
      const existing = {
        adrId: 'adr-1',
        projectId: 'proj-1',
        title: 'Use PostgreSQL',
        status: 'PROPOSED',
        version: 1,
        sourceRoundIds: ['round-1', 'round-2'],
      };
      ddbMock.on(GetCommand).resolves({ Item: existing });
      ddbMock.on(UpdateCommand).resolves({
        Attributes: {...existing, status: 'LOCKED', version: 2, lockedAt: '2026-04-30T00:00:00.000Z' },
      });

      const auth = mockAuthContextFor('architect');
      const locked = await lockADR('adr-1', auth);

      expect(locked.status).toBe('LOCKED');
      expect(locked.version).toBe(2);
      expect(locked.lockedAt).toBeDefined();

      const updates = ddbMock.commandCalls(UpdateCommand);
      expect(updates).toHaveLength(1);
      // Optimistic lock: ConditionExpression on version must be present.
      expect(updates[0].args[0].input.ConditionExpression).toMatch(/version/);

      const ebCalls = ebMock.commandCalls(PutEventsCommand);
      expect(ebCalls).toHaveLength(1);
      const entry = ebCalls[0].args[0].input.Entries![0];
      expect(entry.DetailType).toBe('governance.adr.locked');
      const detail = JSON.parse(entry.Detail!);
      expect(detail.adrId).toBe('adr-1');
      expect(detail.projectId).toBe('proj-1');
      expect(detail.title).toBe('Use PostgreSQL');
      expect(detail.sourceRoundIds).toEqual(['round-1', 'round-2']);
    });

    test('already-LOCKED is an idempotent early-return: no Update, no EventBridge emission', async () => {
      // Design choice (documented in lockADR source): if the ADR is already
      // LOCKED we short-circuit BEFORE the lifecycle check and BEFORE the DDB
      // update, so we never bump the version and never re-emit the event.
      const alreadyLocked = {
        adrId: 'adr-1',
        projectId: 'proj-1',
        title: 'Use PostgreSQL',
        status: 'LOCKED',
        version: 5,
        sourceRoundIds: ['round-1'],
        lockedAt: '2026-04-29T00:00:00.000Z',
      };
      ddbMock.on(GetCommand).resolves({ Item: alreadyLocked });

      const auth = mockAuthContextFor('architect');
      const result = await lockADR('adr-1', auth);

      expect(result).toEqual(alreadyLocked);
      expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
      expect(ebMock.commandCalls(PutEventsCommand)).toHaveLength(0);
    });

    test('non-existent ADR throws', async () => {
      ddbMock.on(GetCommand).resolves({});
      const auth = mockAuthContextFor('architect');
      await expect(lockADR('missing', auth)).rejects.toThrow(/not found/);
    });

    test('rejects caller without adr:create permission', async () => {
      const auth = mockAuthContextFor('developer');
      await expect(lockADR('adr-1', auth)).rejects.toThrow(/UnauthorizedError/);
      expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
    });
  });

  // ── supersedeADR ──────────────────────────────────────────────────────

  describe('supersedeADR', () => {
    test('happy path: old ADR PROPOSED -> SUPERSEDED, version bumps, supersededBy set', async () => {
      const oldAdr = { adrId: 'adr-old', projectId: 'proj-1', status: 'PROPOSED', version: 3, title: 'old', sourceRoundIds: ['r1'] };
      const newAdr = { adrId: 'adr-new', projectId: 'proj-1', status: 'PROPOSED', version: 1, title: 'new', sourceRoundIds: ['r2'] };
      ddbMock
        .on(GetCommand, { TableName: 'citadel-adrs-test', Key: { adrId: 'adr-old' } })
        .resolves({ Item: oldAdr })
        .on(GetCommand, { TableName: 'citadel-adrs-test', Key: { adrId: 'adr-new' } })
        .resolves({ Item: newAdr });
      ddbMock.on(UpdateCommand).resolves({
        Attributes: {...oldAdr, status: 'SUPERSEDED', version: 4, supersededBy: 'adr-new' },
      });

      const auth = mockAuthContextFor('architect');
      const result = await supersedeADR('adr-old', 'adr-new', auth);

      expect(result.status).toBe('SUPERSEDED');
      expect(result.version).toBe(4);
      expect(result.supersededBy).toBe('adr-new');

      const updates = ddbMock.commandCalls(UpdateCommand);
      expect(updates).toHaveLength(1);
      const input = updates[0].args[0].input;
      expect(input.ConditionExpression).toMatch(/version/);
      expect(input.ExpressionAttributeValues![':currentVersion']).toBe(3);
      expect(input.ExpressionAttributeValues![':newVersion']).toBe(4);
    });

    test('rejects cross-project supersede as ValidationError', async () => {
      const oldAdr = { adrId: 'adr-old', projectId: 'proj-A', status: 'PROPOSED', version: 1, title: 'old', sourceRoundIds: [] };
      const newAdr = { adrId: 'adr-new', projectId: 'proj-B', status: 'PROPOSED', version: 1, title: 'new', sourceRoundIds: [] };
      ddbMock
        .on(GetCommand, { TableName: 'citadel-adrs-test', Key: { adrId: 'adr-old' } })
        .resolves({ Item: oldAdr })
        .on(GetCommand, { TableName: 'citadel-adrs-test', Key: { adrId: 'adr-new' } })
        .resolves({ Item: newAdr });

      const auth = mockAuthContextFor('architect');
      await expect(
        supersedeADR('adr-old', 'adr-new', auth)
      ).rejects.toThrow(/ValidationError.*same projectId/);
      expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
    });

    test('stale version (ConditionalCheckFailedException) propagates', async () => {
      const oldAdr = { adrId: 'adr-old', projectId: 'proj-1', status: 'PROPOSED', version: 3, title: 'old', sourceRoundIds: [] };
      const newAdr = { adrId: 'adr-new', projectId: 'proj-1', status: 'PROPOSED', version: 1, title: 'new', sourceRoundIds: [] };
      ddbMock
        .on(GetCommand, { TableName: 'citadel-adrs-test', Key: { adrId: 'adr-old' } })
        .resolves({ Item: oldAdr })
        .on(GetCommand, { TableName: 'citadel-adrs-test', Key: { adrId: 'adr-new' } })
        .resolves({ Item: newAdr });
      const ccfError = new Error('The conditional request failed');
      ccfError.name = 'ConditionalCheckFailedException';
      ddbMock.on(UpdateCommand).rejects(ccfError);

      const auth = mockAuthContextFor('architect');
      await expect(
        supersedeADR('adr-old', 'adr-new', auth)
      ).rejects.toThrow(/conditional/i);
    });

    test('rejects invalid lifecycle transition from SUPERSEDED', async () => {
      const oldAdr = { adrId: 'adr-old', projectId: 'proj-1', status: 'SUPERSEDED', version: 2, title: 'old', sourceRoundIds: [] };
      const newAdr = { adrId: 'adr-new', projectId: 'proj-1', status: 'PROPOSED', version: 1, title: 'new', sourceRoundIds: [] };
      ddbMock
        .on(GetCommand, { TableName: 'citadel-adrs-test', Key: { adrId: 'adr-old' } })
        .resolves({ Item: oldAdr })
        .on(GetCommand, { TableName: 'citadel-adrs-test', Key: { adrId: 'adr-new' } })
        .resolves({ Item: newAdr });

      const auth = mockAuthContextFor('architect');
      await expect(
        supersedeADR('adr-old', 'adr-new', auth)
      ).rejects.toThrow(/Invalid status transition/);
    });
  });

  // ── getADR / listADRsForProject ───────────────────────────────────────

  describe('getADR', () => {
    test('returns null for unknown adrId', async () => {
      ddbMock.on(GetCommand).resolves({});
      const adr = await getADR('missing');
      expect(adr).toBeNull();
    });

    test('returns the ADR when present', async () => {
      const existing = { adrId: 'adr-1', projectId: 'proj-1', status: 'PROPOSED', version: 1, title: 't', sourceRoundIds: [] };
      ddbMock.on(GetCommand).resolves({ Item: existing });
      const adr = await getADR('adr-1');
      expect(adr).toEqual(existing);
    });
  });

  describe('listADRsForProject', () => {
    test('returns [] when project has no ADRs and queries the project-index GSI', async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [] });
      const adrs = await listADRsForProject('proj-none');
      expect(adrs).toEqual([]);
      const calls = ddbMock.commandCalls(QueryCommand);
      expect(calls).toHaveLength(1);
      expect(calls[0].args[0].input.IndexName).toBe('project-index');
      expect(calls[0].args[0].input.KeyConditionExpression).toBe('projectId = :pid');
    });

    test('returns items when project has ADRs', async () => {
      const items = [
        { adrId: 'a1', projectId: 'proj-1', status: 'LOCKED', version: 2, title: 't1', sourceRoundIds: [] },
        { adrId: 'a2', projectId: 'proj-1', status: 'PROPOSED', version: 1, title: 't2', sourceRoundIds: [] },
      ];
      ddbMock.on(QueryCommand).resolves({ Items: items });
      const adrs = await listADRsForProject('proj-1');
      expect(adrs).toEqual(items);
    });
  });

  // ── handler (field dispatch) ──────────────────────────────────────────

  describe('handler dispatch', () => {
    function makeEvent(fieldName: string, args: Record<string, unknown>, role: 'architect' | 'developer' = 'architect') {
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

    test('createADR dispatch routes to createADR function and enforces permission', async () => {
      ddbMock.on(PutCommand).resolves({});
      const result = (await handler(makeEvent('createADR', { input: baseInput() }))) as {
        status: string;
        version: number;
      };
      expect(result.status).toBe('PROPOSED');
      expect(result.version).toBe(1);
    });

    test('getADR dispatch', async () => {
      const existing = { adrId: 'adr-1', projectId: 'proj-1', status: 'PROPOSED', version: 1, title: 't', sourceRoundIds: [] };
      ddbMock.on(GetCommand).resolves({ Item: existing });
      const result = await handler(makeEvent('getADR', { adrId: 'adr-1' }));
      expect(result).toEqual(existing);
    });

    test('listADRsForProject dispatch', async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [] });
      const result = await handler(makeEvent('listADRsForProject', { projectId: 'proj-1' }));
      expect(result).toEqual([]);
    });

    test('unknown field throws', async () => {
      await expect(handler(makeEvent('notAField', {}))).rejects.toThrow(/Unsupported field/);
    });

    test('developer role cannot create ADR', async () => {
      await expect(
        handler(makeEvent('createADR', { input: baseInput() }, 'developer'))
      ).rejects.toThrow(/UnauthorizedError/);
    });
  });

  // ── Property tests ────────────────────────────────────────────────────

  describe('property: ADR_TRANSITIONS via LifecycleManager', () => {
    const lifecycle = new LifecycleManager(ADR_TRANSITIONS);
    const STATUSES = ['PROPOSED', 'LOCKED', 'SUPERSEDED', 'REOPENED'];
    const MATRIX: Record<string, string[]> = {
      PROPOSED: ['LOCKED', 'SUPERSEDED'],
      LOCKED: ['SUPERSEDED', 'REOPENED'],
      REOPENED: ['LOCKED'],
      SUPERSEDED: [],
    };

    test('random (from, to) pairs respect the matrix and same-state idempotence', () => {
      const statusArb = fc.constantFrom(...STATUSES);
      fc.assert(
        fc.property(statusArb, statusArb, (from, to) => {
          const expected = from === to || MATRIX[from].includes(to);
          expect(lifecycle.isValidTransition(from, to)).toBe(expected);
        }),
        { numRuns: 100 }
      );
    });
  });

  describe('property: createADR always returns PROPOSED v1', () => {
    test('for 100 random valid inputs, status=PROPOSED and version=1', async () => {
      ddbMock.on(PutCommand).resolves({});
      const auth = mockAuthContextFor('architect');

      const titleArb = fc.string({ minLength: 1, maxLength: 80 });
      const bodyArb = fc.string({ minLength: 1, maxLength: 500 });
      const listArb = fc.array(fc.string({ minLength: 1, maxLength: 50 }), { minLength: 0, maxLength: 5 });
      const severityArb = fc.option(fc.constantFrom('LOW', 'MEDIUM', 'HIGH', 'CRITICAL'), { nil: undefined });

      await fc.assert(
        fc.asyncProperty(
          titleArb, bodyArb, bodyArb, listArb, listArb, listArb, listArb, severityArb,
          async (title, decision, reasoning, constraints, alternatives, revisits, sourceRoundIds, severity) => {
            ddbMock.resetHistory();
            const input = {
              projectId: 'proj-p',
              title,
              decision,
              reasoning,
              constraints,
              alternativesConsidered: alternatives,
              revisitConditions: revisits,
              sourceRoundIds,
              severity,
            };
            const adr = await createADR(input, auth);
            expect(adr.status).toBe('PROPOSED');
            expect(adr.version).toBe(1);
            expect(adr.adrId).toMatch(/^[0-9a-f-]{36}$/i);
            expect(adr.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  // ── reopenADR ────────────────────────────────────────────
  //
  // The invariant under test is 'audit-before-auth' (QT2A-7 + QT3-3): an
  // audit row is written to citadel-adr-reopen-attempts-{env} BEFORE the
  // Cognito permission check, so every invocation — allowed, denied,
  // lifecycle-rejected — leaves a durable trace. The only exception is
  // pre-audit input-shape validation (step 0), which rejects malformed
  // payloads to keep the audit table clean.

  describe('reopenADR — audit-before-auth', () => {
    const AUDIT_TABLE = 'citadel-adr-reopen-attempts-test';
    const ADRS_TABLE = 'citadel-adrs-test';

    // Helper: auth context for any governance-relevant role (adds
    // project_manager + developer to the existing architect/developer
    // helper above, since grants adr:reopen to architect AND
    // project_manager per QT1-5).
    function auditAuthContextFor(role: 'architect' | 'project_manager' | 'developer'): AuthContext {
      return {
        userId: `user-${role}`,
        username: role,
        groups: [],
        roles: [role],
      };
    }

    // Helper: extract the sequence of audit-table Put/Update commands in
    // the order the SDK recorded them. Ordering is asserted via the
    // commandCalls arrays which aws-sdk-client-mock records chronologically.
    function auditCommands() {
      const puts = ddbMock
        .commandCalls(PutCommand)
        .filter((c) => c.args[0].input.TableName === AUDIT_TABLE);
      const updates = ddbMock
        .commandCalls(UpdateCommand)
        .filter((c) => c.args[0].input.TableName === AUDIT_TABLE);
      return { puts, updates };
    }

    function lockedAdr(overrides: Partial<Record<string, unknown>> = {}) {
      return {
        adrId: 'adr-1',
        projectId: 'proj-1',
        title: 'Adopt PostgreSQL',
        status: 'LOCKED',
        version: 3,
        sourceRoundIds: ['r1'],
        lockedAt: '2026-04-29T00:00:00.000Z',
        ...overrides,
      };
    }

    test('1. denied user: audit row written as PENDING→DENIED, event emitted, then throws', async () => {
      // Fail path must still produce: 1 PutCommand(PENDING) then 1
      // UpdateCommand(DENIED) then 1 PutEvents.
      ddbMock.on(GetCommand).resolves({ Item: lockedAdr() });
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(UpdateCommand).resolves({});

      const auth = auditAuthContextFor('developer');
      await expect(
        reopenADR('adr-1', 'Reopen for clause X', true, 'scope expanded', auth)
      ).rejects.toThrow(/UnauthorizedError.*adr:reopen/);

      const { puts, updates } = auditCommands();
      expect(puts).toHaveLength(1);
      expect(puts[0].args[0].input.TableName).toBe(AUDIT_TABLE);
      expect(puts[0].args[0].input.ConditionExpression).toMatch(/attribute_not_exists\(attemptId\)/);
      const pendingRow = puts[0].args[0].input.Item as Record<string, unknown>;
      expect(pendingRow.authResult).toBe('PENDING');
      expect(pendingRow.adrId).toBe('adr-1');
      expect(pendingRow.projectId).toBe('proj-1');
      expect(pendingRow.attemptedBy).toBe('user-developer');
      expect(pendingRow.attemptedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(pendingRow.proposedChange).toBe('Reopen for clause X');
      expect(pendingRow.revisitConditionMatched).toBe(true);
      expect(pendingRow.reason).toBe('scope expanded');

      expect(updates).toHaveLength(1);
      expect(updates[0].args[0].input.TableName).toBe(AUDIT_TABLE);
      expect(updates[0].args[0].input.ExpressionAttributeValues![':ar']).toBe('DENIED');
      expect(updates[0].args[0].input.Key).toEqual({ attemptId: pendingRow.attemptId });

      // Event IS emitted on denied path (downstream alerting relies on this).
      const ebCalls = ebMock.commandCalls(PutEventsCommand);
      expect(ebCalls).toHaveLength(1);
      const entry = ebCalls[0].args[0].input.Entries![0];
      expect(entry.DetailType).toBe('governance.adr.reopen.attempted');
      const detail = JSON.parse(entry.Detail!);
      expect(detail.authResult).toBe('DENIED');
      expect(detail.attemptedBy).toBe('user-developer');
    });

    test('2. architect on LOCKED ADR succeeds: audit row PENDING→ALLOWED, ADR transitions to REOPENED', async () => {
      const locked = lockedAdr();
      ddbMock.on(GetCommand).resolves({ Item: locked });
      ddbMock.on(PutCommand).resolves({});
      ddbMock
        .on(UpdateCommand, { TableName: AUDIT_TABLE })
        .resolves({})
        .on(UpdateCommand, { TableName: ADRS_TABLE })
        .resolves({ Attributes: {...locked, status: 'REOPENED', version: 4 } });

      const auth = auditAuthContextFor('architect');
      const result = await reopenADR('adr-1', 'Need to rethink clause Y', true, 'vendor contract change', auth);

      expect(result.status).toBe('REOPENED');
      expect(result.version).toBe(4);

      const { puts, updates } = auditCommands();
      expect(puts).toHaveLength(1);
      expect((puts[0].args[0].input.Item as Record<string, unknown>).authResult).toBe('PENDING');
      expect(updates).toHaveLength(1);
      expect(updates[0].args[0].input.ExpressionAttributeValues![':ar']).toBe('ALLOWED');

      // ADR-table update asserts optimistic lock on version.
      const adrUpdates = ddbMock
        .commandCalls(UpdateCommand)
        .filter((c) => c.args[0].input.TableName === ADRS_TABLE);
      expect(adrUpdates).toHaveLength(1);
      expect(adrUpdates[0].args[0].input.ConditionExpression).toMatch(/version/);
      expect(adrUpdates[0].args[0].input.ExpressionAttributeValues![':currentVersion']).toBe(3);
      expect(adrUpdates[0].args[0].input.ExpressionAttributeValues![':newVersion']).toBe(4);
      expect(adrUpdates[0].args[0].input.ExpressionAttributeValues![':newStatus']).toBe('REOPENED');

      const ebCalls = ebMock.commandCalls(PutEventsCommand);
      expect(ebCalls).toHaveLength(1);
      const detail = JSON.parse(ebCalls[0].args[0].input.Entries![0].Detail!);
      expect(detail.authResult).toBe('ALLOWED');
      expect(detail.projectId).toBe('proj-1');
      expect(detail.adrId).toBe('adr-1');
      expect(detail.revisitConditionMatched).toBe(true);
    });

    test('3. architect on non-LOCKED (PROPOSED) ADR: audit row stays ALLOWED with transitionError populated, event emitted, ValidationError thrown', async () => {
      const proposed = lockedAdr({ status: 'PROPOSED' });
      ddbMock.on(GetCommand).resolves({ Item: proposed });
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(UpdateCommand).resolves({});

      const auth = auditAuthContextFor('architect');
      await expect(
        reopenADR('adr-1', 'p', false, 'r', auth)
      ).rejects.toThrow(/Invalid status transition/);

      const { puts, updates } = auditCommands();
      expect(puts).toHaveLength(1);
      expect((puts[0].args[0].input.Item as Record<string, unknown>).authResult).toBe('PENDING');
      // Two audit-table updates: first ALLOWED, then transitionError.
      expect(updates).toHaveLength(2);
      expect(updates[0].args[0].input.ExpressionAttributeValues![':ar']).toBe('ALLOWED');
      expect(updates[1].args[0].input.UpdateExpression).toMatch(/transitionError/);
      expect(updates[1].args[0].input.ExpressionAttributeValues![':te']).toMatch(/Invalid status transition/);
      // No ADR-table write.
      const adrUpdates = ddbMock
        .commandCalls(UpdateCommand)
        .filter((c) => c.args[0].input.TableName === ADRS_TABLE);
      expect(adrUpdates).toHaveLength(0);
      // Event IS emitted — between auth-update and lifecycle validation.
      expect(ebMock.commandCalls(PutEventsCommand)).toHaveLength(1);
      const detail = JSON.parse(ebMock.commandCalls(PutEventsCommand)[0].args[0].input.Entries![0].Detail!);
      expect(detail.authResult).toBe('ALLOWED');
    });

    test('4. architect on non-existent ADR: audit row written with projectId empty, authResult ALLOWED, then throws ADR-not-found', async () => {
      ddbMock.on(GetCommand).resolves({});
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(UpdateCommand).resolves({});

      const auth = auditAuthContextFor('architect');
      await expect(
        reopenADR('ghost-adr', 'p', true, 'r', auth)
      ).rejects.toThrow(/ADR not found: ghost-adr/);

      const { puts, updates } = auditCommands();
      expect(puts).toHaveLength(1);
      const row = puts[0].args[0].input.Item as Record<string, unknown>;
      expect(row.adrId).toBe('ghost-adr');
      expect(row.projectId).toBe('');
      expect(row.authResult).toBe('PENDING');
      expect(updates).toHaveLength(1);
      expect(updates[0].args[0].input.ExpressionAttributeValues![':ar']).toBe('ALLOWED');
      expect(ebMock.commandCalls(PutEventsCommand)).toHaveLength(1);
    });

    test('5. non-existent ADR with denied user: audit row DENIED, UnauthorizedError wins over ADR-not-found', async () => {
      ddbMock.on(GetCommand).resolves({});
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(UpdateCommand).resolves({});

      const auth = auditAuthContextFor('developer');
      await expect(
        reopenADR('ghost-adr', 'p', true, 'r', auth)
      ).rejects.toThrow(/UnauthorizedError/);
      // Specifically NOT the 'ADR not found' error.
      await expect(
        reopenADR('ghost-adr', 'p', true, 'r', auth)
      ).rejects.not.toThrow(/ADR not found/);

      const puts = ddbMock.commandCalls(PutCommand).filter((c) => c.args[0].input.TableName === AUDIT_TABLE);
      const updates = ddbMock.commandCalls(UpdateCommand).filter((c) => c.args[0].input.TableName === AUDIT_TABLE);
      expect(puts.length).toBeGreaterThanOrEqual(1);
      expect(updates.some((c) => c.args[0].input.ExpressionAttributeValues![':ar'] === 'DENIED')).toBe(true);
    });

    test('6. invalid input (non-string proposedChange) with architect: ValidationError BEFORE any DDB write', async () => {
      const auth = auditAuthContextFor('architect');
      await expect(
        reopenADR('adr-1', 123 as unknown as string, true, 'r', auth)
      ).rejects.toThrow(/ValidationError.*proposedChange/);
      // Zero writes to the audit table.
      expect(ddbMock.commandCalls(PutCommand).filter((c) => c.args[0].input.TableName === AUDIT_TABLE)).toHaveLength(0);
      expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
      // And zero GetCommands too — we abort before any DDB contact.
      expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
    });

    test('7. invalid input (non-string reason): ValidationError before audit', async () => {
      const auth = auditAuthContextFor('architect');
      await expect(
        reopenADR('adr-1', 'p', true, 123 as unknown as string, auth)
      ).rejects.toThrow(/ValidationError.*reason/);
      expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    });

    test('8. invalid input (non-boolean revisitConditionMatched): ValidationError before audit', async () => {
      const auth = auditAuthContextFor('architect');
      await expect(
        reopenADR('adr-1', 'p', 'yes' as unknown as boolean, 'r', auth)
      ).rejects.toThrow(/ValidationError.*revisitConditionMatched/);
      expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    });

    test('9. concurrent reopen (stale version): ConditionalCheckFailedException propagates, audit row stays ALLOWED', async () => {
      const locked = lockedAdr();
      ddbMock.on(GetCommand).resolves({ Item: locked });
      ddbMock.on(PutCommand).resolves({});
      const ccf = new Error('The conditional request failed');
      ccf.name = 'ConditionalCheckFailedException';
      ddbMock
        .on(UpdateCommand, { TableName: AUDIT_TABLE })
        .resolves({})
        .on(UpdateCommand, { TableName: ADRS_TABLE })
        .rejects(ccf);

      const auth = auditAuthContextFor('architect');
      await expect(
        reopenADR('adr-1', 'p', true, 'r', auth)
      ).rejects.toThrow(/conditional/i);

      const { puts, updates } = auditCommands();
      expect(puts).toHaveLength(1);
      // Exactly ONE audit-table update (to ALLOWED). transitionError is NOT
      // populated here because the failure happened in the ADRS_TABLE
      // update, not in LifecycleManager.validateTransition.
      expect(updates).toHaveLength(1);
      expect(updates[0].args[0].input.ExpressionAttributeValues![':ar']).toBe('ALLOWED');
    });

    test('10. project_manager role is permitted: happy path identical to architect', async () => {
      const locked = lockedAdr();
      ddbMock.on(GetCommand).resolves({ Item: locked });
      ddbMock.on(PutCommand).resolves({});
      ddbMock
        .on(UpdateCommand, { TableName: AUDIT_TABLE })
        .resolves({})
        .on(UpdateCommand, { TableName: ADRS_TABLE })
        .resolves({ Attributes: {...locked, status: 'REOPENED', version: 4 } });

      const auth = auditAuthContextFor('project_manager');
      const result = await reopenADR('adr-1', 'p', true, 'r', auth);
      expect(result.status).toBe('REOPENED');

      const { puts, updates } = auditCommands();
      expect(puts).toHaveLength(1);
      expect(updates[0].args[0].input.ExpressionAttributeValues![':ar']).toBe('ALLOWED');
      expect(ebMock.commandCalls(PutEventsCommand)).toHaveLength(1);
    });

    test('11. developer role is denied (same as test 1 but explicit)', async () => {
      ddbMock.on(GetCommand).resolves({ Item: lockedAdr() });
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(UpdateCommand).resolves({});

      const auth = auditAuthContextFor('developer');
      await expect(
        reopenADR('adr-1', 'p', true, 'r', auth)
      ).rejects.toThrow(/UnauthorizedError.*adr:reopen/);
      const updates = ddbMock
        .commandCalls(UpdateCommand)
        .filter((c) => c.args[0].input.TableName === AUDIT_TABLE);
      expect(updates[0].args[0].input.ExpressionAttributeValues![':ar']).toBe('DENIED');
    });

    test('12. property: for every invocation that passes input validation, at least one PutCommand was issued to the audit table', async () => {
      const roleArb = fc.constantFrom<'architect' | 'project_manager' | 'developer'>(
        'architect',
        'project_manager',
        'developer',
      );
      const statusArb = fc.constantFrom('PROPOSED', 'LOCKED', 'SUPERSEDED', 'REOPENED');
      const revisitArb = fc.boolean();
      // Bounded strings so the structural validation always passes.
      const strArb = fc.string({ minLength: 0, maxLength: 50 });
      // Sometimes the ADR exists, sometimes not.
      const existsArb = fc.boolean();

      await fc.assert(
        fc.asyncProperty(
          roleArb, statusArb, revisitArb, strArb, strArb, existsArb,
          async (role, status, revisit, proposed, reason, exists) => {
            ddbMock.reset();
            ebMock.reset();
            ebMock.on(PutEventsCommand).resolves({ FailedEntryCount: 0, Entries: [{ EventId: 'e' }] });
            __resetGovernanceNotifierForTest();

            ddbMock.on(GetCommand).resolves(exists? { Item: lockedAdr({ status }) }: {});
            ddbMock.on(PutCommand).resolves({});
            const succeedOnAdrUpdate = exists && status === 'LOCKED' && role!== 'developer';
            ddbMock
              .on(UpdateCommand, { TableName: AUDIT_TABLE })
              .resolves({})
              .on(UpdateCommand, { TableName: ADRS_TABLE })
              .resolves(
                succeedOnAdrUpdate
                  ? { Attributes: {...lockedAdr({ status }), status: 'REOPENED', version: 4 } }
                  : {},
              );

            const auth = auditAuthContextFor(role);
            try {
              await reopenADR('adr-1', proposed, revisit, reason, auth);
            } catch {
              // Expected on many branches.
            }
            // Invariant: at least one audit PutCommand was issued.
            const auditPuts = ddbMock
              .commandCalls(PutCommand)
              .filter((c) => c.args[0].input.TableName === AUDIT_TABLE);
            expect(auditPuts.length).toBeGreaterThanOrEqual(1);
            // And the row is PENDING at insert-time.
            expect((auditPuts[0].args[0].input.Item as Record<string, unknown>).authResult).toBe('PENDING');
          },
        ),
        { numRuns: 100 },
      );
    });

    test('13. emit payload shape: Detail contains exactly {projectId, adrId, revisitConditionMatched, attemptedBy, authResult, timestamp} (correlationId optional)', async () => {
      const locked = lockedAdr();
      ddbMock.on(GetCommand).resolves({ Item: locked });
      ddbMock.on(PutCommand).resolves({});
      ddbMock
        .on(UpdateCommand, { TableName: AUDIT_TABLE })
        .resolves({})
        .on(UpdateCommand, { TableName: ADRS_TABLE })
        .resolves({ Attributes: {...locked, status: 'REOPENED', version: 4 } });

      const auth = auditAuthContextFor('architect');
      await reopenADR('adr-1', 'p', true, 'r', auth);

      const ebCalls = ebMock.commandCalls(PutEventsCommand);
      expect(ebCalls).toHaveLength(1);
      const entry = ebCalls[0].args[0].input.Entries![0];
      expect(entry.Source).toBe('citadel.backend');
      expect(entry.DetailType).toBe('governance.adr.reopen.attempted');
      const detail = JSON.parse(entry.Detail!);
      // Required keys present.
      expect(detail.projectId).toBe('proj-1');
      expect(detail.adrId).toBe('adr-1');
      expect(detail.revisitConditionMatched).toBe(true);
      expect(detail.attemptedBy).toBe('user-architect');
      expect(detail.authResult).toBe('ALLOWED');
      expect(detail.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      // No extra keys besides the allowed set (correlationId is permitted
      // but optional — omitted here since we didn't pass one).
      const allowed = new Set([
        'projectId',
        'adrId',
        'revisitConditionMatched',
        'attemptedBy',
        'authResult',
        'timestamp',
        'correlationId',
      ]);
      for (const key of Object.keys(detail)) {
        expect(allowed.has(key)).toBe(true);
      }
    });
  });

  // ── reopenADR dispatch via handler ────────────────────────────────────

  describe('handler dispatch: reopenADR', () => {
    test('reopenADR dispatches to the resolver with architect auth and returns REOPENED', async () => {
      const locked = {
        adrId: 'adr-1',
        projectId: 'proj-1',
        title: 't',
        status: 'LOCKED',
        version: 3,
        sourceRoundIds: [],
        lockedAt: '2026-04-29T00:00:00.000Z',
      };
      ddbMock.on(GetCommand).resolves({ Item: locked });
      ddbMock.on(PutCommand).resolves({});
      ddbMock
        .on(UpdateCommand, { TableName: 'citadel-adr-reopen-attempts-test' })
        .resolves({})
        .on(UpdateCommand, { TableName: 'citadel-adrs-test' })
        .resolves({ Attributes: {...locked, status: 'REOPENED', version: 4 } });

      const event = {
        info: { fieldName: 'reopenADR' },
        arguments: { adrId: 'adr-1', proposedChange: 'p', revisitConditionMatched: true, reason: 'r' },
        identity: { sub: 'user-architect', username: 'architect', 'custom:role': 'architect' },
      };
      const result = (await handler(event)) as { status: string; version: number };
      expect(result.status).toBe('REOPENED');
      expect(result.version).toBe(4);
    });
  });
});
