/**
 * Property-based tests for auth config validation and storage (Property 8)
 *
 * **Validates: Requirements 3.1, 3.6**
 *
 * For any auth config object, the setAppAuthConfig handler should accept
 * configs with mode API_KEY or OAUTH2 and reject any other mode value.
 * Valid configs should be stored with sortId = CONFIG#auth under the app's
 * groupId. OAuth2 configs must include issuerUrl and audience fields.
 */
import * as fc from 'fast-check';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';

import { setAppAuthConfig, validateAuthConfig } from '../app-auth-config';

// ── Mocks ───────────────────────────────────────────────────

const ddbMock = mockClient(DynamoDBDocumentClient);

function makeDeps() {
  return {
    docClient: DynamoDBDocumentClient.from(new DynamoDBClient({})),
    appsTable: 'citadel-apps-pbt',
  };
}

// ── Generators ──────────────────────────────────────────────

/** Arbitrary app ID */
const appIdArb = fc.stringMatching(/^[a-zA-Z0-9_-]{3,30}$/);

/** Valid URL for OAuth2 issuer */
const urlArb = fc.webUrl({ withFragments: false, withQueryParameters: false });

/** Arbitrary invalid mode (not API_KEY or OAUTH2) */
const invalidModeArb = fc.string({ minLength: 1, maxLength: 30 })
  .filter(s => s !== 'API_KEY' && s !== 'OAUTH2' && s.trim().length > 0);

// ── Property 8 Tests ────────────────────────────────────────

describe('Property 8: Auth config validation and storage', () => {

  beforeEach(() => {
    ddbMock.reset();
    ddbMock.on(PutCommand).resolves({});
  });

  /**
   * **Validates: Requirements 3.1**
   *
   * For any app ID, API_KEY mode is always accepted and stored
   * with sortId = CONFIG#auth.
   */
  it('accepts API_KEY mode and stores with sortId CONFIG#auth', async () => {
    await fc.assert(
      fc.asyncProperty(
        appIdArb,
        async (appId) => {
          ddbMock.reset();
          ddbMock.on(PutCommand).resolves({});

          const result = await setAppAuthConfig(
            appId,
            { mode: 'API_KEY' },
            makeDeps(),
          );

          expect(result.mode).toBe('API_KEY');
          expect(result.sortId).toBe('CONFIG#auth');

          const putCalls = ddbMock.commandCalls(PutCommand);
          expect(putCalls).toHaveLength(1);
          const item = putCalls[0].args[0].input.Item!;
          expect(item.sortId).toBe('CONFIG#auth');
          expect(item.groupId).toBe(`APP#${appId}`);
          expect(item.mode).toBe('API_KEY');
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 3.1, 3.6**
   *
   * For any app ID and valid OAuth2 config (with issuerUrl and audience),
   * OAUTH2 mode is accepted and stored with sortId = CONFIG#auth.
   */
  it('accepts OAUTH2 mode with issuerUrl and audience, stores with sortId CONFIG#auth', async () => {
    await fc.assert(
      fc.asyncProperty(
        appIdArb,
        urlArb,
        urlArb,
        async (appId, issuerUrl, audience) => {
          ddbMock.reset();
          ddbMock.on(PutCommand).resolves({});

          const result = await setAppAuthConfig(
            appId,
            { mode: 'OAUTH2', issuerUrl, audience },
            makeDeps(),
          );

          expect(result.mode).toBe('OAUTH2');
          expect(result.sortId).toBe('CONFIG#auth');
          expect(result.issuerUrl).toBe(issuerUrl);
          expect(result.audience).toBe(audience);

          const putCalls = ddbMock.commandCalls(PutCommand);
          const item = putCalls[0].args[0].input.Item!;
          expect(item.sortId).toBe('CONFIG#auth');
          expect(item.groupId).toBe(`APP#${appId}`);
          expect(item.mode).toBe('OAUTH2');
          expect(item.issuerUrl).toBe(issuerUrl);
          expect(item.audience).toBe(audience);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 3.1**
   *
   * For any invalid mode string (not API_KEY or OAUTH2), the handler
   * rejects the config and does not store anything.
   */
  it('rejects any mode that is not API_KEY or OAUTH2', async () => {
    await fc.assert(
      fc.asyncProperty(
        appIdArb,
        invalidModeArb,
        async (appId, invalidMode) => {
          ddbMock.reset();
          ddbMock.on(PutCommand).resolves({});

          const errors = validateAuthConfig({ mode: invalidMode });
          expect(errors.length).toBeGreaterThan(0);

          await expect(
            setAppAuthConfig(appId, { mode: invalidMode }, makeDeps()),
          ).rejects.toThrow(/Invalid auth mode/);

          expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 3.6**
   *
   * For any OAUTH2 config missing issuerUrl, the handler rejects it.
   */
  it('rejects OAUTH2 mode without issuerUrl', async () => {
    await fc.assert(
      fc.asyncProperty(
        appIdArb,
        urlArb,
        async (appId, audience) => {
          ddbMock.reset();
          ddbMock.on(PutCommand).resolves({});

          const errors = validateAuthConfig({ mode: 'OAUTH2', audience });
          expect(errors).toContainEqual(expect.stringContaining('issuerUrl'));

          await expect(
            setAppAuthConfig(appId, { mode: 'OAUTH2', audience }, makeDeps()),
          ).rejects.toThrow(/issuerUrl/);

          expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 3.6**
   *
   * For any OAUTH2 config missing audience, the handler rejects it.
   */
  it('rejects OAUTH2 mode without audience', async () => {
    await fc.assert(
      fc.asyncProperty(
        appIdArb,
        urlArb,
        async (appId, issuerUrl) => {
          ddbMock.reset();
          ddbMock.on(PutCommand).resolves({});

          const errors = validateAuthConfig({ mode: 'OAUTH2', issuerUrl });
          expect(errors).toContainEqual(expect.stringContaining('audience'));

          await expect(
            setAppAuthConfig(appId, { mode: 'OAUTH2', issuerUrl }, makeDeps()),
          ).rejects.toThrow(/audience/);

          expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
        },
      ),
      { numRuns: 100 },
    );
  });
});
