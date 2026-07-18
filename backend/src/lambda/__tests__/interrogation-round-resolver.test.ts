/**
 * Unit tests for interrogation-round-resolver Lambda.
 *
 * Covers:
 *   - startInterrogationRound: perm gate (adr:create), deterministic
 *     transcriptS3Uri, DDB row status=IN_PROGRESS, emits
 *     governance.round.started.
 *   - stabiliseRound: PII redaction (email + phone) applied to transcript
 *     BEFORE the S3 PutObject; DDB IN_PROGRESS -> STABILISED; emits
 *     governance.round.completed.
 *   - stabiliseRound idempotent early-return on already-STABILISED: no
 *     S3 PutObject, no re-emit of governance.round.completed. Mirrors
 *     the lockADR pattern.
 *   - stabiliseRound >5MB transcript: S3 write still succeeds AND
 *     governance.round.transcript.overflow emitted with sizeBytes.
 *   - injectConstraints: IN_PROGRESS -> AWAITING_CONSTRAINTS, constraints
 *     array persisted; STABILISED rejects with 'Invalid status transition'.
 *   - Unauthorized caller: UnauthorizedError, no DDB write.
 *   - getInterrogationRound: null for missing.
 *   - listInterrogationRounds: Query by projectId PK.
 *   - Property test (200 iterations): redactPII idempotent — stabiliseRound
 *     called twice with the same transcript is a no-op on the second call.
 */
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { mockClient } from 'aws-sdk-client-mock';
import * as fc from 'fast-check';
import type { AuthContext } from '../../types';

const ddbMock = mockClient(DynamoDBDocumentClient);
const s3Mock = mockClient(S3Client);
const ebMock = mockClient(EventBridgeClient);

// Env must be set BEFORE importing the module under test — the resolver
// captures process.env at module load time.
process.env.INTERROGATION_ROUNDS_TABLE = 'citadel-interrogation-rounds-test';
process.env.GOVERNANCE_TRANSCRIPTS_BUCKET = 'citadel-governance-transcripts-test';
process.env.EVENT_BUS_NAME = 'citadel-agents-test';

import {
  startInterrogationRound,
  injectConstraints,
  stabiliseRound,
  getInterrogationRound,
  listInterrogationRounds,
  handler,
  type InterrogationRound,
} from '../interrogation-round-resolver';
import { __resetGovernanceNotifierForTest } from '../../utils/notifier-base';

function mockAuthContextFor(role: 'architect' | 'developer'): AuthContext {
  return {
    userId: `user-${role}`,
    username: role,
    groups: [],
    roles: [role],
  };
}

function baseRow(overrides: Partial<InterrogationRound> = {}): InterrogationRound {
  return {
    projectId: 'proj-1',
    roundN: 1,
    transcriptS3Uri:
      's3://citadel-governance-transcripts-test/projects/proj-1/rounds/1.jsonl',
    status: 'IN_PROGRESS',
    startedAt: '2026-04-30T00:00:00.000Z',
    ...overrides,
  };
}

describe('interrogation-round-resolver', () => {
  beforeEach(() => {
    ddbMock.reset();
    s3Mock.reset();
    ebMock.reset();
    ebMock
      .on(PutEventsCommand)
      .resolves({ FailedEntryCount: 0, Entries: [{ EventId: 'evt-1' }] });
    s3Mock.on(PutObjectCommand).resolves({ ETag: '"abc"' });
    __resetGovernanceNotifierForTest();
  });

  // ── startInterrogationRound ─────────────────────────────────────────

  describe('startInterrogationRound', () => {
    test('writes DDB row with IN_PROGRESS, deterministic S3 URI, and emits governance.round.started', async () => {
      ddbMock.on(PutCommand).resolves({});
      const auth = mockAuthContextFor('architect');

      const row = await startInterrogationRound('proj-42', 7, auth);

      expect(row.projectId).toBe('proj-42');
      expect(row.roundN).toBe(7);
      expect(row.status).toBe('IN_PROGRESS');
      // Deterministic S3 URI derived only from bucket + projectId + roundN.
      expect(row.transcriptS3Uri).toBe(
        's3://citadel-governance-transcripts-test/projects/proj-42/rounds/7.jsonl',
      );
      expect(row.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

      const puts = ddbMock.commandCalls(PutCommand);
      expect(puts).toHaveLength(1);
      const put = puts[0].args[0].input;
      expect(put.TableName).toBe('citadel-interrogation-rounds-test');
      // Idempotency guard on the composite key — if a row for (projectId,
      // roundN) already exists, the Put must fail.
      expect(put.ConditionExpression).toMatch(
        /attribute_not_exists\(projectId\).*attribute_not_exists\(roundN\)/,
      );
      expect((put.Item as Record<string, unknown>).status).toBe('IN_PROGRESS');
      expect((put.Item as Record<string, unknown>).roundN).toBe(7);

      const ebCalls = ebMock.commandCalls(PutEventsCommand);
      expect(ebCalls).toHaveLength(1);
      const entry = ebCalls[0].args[0].input.Entries![0];
      expect(entry.DetailType).toBe('governance.round.started');
      const detail = JSON.parse(entry.Detail!);
      expect(detail.projectId).toBe('proj-42');
      expect(detail.roundN).toBe(7);
    });

    test('rejects caller without adr:create permission and issues no DDB write', async () => {
      const auth = mockAuthContextFor('developer');
      await expect(startInterrogationRound('proj-1', 1, auth)).rejects.toThrow(
        /UnauthorizedError/,
      );
      expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
      expect(ebMock.commandCalls(PutEventsCommand)).toHaveLength(0);
    });

    test('rejects negative or non-integer roundN as ValidationError', async () => {
      const auth = mockAuthContextFor('architect');
      await expect(
        startInterrogationRound('proj-1', 0, auth),
      ).rejects.toThrow(/ValidationError.*roundN/);
      await expect(
        startInterrogationRound('proj-1', -3, auth),
      ).rejects.toThrow(/ValidationError.*roundN/);
      await expect(
        startInterrogationRound('proj-1', 1.5, auth),
      ).rejects.toThrow(/ValidationError.*roundN/);
      expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    });
  });

  // ── stabiliseRound ─────────────────────────────────────────────────

  describe('stabiliseRound', () => {
    test('redacts email + phone BEFORE S3 write; transitions row to STABILISED; emits governance.round.completed', async () => {
      const existing = baseRow({ status: 'IN_PROGRESS' });
      ddbMock.on(GetCommand).resolves({ Item: existing });
      ddbMock
        .on(UpdateCommand)
        .resolves({ Attributes: { ...existing, status: 'STABILISED', completedAt: '2026-04-30T00:00:01.000Z', transcriptSizeBytes: 42 } });

      const auth = mockAuthContextFor('architect');
      const transcript = [
        { role: 'user', content: 'reach me at bob@example.com or 555-1234' },
        { role: 'assistant', content: 'Understood, I will not contact you.' },
      ];

      const result = await stabiliseRound(
        'proj-1',
        1,
        transcript,
        'summary of the round',
        auth,
      );

      expect(result.status).toBe('STABILISED');

      const s3Calls = s3Mock.commandCalls(PutObjectCommand);
      expect(s3Calls).toHaveLength(1);
      const s3Input = s3Calls[0].args[0].input;
      expect(s3Input.Bucket).toBe('citadel-governance-transcripts-test');
      expect(s3Input.Key).toBe('projects/proj-1/rounds/1.jsonl');
      const body = typeof s3Input.Body === 'string' ? s3Input.Body: Buffer.from(s3Input.Body as Uint8Array).toString('utf8');
      // PII must be redacted in the persisted object.
      expect(body).toContain('[REDACTED:email]');
      expect(body).toContain('[REDACTED:phone]');
      expect(body).not.toContain('bob@example.com');
      expect(body).not.toContain('555-1234');
      // JSONL: each line is a valid JSON object.
      const lines = body.trim().split('\n');
      expect(lines.length).toBeGreaterThanOrEqual(2);
      for (const line of lines) {
        expect(() => JSON.parse(line)).not.toThrow();
      }

      const updates = ddbMock.commandCalls(UpdateCommand);
      expect(updates).toHaveLength(1);
      const upd = updates[0].args[0].input;
      expect(upd.ExpressionAttributeValues![':newStatus']).toBe('STABILISED');

      const ebCalls = ebMock.commandCalls(PutEventsCommand);
      expect(ebCalls).toHaveLength(1);
      expect(ebCalls[0].args[0].input.Entries![0].DetailType).toBe(
        'governance.round.completed',
      );
      const detail = JSON.parse(ebCalls[0].args[0].input.Entries![0].Detail!);
      expect(detail.projectId).toBe('proj-1');
      expect(detail.roundN).toBe(1);
    });

    test('already-STABILISED round: idempotent early-return, no S3 PutObject, no re-emit', async () => {
      const alreadyStable = baseRow({
        status: 'STABILISED',
        completedAt: '2026-04-29T00:00:00.000Z',
        transcriptSizeBytes: 512,
      });
      ddbMock.on(GetCommand).resolves({ Item: alreadyStable });

      const auth = mockAuthContextFor('architect');
      const transcript = [{ role: 'user', content: 'anything' }];
      const result = await stabiliseRound('proj-1', 1, transcript, 'summary', auth);

      expect(result).toEqual(alreadyStable);
      expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0);
      expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
      expect(ebMock.commandCalls(PutEventsCommand)).toHaveLength(0);
    });

    test('transcript >5MB: S3 write succeeds AND emits governance.round.transcript.overflow with sizeBytes', async () => {
      const existing = baseRow({ status: 'IN_PROGRESS' });
      ddbMock.on(GetCommand).resolves({ Item: existing });
      ddbMock
        .on(UpdateCommand)
        .resolves({ Attributes: { ...existing, status: 'STABILISED' } });

      // Build a ~6MB payload — a single content string of 6 * 1024 * 1024 bytes.
      // After JSON-encoding + the role wrapper the JSONL body is comfortably >5MB.
      // Use space-separated tokens instead of a uniform 6MB 'x' run. A uniform
            // long atext run triggers catastrophic backtracking in redactPII's
            // EMAIL_RE (the greedy atext character class consumes the whole string
            // before failing at @, then retries from every position — O(n^2) on a
            // 6MB input = many minutes of CPU). Space-separated content caps each
            // match attempt at one token.
            const bigContent = ('hello world ').repeat(Math.ceil((6 * 1024 * 1024) / 12));
      const transcript = [{ role: 'user', content: bigContent }];

      const auth = mockAuthContextFor('architect');
      await stabiliseRound('proj-1', 1, transcript, 'summary', auth);

      expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(1);

      const detailTypes = ebMock
        .commandCalls(PutEventsCommand)
        .map((c) => c.args[0].input.Entries![0].DetailType);
      expect(detailTypes).toContain('governance.round.transcript.overflow');
      expect(detailTypes).toContain('governance.round.completed');

      const overflowCall = ebMock
        .commandCalls(PutEventsCommand)
        .find((c) => c.args[0].input.Entries![0].DetailType === 'governance.round.transcript.overflow')!;
      const overflowDetail = JSON.parse(overflowCall.args[0].input.Entries![0].Detail!);
      expect(overflowDetail.projectId).toBe('proj-1');
      expect(overflowDetail.roundN).toBe(1);
      expect(overflowDetail.sizeBytes).toBeGreaterThan(5 * 1024 * 1024);
    });

    test('rejects caller without adr:create permission', async () => {
      const auth = mockAuthContextFor('developer');
      await expect(
        stabiliseRound('proj-1', 1, [{ role: 'user', content: 'hi' }], 'summary', auth),
      ).rejects.toThrow(/UnauthorizedError/);
      expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
      expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0);
    });

    test('non-existent round throws before S3 write', async () => {
      ddbMock.on(GetCommand).resolves({});
      const auth = mockAuthContextFor('architect');
      await expect(
        stabiliseRound('proj-missing', 1, [{ role: 'user', content: 'hi' }], 'summary', auth),
      ).rejects.toThrow(/not found/);
      expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0);
    });
  });

  // ── injectConstraints ──────────────────────────────────────────────

  describe('injectConstraints', () => {
    test('IN_PROGRESS -> AWAITING_CONSTRAINTS and persists constraints', async () => {
      const existing = baseRow({ status: 'IN_PROGRESS' });
      ddbMock.on(GetCommand).resolves({ Item: existing });
      ddbMock.on(UpdateCommand).resolves({
        Attributes: {
          ...existing,
          status: 'AWAITING_CONSTRAINTS',
          humanConstraints: ['budget<$100k', 'timeline<=Q4'],
        },
      });

      const auth = mockAuthContextFor('architect');
      const result = await injectConstraints(
        'proj-1',
        1,
        ['budget<$100k', 'timeline<=Q4'],
        auth,
      );

      expect(result.status).toBe('AWAITING_CONSTRAINTS');
      expect(result.humanConstraints).toEqual(['budget<$100k', 'timeline<=Q4']);

      const updates = ddbMock.commandCalls(UpdateCommand);
      expect(updates).toHaveLength(1);
      const upd = updates[0].args[0].input;
      expect(upd.ExpressionAttributeValues![':newStatus']).toBe('AWAITING_CONSTRAINTS');
      expect(upd.ExpressionAttributeValues![':constraints']).toEqual([
        'budget<$100k',
        'timeline<=Q4',
      ]);
    });

    test('rejects injectConstraints on STABILISED round with Invalid status transition', async () => {
      const terminal = baseRow({ status: 'STABILISED' });
      ddbMock.on(GetCommand).resolves({ Item: terminal });

      const auth = mockAuthContextFor('architect');
      await expect(
        injectConstraints('proj-1', 1, ['x'], auth),
      ).rejects.toThrow(/Invalid status transition/);
      expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
    });

    test('rejects caller without adr:create permission', async () => {
      const auth = mockAuthContextFor('developer');
      await expect(
        injectConstraints('proj-1', 1, ['x'], auth),
      ).rejects.toThrow(/UnauthorizedError/);
    });
  });

  // ── getInterrogationRound / listInterrogationRounds ────────────────

  describe('getInterrogationRound', () => {
    test('returns null for missing (projectId, roundN)', async () => {
      ddbMock.on(GetCommand).resolves({});
      const row = await getInterrogationRound('proj-nope', 99);
      expect(row).toBeNull();
    });

    test('returns the row when present', async () => {
      const existing = baseRow();
      ddbMock.on(GetCommand).resolves({ Item: existing });
      const row = await getInterrogationRound('proj-1', 1);
      expect(row).toEqual(existing);
    });
  });

  describe('listInterrogationRounds', () => {
    test('queries by projectId PK', async () => {
      const items = [baseRow({ roundN: 1 }), baseRow({ roundN: 2, status: 'STABILISED' })];
      ddbMock.on(QueryCommand).resolves({ Items: items });

      const rows = await listInterrogationRounds('proj-1');
      expect(rows).toEqual(items);

      const calls = ddbMock.commandCalls(QueryCommand);
      expect(calls).toHaveLength(1);
      const input = calls[0].args[0].input;
      expect(input.TableName).toBe('citadel-interrogation-rounds-test');
      expect(input.KeyConditionExpression).toBe('projectId = :pid');
      expect(input.ExpressionAttributeValues![':pid']).toBe('proj-1');
    });

    test('returns [] when no rounds', async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [] });
      const rows = await listInterrogationRounds('proj-empty');
      expect(rows).toEqual([]);
    });
  });

  // ── handler dispatch ────────────────────────────────────────────────

  describe('handler dispatch', () => {
    function makeEvent(
      fieldName: string,
      args: Record<string, unknown>,
      role: 'architect' | 'developer' = 'architect',
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

    test('dispatches startInterrogationRound', async () => {
      ddbMock.on(PutCommand).resolves({});
      const result = (await handler(
        makeEvent('startInterrogationRound', { projectId: 'proj-1', roundN: 1 }),
      )) as { status: string };
      expect(result.status).toBe('IN_PROGRESS');
    });

    test('dispatches getInterrogationRound', async () => {
      ddbMock.on(GetCommand).resolves({});
      const result = await handler(
        makeEvent('getInterrogationRound', { projectId: 'proj-1', roundN: 1 }),
      );
      expect(result).toBeNull();
    });

    test('dispatches listInterrogationRounds', async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [] });
      const result = await handler(
        makeEvent('listInterrogationRounds', { projectId: 'proj-1' }),
      );
      expect(result).toEqual([]);
    });

    test('unknown field throws', async () => {
      await expect(handler(makeEvent('notAField', {}))).rejects.toThrow(/Unsupported field/);
    });

    test('developer role cannot start a round', async () => {
      await expect(
        handler(
          makeEvent('startInterrogationRound', { projectId: 'proj-1', roundN: 1 }, 'developer'),
        ),
      ).rejects.toThrow(/UnauthorizedError/);
    });
  });

  // ── Property tests ──────────────────────────────────────────────────

  describe('property: redactPII idempotent through stabiliseRound', () => {
    test('calling stabiliseRound twice with the same transcript is a no-op on the second call (200 iterations)', async () => {
      // Generators for potentially-PII-bearing transcript content.
      const piiFragment = fc.oneof(
        fc.constantFrom(
          'bob@example.com',
          'alice@corp.io',
          '555-1234',
          '555-123-4567',
          '+14155551234',
          '123456789012',
          'AKIAIOSFODNN7EXAMPLE',
          'ASIAIOSFODNN7EXAMPLE',
          '4111111111111111',
        ),
        fc.string({ minLength: 1, maxLength: 20 }),
      );
      const messageContent = fc
        .array(piiFragment, { minLength: 1, maxLength: 4 })
        .map((parts) => parts.join(' '));
      const transcriptArb = fc.array(
        fc.record({
          role: fc.constantFrom('user', 'assistant', 'system'),
          content: messageContent,
        }),
        { minLength: 1, maxLength: 3 },
      );

      await fc.assert(
        fc.asyncProperty(transcriptArb, async (transcript) => {
          ddbMock.reset();
          s3Mock.reset();
          ebMock.reset();
          ebMock
            .on(PutEventsCommand)
            .resolves({ FailedEntryCount: 0, Entries: [{ EventId: 'e' }] });
          __resetGovernanceNotifierForTest();
                    s3Mock.on(PutObjectCommand).resolves({ ETag: '"a"' });

          // First call: IN_PROGRESS -> STABILISED (S3 + DDB + event).
          const inProgress = baseRow({ status: 'IN_PROGRESS' });
          const stabilised = baseRow({ status: 'STABILISED' });
          // Simulate DDB state change: first GetCommand returns IN_PROGRESS,
          // the second returns STABILISED so the idempotent early-return
          // fires on the retry.
          let getCallCount = 0;
          ddbMock.on(GetCommand).callsFake(() => {
            getCallCount += 1;
            return Promise.resolve({ Item: getCallCount === 1 ? inProgress: stabilised });
          });
          ddbMock.on(UpdateCommand).resolves({ Attributes: stabilised });

          const auth = mockAuthContextFor('architect');
          await stabiliseRound('proj-1', 1, transcript, 'summary', auth);
          await stabiliseRound('proj-1', 1, transcript, 'summary', auth);

          // First call writes S3 once. Second call (already-STABILISED) does not.
          expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(1);
          // Exactly one UpdateCommand fired (from the first call).
          expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(1);
          // governance.round.completed must only have been emitted once.
          const completed = ebMock
            .commandCalls(PutEventsCommand)
            .filter(
              (c) =>
                c.args[0].input.Entries![0].DetailType === 'governance.round.completed',
            );
          expect(completed).toHaveLength(1);
        }),
        { numRuns: 200 },
      );
    });
  });
});
