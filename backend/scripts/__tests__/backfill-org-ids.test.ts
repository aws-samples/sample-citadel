/**
 * Unit tests for the pure-logic helpers in backfill-org-ids.ts.
 *
 * We test only the decision/derivation helpers — the main loop and the
 * AWS-client call sites are integration-level and out of scope here.
 * AWS clients are mocked only to exercise the helpers' interaction
 * pattern, not the script's end-to-end orchestration.
 */

// Wrap fs.existsSync / fs.readFileSync in jest.fn() so the env-auto-load
// tests can stub them per-case. We can't use jest.spyOn on `fs` directly in
// Node 24+ because the exports are non-configurable, which is why the mock
// is installed at module scope here. Other fs functions delegate to the
// real implementation so unrelated code paths remain untouched.
jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    existsSync: jest.fn(actual.existsSync),
    readFileSync: jest.fn(actual.readFileSync),
  };
});

import * as fs from 'fs';
import {
  classifyOrgSource,
  deriveOrgId,
  loadEnvFromCdkOutputs,
  loadEnvFromDotenv,
  deriveToolsTable,
  bootstrapEnv,
} from '../backfill-org-ids';

const mockedExistsSync = fs.existsSync as jest.MockedFunction<
  typeof fs.existsSync
>;
const mockedReadFileSync = fs.readFileSync as jest.MockedFunction<
  typeof fs.readFileSync
>;

// The helpers are pure, so the AWS SDK mock is not strictly required. We
// set it up anyway to match the project convention for scripts that
// touch AWS — and to verify the helpers do not accidentally call any
// SDK.
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';

const cognitoMock = mockClient(CognitoIdentityProviderClient);
const ddbMock = mockClient(DynamoDBClient);

describe('classifyOrgSource', () => {
  beforeEach(() => {
    cognitoMock.reset();
    ddbMock.reset();
  });

  it("returns 'skip' when meta.orgId is already set", () => {
    expect(
      classifyOrgSource({ orgId: 'org-123', createdBy: 'alice' }, undefined),
    ).toBe('skip');
  });

  it("treats whitespace-only orgId as empty (not 'skip')", () => {
    // createdBy absent → sentinel path
    expect(classifyOrgSource({ orgId: '   ' }, undefined)).toBe('sentinel');
  });

  it("returns 'sentinel' when createdBy is absent", () => {
    expect(classifyOrgSource({}, undefined)).toBe('sentinel');
  });

  it("returns 'sentinel' when createdBy is empty string", () => {
    expect(classifyOrgSource({ createdBy: '' }, undefined)).toBe('sentinel');
  });

  it("returns 'sentinel' when createdBy is 'fabricator'", () => {
    expect(classifyOrgSource({ createdBy: 'fabricator' }, undefined)).toBe(
      'sentinel',
    );
  });

  it("returns 'sentinel' when createdBy is 'unknown'", () => {
    expect(classifyOrgSource({ createdBy: 'unknown' }, undefined)).toBe(
      'sentinel',
    );
  });

  it("returns 'cognito-lookup' when createdBy is a real user and no lookup provided", () => {
    expect(classifyOrgSource({ createdBy: 'alice@corp' }, undefined)).toBe(
      'cognito-lookup',
    );
    expect(classifyOrgSource({ createdBy: 'alice@corp' }, null)).toBe(
      'cognito-lookup',
    );
  });

  it("returns 'claim-copy' when Cognito lookup yields a non-empty orgId", () => {
    expect(
      classifyOrgSource({ createdBy: 'alice@corp' }, { orgId: 'org-999' }),
    ).toBe('claim-copy');
  });

  it("returns 'sentinel' when Cognito lookup yields null/empty orgId", () => {
    expect(
      classifyOrgSource({ createdBy: 'alice@corp' }, { orgId: null }),
    ).toBe('sentinel');
    expect(
      classifyOrgSource({ createdBy: 'alice@corp' }, { orgId: '' }),
    ).toBe('sentinel');
  });

  it('handles null / undefined meta safely', () => {
    expect(classifyOrgSource(null, undefined)).toBe('sentinel');
    expect(classifyOrgSource(undefined, undefined)).toBe('sentinel');
  });

  it('does not call AWS clients from the helper', async () => {
    classifyOrgSource({ createdBy: 'alice@corp' }, undefined);
    classifyOrgSource(
      { createdBy: 'alice@corp' },
      { orgId: 'org-x' },
    );
    // Helper is pure — no SDK traffic.
    expect(cognitoMock.calls().length).toBe(0);
    expect(ddbMock.calls().length).toBe(0);
  });
});

describe('deriveOrgId', () => {
  it("returns 'system' when createdBy is absent", () => {
    expect(deriveOrgId(undefined, undefined)).toBe('system');
    expect(deriveOrgId(null, undefined)).toBe('system');
    expect(deriveOrgId('', undefined)).toBe('system');
  });

  it("returns 'system' when createdBy is whitespace", () => {
    expect(deriveOrgId('   ', undefined)).toBe('system');
  });

  it("returns 'system' when createdBy is 'fabricator'", () => {
    expect(deriveOrgId('fabricator', undefined)).toBe('system');
    // Even with a Cognito hit, a sentinel creator collapses to 'system'.
    expect(deriveOrgId('fabricator', { orgId: 'org-999' })).toBe('system');
  });

  it("returns 'system' when createdBy is 'unknown'", () => {
    expect(deriveOrgId('unknown', undefined)).toBe('system');
    expect(deriveOrgId('unknown', { orgId: 'org-999' })).toBe('system');
  });

  it('returns the Cognito orgId when createdBy is a real user with a resolved org', () => {
    expect(deriveOrgId('alice@corp', { orgId: 'org-777' })).toBe('org-777');
  });

  it("returns 'system' when createdBy is real but Cognito has no org", () => {
    expect(deriveOrgId('alice@corp', { orgId: null })).toBe('system');
    expect(deriveOrgId('alice@corp', { orgId: '' })).toBe('system');
    expect(deriveOrgId('alice@corp', null)).toBe('system');
    expect(deriveOrgId('alice@corp', undefined)).toBe('system');
  });
});

// ---------------------------------------------------------------------------
// Env auto-load
// ---------------------------------------------------------------------------

describe('env auto-load', () => {
  // Env keys the loaders touch — saved/restored around each test so we don't
  // leak state into other suites running in the same worker.
  const ENV_KEYS = [
    'REGISTRY_ID',
    'USER_POOL_ID',
    'AGENT_CONFIG_TABLE',
    'TOOL_CONFIG_TABLE',
    'AWS_REGION',
    'ENVIRONMENT',
  ];

  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {};
    for (const k of ENV_KEYS) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
    mockedExistsSync.mockReset();
    mockedReadFileSync.mockReset();
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = savedEnv[k];
      }
    }
  });

  // Synthetic cdk-outputs.json mirroring the real shape, including the
  // `ExportsOutputRef*`-prefixed AgentConfigTable key that CDK emits for
  // cross-stack exports. Plain `UserPoolId` and `AgentCoreRegistryId` are
  // also present, exactly as in the live file.
  const SYNTHETIC_OUTPUTS = JSON.stringify({
    'citadel-backend-dev': {
      AgentCoreRegistryId: 'reg-abc-123',
      UserPoolId: 'us-west-2_FAKEPOOL',
      ExportsOutputRefAgentConfigTableE9BDF3BA8308F292: 'citadel-agents-dev',
    },
    'citadel-services-dev': {
      Unrelated: 'ignored',
    },
  });

  describe('loadEnvFromCdkOutputs', () => {
    it('populates REGISTRY_ID, USER_POOL_ID, AGENT_CONFIG_TABLE from cdk-outputs.json', () => {
      mockedExistsSync.mockImplementation(
        (p) => String(p).endsWith('cdk-outputs.json'),
      );
      mockedReadFileSync.mockImplementation((p) => {
        if (String(p).endsWith('cdk-outputs.json')) return SYNTHETIC_OUTPUTS;
        throw new Error(`unexpected read: ${String(p)}`);
      });

      loadEnvFromCdkOutputs();

      expect(process.env.REGISTRY_ID).toBe('reg-abc-123');
      expect(process.env.USER_POOL_ID).toBe('us-west-2_FAKEPOOL');
      // Suffix-match against the ExportsOutputRef* form.
      expect(process.env.AGENT_CONFIG_TABLE).toBe('citadel-agents-dev');
    });

    it('does not overwrite pre-set env vars', () => {
      process.env.REGISTRY_ID = 'pre-existing-registry';
      process.env.USER_POOL_ID = 'pre-existing-pool';
      process.env.AGENT_CONFIG_TABLE = 'pre-existing-table';
      mockedExistsSync.mockImplementation(
        (p) => String(p).endsWith('cdk-outputs.json'),
      );
      mockedReadFileSync.mockImplementation(() => SYNTHETIC_OUTPUTS);

      loadEnvFromCdkOutputs();

      expect(process.env.REGISTRY_ID).toBe('pre-existing-registry');
      expect(process.env.USER_POOL_ID).toBe('pre-existing-pool');
      expect(process.env.AGENT_CONFIG_TABLE).toBe('pre-existing-table');
    });

    it('is a no-op when cdk-outputs.json is missing (no throw)', () => {
      mockedExistsSync.mockReturnValue(false);

      expect(() => loadEnvFromCdkOutputs()).not.toThrow();
      expect(process.env.REGISTRY_ID).toBeUndefined();
      expect(process.env.USER_POOL_ID).toBeUndefined();
      expect(process.env.AGENT_CONFIG_TABLE).toBeUndefined();
      expect(mockedReadFileSync).not.toHaveBeenCalled();
    });

    it('is a no-op when cdk-outputs.json is malformed JSON (no throw)', () => {
      mockedExistsSync.mockImplementation(
        (p) => String(p).endsWith('cdk-outputs.json'),
      );
      mockedReadFileSync.mockImplementation(() => '{ this is not json');

      expect(() => loadEnvFromCdkOutputs()).not.toThrow();
      expect(process.env.REGISTRY_ID).toBeUndefined();
    });

    it('tolerates missing citadel-backend-dev stack key', () => {
      mockedExistsSync.mockImplementation(
        (p) => String(p).endsWith('cdk-outputs.json'),
      );
      mockedReadFileSync.mockImplementation(() =>
        JSON.stringify({ 'some-other-stack': { UserPoolId: 'x' } }),
      );

      expect(() => loadEnvFromCdkOutputs()).not.toThrow();
      expect(process.env.USER_POOL_ID).toBeUndefined();
    });

    it('falls back to UserPoolIdExport when UserPoolId is absent', () => {
      mockedExistsSync.mockImplementation(
        (p) => String(p).endsWith('cdk-outputs.json'),
      );
      mockedReadFileSync.mockImplementation(() =>
        JSON.stringify({
          'citadel-backend-dev': {
            UserPoolIdExport: 'us-west-2_FALLBACK',
            AgentCoreRegistryId: 'r',
          },
        }),
      );

      loadEnvFromCdkOutputs();
      expect(process.env.USER_POOL_ID).toBe('us-west-2_FALLBACK');
    });
  });

  describe('loadEnvFromDotenv', () => {
    const SYNTHETIC_ENV =
      '# comment line\n' +
      'ENVIRONMENT=staging\n' +
      'CDK_DEFAULT_REGION="eu-west-1"\n' +
      "ADMIN_EMAIL='ignored@example.com'\n" +
      '\n' +
      'BLANK_LINE_ABOVE=ok\n';

    it('populates AWS_REGION (from CDK_DEFAULT_REGION) and ENVIRONMENT', () => {
      mockedExistsSync.mockImplementation((p) =>
        String(p).endsWith(`backend/.env`),
      );
      mockedReadFileSync.mockImplementation(() => SYNTHETIC_ENV);

      loadEnvFromDotenv();

      expect(process.env.AWS_REGION).toBe('eu-west-1');
      expect(process.env.ENVIRONMENT).toBe('staging');
    });

    it('does not overwrite pre-set AWS_REGION or ENVIRONMENT', () => {
      process.env.AWS_REGION = 'us-east-1';
      process.env.ENVIRONMENT = 'prod';
      mockedExistsSync.mockImplementation((p) =>
        String(p).endsWith(`backend/.env`),
      );
      mockedReadFileSync.mockImplementation(() => SYNTHETIC_ENV);

      loadEnvFromDotenv();

      expect(process.env.AWS_REGION).toBe('us-east-1');
      expect(process.env.ENVIRONMENT).toBe('prod');
    });

    it('is a no-op when no .env file exists (no throw)', () => {
      mockedExistsSync.mockReturnValue(false);

      expect(() => loadEnvFromDotenv()).not.toThrow();
      expect(process.env.AWS_REGION).toBeUndefined();
      expect(process.env.ENVIRONMENT).toBeUndefined();
    });

    it('swallows readFileSync errors without throwing', () => {
      mockedExistsSync.mockImplementation((p) =>
        String(p).endsWith(`backend/.env`),
      );
      mockedReadFileSync.mockImplementation(() => {
        throw new Error('EACCES');
      });

      expect(() => loadEnvFromDotenv()).not.toThrow();
    });
  });

  describe('deriveToolsTable', () => {
    it('synthesizes citadel-tools-${ENVIRONMENT} when ENVIRONMENT is set', () => {
      process.env.ENVIRONMENT = 'staging';
      deriveToolsTable();
      expect(process.env.TOOL_CONFIG_TABLE).toBe('citadel-tools-staging');
    });

    it('falls back to citadel-tools-dev when ENVIRONMENT is unset', () => {
      deriveToolsTable();
      expect(process.env.TOOL_CONFIG_TABLE).toBe('citadel-tools-dev');
    });

    it('does not overwrite a pre-set TOOL_CONFIG_TABLE', () => {
      process.env.TOOL_CONFIG_TABLE = 'custom-table';
      process.env.ENVIRONMENT = 'staging';
      deriveToolsTable();
      expect(process.env.TOOL_CONFIG_TABLE).toBe('custom-table');
    });
  });

  describe('bootstrapEnv', () => {
    it('runs all three loaders in the order: cdk-outputs → dotenv → tools-table', () => {
      // cdk-outputs sets REGISTRY_ID/USER_POOL_ID/AGENT_CONFIG_TABLE.
      // dotenv sets ENVIRONMENT, which deriveToolsTable then reads to
      // synthesize TOOL_CONFIG_TABLE — verifies the ordering.
      mockedExistsSync.mockImplementation((p) => {
        const s = String(p);
        return s.endsWith('cdk-outputs.json') || s.endsWith(`backend/.env`);
      });
      mockedReadFileSync.mockImplementation((p) => {
        const s = String(p);
        if (s.endsWith('cdk-outputs.json')) return SYNTHETIC_OUTPUTS;
        if (s.endsWith(`backend/.env`)) {
          return 'ENVIRONMENT=staging\nCDK_DEFAULT_REGION=eu-west-1\n';
        }
        throw new Error(`unexpected read: ${s}`);
      });

      bootstrapEnv();

      expect(process.env.REGISTRY_ID).toBe('reg-abc-123');
      expect(process.env.USER_POOL_ID).toBe('us-west-2_FAKEPOOL');
      expect(process.env.AGENT_CONFIG_TABLE).toBe('citadel-agents-dev');
      expect(process.env.AWS_REGION).toBe('eu-west-1');
      expect(process.env.ENVIRONMENT).toBe('staging');
      expect(process.env.TOOL_CONFIG_TABLE).toBe('citadel-tools-staging');
    });

    it('is safe when neither cdk-outputs.json nor .env exist', () => {
      mockedExistsSync.mockReturnValue(false);

      expect(() => bootstrapEnv()).not.toThrow();
      // Only TOOL_CONFIG_TABLE gets a default; the others remain unset so
      // main()'s explicit env-required checks fire as expected.
      expect(process.env.REGISTRY_ID).toBeUndefined();
      expect(process.env.USER_POOL_ID).toBeUndefined();
      expect(process.env.AGENT_CONFIG_TABLE).toBeUndefined();
      expect(process.env.TOOL_CONFIG_TABLE).toBe('citadel-tools-dev');
    });
  });
});
