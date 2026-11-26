/**
 * Property-based tests for API Gateway naming convention (Task 4.5)
 *
 * Property 5: API Gateway naming convention
 * **Validates: Requirements 2.1, 2.7**
 *
 * For any appId and environment string, the derived API name follows
 * `citadel-app-{appId}-{env}` and endpoint URL follows
 * `https://{apiId}.execute-api.{region}.amazonaws.com`
 */
import * as fc from 'fast-check';
import { deriveApiGatewayName, deriveEndpointUrl } from '../app-publish-handler';

// ── Generators ──────────────────────────────────────────────

/** Generate a valid appId (alphanumeric + hyphens, non-empty) */
const appIdArb = fc.string({ minLength: 1, maxLength: 40 })
  .filter(s => /^[a-zA-Z0-9_-]+$/.test(s));

/** Generate a valid environment string */
const envArb = fc.constantFrom('dev', 'staging', 'prod', 'test', 'qa');

/** Generate a valid API Gateway ID (alphanumeric, 10 chars typical) */
const apiIdArb = fc.string({ minLength: 1, maxLength: 20 })
  .filter(s => /^[a-zA-Z0-9]+$/.test(s));

/** Generate a valid AWS region */
const regionArb = fc.constantFrom(
  'us-east-1', 'us-west-2', 'eu-west-1', 'ap-southeast-1', 'ap-northeast-1',
);

// ── Property 5 Tests ────────────────────────────────────────

describe('Property 5: API Gateway naming convention', () => {

  /**
   * **Validates: Requirements 2.1**
   *
   * For any appId and environment, the API name follows citadel-app-{appId}-{env}.
   */
  it('API name follows citadel-app-{appId}-{env} pattern for all valid inputs', () => {
    fc.assert(
      fc.property(appIdArb, envArb, (appId, env) => {
        const name = deriveApiGatewayName(appId, env);

        // Must match exact pattern
        expect(name).toBe(`citadel-app-${appId}-${env}`);

        // Must start with citadel-app-
        expect(name.startsWith('citadel-app-')).toBe(true);

        // Must end with the environment
        expect(name.endsWith(`-${env}`)).toBe(true);

        // Must contain the appId
        expect(name).toContain(appId);
      }),
      { numRuns: 200 },
    );
  });

  /**
   * **Validates: Requirements 2.7**
   *
   * For any apiId and region, the endpoint URL follows
   * https://{apiId}.execute-api.{region}.amazonaws.com
   */
  it('endpoint URL follows https://{apiId}.execute-api.{region}.amazonaws.com pattern', () => {
    fc.assert(
      fc.property(apiIdArb, regionArb, (apiId, region) => {
        const url = deriveEndpointUrl(apiId, region);

        // Must match exact pattern
        expect(url).toBe(`https://${apiId}.execute-api.${region}.amazonaws.com`);

        // Must be a valid HTTPS URL
        expect(url.startsWith('https://')).toBe(true);

        // Must contain execute-api
        expect(url).toContain('.execute-api.');

        // Must end with amazonaws.com
        expect(url.endsWith('.amazonaws.com')).toBe(true);

        // Must contain the region
        expect(url).toContain(region);

        // Must contain the apiId
        expect(url).toContain(apiId);
      }),
      { numRuns: 200 },
    );
  });

  /**
   * **Validates: Requirements 2.1**
   *
   * API names are deterministic — same inputs always produce same output.
   */
  it('API name derivation is deterministic', () => {
    fc.assert(
      fc.property(appIdArb, envArb, (appId, env) => {
        const name1 = deriveApiGatewayName(appId, env);
        const name2 = deriveApiGatewayName(appId, env);
        expect(name1).toBe(name2);
      }),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 2.7**
   *
   * Endpoint URL derivation is deterministic.
   */
  it('endpoint URL derivation is deterministic', () => {
    fc.assert(
      fc.property(apiIdArb, regionArb, (apiId, region) => {
        const url1 = deriveEndpointUrl(apiId, region);
        const url2 = deriveEndpointUrl(apiId, region);
        expect(url1).toBe(url2);
      }),
      { numRuns: 100 },
    );
  });
});
