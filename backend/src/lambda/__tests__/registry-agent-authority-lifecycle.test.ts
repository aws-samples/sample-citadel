/**
 * US-ARB-014 — Per-app fabricator authority unit lifecycle helpers
 *
 * Tests for the 3 exported helpers in ../registry-agent-authority-lifecycle.ts:
 *   - getAuthorityUnitsTable()
 *   - grantFabricatorAuthority(appId)
 *   - revokeFabricatorAuthority(appId)
 *
 * PR 6a relocated this test from `agent-app-authority-lifecycle.test.ts` to
 * mirror the source rename `agent-app-authority-lifecycle.ts` →
 * `registry-agent-authority-lifecycle.ts`. Test bodies are unchanged.
 *
 * The authority module does NOT export a top-level entrypoint — only the 3
 * helpers below. All assertions adapted to the source's EXACT literals (see
 * source file backend/src/lambda/registry-agent-authority-lifecycle.ts for
 * the canonical UpdateExpression and ExpressionAttributeValues keys —
 * :true / :false / :now — NOT the generic :isTrue / :isFalse placeholders).
 */
import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBDocumentClient,
  PutCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  getAuthorityUnitsTable,
  grantFabricatorAuthority,
  revokeFabricatorAuthority,
} from '../registry-agent-authority-lifecycle';

const ddbMock = mockClient(DynamoDBDocumentClient);

describe('registry-agent-authority-lifecycle (PR 6a)', () => {
  beforeEach(() => {
    ddbMock.reset();
    process.env.AUTHORITY_UNITS_TABLE = 'test-authority-units';
  });

  afterEach(() => {
    delete process.env.AUTHORITY_UNITS_TABLE;
  });

  describe('getAuthorityUnitsTable', () => {
    test('returns undefined when AUTHORITY_UNITS_TABLE env var is unset', () => {
      delete process.env.AUTHORITY_UNITS_TABLE;
      expect(getAuthorityUnitsTable()).toBeUndefined();
    });

    test('returns the env value when set', () => {
      expect(getAuthorityUnitsTable()).toBe('test-authority-units');
    });
  });

  describe('grantFabricatorAuthority', () => {
    test('writes a PutCommand with registryId column (Decision #9)', async () => {
      ddbMock.on(PutCommand).resolves({});

      await grantFabricatorAuthority('test-app-id');

      const calls = ddbMock.commandCalls(PutCommand);
      expect(calls).toHaveLength(1);
      const input = calls[0].args[0].input as any;
      expect(input.TableName).toBe('test-authority-units');
      expect(input.Item.unitId).toBe('fabricator-test-app-id-create-agents');
      expect(input.Item.registryId).toBe('test-app-id');
      // Decision #9: column is `registryId`, never `appId`
      expect(input.Item.appId).toBeUndefined();
      expect(input.ConditionExpression).toBe('attribute_not_exists(unitId)');
    });

    test('swallows ConditionalCheckFailedException (idempotent on duplicate)', async () => {
      const err: any = new Error('Conditional check failed');
      err.name = 'ConditionalCheckFailedException';
      ddbMock.on(PutCommand).rejects(err);

      await expect(grantFabricatorAuthority('existing-app')).resolves.toBeUndefined();
    });

    test('graceful no-op when AUTHORITY_UNITS_TABLE env var is unset', async () => {
      delete process.env.AUTHORITY_UNITS_TABLE;

      await grantFabricatorAuthority('any-app');

      expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    });
  });

  describe('revokeFabricatorAuthority', () => {
    test('writes an UpdateCommand setting revoked=true with exists+not-revoked condition', async () => {
      ddbMock.on(UpdateCommand).resolves({});

      await revokeFabricatorAuthority('target-app');

      const calls = ddbMock.commandCalls(UpdateCommand);
      expect(calls).toHaveLength(1);
      const input = calls[0].args[0].input as any;
      expect(input.TableName).toBe('test-authority-units');
      expect(input.Key.unitId).toBe('fabricator-target-app-create-agents');
      expect(input.ConditionExpression).toContain('attribute_exists(unitId)');
      // Source uses `:false` (not `:isFalse`) as the placeholder name
      expect(input.ConditionExpression).toContain('revoked = :false');
      expect(input.ExpressionAttributeValues?.[':true']).toBe(true);
      expect(input.ExpressionAttributeValues?.[':false']).toBe(false);
    });

    test('swallows ConditionalCheckFailedException on already-revoked row', async () => {
      const err: any = new Error('Conditional check failed');
      err.name = 'ConditionalCheckFailedException';
      ddbMock.on(UpdateCommand).rejects(err);

      await expect(revokeFabricatorAuthority('x')).resolves.toBeUndefined();
    });

    test('graceful no-op when AUTHORITY_UNITS_TABLE env var is unset', async () => {
      delete process.env.AUTHORITY_UNITS_TABLE;

      await revokeFabricatorAuthority('any');

      expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
    });
  });
});
