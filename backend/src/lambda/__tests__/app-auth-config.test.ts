/**
 * Unit tests for auth config management.
 *
 * Validates: Requirements 3.1, 3.5, 3.6, 3.7
 */
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';

import { setAppAuthConfig, validateAuthConfig } from '../app-auth-config';

// ── Mocks ───────────────────────────────────────────────────

const ddbMock = mockClient(DynamoDBDocumentClient);

// ── Helpers ─────────────────────────────────────────────────

const TEST_APP_ID = 'app-auth-001';

function makeDeps() {
  return {
    docClient: DynamoDBDocumentClient.from(new DynamoDBClient({})),
    appsTable: 'citadel-apps-test',
  };
}

// ── Setup / Teardown ────────────────────────────────────────

beforeEach(() => {
  ddbMock.reset();
  ddbMock.on(PutCommand).resolves({});
});

// ── validateAuthConfig Tests ────────────────────────────────

describe('validateAuthConfig', () => {
  test('accepts API_KEY mode with no additional fields', () => {
    const errors = validateAuthConfig({ mode: 'API_KEY' });
    expect(errors).toEqual([]);
  });

  test('accepts OAUTH2 mode with issuerUrl and audience', () => {
    const errors = validateAuthConfig({
      mode: 'OAUTH2',
      issuerUrl: 'https://auth.example.com',
      audience: 'https://api.example.com',
    });
    expect(errors).toEqual([]);
  });

  test('rejects invalid mode values', () => {
    const errors = validateAuthConfig({ mode: 'BASIC' });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('Invalid auth mode');
  });

  test('rejects empty mode', () => {
    const errors = validateAuthConfig({ mode: '' });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('Invalid auth mode');
  });

  test('rejects OAUTH2 mode without issuerUrl', () => {
    const errors = validateAuthConfig({
      mode: 'OAUTH2',
      audience: 'https://api.example.com',
    });
    expect(errors).toContainEqual(expect.stringContaining('issuerUrl'));
  });

  test('rejects OAUTH2 mode without audience', () => {
    const errors = validateAuthConfig({
      mode: 'OAUTH2',
      issuerUrl: 'https://auth.example.com',
    });
    expect(errors).toContainEqual(expect.stringContaining('audience'));
  });

  test('rejects OAUTH2 mode missing both issuerUrl and audience', () => {
    const errors = validateAuthConfig({ mode: 'OAUTH2' });
    expect(errors.length).toBe(2);
    expect(errors).toContainEqual(expect.stringContaining('issuerUrl'));
    expect(errors).toContainEqual(expect.stringContaining('audience'));
  });

  test('rejects case-insensitive variants like api_key', () => {
    const errors = validateAuthConfig({ mode: 'api_key' });
    expect(errors.length).toBeGreaterThan(0);
  });
});

// ── setAppAuthConfig Tests ──────────────────────────────────

describe('setAppAuthConfig', () => {
  test('stores API_KEY config as CONFIG#auth component item', async () => {
    const result = await setAppAuthConfig(
      TEST_APP_ID,
      { mode: 'API_KEY' },
      makeDeps(),
    );

    expect(result.mode).toBe('API_KEY');
    expect(result.sortId).toBe('CONFIG#auth');

    const putCalls = ddbMock.commandCalls(PutCommand);
    expect(putCalls).toHaveLength(1);
    const storedItem = putCalls[0].args[0].input.Item!;
    expect(storedItem.sortId).toBe('CONFIG#auth');
    expect(storedItem.groupId).toBe(`APP#${TEST_APP_ID}`);
    expect(storedItem.mode).toBe('API_KEY');
  });

  test('stores OAUTH2 config with issuerUrl and audience', async () => {
    const result = await setAppAuthConfig(
      TEST_APP_ID,
      {
        mode: 'OAUTH2',
        issuerUrl: 'https://auth.example.com',
        audience: 'https://api.example.com',
      },
      makeDeps(),
    );

    expect(result.mode).toBe('OAUTH2');
    expect(result.issuerUrl).toBe('https://auth.example.com');
    expect(result.audience).toBe('https://api.example.com');

    const putCalls = ddbMock.commandCalls(PutCommand);
    const storedItem = putCalls[0].args[0].input.Item!;
    expect(storedItem.issuerUrl).toBe('https://auth.example.com');
    expect(storedItem.audience).toBe('https://api.example.com');
  });

  test('throws error for invalid mode', async () => {
    await expect(
      setAppAuthConfig(TEST_APP_ID, { mode: 'BASIC' }, makeDeps()),
    ).rejects.toThrow(/Invalid auth mode/);

    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  test('throws error for OAUTH2 without required fields', async () => {
    await expect(
      setAppAuthConfig(TEST_APP_ID, { mode: 'OAUTH2' }, makeDeps()),
    ).rejects.toThrow(/issuerUrl/);

    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  test('uses correct composite key for DynamoDB item', async () => {
    await setAppAuthConfig(TEST_APP_ID, { mode: 'API_KEY' }, makeDeps());

    const putCalls = ddbMock.commandCalls(PutCommand);
    const storedItem = putCalls[0].args[0].input.Item!;
    expect(storedItem.appId).toBe(`${TEST_APP_ID}#CONFIG#auth`);
    expect(storedItem.groupId).toBe(`APP#${TEST_APP_ID}`);
  });

  test('includes updatedAt timestamp', async () => {
    const before = new Date().toISOString();
    await setAppAuthConfig(TEST_APP_ID, { mode: 'API_KEY' }, makeDeps());
    const after = new Date().toISOString();

    const putCalls = ddbMock.commandCalls(PutCommand);
    const storedItem = putCalls[0].args[0].input.Item!;
    expect(storedItem.updatedAt).toBeDefined();
    expect(storedItem.updatedAt >= before).toBe(true);
    expect(storedItem.updatedAt <= after).toBe(true);
  });

  test('API_KEY config does not include issuerUrl or audience', async () => {
    await setAppAuthConfig(TEST_APP_ID, { mode: 'API_KEY' }, makeDeps());

    const putCalls = ddbMock.commandCalls(PutCommand);
    const storedItem = putCalls[0].args[0].input.Item!;
    expect(storedItem.issuerUrl).toBeUndefined();
    expect(storedItem.audience).toBeUndefined();
  });
});
