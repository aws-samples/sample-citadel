/**
 * Tests for governance-ui-resolver Lambda — Wave 1 + Wave 2.A + Wave 2.B.
 *
 * Mirrors the style of registry-sync.test.ts: env vars set first, then
 * imports, with mocks for AWS SDK clients (aws-sdk-client-mock) and
 * jest.mock for the auth-event + governance-flag utility modules.
 */

// Set env vars before importing the module.
process.env.ENVIRONMENT = 'test';
process.env.GOVERNANCE_LEDGER_TABLE = 'citadel-governance-ledger-test';
process.env.AUTHORITY_UNITS_TABLE = 'citadel-authority-units-test';
process.env.COMPOSITION_CONTRACTS_TABLE = 'citadel-composition-contracts-test';
process.env.CONSTITUTIONAL_LAYERS_TABLE = 'citadel-constitutional-layers-test';
process.env.CASE_LAW_TABLE = 'citadel-case-law-test';
process.env.GRAPH_SNAPSHOTS_TABLE = 'citadel-governance-graph-snapshots-test';
process.env.REGISTRY_ID = 'reg-test-1';
process.env.DATASTORES_TABLE = 'citadel-datastores-test';
process.env.INTEGRATIONS_TABLE = 'citadel-integrations-test';
process.env.LAMBDA_EXEC_ROLE_ARN = 'arn:aws:iam::123456789012:role/citadel-governance-ui-resolver-test';

import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  type ScanCommandInput,
} from '@aws-sdk/lib-dynamodb';
import {
  SSMClient,
  GetParameterCommand,
  GetParameterHistoryCommand,
  PutParameterCommand,
  type GetParameterCommandInput,
  type PutParameterCommandInput,
} from '@aws-sdk/client-ssm';
import {
  CloudWatchClient,
  GetMetricStatisticsCommand,
} from '@aws-sdk/client-cloudwatch';
import {
  EventBridgeClient,
  PutEventsCommand,
} from '@aws-sdk/client-eventbridge';
import {
  IAMClient,
  GetRoleCommand,
  GetRolePolicyCommand,
  type GetRoleCommandInput,
  type GetRolePolicyCommandInput,
} from '@aws-sdk/client-iam';
import {
  STSClient,
  GetCallerIdentityCommand,
} from '@aws-sdk/client-sts';

// Mock auth + governance-flag modules so per-test we can dictate behaviour.
jest.mock('../../utils/auth-event');
jest.mock('../../utils/governance-flag');

// Mock the unified registry adapter facade so the Wave 5.C IAM-drift
// resolver can be exercised without spinning up the real registry. Per-
// test we override `getUnifiedRegistry().getAdapter(...).requiredPolicies`
// with a stub that returns the test fixture.
jest.mock('../../adapters/registry', () => ({
  getUnifiedRegistry: jest.fn(),
}));

// Mock the RegistryService class so data-2 + data-3 can be exercised
// without spinning up the real AgentCore SDK. Per-test we override the
// returned methods via getResourceMock / listResourcesMock.
const getResourceMock = jest.fn();
const listResourcesMock = jest.fn();
const deserializeCustomMetadataMock = jest.fn(
  (json: string | null | undefined, defaults: Record<string, unknown>) => {
    if (!json) return { ...defaults };
    try {
      const parsed = JSON.parse(json);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return { ...defaults };
      }
      return { ...defaults, ...parsed };
    } catch {
      return { ...defaults };
    }
  },
);
jest.mock('../../services/registry-service', () => {
  // Preserve TypeMismatchError as a real class so `instanceof` works.
  class TypeMismatchError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'TypeMismatchError';
    }
  }
  return {
    TypeMismatchError,
    RegistryService: jest.fn().mockImplementation(() => ({
      getRegistryId: () => 'reg-test-1',
      getResource: getResourceMock,
      listResources: listResourcesMock,
      deserializeCustomMetadata: deserializeCustomMetadataMock,
    })),
  };
});

import { isAdminFromEvent } from '../../utils/auth-event';
import {
  getGovernanceEnforce,
  getGovernanceEffectiveAt,
} from '../../utils/governance-flag';
import { getUnifiedRegistry } from '../../adapters/registry';
import {
  handler,
  projectFinding,
  __resetReadinessCacheForTest,
  __resetMismatchHeatmapCacheForTest,
  __resetEscalationMetricCacheForTest,
  __resetManualVerificationCacheForTest,
  __resetAuthorityUnitsCacheForTest,
  __resetCompositionContractsCacheForTest,
  __resetRevokeImpactCacheForTest,
  __resetConstitutionalLayersCacheForTest,
  __resetConstitutionalRuleStatsCacheForTest,
  __resetCaseLawCacheForTest,
  __resetAuthorityGraphHistoryCacheForTest,
  __resetListAuthorityGraphSnapshotsCacheForTest,
  __resetGetAuthorityGraphSnapshotCacheForTest,
  __resetD4RetrospectiveCacheForTest,
  __resetTrustPathCacheForTest,
  computeD4Recommendation,
  parseTrustPolicyPrincipals,
  projectInlinePolicyDocument,
  extractCrossAccountRoleArn,
} from '../governance-ui-resolver';
import { TypeMismatchError } from '../../services/registry-service';

const ddbMock = mockClient(DynamoDBDocumentClient);
const ssmMock = mockClient(SSMClient);
const cwMock = mockClient(CloudWatchClient);
const ebMock = mockClient(EventBridgeClient);
const iamMock = mockClient(IAMClient);
const stsMock = mockClient(STSClient);

const isAdminFromEventMock = isAdminFromEvent as jest.MockedFunction<
  typeof isAdminFromEvent
>;
const getGovernanceEnforceMock = getGovernanceEnforce as jest.MockedFunction<
  typeof getGovernanceEnforce
>;
const getGovernanceEffectiveAtMock =
  getGovernanceEffectiveAt as jest.MockedFunction<typeof getGovernanceEffectiveAt>;

beforeEach(() => {
  ddbMock.reset();
  ssmMock.reset();
  cwMock.reset();
  ebMock.reset();
  iamMock.reset();
  stsMock.reset();
  isAdminFromEventMock.mockReset();
  getGovernanceEnforceMock.mockReset();
  getGovernanceEffectiveAtMock.mockReset();
  getResourceMock.mockReset();
  listResourcesMock.mockReset();
  __resetReadinessCacheForTest();
  __resetMismatchHeatmapCacheForTest();
  __resetEscalationMetricCacheForTest();
  __resetManualVerificationCacheForTest();
  __resetAuthorityUnitsCacheForTest();
  __resetCompositionContractsCacheForTest();
  __resetRevokeImpactCacheForTest();
  __resetConstitutionalLayersCacheForTest();
  __resetConstitutionalRuleStatsCacheForTest();
  __resetCaseLawCacheForTest();
  __resetAuthorityGraphHistoryCacheForTest();
  __resetListAuthorityGraphSnapshotsCacheForTest();
  __resetGetAuthorityGraphSnapshotCacheForTest();
  __resetD4RetrospectiveCacheForTest();
  __resetTrustPathCacheForTest();
  // Re-arm the deserialize mock with default behaviour after reset.
  deserializeCustomMetadataMock.mockImplementation(
    (json: string | null | undefined, defaults: Record<string, unknown>) => {
      if (!json) return { ...defaults };
      try {
        const parsed = JSON.parse(json);
        if (
          typeof parsed !== 'object' ||
          parsed === null ||
          Array.isArray(parsed)
        ) {
          return { ...defaults };
        }
        return { ...defaults, ...parsed };
      } catch {
        return { ...defaults };
      }
    },
  );
  jest.spyOn(console, 'warn').mockImplementation();
  jest.spyOn(console, 'error').mockImplementation();
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface PartialEvent {
  fieldName: string;
  args?: Record<string, unknown>;
  identity?: Record<string, unknown>;
}

type HandlerEvent = Parameters<typeof handler>[0];

function makeEvent({ fieldName, args = {}, identity = {} }: PartialEvent): HandlerEvent {
  return {
    arguments: args,
    identity,
    info: { fieldName, parentTypeName: 'Query', variables: {} },
    request: { headers: {} },
    source: null,
    prev: null,
    stash: {},
  } as unknown as HandlerEvent;
}

function makeDdbRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    findingId: 'finding-1',
    workflowId: 'wf-1',
    decision: 'permit',
    reason: 'authority_match:unit=u1',
    requesting_agent: 'agent-a',
    target_agent: 'agent-b',
    scope_evaluated: 'unit-1',
    contract_evaluated: 'contract-1',
    escalation_target: null,
    residual_authority_denial: false,
    timestamp: 1715000000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// projectFinding — direct unit tests for the snake → camel mapping
// ---------------------------------------------------------------------------

describe('projectFinding', () => {
  test('maps snake_case DDB attributes to camelCase GraphQL shape', () => {
    const row = makeDdbRow();
    const projected = projectFinding(row);

    expect(projected.findingId).toBe('finding-1');
    expect(projected.workflowId).toBe('wf-1');
    expect(projected.decision).toBe('permit');
    expect(projected.requestingAgent).toBe('agent-a');
    expect(projected.targetAgent).toBe('agent-b');
    expect(projected.scopeEvaluated).toBe('unit-1');
    expect(projected.contractEvaluated).toBe('contract-1');
    expect(projected.escalationTarget).toBeNull();
    expect(projected.residualAuthorityDenial).toBe(false);
    expect(projected.timestamp).toBe(1715000000);
  });

  test('coerces missing nullable string fields to null', () => {
    const row = makeDdbRow({
      scope_evaluated: undefined,
      contract_evaluated: undefined,
      escalation_target: undefined,
    });
    const projected = projectFinding(row);
    expect(projected.scopeEvaluated).toBeNull();
    expect(projected.contractEvaluated).toBeNull();
    expect(projected.escalationTarget).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getGovernanceMode
// ---------------------------------------------------------------------------

describe('getGovernanceMode', () => {
  test('returns enforce and effectiveAt from mocked SSM helpers', async () => {
    getGovernanceEnforceMock.mockResolvedValue('shadow');
    getGovernanceEffectiveAtMock.mockResolvedValue('2026-05-18T10:00:00Z');

    const result = (await handler(makeEvent({ fieldName: 'getGovernanceMode' }))) as {
      enforce: string;
      effectiveAt: string | null;
      env: string;
    };

    expect(result.enforce).toBe('shadow');
    expect(result.effectiveAt).toBe('2026-05-18T10:00:00Z');
  });

  test('returns permissive fallback when SSM (helper) throws', async () => {
    getGovernanceEnforceMock.mockRejectedValue(new Error('SSM down'));
    getGovernanceEffectiveAtMock.mockRejectedValue(new Error('SSM down'));

    const result = (await handler(makeEvent({ fieldName: 'getGovernanceMode' }))) as {
      enforce: string;
      effectiveAt: string | null;
      env: string;
    };

    expect(result.enforce).toBe('permissive');
    expect(result.effectiveAt).toBeNull();
  });

  test('includes env from process.env.ENVIRONMENT', async () => {
    getGovernanceEnforceMock.mockResolvedValue('permissive');
    getGovernanceEffectiveAtMock.mockResolvedValue(null);

    const result = (await handler(makeEvent({ fieldName: 'getGovernanceMode' }))) as {
      enforce: string;
      effectiveAt: string | null;
      env: string;
    };

    expect(result.env).toBe('test');
  });
});

// ---------------------------------------------------------------------------
// listGovernanceFindings
// ---------------------------------------------------------------------------

describe('listGovernanceFindings', () => {
  test('default Scan returns items + null cursor when no LastEvaluatedKey', async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [makeDdbRow({ findingId: 'f1' }), makeDdbRow({ findingId: 'f2' })],
    });

    const result = (await handler(
      makeEvent({ fieldName: 'listGovernanceFindings', args: {} }),
    )) as { items: { findingId: string }[]; nextCursor: string | null };

    expect(result.items).toHaveLength(2);
    expect(result.items[0].findingId).toBe('f1');
    expect(result.nextCursor).toBeNull();
  });

  test('default Scan returns base64 cursor when LastEvaluatedKey present', async () => {
    const lastKey = { findingId: 'f-last' };
    ddbMock.on(ScanCommand).resolves({
      Items: [makeDdbRow({ findingId: 'f1' })],
      LastEvaluatedKey: lastKey,
    });

    const result = (await handler(
      makeEvent({ fieldName: 'listGovernanceFindings', args: {} }),
    )) as { items: unknown[]; nextCursor: string | null };

    expect(result.nextCursor).not.toBeNull();
    const decoded = JSON.parse(
      Buffer.from(result.nextCursor as string, 'base64').toString('utf8'),
    );
    expect(decoded).toEqual(lastKey);
  });

  test('workflowId path uses QueryCommand against workflow-index GSI', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [makeDdbRow()] });

    await handler(
      makeEvent({
        fieldName: 'listGovernanceFindings',
        args: { workflowId: 'wf-42' },
      }),
    );

    const queryCalls = ddbMock.commandCalls(QueryCommand);
    expect(queryCalls).toHaveLength(1);
    const input = queryCalls[0].args[0].input;
    expect(input.IndexName).toBe('workflow-index');
    expect(input.KeyConditionExpression).toBe('workflowId = :wid');
    expect(input.ExpressionAttributeValues).toMatchObject({ ':wid': 'wf-42' });
    // Scan should NOT have been used.
    expect(ddbMock.commandCalls(ScanCommand)).toHaveLength(0);
  });

  test('workflowId path adds sinceTs as SK comparator with #ts placeholder', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    await handler(
      makeEvent({
        fieldName: 'listGovernanceFindings',
        args: { workflowId: 'wf-42', sinceTs: 1700000000 },
      }),
    );

    const input = ddbMock.commandCalls(QueryCommand)[0].args[0].input;
    expect(input.KeyConditionExpression).toBe('workflowId = :wid AND #ts >= :since');
    expect(input.ExpressionAttributeNames).toMatchObject({ '#ts': 'timestamp' });
    expect(input.ExpressionAttributeValues).toMatchObject({ ':since': 1700000000 });
  });

  test('decision filter applied on Scan path', async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [] });

    await handler(
      makeEvent({
        fieldName: 'listGovernanceFindings',
        args: { decision: 'deny' },
      }),
    );

    const input = ddbMock.commandCalls(ScanCommand)[0].args[0].input;
    expect(input.FilterExpression).toContain('#decision = :decision');
    expect(input.ExpressionAttributeNames).toMatchObject({ '#decision': 'decision' });
    expect(input.ExpressionAttributeValues).toMatchObject({ ':decision': 'deny' });
  });

  test('limit is clamped to 200', async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [] });

    await handler(
      makeEvent({
        fieldName: 'listGovernanceFindings',
        args: { limit: 9999 },
      }),
    );

    expect(ddbMock.commandCalls(ScanCommand)[0].args[0].input.Limit).toBe(200);
  });

  test('cursor is base64-decoded into ExclusiveStartKey', async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [] });

    const startKey = { findingId: 'page-2-start' };
    const cursor = Buffer.from(JSON.stringify(startKey), 'utf8').toString('base64');

    await handler(
      makeEvent({
        fieldName: 'listGovernanceFindings',
        args: { cursor },
      }),
    );

    const input = ddbMock.commandCalls(ScanCommand)[0].args[0].input;
    expect(input.ExclusiveStartKey).toEqual(startKey);
  });
});

// ---------------------------------------------------------------------------
// getGovernanceFinding
// ---------------------------------------------------------------------------

describe('getGovernanceFinding', () => {
  test('returns null when DDB returns no item', async () => {
    ddbMock.on(GetCommand).resolves({});

    const result = await handler(
      makeEvent({ fieldName: 'getGovernanceFinding', args: { findingId: 'missing' } }),
    );
    expect(result).toBeNull();
  });

  test('returns projected item with camelCase fields', async () => {
    ddbMock.on(GetCommand).resolves({ Item: makeDdbRow() });

    const result = (await handler(
      makeEvent({ fieldName: 'getGovernanceFinding', args: { findingId: 'finding-1' } }),
    )) as { findingId: string; requestingAgent: string; targetAgent: string };

    expect(result.findingId).toBe('finding-1');
    expect(result.requestingAgent).toBe('agent-a');
    expect(result.targetAgent).toBe('agent-b');
  });
});

// ---------------------------------------------------------------------------
// getReconcilerStatus
// ---------------------------------------------------------------------------

describe('getReconcilerStatus', () => {
  test('throws when caller is not admin', async () => {
    isAdminFromEventMock.mockReturnValue(false);

    await expect(
      handler(makeEvent({ fieldName: 'getReconcilerStatus' })),
    ).rejects.toThrow('Forbidden: admin required');
  });

  test('returns zero defaults when SSM throws ParameterNotFound', async () => {
    isAdminFromEventMock.mockReturnValue(true);
    const err = new Error('Parameter not found');
    err.name = 'ParameterNotFound';
    ssmMock.on(GetParameterCommand).rejects(err);

    const result = (await handler(
      makeEvent({ fieldName: 'getReconcilerStatus' }),
    )) as {
      lastRunAt: string | null;
      lastRunMode: string | null;
      classifications: { inSync: number; missing: number; stale: number; orphan: number };
      totalRecords: number;
    };

    expect(result.lastRunAt).toBeNull();
    expect(result.lastRunMode).toBeNull();
    expect(result.classifications).toEqual({ inSync: 0, missing: 0, stale: 0, orphan: 0 });
    expect(result.totalRecords).toBe(0);
  });

  test('returns parsed JSON when SSM returns valid blob', async () => {
    isAdminFromEventMock.mockReturnValue(true);
    const blob = {
      lastRunAt: '2026-05-18T10:23:55Z',
      lastRunMode: 'apply',
      classifications: { inSync: 24, missing: 0, stale: 1, orphan: 0 },
      totalRecords: 25,
    };
    ssmMock.on(GetParameterCommand).resolves({
      Parameter: { Value: JSON.stringify(blob) },
    });

    const result = await handler(makeEvent({ fieldName: 'getReconcilerStatus' }));
    expect(result).toEqual(blob);
  });

  test('returns zero defaults when JSON parse fails', async () => {
    isAdminFromEventMock.mockReturnValue(true);
    ssmMock.on(GetParameterCommand).resolves({
      Parameter: { Value: 'not-json{' },
    });

    const result = (await handler(
      makeEvent({ fieldName: 'getReconcilerStatus' }),
    )) as { totalRecords: number; classifications: { inSync: number } };

    expect(result.totalRecords).toBe(0);
    expect(result.classifications.inSync).toBe(0);
  });

  test('returns zero defaults when shape does not match', async () => {
    isAdminFromEventMock.mockReturnValue(true);
    ssmMock.on(GetParameterCommand).resolves({
      Parameter: { Value: JSON.stringify({ lastRunAt: 'x', classifications: 'wrong' }) },
    });

    const result = (await handler(
      makeEvent({ fieldName: 'getReconcilerStatus' }),
    )) as { totalRecords: number };

    expect(result.totalRecords).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// getRolloutReadiness — Wave 2.A
// ---------------------------------------------------------------------------

// Helper: build N AuthorityUnit rows. By default each row has a registryId.
function makeUnits(
  n: number,
  opts: { withRegistryId?: number } = {},
): Array<{ unitId: string; registryId?: string | null }> {
  const withId = opts.withRegistryId ?? n;
  const out: Array<{ unitId: string; registryId?: string | null }> = [];
  for (let i = 0; i < n; i++) {
    if (i < withId) {
      out.push({ unitId: `u-${i}`, registryId: `rec-${i}` });
    } else {
      out.push({ unitId: `u-${i}` });
    }
  }
  return out;
}

describe('getRolloutReadiness', () => {
  // Restore the env var that earlier suites may rely on staying unset
  // for negative-path coverage.
  const ORIGINAL_AUTHORITY_UNITS_TABLE = process.env.AUTHORITY_UNITS_TABLE;
  const ORIGINAL_REGISTRY_ID = process.env.REGISTRY_ID;
  afterEach(() => {
    process.env.AUTHORITY_UNITS_TABLE = ORIGINAL_AUTHORITY_UNITS_TABLE;
    process.env.REGISTRY_ID = ORIGINAL_REGISTRY_ID;
  });

  test('throws when caller is not admin', async () => {
    isAdminFromEventMock.mockReturnValue(false);

    await expect(
      handler(makeEvent({ fieldName: 'getRolloutReadiness' })),
    ).rejects.toThrow('Forbidden: admin required');
  });

  test('returns a report with 11 checks when caller is admin', async () => {
    isAdminFromEventMock.mockReturnValue(true);
    getGovernanceEnforceMock.mockResolvedValue('permissive');
    getGovernanceEffectiveAtMock.mockResolvedValue(null);
    ddbMock.on(ScanCommand).resolves({ Items: [], ScannedCount: 0 });
    listResourcesMock.mockRejectedValue(new Error('skip'));
    cwMock.on(GetMetricStatisticsCommand).rejects(new Error('skip'));
    ssmMock.on(GetParameterCommand).rejects(new Error('skip'));

    const result = (await handler(
      makeEvent({ fieldName: 'getRolloutReadiness' }),
    )) as { checks: Array<{ id: string }> };

    expect(result.checks).toHaveLength(11);
    expect(result.checks.map((c) => c.id)).toEqual([
      'data-1',
      'data-2',
      'data-3',
      'tel-1',
      'tel-2',
      'tel-3',
      'rb-1',
      'rb-2',
      'own-1',
      'own-2',
      'own-3',
    ]);
  });

  test('data-1 returns PASS with detail "All N ..." when no rows are missing', async () => {
    isAdminFromEventMock.mockReturnValue(true);
    getGovernanceEnforceMock.mockResolvedValue('permissive');
    getGovernanceEffectiveAtMock.mockResolvedValue(null);
    ddbMock
      .on(ScanCommand)
      .resolves({ Items: makeUnits(42), ScannedCount: 42 });
    // Stub upstreams to avoid their checks polluting the test.
    listResourcesMock.mockRejectedValue(new Error('skip'));
    cwMock.on(GetMetricStatisticsCommand).rejects(new Error('skip'));
    ssmMock.on(GetParameterCommand).rejects(new Error('skip'));
    getResourceMock.mockResolvedValue({
      recordId: 'rec',
      name: 'n',
      status: 'APPROVED',
    });

    const result = (await handler(
      makeEvent({ fieldName: 'getRolloutReadiness' }),
    )) as { checks: Array<{ id: string; status: string; detail: string | null }> };

    const dataOne = result.checks.find((c) => c.id === 'data-1')!;
    expect(dataOne.status).toBe('PASS');
    expect(dataOne.detail).toBe('All 42 authority units have registryId');
  });

  test('data-1 returns FAIL with M/N detail when scan count is non-zero', async () => {
    isAdminFromEventMock.mockReturnValue(true);
    getGovernanceEnforceMock.mockResolvedValue('permissive');
    getGovernanceEffectiveAtMock.mockResolvedValue(null);
    ddbMock.on(ScanCommand).resolves({
      Items: makeUnits(50, { withRegistryId: 47 }), // 3 missing
      ScannedCount: 50,
    });
    listResourcesMock.mockRejectedValue(new Error('skip'));
    cwMock.on(GetMetricStatisticsCommand).rejects(new Error('skip'));
    ssmMock.on(GetParameterCommand).rejects(new Error('skip'));
    getResourceMock.mockResolvedValue({
      recordId: 'rec',
      name: 'n',
      status: 'APPROVED',
    });

    const result = (await handler(
      makeEvent({ fieldName: 'getRolloutReadiness' }),
    )) as { checks: Array<{ id: string; status: string; detail: string | null }> };

    const dataOne = result.checks.find((c) => c.id === 'data-1')!;
    expect(dataOne.status).toBe('FAIL');
    expect(dataOne.detail).toBe('3 of 50 units missing registryId');
  });

  test('data-1 returns UNKNOWN when AUTHORITY_UNITS_TABLE is unset', async () => {
    isAdminFromEventMock.mockReturnValue(true);
    getGovernanceEnforceMock.mockResolvedValue('permissive');
    getGovernanceEffectiveAtMock.mockResolvedValue(null);
    delete process.env.AUTHORITY_UNITS_TABLE;
    listResourcesMock.mockRejectedValue(new Error('skip'));
    cwMock.on(GetMetricStatisticsCommand).rejects(new Error('skip'));
    ssmMock.on(GetParameterCommand).rejects(new Error('skip'));

    const result = (await handler(
      makeEvent({ fieldName: 'getRolloutReadiness' }),
    )) as { checks: Array<{ id: string; status: string; detail: string | null; evidence: string | null }> };

    const dataOne = result.checks.find((c) => c.id === 'data-1')!;
    expect(dataOne.status).toBe('UNKNOWN');
    expect(dataOne.detail).toBe('Authority units table unreachable');
    expect(dataOne.evidence).toBe('AUTHORITY_UNITS_TABLE env var is not set');
  });

  test('data-1 returns UNKNOWN with error message in evidence when scan throws', async () => {
    isAdminFromEventMock.mockReturnValue(true);
    getGovernanceEnforceMock.mockResolvedValue('permissive');
    getGovernanceEffectiveAtMock.mockResolvedValue(null);
    ddbMock.on(ScanCommand).rejects(new Error('access denied'));
    listResourcesMock.mockRejectedValue(new Error('skip'));
    cwMock.on(GetMetricStatisticsCommand).rejects(new Error('skip'));
    ssmMock.on(GetParameterCommand).rejects(new Error('skip'));

    const result = (await handler(
      makeEvent({ fieldName: 'getRolloutReadiness' }),
    )) as { checks: Array<{ id: string; status: string; detail: string | null; evidence: string | null }> };

    const dataOne = result.checks.find((c) => c.id === 'data-1')!;
    expect(dataOne.status).toBe('UNKNOWN');
    expect(dataOne.detail).toBe('Authority units table unreachable');
    expect(dataOne.evidence).toBe('access denied');
  });

  test('the 3 manual stub checks return STUB with operator instructions and null evidence', async () => {
    isAdminFromEventMock.mockReturnValue(true);
    getGovernanceEnforceMock.mockResolvedValue('permissive');
    getGovernanceEffectiveAtMock.mockResolvedValue(null);
    ddbMock.on(ScanCommand).resolves({ Items: [], ScannedCount: 0 });
    listResourcesMock.mockRejectedValue(new Error('skip'));
    cwMock.on(GetMetricStatisticsCommand).rejects(new Error('skip'));
    ssmMock.on(GetParameterCommand).rejects(new Error('skip'));

    const result = (await handler(
      makeEvent({ fieldName: 'getRolloutReadiness' }),
    )) as { checks: Array<{ id: string; status: string; detail: string | null; evidence: string | null }> };

    const stubIds = new Set(['own-1', 'own-2', 'own-3']);
    const stubs = result.checks.filter((c) => stubIds.has(c.id));
    expect(stubs).toHaveLength(3);
    for (const c of stubs) {
      expect(c.status).toBe('STUB');
      expect(c.detail).toBeTruthy();
      expect(c.detail).not.toContain('Wave');
      expect(c.evidence).toBeNull();
    }
  });

  test('shadowSoakStartedAt mirrors effectiveAt only when mode = shadow', async () => {
    isAdminFromEventMock.mockReturnValue(true);
    ddbMock.on(ScanCommand).resolves({ Items: [], ScannedCount: 0 });
    listResourcesMock.mockRejectedValue(new Error('skip'));
    cwMock.on(GetMetricStatisticsCommand).rejects(new Error('skip'));
    ssmMock.on(GetParameterCommand).rejects(new Error('skip'));

    getGovernanceEnforceMock.mockResolvedValue('shadow');
    getGovernanceEffectiveAtMock.mockResolvedValue('2026-05-18T10:00:00Z');

    const result = (await handler(
      makeEvent({ fieldName: 'getRolloutReadiness' }),
    )) as { shadowSoakStartedAt: string | null; currentMode: string };

    expect(result.shadowSoakStartedAt).toBe('2026-05-18T10:00:00Z');
    expect(result.currentMode).toBe('shadow');
  });

  test('shadowSoakStartedAt is null when mode is shadow but effectiveAt is null', async () => {
    isAdminFromEventMock.mockReturnValue(true);
    ddbMock.on(ScanCommand).resolves({ Items: [], ScannedCount: 0 });
    listResourcesMock.mockRejectedValue(new Error('skip'));
    cwMock.on(GetMetricStatisticsCommand).rejects(new Error('skip'));
    ssmMock.on(GetParameterCommand).rejects(new Error('skip'));

    getGovernanceEnforceMock.mockResolvedValue('shadow');
    getGovernanceEffectiveAtMock.mockResolvedValue(null);

    const result = (await handler(
      makeEvent({ fieldName: 'getRolloutReadiness' }),
    )) as { shadowSoakStartedAt: string | null };

    expect(result.shadowSoakStartedAt).toBeNull();
  });

  test('shadowSoakStartedAt is null when mode is permissive even with effectiveAt set', async () => {
    isAdminFromEventMock.mockReturnValue(true);
    ddbMock.on(ScanCommand).resolves({ Items: [], ScannedCount: 0 });
    listResourcesMock.mockRejectedValue(new Error('skip'));
    cwMock.on(GetMetricStatisticsCommand).rejects(new Error('skip'));
    ssmMock.on(GetParameterCommand).rejects(new Error('skip'));

    getGovernanceEnforceMock.mockResolvedValue('permissive');
    getGovernanceEffectiveAtMock.mockResolvedValue('2026-05-18T10:00:00Z');

    const result = (await handler(
      makeEvent({ fieldName: 'getRolloutReadiness' }),
    )) as { shadowSoakStartedAt: string | null };

    expect(result.shadowSoakStartedAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getRolloutReadiness real checks (Wave 2.B)
// ---------------------------------------------------------------------------

describe('getRolloutReadiness real checks (Wave 2.B)', () => {
  const ORIGINAL_REGISTRY_ID = process.env.REGISTRY_ID;
  const ORIGINAL_AUTHORITY_UNITS_TABLE = process.env.AUTHORITY_UNITS_TABLE;
  afterEach(() => {
    process.env.REGISTRY_ID = ORIGINAL_REGISTRY_ID;
    process.env.AUTHORITY_UNITS_TABLE = ORIGINAL_AUTHORITY_UNITS_TABLE;
  });

  function setupHappyPath() {
    isAdminFromEventMock.mockReturnValue(true);
    getGovernanceEnforceMock.mockResolvedValue('permissive');
    getGovernanceEffectiveAtMock.mockResolvedValue(null);
  }

  function findCheck(checks: Array<{ id: string }>, id: string) {
    return checks.find((c) => c.id === id) as
      | {
          id: string;
          status: string;
          detail: string | null;
          evidence: string | null;
        }
      | undefined;
  }

  // ----- data-2 -----

  test('data-2 PASS: sample of 5 units, all return live records', async () => {
    setupHappyPath();
    ddbMock.on(ScanCommand).resolves({
      Items: makeUnits(5),
      ScannedCount: 5,
    });
    getResourceMock.mockResolvedValue({
      recordId: 'rec',
      name: 'n',
      status: 'APPROVED',
    });
    // Other real checks: don't care about result for this test.
    listResourcesMock.mockRejectedValue(new Error('skip'));
    cwMock.on(GetMetricStatisticsCommand).rejects(new Error('skip'));
    ssmMock.on(GetParameterCommand).rejects(new Error('skip'));

    const result = (await handler(
      makeEvent({ fieldName: 'getRolloutReadiness' }),
    )) as { checks: Array<{ id: string }> };

    const dataTwo = findCheck(result.checks, 'data-2')!;
    expect(dataTwo.status).toBe('PASS');
    expect(dataTwo.detail).toBe(
      'Sampled 5 units, all live and non-deprecated',
    );
    expect(dataTwo.evidence).toBeNull();
  });

  test('data-2 FAIL: 2 of 5 deprecated, evidence has IDs', async () => {
    setupHappyPath();
    ddbMock.on(ScanCommand).resolves({
      Items: makeUnits(5),
      ScannedCount: 5,
    });
    // rec-1 and rec-3 deprecated, others live
    getResourceMock.mockImplementation(
      async (_type: 'agent' | 'tool', recordId: string) => {
        if (recordId === 'rec-1' || recordId === 'rec-3') {
          return {
            recordId,
            name: 'n',
            status: 'DEPRECATED',
          };
        }
        return { recordId, name: 'n', status: 'APPROVED' };
      },
    );
    listResourcesMock.mockRejectedValue(new Error('skip'));
    cwMock.on(GetMetricStatisticsCommand).rejects(new Error('skip'));
    ssmMock.on(GetParameterCommand).rejects(new Error('skip'));

    const result = (await handler(
      makeEvent({ fieldName: 'getRolloutReadiness' }),
    )) as { checks: Array<{ id: string }> };

    const dataTwo = findCheck(result.checks, 'data-2')!;
    expect(dataTwo.status).toBe('FAIL');
    expect(dataTwo.detail).toBe(
      '2 of 5 sampled units missing or deprecated',
    );
    // Evidence — both rec-1 and rec-3 must be listed (order may vary).
    expect(dataTwo.evidence).toContain('rec-1');
    expect(dataTwo.evidence).toContain('rec-3');
  });

  test('data-2 WARN: AuthorityUnits scan returns empty', async () => {
    setupHappyPath();
    ddbMock.on(ScanCommand).resolves({ Items: [], ScannedCount: 0 });
    listResourcesMock.mockRejectedValue(new Error('skip'));
    cwMock.on(GetMetricStatisticsCommand).rejects(new Error('skip'));
    ssmMock.on(GetParameterCommand).rejects(new Error('skip'));

    const result = (await handler(
      makeEvent({ fieldName: 'getRolloutReadiness' }),
    )) as { checks: Array<{ id: string }> };

    const dataTwo = findCheck(result.checks, 'data-2')!;
    expect(dataTwo.status).toBe('WARN');
    expect(dataTwo.detail).toBe('No units to sample (see data-1)');
  });

  test('data-2 UNKNOWN: REGISTRY_ID missing', async () => {
    setupHappyPath();
    delete process.env.REGISTRY_ID;
    ddbMock.on(ScanCommand).resolves({
      Items: makeUnits(3),
      ScannedCount: 3,
    });
    listResourcesMock.mockRejectedValue(new Error('skip'));
    cwMock.on(GetMetricStatisticsCommand).rejects(new Error('skip'));
    ssmMock.on(GetParameterCommand).rejects(new Error('skip'));

    const result = (await handler(
      makeEvent({ fieldName: 'getRolloutReadiness' }),
    )) as { checks: Array<{ id: string }> };

    const dataTwo = findCheck(result.checks, 'data-2')!;
    expect(dataTwo.status).toBe('UNKNOWN');
    expect(dataTwo.evidence).toBe('REGISTRY_ID env var is not set');
  });

  // ----- data-3 -----

  test('data-3 PASS: all agents + tools have registryId in metadata', async () => {
    setupHappyPath();
    ddbMock.on(ScanCommand).resolves({ Items: [], ScannedCount: 0 });
    cwMock.on(GetMetricStatisticsCommand).rejects(new Error('skip'));
    ssmMock.on(GetParameterCommand).rejects(new Error('skip'));

    const agentRecords = [
      {
        recordId: 'a-1',
        name: 'a1',
        status: 'APPROVED',
        customDescriptorContent: JSON.stringify({ registryId: 'wid-a-1' }),
      },
      {
        recordId: 'a-2',
        name: 'a2',
        status: 'APPROVED',
        customDescriptorContent: JSON.stringify({ registryId: 'wid-a-2' }),
      },
    ];
    const toolRecords = [
      {
        recordId: 't-1',
        name: 't1',
        status: 'APPROVED',
        customDescriptorContent: JSON.stringify({ registryId: 'wid-t-1' }),
      },
    ];
    listResourcesMock.mockImplementation(async (type: 'agent' | 'tool') =>
      type === 'agent' ? agentRecords : toolRecords,
    );

    const result = (await handler(
      makeEvent({ fieldName: 'getRolloutReadiness' }),
    )) as { checks: Array<{ id: string }> };

    const dataThree = findCheck(result.checks, 'data-3')!;
    expect(dataThree.status).toBe('PASS');
    expect(dataThree.detail).toBe(
      'All 2 agents and 1 tools have workload-identity attribute',
    );
  });

  test('data-3 FAIL: 1 agent missing, 1 tool missing, evidence shows IDs', async () => {
    setupHappyPath();
    ddbMock.on(ScanCommand).resolves({ Items: [], ScannedCount: 0 });
    cwMock.on(GetMetricStatisticsCommand).rejects(new Error('skip'));
    ssmMock.on(GetParameterCommand).rejects(new Error('skip'));

    const agentRecords = [
      {
        recordId: 'a-1',
        name: 'a1',
        status: 'APPROVED',
        customDescriptorContent: JSON.stringify({ registryId: 'wid-a-1' }),
      },
      {
        recordId: 'a-bad',
        name: 'a2',
        status: 'APPROVED',
        customDescriptorContent: JSON.stringify({}), // missing registryId
      },
    ];
    const toolRecords = [
      {
        recordId: 't-bad',
        name: 't1',
        status: 'APPROVED',
        // No customDescriptorContent at all → defaults → no registryId
      },
      {
        recordId: 't-good',
        name: 't2',
        status: 'APPROVED',
        customDescriptorContent: JSON.stringify({ registryId: 'wid-t-good' }),
      },
    ];
    listResourcesMock.mockImplementation(async (type: 'agent' | 'tool') =>
      type === 'agent' ? agentRecords : toolRecords,
    );

    const result = (await handler(
      makeEvent({ fieldName: 'getRolloutReadiness' }),
    )) as { checks: Array<{ id: string }> };

    const dataThree = findCheck(result.checks, 'data-3')!;
    expect(dataThree.status).toBe('FAIL');
    expect(dataThree.detail).toBe(
      '1 of 2 agents and 1 of 2 tools missing workload-identity',
    );
    expect(dataThree.evidence).toContain('a-bad');
    expect(dataThree.evidence).toContain('t-bad');
  });

  test('data-3 UNKNOWN: listResources throws', async () => {
    setupHappyPath();
    ddbMock.on(ScanCommand).resolves({ Items: [], ScannedCount: 0 });
    cwMock.on(GetMetricStatisticsCommand).rejects(new Error('skip'));
    ssmMock.on(GetParameterCommand).rejects(new Error('skip'));
    listResourcesMock.mockRejectedValue(new Error('registry boom'));

    const result = (await handler(
      makeEvent({ fieldName: 'getRolloutReadiness' }),
    )) as { checks: Array<{ id: string }> };

    const dataThree = findCheck(result.checks, 'data-3')!;
    expect(dataThree.status).toBe('UNKNOWN');
    expect(dataThree.evidence).toBe('registry boom');
  });

  // ----- tel-3 -----

  test('tel-3 PASS: GetMetricStatistics returns no datapoints', async () => {
    setupHappyPath();
    ddbMock.on(ScanCommand).resolves({ Items: [], ScannedCount: 0 });
    listResourcesMock.mockRejectedValue(new Error('skip'));
    ssmMock.on(GetParameterCommand).rejects(new Error('skip'));
    cwMock.on(GetMetricStatisticsCommand).resolves({ Datapoints: [] });

    const result = (await handler(
      makeEvent({ fieldName: 'getRolloutReadiness' }),
    )) as { checks: Array<{ id: string }> };

    const telThree = findCheck(result.checks, 'tel-3')!;
    expect(telThree.status).toBe('PASS');
    expect(telThree.detail).toBe('Zero sync failures in last 48h');
  });

  test('tel-3 PASS: GetMetricStatistics returns datapoints all summing to 0', async () => {
    setupHappyPath();
    ddbMock.on(ScanCommand).resolves({ Items: [], ScannedCount: 0 });
    listResourcesMock.mockRejectedValue(new Error('skip'));
    ssmMock.on(GetParameterCommand).rejects(new Error('skip'));
    cwMock.on(GetMetricStatisticsCommand).resolves({
      Datapoints: [
        { Sum: 0, Timestamp: new Date('2026-05-17T10:00:00Z') },
        { Sum: 0, Timestamp: new Date('2026-05-17T11:00:00Z') },
      ],
    });

    const result = (await handler(
      makeEvent({ fieldName: 'getRolloutReadiness' }),
    )) as { checks: Array<{ id: string }> };

    const telThree = findCheck(result.checks, 'tel-3')!;
    expect(telThree.status).toBe('PASS');
    expect(telThree.detail).toBe('Zero sync failures in last 48h');
  });

  test('tel-3 FAIL: datapoints sum to 5 (peak 3 at <iso>)', async () => {
    setupHappyPath();
    ddbMock.on(ScanCommand).resolves({ Items: [], ScannedCount: 0 });
    listResourcesMock.mockRejectedValue(new Error('skip'));
    ssmMock.on(GetParameterCommand).rejects(new Error('skip'));
    const peakTs = new Date('2026-05-17T14:00:00Z');
    cwMock.on(GetMetricStatisticsCommand).resolves({
      Datapoints: [
        { Sum: 1, Timestamp: new Date('2026-05-17T10:00:00Z') },
        { Sum: 3, Timestamp: peakTs },
        { Sum: 1, Timestamp: new Date('2026-05-17T18:00:00Z') },
      ],
    });

    const result = (await handler(
      makeEvent({ fieldName: 'getRolloutReadiness' }),
    )) as { checks: Array<{ id: string }> };

    const telThree = findCheck(result.checks, 'tel-3')!;
    expect(telThree.status).toBe('FAIL');
    expect(telThree.detail).toBe(
      `5 sync failures in last 48h (peak 3/h at ${peakTs.toISOString()})`,
    );
  });

  test('tel-3 UNKNOWN: CW throws', async () => {
    setupHappyPath();
    ddbMock.on(ScanCommand).resolves({ Items: [], ScannedCount: 0 });
    listResourcesMock.mockRejectedValue(new Error('skip'));
    ssmMock.on(GetParameterCommand).rejects(new Error('skip'));
    cwMock.on(GetMetricStatisticsCommand).rejects(new Error('cw down'));

    const result = (await handler(
      makeEvent({ fieldName: 'getRolloutReadiness' }),
    )) as { checks: Array<{ id: string }> };

    const telThree = findCheck(result.checks, 'tel-3')!;
    expect(telThree.status).toBe('UNKNOWN');
    expect(telThree.evidence).toBe('cw down');
  });

  // ----- rb-1 -----

  test("rb-1 PASS: enforce param returns 'shadow'", async () => {
    setupHappyPath();
    ddbMock.on(ScanCommand).resolves({ Items: [], ScannedCount: 0 });
    listResourcesMock.mockRejectedValue(new Error('skip'));
    cwMock.on(GetMetricStatisticsCommand).rejects(new Error('skip'));
    ssmMock.on(GetParameterCommand).resolves({
      Parameter: { Value: 'shadow' },
    });

    const result = (await handler(
      makeEvent({ fieldName: 'getRolloutReadiness' }),
    )) as { checks: Array<{ id: string }> };

    const rbOne = findCheck(result.checks, 'rb-1')!;
    expect(rbOne.status).toBe('PASS');
    expect(rbOne.detail).toBe('Mode parameter present, value: shadow');
  });

  test("rb-1 FAIL: enforce param returns 'invalid'", async () => {
    setupHappyPath();
    ddbMock.on(ScanCommand).resolves({ Items: [], ScannedCount: 0 });
    listResourcesMock.mockRejectedValue(new Error('skip'));
    cwMock.on(GetMetricStatisticsCommand).rejects(new Error('skip'));
    ssmMock.on(GetParameterCommand).resolves({
      Parameter: { Value: 'invalid' },
    });

    const result = (await handler(
      makeEvent({ fieldName: 'getRolloutReadiness' }),
    )) as { checks: Array<{ id: string }> };

    const rbOne = findCheck(result.checks, 'rb-1')!;
    expect(rbOne.status).toBe('FAIL');
    expect(rbOne.detail).toBe('Mode parameter has invalid value: invalid');
  });

  test('rb-1 UNKNOWN: ParameterNotFound', async () => {
    setupHappyPath();
    ddbMock.on(ScanCommand).resolves({ Items: [], ScannedCount: 0 });
    listResourcesMock.mockRejectedValue(new Error('skip'));
    cwMock.on(GetMetricStatisticsCommand).rejects(new Error('skip'));
    const err = new Error('Parameter not found');
    (err as { name: string }).name = 'ParameterNotFound';
    ssmMock.on(GetParameterCommand).rejects(err);

    const result = (await handler(
      makeEvent({ fieldName: 'getRolloutReadiness' }),
    )) as { checks: Array<{ id: string }> };

    const rbOne = findCheck(result.checks, 'rb-1')!;
    expect(rbOne.status).toBe('UNKNOWN');
    expect(rbOne.evidence).toBe('Parameter not found');
  });

  // ----- TypeMismatch fallback -----

  test('data-2: getResource("agent") TypeMismatchError falls back to "tool"', async () => {
    setupHappyPath();
    ddbMock.on(ScanCommand).resolves({
      Items: [{ unitId: 'u-0', registryId: 'rec-0' }],
      ScannedCount: 1,
    });
    listResourcesMock.mockRejectedValue(new Error('skip'));
    cwMock.on(GetMetricStatisticsCommand).rejects(new Error('skip'));
    ssmMock.on(GetParameterCommand).rejects(new Error('skip'));

    getResourceMock.mockImplementation(
      async (type: 'agent' | 'tool', recordId: string) => {
        if (type === 'agent') {
          throw new TypeMismatchError(`not an agent: ${recordId}`);
        }
        return { recordId, name: 'n', status: 'APPROVED' };
      },
    );

    const result = (await handler(
      makeEvent({ fieldName: 'getRolloutReadiness' }),
    )) as { checks: Array<{ id: string }> };

    const dataTwo = findCheck(result.checks, 'data-2')!;
    expect(dataTwo.status).toBe('PASS');
  });

  // ----- Counts -----

  test('counts after all checks: sum to 11; stubCount = 3 in the all-real-pass scenario', async () => {
    setupHappyPath();
    // data-1 + data-2 PASS, plus tel-1/tel-2 PASS via differentiated
    // ScanCommand responses (governance-ledger reads see ledger-shaped
    // rows; authority-units reads see makeUnits).
    const telOneOldTs = Math.floor(Date.now() / 1000) - 10 * 86_400;
    ddbMock.on(ScanCommand).callsFake((input: ScanCommandInput) => {
      if (input.TableName === 'citadel-governance-ledger-test') {
        if (input.Select === 'COUNT') {
          // tel-2: total >= 100, mismatches < 0.5%.
          const isMismatch =
            String(input.FilterExpression ?? '').includes(':deny');
          return Promise.resolve({ Count: isMismatch ? 0 : 1000 });
        }
        // tel-1: at least one ledger row >= 7 days old.
        return Promise.resolve({
          Items: [{ timestamp: telOneOldTs, decision: 'deny' }],
          ScannedCount: 1,
        });
      }
      return Promise.resolve({ Items: makeUnits(3), ScannedCount: 3 });
    });
    getResourceMock.mockResolvedValue({
      recordId: 'rec',
      name: 'n',
      status: 'APPROVED',
    });
    // data-3 PASS
    listResourcesMock.mockImplementation(async (type: 'agent' | 'tool') => [
      {
        recordId: type === 'agent' ? 'a-1' : 't-1',
        name: 'n',
        status: 'APPROVED',
        customDescriptorContent: JSON.stringify({ registryId: 'wid' }),
      },
    ]);
    // tel-3 PASS
    cwMock.on(GetMetricStatisticsCommand).resolves({ Datapoints: [] });
    // rb-1 PASS
    ssmMock.on(GetParameterCommand).resolves({
      Parameter: { Value: 'shadow' },
    });
    // rb-2 PASS — history with a recent transition into 'permissive'.
    ssmMock.on(GetParameterHistoryCommand).resolves({
      Parameters: [
        { Value: 'permissive', LastModifiedDate: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
        { Value: 'shadow', LastModifiedDate: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000) },
        { Value: 'permissive', LastModifiedDate: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000) },
      ],
    });

    const result = (await handler(
      makeEvent({ fieldName: 'getRolloutReadiness' }),
    )) as {
      passCount: number;
      failCount: number;
      warnCount: number;
      stubCount: number;
    };

    expect(
      result.passCount + result.failCount + result.warnCount + result.stubCount,
    ).toBe(11);
    expect(result.passCount).toBe(8);
    expect(result.failCount).toBe(0);
    expect(result.warnCount).toBe(0);
    expect(result.stubCount).toBe(3);
  });
});


// ---------------------------------------------------------------------------
// getMismatchHeatmap — Wave 2.C
// ---------------------------------------------------------------------------

describe('getMismatchHeatmap', () => {
  function setupHeatmapHappyPath() {
    isAdminFromEventMock.mockReturnValue(true);
    getGovernanceEnforceMock.mockResolvedValue('shadow');
    getGovernanceEffectiveAtMock.mockResolvedValue(null);
  }

  function makeMismatchRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      findingId: 'f-' + Math.random().toString(36).slice(2, 8),
      workflowId: 'wf-1',
      decision: 'deny',
      reason: 'rule:winner=X',
      requesting_agent: 'a',
      target_agent: 'b',
      timestamp: 1000,
      ...overrides,
    };
  }

  test('throws when caller is not admin', async () => {
    isAdminFromEventMock.mockReturnValue(false);

    await expect(
      handler(makeEvent({ fieldName: 'getMismatchHeatmap', args: {} })),
    ).rejects.toThrow('Forbidden: admin required');
  });

  test('default sinceTs / untilTs window when args are omitted (~ now-7d to now)', async () => {
    setupHeatmapHappyPath();
    ddbMock.on(ScanCommand).resolves({ Items: [] });

    const before = Math.floor(Date.now() / 1000);
    const result = (await handler(
      makeEvent({ fieldName: 'getMismatchHeatmap', args: {} }),
    )) as { sinceTs: number; untilTs: number; bucketSeconds: number };
    const after = Math.floor(Date.now() / 1000);

    expect(result.bucketSeconds).toBe(3600);
    expect(result.untilTs).toBeGreaterThanOrEqual(before);
    expect(result.untilTs).toBeLessThanOrEqual(after);
    expect(result.sinceTs).toBeGreaterThanOrEqual(before - 7 * 86400);
    expect(result.sinceTs).toBeLessThanOrEqual(after - 7 * 86400);
  });

  test('bucketing groups items at t=100, t=110, t=3700 into 2 buckets with bucketSeconds=3600', async () => {
    setupHeatmapHappyPath();
    ddbMock.on(ScanCommand).resolves({
      Items: [
        makeMismatchRow({ findingId: 'a', timestamp: 100, decision: 'deny' }),
        makeMismatchRow({ findingId: 'b', timestamp: 110, decision: 'deny' }),
        makeMismatchRow({ findingId: 'c', timestamp: 3700, decision: 'deny' }),
      ],
    });

    const result = (await handler(
      makeEvent({
        fieldName: 'getMismatchHeatmap',
        args: { sinceTs: 0, untilTs: 7200, bucketSeconds: 3600 },
      }),
    )) as {
      buckets: Array<{ bucketStart: number; count: number; decision: string }>;
      totalDenials: number;
    };

    expect(result.buckets).toHaveLength(2);
    expect(result.buckets[0]).toMatchObject({
      bucketStart: 0,
      count: 2,
      decision: 'deny',
    });
    expect(result.buckets[1]).toMatchObject({
      bucketStart: 3600,
      count: 1,
      decision: 'deny',
    });
    expect(result.totalDenials).toBe(3);
  });

  test('decision filter: only deny and escalate items are included', async () => {
    setupHeatmapHappyPath();
    // Items returned mirror what the FilterExpression yields server-side; the
    // resolver also defends against accidental permits in case of cache reuse.
    ddbMock.on(ScanCommand).resolves({
      Items: [
        makeMismatchRow({ findingId: 'd1', timestamp: 100, decision: 'deny' }),
        makeMismatchRow({ findingId: 'e1', timestamp: 200, decision: 'escalate' }),
        makeMismatchRow({ findingId: 'p1', timestamp: 300, decision: 'permit' }),
      ],
    });

    const result = (await handler(
      makeEvent({
        fieldName: 'getMismatchHeatmap',
        args: { sinceTs: 0, untilTs: 7200, bucketSeconds: 3600 },
      }),
    )) as {
      totalDenials: number;
      totalEscalations: number;
      buckets: Array<{ decision: string }>;
    };

    expect(result.totalDenials).toBe(1);
    expect(result.totalEscalations).toBe(1);
    expect(result.buckets.every((b) => b.decision === 'deny' || b.decision === 'escalate')).toBe(
      true,
    );
  });

  test('top-reason aggregation returns the most-common prefix', async () => {
    setupHeatmapHappyPath();
    ddbMock.on(ScanCommand).resolves({
      Items: [
        makeMismatchRow({ findingId: 'x1', timestamp: 100, decision: 'deny', reason: 'a:1' }),
        makeMismatchRow({ findingId: 'x2', timestamp: 110, decision: 'deny', reason: 'a:1' }),
        makeMismatchRow({ findingId: 'x3', timestamp: 120, decision: 'deny', reason: 'b:2' }),
      ],
    });

    const result = (await handler(
      makeEvent({
        fieldName: 'getMismatchHeatmap',
        args: { sinceTs: 0, untilTs: 7200, bucketSeconds: 3600 },
      }),
    )) as { buckets: Array<{ topReason: string | null }> };

    expect(result.buckets).toHaveLength(1);
    expect(result.buckets[0].topReason).toBe('a');
  });

  test('bucketSeconds outside the allowlist is rejected', async () => {
    setupHeatmapHappyPath();

    await expect(
      handler(
        makeEvent({
          fieldName: 'getMismatchHeatmap',
          args: { bucketSeconds: 60 },
        }),
      ),
    ).rejects.toThrow('Invalid bucketSeconds');
  });

  test('time window > 30 days is clamped to 30 days', async () => {
    setupHeatmapHappyPath();
    ddbMock.on(ScanCommand).resolves({ Items: [] });

    const untilTs = 1_700_000_000;
    const sinceTs = untilTs - 100 * 86400; // 100 days

    const result = (await handler(
      makeEvent({
        fieldName: 'getMismatchHeatmap',
        args: { sinceTs, untilTs, bucketSeconds: 3600 },
      }),
    )) as { sinceTs: number; untilTs: number };

    expect(result.untilTs).toBe(untilTs);
    expect(result.untilTs - result.sinceTs).toBe(30 * 86400);
  });

  test('item count > 10000 is truncated with a logged warning', async () => {
    setupHeatmapHappyPath();
    // Build 10500 rows in a single page (no LastEvaluatedKey). The resolver
    // must stop appending at the cap and log a warning.
    const items = [] as Record<string, unknown>[];
    for (let i = 0; i < 10500; i++) {
      items.push(makeMismatchRow({ findingId: `f-${i}`, timestamp: 100 + i, decision: 'deny' }));
    }
    ddbMock.on(ScanCommand).resolves({ Items: items });

    const warnSpy = jest.spyOn(console, 'warn');

    const result = (await handler(
      makeEvent({
        fieldName: 'getMismatchHeatmap',
        args: { sinceTs: 0, untilTs: 1_000_000, bucketSeconds: 3600 },
      }),
    )) as { totalDenials: number };

    // Counts reflect the truncated set (10000 max).
    expect(result.totalDenials).toBe(10000);
    expect(
      warnSpy.mock.calls.some((args) =>
        String(args[0]).includes('item count exceeded'),
      ),
    ).toBe(true);
  });

  test('cache hit: same args within 30s returns cached result without re-scanning DDB', async () => {
    setupHeatmapHappyPath();
    ddbMock.on(ScanCommand).resolves({
      Items: [
        makeMismatchRow({ findingId: 'a', timestamp: 100, decision: 'deny' }),
      ],
    });

    const args = { sinceTs: 0, untilTs: 7200, bucketSeconds: 3600 };

    await handler(makeEvent({ fieldName: 'getMismatchHeatmap', args }));
    await handler(makeEvent({ fieldName: 'getMismatchHeatmap', args }));

    // Only one scan should have fired across the two calls.
    expect(ddbMock.commandCalls(ScanCommand)).toHaveLength(1);
  });

  test('modeWindows is a 1-element window covering [sinceTs, untilTs] with the current mode', async () => {
    setupHeatmapHappyPath();
    getGovernanceEnforceMock.mockResolvedValue('shadow');
    ddbMock.on(ScanCommand).resolves({ Items: [] });

    const result = (await handler(
      makeEvent({
        fieldName: 'getMismatchHeatmap',
        args: { sinceTs: 100, untilTs: 200, bucketSeconds: 900 },
      }),
    )) as { modeWindows: Array<{ startTs: number; endTs: number | null; mode: string }> };

    expect(result.modeWindows).toEqual([
      { startTs: 100, endTs: 200, mode: 'shadow' },
    ]);
  });

  test('uses the workflow scan FilterExpression with deny + escalate IN clause', async () => {
    setupHeatmapHappyPath();
    ddbMock.on(ScanCommand).resolves({ Items: [] });

    await handler(
      makeEvent({
        fieldName: 'getMismatchHeatmap',
        args: { sinceTs: 100, untilTs: 200, bucketSeconds: 3600 },
      }),
    );

    const input = ddbMock.commandCalls(ScanCommand)[0].args[0].input;
    expect(input.FilterExpression).toBe(
      'decision IN (:deny, :escalate) AND #ts BETWEEN :since AND :until',
    );
    expect(input.ExpressionAttributeNames).toMatchObject({ '#ts': 'timestamp' });
    expect(input.ExpressionAttributeValues).toMatchObject({
      ':deny': 'deny',
      ':escalate': 'escalate',
      ':since': 100,
      ':until': 200,
    });
  });
});

// ---------------------------------------------------------------------------
// getEscalationMetricSeries — Wave 2.D
// ---------------------------------------------------------------------------

describe('getEscalationMetricSeries', () => {
  function setupHappyPath() {
    isAdminFromEventMock.mockReturnValue(true);
  }

  test('throws when caller is not admin', async () => {
    isAdminFromEventMock.mockReturnValue(false);

    await expect(
      handler(makeEvent({ fieldName: 'getEscalationMetricSeries', args: {} })),
    ).rejects.toThrow('Forbidden: admin required');
  });

  test('default args produce a 7-day window with 3600s period', async () => {
    setupHappyPath();
    cwMock.on(GetMetricStatisticsCommand).resolves({ Datapoints: [] });

    const before = Math.floor(Date.now() / 1000);
    const result = (await handler(
      makeEvent({ fieldName: 'getEscalationMetricSeries', args: {} }),
    )) as {
      sinceTs: number;
      untilTs: number;
      periodSeconds: number;
      namespace: string;
      metric: string;
      statistic: string;
    };
    const after = Math.floor(Date.now() / 1000);

    expect(result.periodSeconds).toBe(3600);
    expect(result.namespace).toBe('CitadelGovernance');
    expect(result.metric).toBe('OffFrontierEscalations');
    expect(result.statistic).toBe('Sum');
    expect(result.untilTs).toBeGreaterThanOrEqual(before);
    expect(result.untilTs).toBeLessThanOrEqual(after);
    expect(result.sinceTs).toBeGreaterThanOrEqual(before - 7 * 86400);
    expect(result.sinceTs).toBeLessThanOrEqual(after - 7 * 86400);

    const input = cwMock.commandCalls(GetMetricStatisticsCommand)[0].args[0]
      .input;
    expect(input.Namespace).toBe('CitadelGovernance');
    expect(input.MetricName).toBe('OffFrontierEscalations');
    expect(input.Statistics).toEqual(['Sum']);
    expect(input.Period).toBe(3600);
  });

  test('periodSeconds outside the allowlist is rejected', async () => {
    setupHappyPath();

    await expect(
      handler(
        makeEvent({
          fieldName: 'getEscalationMetricSeries',
          args: { periodSeconds: 30 },
        }),
      ),
    ).rejects.toThrow('Invalid periodSeconds');

    // Boundary: 600 (between 300 and 3600) is also rejected.
    await expect(
      handler(
        makeEvent({
          fieldName: 'getEscalationMetricSeries',
          args: { periodSeconds: 600 },
        }),
      ),
    ).rejects.toThrow('Invalid periodSeconds');
  });

  test('time window > 30 days is clamped to 30 days', async () => {
    setupHappyPath();
    cwMock.on(GetMetricStatisticsCommand).resolves({ Datapoints: [] });

    const untilTs = 1_700_000_000;
    const sinceTs = untilTs - 100 * 86400; // 100 days

    const result = (await handler(
      makeEvent({
        fieldName: 'getEscalationMetricSeries',
        args: { sinceTs, untilTs, periodSeconds: 3600 },
      }),
    )) as { sinceTs: number; untilTs: number };

    expect(result.untilTs).toBe(untilTs);
    expect(result.untilTs - result.sinceTs).toBe(30 * 86400);
  });

  test('datapoints are sorted ascending by timestamp', async () => {
    setupHappyPath();
    cwMock.on(GetMetricStatisticsCommand).resolves({
      Datapoints: [
        { Sum: 2, Timestamp: new Date(3000 * 1000) },
        { Sum: 1, Timestamp: new Date(1000 * 1000) },
        { Sum: 3, Timestamp: new Date(2000 * 1000) },
      ],
    });

    const result = (await handler(
      makeEvent({
        fieldName: 'getEscalationMetricSeries',
        args: { sinceTs: 1, untilTs: 1_000_000, periodSeconds: 3600 },
      }),
    )) as { datapoints: Array<{ timestamp: number; value: number }> };

    expect(result.datapoints.map((d) => d.timestamp)).toEqual([
      1000, 2000, 3000,
    ]);
    expect(result.datapoints.map((d) => d.value)).toEqual([1, 3, 2]);
  });

  test('total equals the sum of all datapoint values', async () => {
    setupHappyPath();
    cwMock.on(GetMetricStatisticsCommand).resolves({
      Datapoints: [
        { Sum: 1, Timestamp: new Date(1000 * 1000) },
        { Sum: 4, Timestamp: new Date(2000 * 1000) },
        { Sum: 2, Timestamp: new Date(3000 * 1000) },
      ],
    });

    const result = (await handler(
      makeEvent({
        fieldName: 'getEscalationMetricSeries',
        args: { sinceTs: 1, untilTs: 1_000_000, periodSeconds: 3600 },
      }),
    )) as { total: number; datapoints: Array<{ value: number }> };

    expect(result.total).toBe(7);
  });

  test('cache hit: same args within 60s returns cached result without re-calling CloudWatch', async () => {
    setupHappyPath();
    cwMock.on(GetMetricStatisticsCommand).resolves({
      Datapoints: [{ Sum: 5, Timestamp: new Date(1000 * 1000) }],
    });

    const args = { sinceTs: 1, untilTs: 7200, periodSeconds: 3600 };

    await handler(makeEvent({ fieldName: 'getEscalationMetricSeries', args }));
    await handler(makeEvent({ fieldName: 'getEscalationMetricSeries', args }));

    expect(cwMock.commandCalls(GetMetricStatisticsCommand)).toHaveLength(1);
  });

  test('CloudWatch error propagates as a GraphQL error (not swallowed)', async () => {
    setupHappyPath();
    cwMock
      .on(GetMetricStatisticsCommand)
      .rejects(new Error('AccessDeniedException'));

    await expect(
      handler(
        makeEvent({
          fieldName: 'getEscalationMetricSeries',
          args: { sinceTs: 1, untilTs: 7200, periodSeconds: 3600 },
        }),
      ),
    ).rejects.toThrow('AccessDeniedException');
  });
});

// ---------------------------------------------------------------------------
// setGovernanceMode — Wave 2.E
// ---------------------------------------------------------------------------

describe('setGovernanceMode', () => {
  const ACK_TEXT =
    'I understand this affects production governance enforcement';
  const ORIGINAL_ENVIRONMENT = process.env.ENVIRONMENT;

  function adminEvent(input: {
    targetMode?: string;
    acknowledgement?: string;
    reason?: string | null;
  }): HandlerEvent {
    return makeEvent({
      fieldName: 'setGovernanceMode',
      args: { input },
      identity: { sub: 'actor-admin-1', username: 'admin@example.com' },
    });
  }

  /**
   * Stubs the SSM mock so the first GetParameterCommand call (for
   * /citadel/governance/enforce/<env>) returns `currentMode` and the
   * second GetParameterCommand (for /citadel/governance/effective_at/<env>)
   * returns `currentEffectiveAt`. PutParameterCommand defaults to no-op.
   *
   * The resolver may also call GetParameterCommand for effective_at again
   * after the enforce write — both calls hit the same param name, so we
   * key on the Name argument and let aws-sdk-client-mock return the right
   * value per call.
   */
  function stubSsm(opts: {
    currentMode: 'permissive' | 'shadow' | 'strict';
    currentEffectiveAt: string;
    putShouldFailOn?: 'enforce' | 'effective_at' | null;
  }) {
    const { currentMode, currentEffectiveAt, putShouldFailOn } = opts;
    ssmMock.on(GetParameterCommand).callsFake((input: GetParameterCommandInput) => {
      const name: string = input?.Name ?? '';
      if (name.includes('/enforce/')) {
        return Promise.resolve({ Parameter: { Value: currentMode } });
      }
      if (name.includes('/effective_at/')) {
        return Promise.resolve({ Parameter: { Value: currentEffectiveAt } });
      }
      return Promise.resolve({});
    });
    ssmMock.on(PutParameterCommand).callsFake((input: PutParameterCommandInput) => {
      const name: string = input?.Name ?? '';
      if (putShouldFailOn === 'enforce' && name.includes('/enforce/')) {
        return Promise.reject(new Error('SSM enforce write failed'));
      }
      if (
        putShouldFailOn === 'effective_at' &&
        name.includes('/effective_at/')
      ) {
        return Promise.reject(new Error('SSM effective_at write failed'));
      }
      return Promise.resolve({});
    });
  }

  beforeEach(() => {
    isAdminFromEventMock.mockReturnValue(true);
    // Reset event-bridge default — most tests want PutEvents to succeed.
    ebMock.on(PutEventsCommand).resolves({});
  });

  afterEach(() => {
    process.env.ENVIRONMENT = ORIGINAL_ENVIRONMENT;
  });

  test('admin gate throws Forbidden for non-admin', async () => {
    isAdminFromEventMock.mockReturnValue(false);
    await expect(
      handler(
        adminEvent({ targetMode: 'shadow', acknowledgement: ACK_TEXT }),
      ),
    ).rejects.toThrow('Forbidden: admin required');
  });

  test('acknowledgement string mismatch throws', async () => {
    await expect(
      handler(
        adminEvent({ targetMode: 'shadow', acknowledgement: 'wrong' }),
      ),
    ).rejects.toThrow('Acknowledgement string mismatch');
  });

  test('invalid targetMode throws with the offending value', async () => {
    await expect(
      handler(
        adminEvent({ targetMode: 'enforce', acknowledgement: ACK_TEXT }),
      ),
    ).rejects.toThrow('Invalid target mode: enforce');
  });

  test('permissive→shadow ALLOWED, writes SSM, returns ok', async () => {
    process.env.ENVIRONMENT = 'dev';
    stubSsm({ currentMode: 'permissive', currentEffectiveAt: '__EMPTY__' });

    const result = (await handler(
      adminEvent({ targetMode: 'shadow', acknowledgement: ACK_TEXT }),
    )) as {
      ok: boolean;
      previousMode: string;
      newMode: string;
      noop: boolean;
      emittedEventDetailType: string | null;
    };

    expect(result.ok).toBe(true);
    expect(result.previousMode).toBe('permissive');
    expect(result.newMode).toBe('shadow');
    expect(result.noop).toBe(false);
    const enforceWrites = ssmMock
      .commandCalls(PutParameterCommand)
      .filter((c) => String(c.args[0].input.Name).includes('/enforce/'));
    expect(enforceWrites).toHaveLength(1);
    expect(enforceWrites[0].args[0].input.Value).toBe('shadow');
    expect(result.emittedEventDetailType).toBe('governance.mode.transition');
  });

  test('permissive→strict in non-prod env (env=dev) ALLOWED', async () => {
    process.env.ENVIRONMENT = 'dev';
    stubSsm({ currentMode: 'permissive', currentEffectiveAt: '__EMPTY__' });

    const result = (await handler(
      adminEvent({ targetMode: 'strict', acknowledgement: ACK_TEXT }),
    )) as { ok: boolean; newMode: string };

    expect(result.ok).toBe(true);
    expect(result.newMode).toBe('strict');
  });

  test('permissive→strict in prod env (env=prod) THROWS Decision #8', async () => {
    process.env.ENVIRONMENT = 'prod';
    stubSsm({ currentMode: 'permissive', currentEffectiveAt: '__EMPTY__' });

    await expect(
      handler(
        adminEvent({ targetMode: 'strict', acknowledgement: ACK_TEXT }),
      ),
    ).rejects.toThrow('Decision #8');
    // No SSM enforce write must have happened.
    const enforceWrites = ssmMock
      .commandCalls(PutParameterCommand)
      .filter((c) => String(c.args[0].input.Name).includes('/enforce/'));
    expect(enforceWrites).toHaveLength(0);
  });

  test('shadow→strict ALLOWED', async () => {
    process.env.ENVIRONMENT = 'prod';
    stubSsm({
      currentMode: 'shadow',
      currentEffectiveAt: '2026-01-01T00:00:00.000Z',
    });

    const result = (await handler(
      adminEvent({ targetMode: 'strict', acknowledgement: ACK_TEXT }),
    )) as { ok: boolean; previousMode: string; newMode: string };

    expect(result.ok).toBe(true);
    expect(result.previousMode).toBe('shadow');
    expect(result.newMode).toBe('strict');
  });

  test('shadow→permissive ALLOWED (rollback)', async () => {
    process.env.ENVIRONMENT = 'prod';
    stubSsm({
      currentMode: 'shadow',
      currentEffectiveAt: '2026-01-01T00:00:00.000Z',
    });

    const result = (await handler(
      adminEvent({ targetMode: 'permissive', acknowledgement: ACK_TEXT }),
    )) as { ok: boolean; newMode: string };

    expect(result.ok).toBe(true);
    expect(result.newMode).toBe('permissive');
  });

  test('strict→permissive ALLOWED (rollback)', async () => {
    process.env.ENVIRONMENT = 'prod';
    stubSsm({
      currentMode: 'strict',
      currentEffectiveAt: '2026-01-01T00:00:00.000Z',
    });

    const result = (await handler(
      adminEvent({ targetMode: 'permissive', acknowledgement: ACK_TEXT }),
    )) as { ok: boolean; newMode: string };

    expect(result.ok).toBe(true);
    expect(result.newMode).toBe('permissive');
  });

  test('strict→shadow THROWS', async () => {
    process.env.ENVIRONMENT = 'prod';
    stubSsm({
      currentMode: 'strict',
      currentEffectiveAt: '2026-01-01T00:00:00.000Z',
    });

    await expect(
      handler(
        adminEvent({ targetMode: 'shadow', acknowledgement: ACK_TEXT }),
      ),
    ).rejects.toThrow('Strict can only roll back to permissive');
  });

  test('shadow→shadow returns noop:true with no SSM write', async () => {
    process.env.ENVIRONMENT = 'dev';
    stubSsm({
      currentMode: 'shadow',
      currentEffectiveAt: '2026-01-01T00:00:00.000Z',
    });

    const result = (await handler(
      adminEvent({ targetMode: 'shadow', acknowledgement: ACK_TEXT }),
    )) as {
      ok: boolean;
      noop: boolean;
      previousMode: string;
      newMode: string;
      effectiveAt: string | null;
      emittedEventDetailType: string | null;
    };

    expect(result.ok).toBe(true);
    expect(result.noop).toBe(true);
    expect(result.previousMode).toBe('shadow');
    expect(result.newMode).toBe('shadow');
    expect(result.effectiveAt).toBe('2026-01-01T00:00:00.000Z');
    expect(result.emittedEventDetailType).toBeNull();
    // Crucially: no PutParameter calls and no PutEvents calls.
    expect(ssmMock.commandCalls(PutParameterCommand)).toHaveLength(0);
    expect(ebMock.commandCalls(PutEventsCommand)).toHaveLength(0);
  });

  test('effective_at written when previously __EMPTY__ and newMode is shadow', async () => {
    process.env.ENVIRONMENT = 'dev';
    stubSsm({ currentMode: 'permissive', currentEffectiveAt: '__EMPTY__' });

    await handler(
      adminEvent({ targetMode: 'shadow', acknowledgement: ACK_TEXT }),
    );

    const effectiveAtWrites = ssmMock
      .commandCalls(PutParameterCommand)
      .filter((c) => String(c.args[0].input.Name).includes('/effective_at/'));
    expect(effectiveAtWrites).toHaveLength(1);
    // The written value is an ISO string; assert it parses.
    const writtenIso = effectiveAtWrites[0].args[0].input.Value as string;
    expect(Number.isNaN(new Date(writtenIso).getTime())).toBe(false);
  });

  test('effective_at NOT written when newMode is permissive', async () => {
    process.env.ENVIRONMENT = 'prod';
    stubSsm({
      currentMode: 'shadow',
      currentEffectiveAt: '2026-01-01T00:00:00.000Z',
    });

    await handler(
      adminEvent({ targetMode: 'permissive', acknowledgement: ACK_TEXT }),
    );

    const effectiveAtWrites = ssmMock
      .commandCalls(PutParameterCommand)
      .filter((c) => String(c.args[0].input.Name).includes('/effective_at/'));
    expect(effectiveAtWrites).toHaveLength(0);
  });

  test('audit event emitted with correct detail-type and payload', async () => {
    process.env.ENVIRONMENT = 'dev';
    stubSsm({ currentMode: 'permissive', currentEffectiveAt: '__EMPTY__' });

    await handler(
      adminEvent({
        targetMode: 'shadow',
        acknowledgement: ACK_TEXT,
        reason: 'soak window starting',
      }),
    );

    const calls = ebMock.commandCalls(PutEventsCommand);
    expect(calls).toHaveLength(1);
    const entry = calls[0].args[0].input.Entries![0];
    expect(entry.DetailType).toBe('governance.mode.transition');
    const detail = JSON.parse(entry.Detail as string);
    expect(detail.previousMode).toBe('permissive');
    expect(detail.newMode).toBe('shadow');
    expect(detail.env).toBe('dev');
    expect(detail.reason).toBe('soak window starting');
    expect(detail.actorSub).toBe('actor-admin-1');
    expect(detail.effectiveAtUpdated).toBe(true);
    // ISO timestamp is present.
    expect(typeof detail.timestamp).toBe('string');
  });

  test('SSM enforce write failure propagates as a thrown error', async () => {
    process.env.ENVIRONMENT = 'dev';
    stubSsm({
      currentMode: 'permissive',
      currentEffectiveAt: '__EMPTY__',
      putShouldFailOn: 'enforce',
    });

    await expect(
      handler(
        adminEvent({ targetMode: 'shadow', acknowledgement: ACK_TEXT }),
      ),
    ).rejects.toThrow('SSM enforce write failed');
  });

  test('effective_at write failure does NOT roll back the mode write', async () => {
    process.env.ENVIRONMENT = 'dev';
    stubSsm({
      currentMode: 'permissive',
      currentEffectiveAt: '__EMPTY__',
      putShouldFailOn: 'effective_at',
    });

    const result = (await handler(
      adminEvent({ targetMode: 'shadow', acknowledgement: ACK_TEXT }),
    )) as { ok: boolean; newMode: string; effectiveAt: string | null };

    expect(result.ok).toBe(true);
    expect(result.newMode).toBe('shadow');
    expect(result.effectiveAt).toBeNull();
    // Enforce write still happened.
    const enforceWrites = ssmMock
      .commandCalls(PutParameterCommand)
      .filter((c) => String(c.args[0].input.Name).includes('/enforce/'));
    expect(enforceWrites).toHaveLength(1);
  });

  test('audit event failure does NOT roll back the mode write', async () => {
    process.env.ENVIRONMENT = 'dev';
    stubSsm({ currentMode: 'permissive', currentEffectiveAt: '__EMPTY__' });
    ebMock.on(PutEventsCommand).rejects(new Error('eventbridge down'));

    const result = (await handler(
      adminEvent({ targetMode: 'shadow', acknowledgement: ACK_TEXT }),
    )) as { ok: boolean; newMode: string; emittedEventDetailType: string | null };

    expect(result.ok).toBe(true);
    expect(result.newMode).toBe('shadow');
    expect(result.emittedEventDetailType).toBeNull();
    // Enforce write still happened.
    const enforceWrites = ssmMock
      .commandCalls(PutParameterCommand)
      .filter((c) => String(c.args[0].input.Name).includes('/enforce/'));
    expect(enforceWrites).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// markReadinessCheckVerified — Wave 2.B.2
// ---------------------------------------------------------------------------

describe('markReadinessCheckVerified', () => {
  const ORIGINAL_ENVIRONMENT = process.env.ENVIRONMENT;

  function adminVerifyEvent(input: {
    checkId?: string;
    expiresInDays?: number | null;
    note?: string | null;
  }, identity: Record<string, unknown> = { sub: 'verifier-sub-1' }): HandlerEvent {
    return makeEvent({
      fieldName: 'markReadinessCheckVerified',
      args: { input },
      identity,
    });
  }

  beforeEach(() => {
    isAdminFromEventMock.mockReturnValue(true);
    process.env.ENVIRONMENT = 'dev';
    ssmMock.on(PutParameterCommand).resolves({});
  });

  afterEach(() => {
    process.env.ENVIRONMENT = ORIGINAL_ENVIRONMENT;
  });

  test('admin gate throws Forbidden for non-admin', async () => {
    isAdminFromEventMock.mockReturnValue(false);

    await expect(
      handler(adminVerifyEvent({ checkId: 'tel-1' })),
    ).rejects.toThrow('Forbidden: admin required');
  });

  test('rejects a real check id (data-1) — not in manual allowlist', async () => {
    await expect(
      handler(adminVerifyEvent({ checkId: 'data-1' })),
    ).rejects.toThrow(
      'Check ID not in manual-verification allowlist: data-1',
    );
  });

  test('rejects an unrecognised id (bogus) — not in manual allowlist', async () => {
    await expect(
      handler(adminVerifyEvent({ checkId: 'bogus' })),
    ).rejects.toThrow(
      'Check ID not in manual-verification allowlist: bogus',
    );
  });

  test('rejects expiresInDays = 99 (outside the 1/3/7/30 allowlist)', async () => {
    await expect(
      handler(adminVerifyEvent({ checkId: 'own-1', expiresInDays: 99 })),
    ).rejects.toThrow('Invalid expiresInDays: 99');
  });

  test('default expiresInDays = 7 when omitted', async () => {
    const before = Date.now();
    const result = (await handler(
      adminVerifyEvent({ checkId: 'own-1' }),
    )) as { verifiedAt: string; expiresAt: string };
    const after = Date.now();

    const verifiedMs = Date.parse(result.verifiedAt);
    const expiresMs = Date.parse(result.expiresAt);
    expect(expiresMs - verifiedMs).toBe(7 * 86_400_000);
    expect(verifiedMs).toBeGreaterThanOrEqual(before);
    expect(verifiedMs).toBeLessThanOrEqual(after);
  });

  test('writes SSM with the expected name + JSON shape', async () => {
    await handler(
      adminVerifyEvent({
        checkId: 'own-1',
        expiresInDays: 3,
        note: 'paged Bob in #ops',
      }),
    );

    const puts = ssmMock.commandCalls(PutParameterCommand);
    expect(puts).toHaveLength(1);
    const input = puts[0].args[0].input;
    expect(input.Name).toBe(
      '/citadel/governance/readiness/manual/dev/own-1',
    );
    expect(input.Type).toBe('String');
    expect(input.Overwrite).toBe(true);
    const payload = JSON.parse(String(input.Value));
    expect(payload.verifiedAt).toEqual(expect.any(String));
    expect(payload.verifiedBy).toBe('verifier-sub-1');
    expect(payload.expiresAt).toEqual(expect.any(String));
    expect(payload.note).toBe('paged Bob in #ops');
  });

  test('returns ok with computed expiresAt = verifiedAt + days', async () => {
    const result = (await handler(
      adminVerifyEvent({ checkId: 'own-1', expiresInDays: 30 }),
    )) as {
      ok: boolean;
      checkId: string;
      verifiedAt: string;
      expiresAt: string;
      verifiedBy: string;
    };

    expect(result.ok).toBe(true);
    expect(result.checkId).toBe('own-1');
    expect(result.verifiedBy).toBe('verifier-sub-1');
    const verifiedMs = Date.parse(result.verifiedAt);
    const expiresMs = Date.parse(result.expiresAt);
    expect(expiresMs - verifiedMs).toBe(30 * 86_400_000);
  });

  test('verifiedBy comes from event.identity.sub', async () => {
    const result = (await handler(
      adminVerifyEvent({ checkId: 'own-1' }, {
        sub: 'sub-from-token',
        username: 'user@example.com',
      }),
    )) as { verifiedBy: string };

    expect(result.verifiedBy).toBe('sub-from-token');
  });

  test('verifiedBy falls back to identity.username when sub absent', async () => {
    const result = (await handler(
      adminVerifyEvent({ checkId: 'own-1' }, {
        username: 'user@example.com',
      }),
    )) as { verifiedBy: string };

    expect(result.verifiedBy).toBe('user@example.com');
  });

  test('verifiedBy falls back to "unknown" when neither sub nor username present', async () => {
    const result = (await handler(
      adminVerifyEvent({ checkId: 'own-1' }, {}),
    )) as { verifiedBy: string };

    expect(result.verifiedBy).toBe('unknown');
  });

  test('SSM write failure propagates as a thrown error', async () => {
    ssmMock.on(PutParameterCommand).rejects(new Error('SSM PutParameter denied'));

    await expect(
      handler(adminVerifyEvent({ checkId: 'own-1' })),
    ).rejects.toThrow('SSM PutParameter denied');
  });
});

// ---------------------------------------------------------------------------
// getRolloutReadiness — Wave 2.B.2 verification overlay
// ---------------------------------------------------------------------------

describe('getRolloutReadiness verification overlay (Wave 2.B.2)', () => {
  const ORIGINAL_ENVIRONMENT = process.env.ENVIRONMENT;

  beforeEach(() => {
    isAdminFromEventMock.mockReturnValue(true);
    getGovernanceEnforceMock.mockResolvedValue('permissive');
    getGovernanceEffectiveAtMock.mockResolvedValue(null);
    process.env.ENVIRONMENT = 'dev';
    ddbMock.on(ScanCommand).resolves({ Items: [], ScannedCount: 0 });
    listResourcesMock.mockRejectedValue(new Error('skip'));
    cwMock.on(GetMetricStatisticsCommand).rejects(new Error('skip'));
  });

  afterEach(() => {
    process.env.ENVIRONMENT = ORIGINAL_ENVIRONMENT;
  });

  /**
   * Configure SSM responses so each manual check id maps to a custom
   * record (or to undefined for "no verification" / "param not found").
   * Falls through to ParameterNotFound for unmapped names.
   */
  function stubSsmForManual(
    map: Record<string, { value?: string; throws?: boolean } | undefined>,
  ) {
    ssmMock.on(GetParameterCommand).callsFake((input: GetParameterCommandInput) => {
      const name: string = input?.Name ?? '';
      const m = name.match(
        /\/citadel\/governance\/readiness\/manual\/[^/]+\/([^/]+)$/,
      );
      if (m) {
        const id = m[1];
        const cfg = map[id];
        if (!cfg) {
          const err = new Error('Parameter not found');
          (err as { name: string }).name = 'ParameterNotFound';
          return Promise.reject(err);
        }
        if (cfg.throws) {
          return Promise.reject(new Error('SSM access denied'));
        }
        return Promise.resolve({ Parameter: { Value: cfg.value } });
      }
      // rb-1 reads /citadel/governance/enforce/<env> — keep UNKNOWN by
      // default so the test isolates the verification overlay.
      const err = new Error('Parameter not found');
      (err as { name: string }).name = 'ParameterNotFound';
      return Promise.reject(err);
    });
  }

  function findCheck(checks: Array<{ id: string }>, id: string) {
    return checks.find((c) => c.id === id) as
      | {
          id: string;
          status: string;
          detail: string | null;
          evidence: string | null;
        }
      | undefined;
  }

  test('manual check own-2 with non-expired verification → status PASS', async () => {
    const futureExpiry = new Date(Date.now() + 86_400_000).toISOString();
    stubSsmForManual({
      'own-2': {
        value: JSON.stringify({
          verifiedAt: '2026-05-19T08:00:00.000Z',
          verifiedBy: 'alice@example.com',
          expiresAt: futureExpiry,
          note: 'dashboard reviewed',
        }),
      },
    });

    const result = (await handler(
      makeEvent({ fieldName: 'getRolloutReadiness' }),
    )) as { checks: Array<{ id: string }> };

    const ownTwo = findCheck(result.checks, 'own-2')!;
    expect(ownTwo.status).toBe('PASS');
    expect(ownTwo.detail).toBe(
      `Verified by alice@example.com at 2026-05-19T08:00:00.000Z, expires ${futureExpiry}`,
    );
  });

  test('manual check own-1 with expired verification → STUB with "Verification expired" detail', async () => {
    const pastExpiry = new Date(Date.now() - 60_000).toISOString();
    stubSsmForManual({
      'own-1': {
        value: JSON.stringify({
          verifiedAt: '2026-05-01T08:00:00.000Z',
          verifiedBy: 'alice@example.com',
          expiresAt: pastExpiry,
          note: null,
        }),
      },
    });

    const result = (await handler(
      makeEvent({ fieldName: 'getRolloutReadiness' }),
    )) as { checks: Array<{ id: string }> };

    const ownOne = findCheck(result.checks, 'own-1')!;
    expect(ownOne.status).toBe('STUB');
    expect(ownOne.detail).toBe(
      `Verification expired ${pastExpiry} — re-mark required`,
    );
  });

  test('2 manual verified + 8 real PASS → passCount = 10, stubCount = 1', async () => {
    // Real-check happy paths (data-1, data-2, data-3, tel-1, tel-2, tel-3, rb-1, rb-2):
    const telOneOldTs = Math.floor(Date.now() / 1000) - 10 * 86_400;
    ddbMock.on(ScanCommand).callsFake((input: ScanCommandInput) => {
      if (input.TableName === 'citadel-governance-ledger-test') {
        if (input.Select === 'COUNT') {
          // tel-2: total >= 100, mismatches < 0.5%.
          const isMismatch =
            String(input.FilterExpression ?? '').includes(':deny');
          return Promise.resolve({ Count: isMismatch ? 0 : 1000 });
        }
        // tel-1: at least one ledger row >= 7 days old.
        return Promise.resolve({
          Items: [{ timestamp: telOneOldTs, decision: 'deny' }],
          ScannedCount: 1,
        });
      }
      return Promise.resolve({ Items: makeUnits(3), ScannedCount: 3 });
    });
    getResourceMock.mockResolvedValue({
      recordId: 'rec',
      name: 'n',
      status: 'APPROVED',
    });
    listResourcesMock.mockImplementation(async (type: 'agent' | 'tool') => [
      {
        recordId: type === 'agent' ? 'a-1' : 't-1',
        name: 'n',
        status: 'APPROVED',
        customDescriptorContent: JSON.stringify({ registryId: 'wid' }),
      },
    ]);
    cwMock.on(GetMetricStatisticsCommand).resolves({ Datapoints: [] });

    // Manual: 2 verified (own-1, own-2), own-3 absent.
    const futureExpiry = new Date(Date.now() + 86_400_000).toISOString();
    const recordValue = (verifier: string) =>
      JSON.stringify({
        verifiedAt: '2026-05-19T08:00:00.000Z',
        verifiedBy: verifier,
        expiresAt: futureExpiry,
        note: null,
      });
    ssmMock.on(GetParameterCommand).callsFake((input: GetParameterCommandInput) => {
      const name: string = input?.Name ?? '';
      if (name.endsWith('/enforce/dev')) {
        // rb-1 PASS path
        return Promise.resolve({ Parameter: { Value: 'permissive' } });
      }
      const m = name.match(
        /\/citadel\/governance\/readiness\/manual\/[^/]+\/([^/]+)$/,
      );
      if (m) {
        const id = m[1];
        if (id === 'own-3') {
          const err = new Error('Parameter not found');
          (err as { name: string }).name = 'ParameterNotFound';
          return Promise.reject(err);
        }
        return Promise.resolve({ Parameter: { Value: recordValue(id) } });
      }
      const err = new Error('Parameter not found');
      (err as { name: string }).name = 'ParameterNotFound';
      return Promise.reject(err);
    });
    // rb-2 PASS — history with a recent transition into 'permissive'.
    ssmMock.on(GetParameterHistoryCommand).resolves({
      Parameters: [
        { Value: 'permissive', LastModifiedDate: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
        { Value: 'shadow', LastModifiedDate: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000) },
        { Value: 'permissive', LastModifiedDate: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000) },
      ],
    });

    const result = (await handler(
      makeEvent({ fieldName: 'getRolloutReadiness' }),
    )) as {
      passCount: number;
      failCount: number;
      warnCount: number;
      stubCount: number;
    };

    expect(result.passCount).toBe(10);
    expect(result.failCount).toBe(0);
    expect(result.warnCount).toBe(0);
    expect(result.stubCount).toBe(1);
  });

  test('all 3 manual verified + all 8 real PASS → passCount = 11, stubCount = 0', async () => {
    const telOneOldTs = Math.floor(Date.now() / 1000) - 10 * 86_400;
    ddbMock.on(ScanCommand).callsFake((input: ScanCommandInput) => {
      if (input.TableName === 'citadel-governance-ledger-test') {
        if (input.Select === 'COUNT') {
          const isMismatch =
            String(input.FilterExpression ?? '').includes(':deny');
          return Promise.resolve({ Count: isMismatch ? 0 : 1000 });
        }
        return Promise.resolve({
          Items: [{ timestamp: telOneOldTs, decision: 'deny' }],
          ScannedCount: 1,
        });
      }
      return Promise.resolve({ Items: makeUnits(3), ScannedCount: 3 });
    });
    getResourceMock.mockResolvedValue({
      recordId: 'rec',
      name: 'n',
      status: 'APPROVED',
    });
    listResourcesMock.mockImplementation(async (type: 'agent' | 'tool') => [
      {
        recordId: type === 'agent' ? 'a-1' : 't-1',
        name: 'n',
        status: 'APPROVED',
        customDescriptorContent: JSON.stringify({ registryId: 'wid' }),
      },
    ]);
    cwMock.on(GetMetricStatisticsCommand).resolves({ Datapoints: [] });

    const futureExpiry = new Date(Date.now() + 86_400_000).toISOString();
    const recordValue = (verifier: string) =>
      JSON.stringify({
        verifiedAt: '2026-05-19T08:00:00.000Z',
        verifiedBy: verifier,
        expiresAt: futureExpiry,
        note: null,
      });
    ssmMock.on(GetParameterCommand).callsFake((input: GetParameterCommandInput) => {
      const name: string = input?.Name ?? '';
      if (name.endsWith('/enforce/dev')) {
        return Promise.resolve({ Parameter: { Value: 'permissive' } });
      }
      const m = name.match(
        /\/citadel\/governance\/readiness\/manual\/[^/]+\/([^/]+)$/,
      );
      if (m) {
        return Promise.resolve({ Parameter: { Value: recordValue(m[1]) } });
      }
      const err = new Error('Parameter not found');
      (err as { name: string }).name = 'ParameterNotFound';
      return Promise.reject(err);
    });
    // rb-2 PASS — history with a recent transition into 'permissive'.
    ssmMock.on(GetParameterHistoryCommand).resolves({
      Parameters: [
        { Value: 'permissive', LastModifiedDate: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
        { Value: 'shadow', LastModifiedDate: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000) },
        { Value: 'permissive', LastModifiedDate: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000) },
      ],
    });

    const result = (await handler(
      makeEvent({ fieldName: 'getRolloutReadiness' }),
    )) as {
      passCount: number;
      failCount: number;
      warnCount: number;
      stubCount: number;
    };

    expect(result.passCount).toBe(11);
    expect(result.stubCount).toBe(0);
  });

  test('SSM read failure (non-NotFound) on a single manual check does not crater the report', async () => {
    const futureExpiry = new Date(Date.now() + 86_400_000).toISOString();
    const recordValue = (verifier: string) =>
      JSON.stringify({
        verifiedAt: '2026-05-19T08:00:00.000Z',
        verifiedBy: verifier,
        expiresAt: futureExpiry,
        note: null,
      });
    ssmMock.on(GetParameterCommand).callsFake((input: GetParameterCommandInput) => {
      const name: string = input?.Name ?? '';
      const m = name.match(
        /\/citadel\/governance\/readiness\/manual\/[^/]+\/([^/]+)$/,
      );
      if (m) {
        const id = m[1];
        if (id === 'own-2') {
          return Promise.reject(new Error('AccessDenied on own-2'));
        }
        return Promise.resolve({ Parameter: { Value: recordValue(id) } });
      }
      const err = new Error('Parameter not found');
      (err as { name: string }).name = 'ParameterNotFound';
      return Promise.reject(err);
    });

    const result = (await handler(
      makeEvent({ fieldName: 'getRolloutReadiness' }),
    )) as { checks: Array<{ id: string; status: string }> };

    // own-2 → STUB (read failure swallowed)
    const ownTwo = result.checks.find((c) => c.id === 'own-2')!;
    expect(ownTwo.status).toBe('STUB');
    // The other 2 manual checks → PASS
    for (const id of ['own-1', 'own-3']) {
      const c = result.checks.find((x) => x.id === id)!;
      expect(c.status).toBe('PASS');
    }
  });
});


// ---------------------------------------------------------------------------
// getDecisionTrace — Wave 3.B
// ---------------------------------------------------------------------------

describe('getDecisionTrace', () => {
  function ledgerRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return makeDdbRow({
      decision: 'permit',
      reason: 'scope_match:unit-1',
      scope_evaluated: 'unit-1',
      contract_evaluated: null,
      residual_authority_denial: false,
      ...overrides,
    });
  }

  function assertEightSteps(steps: Array<{ stepNumber: number; status: string; inputs: string; outputs: string | null }>) {
    expect(steps).toHaveLength(8);
    for (let i = 0; i < 8; i++) {
      expect(steps[i].stepNumber).toBe(i + 1);
      // Inputs JSON parses on every step.
      expect(() => JSON.parse(steps[i].inputs)).not.toThrow();
      // Outputs JSON parses when present.
      if (steps[i].outputs !== null) {
        expect(() => JSON.parse(steps[i].outputs as string)).not.toThrow();
      }
    }
    // Step 2 is always pass-through per Wave 3.B spec.
    expect(steps[1].status).toBe('pass-through');
  }

  test('returns null when finding not found', async () => {
    ddbMock.on(GetCommand).resolves({});

    const result = await handler(
      makeEvent({
        fieldName: 'getDecisionTrace',
        args: { findingId: 'missing-id' },
      }),
    );
    expect(result).toBeNull();
  });

  test('case-law match: step 1 matched, terminal=1, others skipped', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: ledgerRow({
        decision: 'permit',
        reason: 'case_law:case-42',
        scope_evaluated: null,
        contract_evaluated: null,
      }),
    });

    const result = (await handler(
      makeEvent({
        fieldName: 'getDecisionTrace',
        args: { findingId: 'finding-1' },
      }),
    )) as {
      terminalDecision: string;
      terminalStepNumber: number;
      reasonTokens: string[];
      constitutionalOverride: boolean;
      arbitrationPattern: string | null;
      scopeReduction: string | null;
      steps: Array<{ stepNumber: number; status: string; inputs: string; outputs: string | null }>;
    };

    assertEightSteps(result.steps);
    expect(result.terminalDecision).toBe('permit');
    expect(result.terminalStepNumber).toBe(1);
    expect(result.steps[0].status).toBe('matched');
    // Steps 3..7 skipped on case-law hits.
    for (const stepNum of [3, 4, 5, 6, 7]) {
      expect(result.steps[stepNum - 1].status).toBe('skipped');
    }
    expect(result.steps[7].status).toBe('skipped');
    expect(result.constitutionalOverride).toBe(false);
    expect(result.arbitrationPattern).toBeNull();
    expect(result.scopeReduction).toBeNull();
    expect(result.reasonTokens).toEqual(['case_law', 'case-42']);
    // Step 1 outputs include the case_id.
    const step1Output = JSON.parse(result.steps[0].outputs as string);
    expect(step1Output.case_id).toBe('case-42');
  });

  test('case-law PERMIT with constitutional override: terminal=8, override=true', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: ledgerRow({
        decision: 'deny',
        reason:
          'constitutional_review:layer-global:invariant_violated:max_tokens',
        scope_evaluated: 'unit-1',
        contract_evaluated: null,
      }),
    });

    const result = (await handler(
      makeEvent({
        fieldName: 'getDecisionTrace',
        args: { findingId: 'finding-1' },
      }),
    )) as {
      terminalStepNumber: number;
      constitutionalOverride: boolean;
      steps: Array<{ stepNumber: number; status: string; outputs: string | null }>;
    };

    expect(result.constitutionalOverride).toBe(true);
    expect(result.terminalStepNumber).toBe(8);
    expect(result.steps[7].status).toBe('overridden');
    const step8Output = JSON.parse(result.steps[7].outputs as string);
    expect(step8Output.override_layer).toBe('layer-global');
    expect(step8Output.override_field).toBe('max_tokens');
    expect(step8Output.decision).toBe('deny');
  });

  test('residual-authority denial: step 4 denied, terminal=4', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: ledgerRow({
        decision: 'deny',
        reason: 'residual_authority_denial:no_scope_covers_action',
        scope_evaluated: null,
        contract_evaluated: null,
        residual_authority_denial: true,
      }),
    });

    const result = (await handler(
      makeEvent({
        fieldName: 'getDecisionTrace',
        args: { findingId: 'finding-1' },
      }),
    )) as {
      terminalStepNumber: number;
      steps: Array<{ stepNumber: number; status: string }>;
    };

    expect(result.terminalStepNumber).toBe(4);
    expect(result.steps[0].status).toBe('pass-through');
    expect(result.steps[2].status).toBe('matched');
    expect(result.steps[3].status).toBe('denied');
    // Steps 5..8 skipped.
    for (const stepNum of [5, 6, 7, 8]) {
      expect(result.steps[stepNum - 1].status).toBe('skipped');
    }
  });

  test('scope-match permit: step 7 permitted, terminal=7', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: ledgerRow({
        decision: 'permit',
        reason: 'scope_match:unit-42',
        scope_evaluated: 'unit-42',
        contract_evaluated: null,
      }),
    });

    const result = (await handler(
      makeEvent({
        fieldName: 'getDecisionTrace',
        args: { findingId: 'finding-1' },
      }),
    )) as {
      terminalStepNumber: number;
      steps: Array<{ stepNumber: number; status: string; outputs: string | null }>;
    };

    expect(result.terminalStepNumber).toBe(7);
    expect(result.steps[0].status).toBe('pass-through');
    expect(result.steps[2].status).toBe('matched');
    expect(result.steps[3].status).toBe('pass-through');
    expect(result.steps[4].status).toBe('matched');
    expect(result.steps[5].status).toBe('pass-through');
    expect(result.steps[6].status).toBe('permitted');
    expect(result.steps[7].status).toBe('skipped');
    // Step 5 outputs include the scope_evaluated.
    const step5Output = JSON.parse(result.steps[4].outputs as string);
    expect(step5Output.scope_evaluated).toBe('unit-42');
    // Step 7 outputs include the permit decision.
    const step7Output = JSON.parse(result.steps[6].outputs as string);
    expect(step7Output.decision).toBe('permit');
    expect(step7Output.scope_evaluated).toBe('unit-42');
  });

  test('scope-match permit + constitutional override: terminal=8, override=true', async () => {
    // The engine rewrites the reason on override, so callers see the
    // constitutional_review: prefix. Verify that path lights up step 8
    // and pass-throughs the upstream pipeline rather than mis-asserting
    // a permit at step 7.
    ddbMock.on(GetCommand).resolves({
      Item: ledgerRow({
        decision: 'deny',
        reason:
          'constitutional_review:layer-pairwise:invariant_violated:tool_allowlist',
        scope_evaluated: 'unit-7',
        contract_evaluated: null,
      }),
    });

    const result = (await handler(
      makeEvent({
        fieldName: 'getDecisionTrace',
        args: { findingId: 'finding-1' },
      }),
    )) as {
      terminalStepNumber: number;
      constitutionalOverride: boolean;
      steps: Array<{ stepNumber: number; status: string }>;
    };

    expect(result.terminalStepNumber).toBe(8);
    expect(result.constitutionalOverride).toBe(true);
    expect(result.steps[7].status).toBe('overridden');
  });

  test.each([
    'deferred_authority',
    'unilateral_sovereignty',
    'rivalrous_claim',
    'collaborative_composition',
  ])(
    'arbitration pattern %s sets arbitrationPattern and terminal=6',
    async (pattern) => {
      ddbMock.on(GetCommand).resolves({
        Item: ledgerRow({
          decision: 'permit',
          reason: `${pattern}:both_permit`,
          scope_evaluated: 'unit-1',
          contract_evaluated: 'contract-1',
        }),
      });

      const result = (await handler(
        makeEvent({
          fieldName: 'getDecisionTrace',
          args: { findingId: 'finding-1' },
        }),
      )) as {
        terminalStepNumber: number;
        arbitrationPattern: string | null;
        steps: Array<{ stepNumber: number; status: string; outputs: string | null }>;
      };

      expect(result.arbitrationPattern).toBe(pattern);
      expect(result.terminalStepNumber).toBe(6);
      expect(result.steps[5].status).toBe('matched');
      expect(result.steps[6].status).toBe('skipped');
      // Step 6 outputs include the contract_evaluated.
      const step6Output = JSON.parse(result.steps[5].outputs as string);
      expect(step6Output.contract_evaluated).toBe('contract-1');
      expect(step6Output.arbitrationPattern).toBe(pattern);
    },
  );

  test(':unconfirmed_state suffix sets scopeReduction = unconfirmed_state', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: ledgerRow({
        decision: 'deny',
        reason: 'deferred_authority:unconfirmed_state',
        scope_evaluated: 'unit-1',
        contract_evaluated: 'contract-1',
      }),
    });

    const result = (await handler(
      makeEvent({
        fieldName: 'getDecisionTrace',
        args: { findingId: 'finding-1' },
      }),
    )) as {
      arbitrationPattern: string | null;
      scopeReduction: string | null;
      steps: Array<{ status: string; outputs: string | null }>;
    };

    expect(result.scopeReduction).toBe('unconfirmed_state');
    expect(result.arbitrationPattern).toBe('deferred_authority');
    // Step 6 reflects the deny → 'denied' status.
    expect(result.steps[5].status).toBe('denied');
  });

  test(':attenuation suffix sets scopeReduction = attenuation', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: ledgerRow({
        decision: 'permit',
        reason: 'rivalrous_claim:winner=A:loser=B:attenuation',
        scope_evaluated: 'unit-1',
        contract_evaluated: 'contract-1',
      }),
    });

    const result = (await handler(
      makeEvent({
        fieldName: 'getDecisionTrace',
        args: { findingId: 'finding-1' },
      }),
    )) as {
      arbitrationPattern: string | null;
      scopeReduction: string | null;
      reasonTokens: string[];
    };

    expect(result.scopeReduction).toBe('attenuation');
    expect(result.arbitrationPattern).toBe('rivalrous_claim');
    expect(result.reasonTokens).toEqual([
      'rivalrous_claim',
      'winner=A',
      'loser=B',
      'attenuation',
    ]);
  });

  test('reason tokens parsed correctly for rivalrous_claim with 4 tokens', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: ledgerRow({
        decision: 'permit',
        reason: 'rivalrous_claim:winner=X:loser=Y:attenuation',
        scope_evaluated: 'unit-1',
        contract_evaluated: 'contract-1',
      }),
    });

    const result = (await handler(
      makeEvent({
        fieldName: 'getDecisionTrace',
        args: { findingId: 'finding-1' },
      }),
    )) as { reasonTokens: string[] };

    expect(result.reasonTokens).toHaveLength(4);
    expect(result.reasonTokens[0]).toBe('rivalrous_claim');
    expect(result.reasonTokens[1]).toBe('winner=X');
    expect(result.reasonTokens[2]).toBe('loser=Y');
    expect(result.reasonTokens[3]).toBe('attenuation');
  });

  test('all 8 steps always present; step 2 always pass-through', async () => {
    // Three different reason shapes — every one must yield 8 steps with
    // step 2 pass-through.
    const cases = [
      'case_law:c-1',
      'residual_authority_denial:none',
      'scope_match:unit-1',
      'deferred_authority:both_permit',
    ];
    for (const reason of cases) {
      ddbMock.reset();
      ddbMock
        .on(GetCommand)
        .resolves({ Item: ledgerRow({ decision: 'permit', reason }) });

      const result = (await handler(
        makeEvent({
          fieldName: 'getDecisionTrace',
          args: { findingId: 'finding-1' },
        }),
      )) as { steps: Array<{ stepNumber: number; status: string }> };

      expect(result.steps).toHaveLength(8);
      expect(result.steps[1].status).toBe('pass-through');
      expect(result.steps[1].name).toBe('Composition arbitration scaffold');
    }
  });

  test('inputs/outputs JSON parses cleanly for every step', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: ledgerRow({
        decision: 'permit',
        reason: 'scope_match:unit-7',
        scope_evaluated: 'unit-7',
      }),
    });

    const result = (await handler(
      makeEvent({
        fieldName: 'getDecisionTrace',
        args: { findingId: 'finding-1' },
      }),
    )) as {
      steps: Array<{ stepNumber: number; inputs: string; outputs: string | null }>;
    };

    for (const step of result.steps) {
      expect(typeof step.inputs).toBe('string');
      const parsedInputs = JSON.parse(step.inputs);
      expect(parsedInputs).toBeInstanceOf(Object);
      if (step.outputs !== null) {
        const parsedOutputs = JSON.parse(step.outputs);
        expect(parsedOutputs).toBeInstanceOf(Object);
      }
    }
  });

  test('inner finding is projected via projectFinding (snake → camel)', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: ledgerRow({
        findingId: 'f-77',
        decision: 'permit',
        reason: 'scope_match:unit-1',
      }),
    });

    const result = (await handler(
      makeEvent({
        fieldName: 'getDecisionTrace',
        args: { findingId: 'f-77' },
      }),
    )) as {
      findingId: string;
      finding: { findingId: string; requestingAgent: string; targetAgent: string };
    };

    expect(result.findingId).toBe('f-77');
    expect(result.finding.findingId).toBe('f-77');
    expect(result.finding.requestingAgent).toBe('agent-a');
    expect(result.finding.targetAgent).toBe('agent-b');
  });

  test('unrecognised reason format degrades gracefully (pass-through, arbitrationPattern null)', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: ledgerRow({
        decision: 'permit',
        reason: 'totally_unknown_prefix:foo',
        scope_evaluated: 'unit-1',
      }),
    });

    const result = (await handler(
      makeEvent({
        fieldName: 'getDecisionTrace',
        args: { findingId: 'finding-1' },
      }),
    )) as {
      arbitrationPattern: string | null;
      constitutionalOverride: boolean;
      steps: Array<{ status: string }>;
    };

    expect(result.arbitrationPattern).toBeNull();
    expect(result.constitutionalOverride).toBe(false);
    // No step asserts a wrong matched/denied/permitted status — every
    // upstream step renders pass-through under the unknown-format
    // fallback.
    for (const step of result.steps) {
      expect(['pass-through', 'skipped']).toContain(step.status);
    }
  });
});

// ---------------------------------------------------------------------------
// Wave 3.C — publishGovernanceFinding (fanout-only mutation)
// ---------------------------------------------------------------------------

describe('publishGovernanceFinding', () => {
  const validInput = {
    findingId: 'f-pub-1',
    workflowId: 'wf-pub-1',
    decision: 'permit',
    reason: 'unit_match:unit-a',
    requestingAgent: 'agent-a',
    targetAgent: 'agent-b',
    scopeEvaluated: 'unit-a',
    contractEvaluated: null,
    escalationTarget: null,
    residualAuthorityDenial: false,
    timestamp: 1715000000.5,
  };

  it('rejects when identity is undefined (anonymous / API key)', async () => {
    await expect(
      handler({
        arguments: { input: validInput },
        // No identity at all — pass through as undefined.
        identity: undefined,
        info: {
          fieldName: 'publishGovernanceFinding',
          parentTypeName: 'Mutation',
          variables: {},
        },
        request: { headers: {} },
        source: null,
        prev: null,
        stash: {},
      } as unknown as HandlerEvent),
    ).rejects.toThrow(/Forbidden: publishGovernanceFinding is IAM-only/);
  });

  it('rejects when identity is a Cognito user-pool shape (claims present)', async () => {
    await expect(
      handler(
        makeEvent({
          fieldName: 'publishGovernanceFinding',
          args: { input: validInput },
          identity: {
            sub: 'sub-1',
            claims: { 'cognito:username': 'alice', 'cognito:groups': ['admin'] },
            username: 'alice',
          },
        }),
      ),
    ).rejects.toThrow(/Forbidden: publishGovernanceFinding is IAM-only/);
  });

  it('rejects when identity has sub but no accountId (OIDC-style)', async () => {
    await expect(
      handler(
        makeEvent({
          fieldName: 'publishGovernanceFinding',
          args: { input: validInput },
          identity: { sub: 'sub-2', issuer: 'https://oidc.example' },
        }),
      ),
    ).rejects.toThrow(/Forbidden: publishGovernanceFinding is IAM-only/);
  });

  it('accepts an IAM identity (accountId + no claims) and returns the input unchanged', async () => {
    const result = (await handler(
      makeEvent({
        fieldName: 'publishGovernanceFinding',
        args: { input: validInput },
        identity: {
          accountId: '123456789012',
          userArn: 'arn:aws:sts::123456789012:assumed-role/Fanout/abc',
          cognitoIdentityPoolId: null,
          sourceIp: ['10.0.0.1'],
        },
      }),
    )) as typeof validInput;

    expect(result).toEqual(validInput);
  });

  it('throws when input is missing on the IAM-authed event', async () => {
    await expect(
      handler(
        makeEvent({
          fieldName: 'publishGovernanceFinding',
          args: {},
          identity: {
            accountId: '123456789012',
            userArn: 'arn:aws:sts::123456789012:assumed-role/Fanout/abc',
          },
        }),
      ),
    ).rejects.toThrow(/missing input/);
  });
});


// ---------------------------------------------------------------------------
// listAuthorityUnits — Wave 4.A
// ---------------------------------------------------------------------------

describe('listAuthorityUnits', () => {
  function makeUnitRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      unitId: 'u-1',
      agentId: 'agent-a',
      scope: JSON.stringify({
        decision_type: 'invoke_agent',
        domain: 'payment',
        conditions: { tier: 'gold' },
        limits: { max_amount: 1000 },
      }),
      delegationSource: null,
      canRedelegate: false,
      expiryTimestamp: null,
      revoked: false,
      riskRating: 'low',
      registryId: 'reg-app-1',
      ...overrides,
    };
  }

  test('throws when caller is not admin', async () => {
    isAdminFromEventMock.mockReturnValue(false);

    await expect(
      handler(makeEvent({ fieldName: 'listAuthorityUnits' })),
    ).rejects.toThrow('Forbidden: admin required');
  });

  test('returns [] when DDB scan returns no items', async () => {
    isAdminFromEventMock.mockReturnValue(true);
    ddbMock.on(ScanCommand).resolves({ Items: [] });

    const result = (await handler(
      makeEvent({ fieldName: 'listAuthorityUnits' }),
    )) as unknown[];

    expect(result).toEqual([]);
  });

  test('returns all units when registryId is omitted', async () => {
    isAdminFromEventMock.mockReturnValue(true);
    ddbMock.on(ScanCommand).resolves({
      Items: [
        makeUnitRow({ unitId: 'u-1', registryId: 'reg-app-1' }),
        makeUnitRow({ unitId: 'u-2', registryId: 'reg-app-2' }),
        makeUnitRow({ unitId: 'u-3', registryId: '*GLOBAL*' }),
      ],
    });

    const result = (await handler(
      makeEvent({ fieldName: 'listAuthorityUnits' }),
    )) as Array<{ unitId: string; registryId: string }>;

    expect(result).toHaveLength(3);
    const ids = result.map((u) => u.unitId).sort();
    expect(ids).toEqual(['u-1', 'u-2', 'u-3']);
  });

  test('filters by registryId (only :rid or *GLOBAL*) via scan filter expression', async () => {
    isAdminFromEventMock.mockReturnValue(true);
    ddbMock.on(ScanCommand).resolves({ Items: [] });

    await handler(
      makeEvent({
        fieldName: 'listAuthorityUnits',
        args: { registryId: 'reg-app-1' },
      }),
    );

    const calls = ddbMock.commandCalls(ScanCommand);
    expect(calls).toHaveLength(1);
    const input = calls[0].args[0].input;
    expect(input.FilterExpression).toContain('#rid IN (:rid, :global)');
    expect(input.ExpressionAttributeNames).toMatchObject({ '#rid': 'registryId' });
    expect(input.ExpressionAttributeValues).toMatchObject({
      ':rid': 'reg-app-1',
      ':global': '*GLOBAL*',
    });
  });

  test('excludes revoked units by default and includes them when includeRevoked=true', async () => {
    isAdminFromEventMock.mockReturnValue(true);
    ddbMock.on(ScanCommand).resolves({ Items: [] });

    // Default: revoked excluded.
    await handler(makeEvent({ fieldName: 'listAuthorityUnits' }));
    let input = ddbMock.commandCalls(ScanCommand)[0].args[0].input;
    expect(input.FilterExpression).toContain('#revoked');
    expect(input.ExpressionAttributeValues).toMatchObject({ ':false': false });

    // includeRevoked=true: revoked filter NOT applied.
    ddbMock.reset();
    isAdminFromEventMock.mockReturnValue(true);
    __resetAuthorityUnitsCacheForTest();
    ddbMock.on(ScanCommand).resolves({ Items: [] });

    await handler(
      makeEvent({
        fieldName: 'listAuthorityUnits',
        args: { includeRevoked: true },
      }),
    );

    input = ddbMock.commandCalls(ScanCommand)[0].args[0].input;
    // FilterExpression may be undefined or omit the revoked clause when
    // includeRevoked is true and registryId is not supplied.
    expect(input.FilterExpression ?? '').not.toContain('#revoked');
  });

  test('computes specificity from conditions + limits keys', async () => {
    isAdminFromEventMock.mockReturnValue(true);
    ddbMock.on(ScanCommand).resolves({
      Items: [
        makeUnitRow({
          unitId: 'u-empty',
          scope: JSON.stringify({
            decision_type: '*',
            domain: '*',
            conditions: {},
            limits: {},
          }),
        }),
        makeUnitRow({
          unitId: 'u-three',
          scope: JSON.stringify({
            decision_type: 'invoke',
            domain: 'p',
            conditions: { a: 1, b: 2 },
            limits: { c: 3 },
          }),
        }),
      ],
    });

    const result = (await handler(
      makeEvent({ fieldName: 'listAuthorityUnits' }),
    )) as Array<{ unitId: string; scope: { specificity: number } }>;

    const byId = Object.fromEntries(result.map((u) => [u.unitId, u]));
    expect(byId['u-empty'].scope.specificity).toBe(0);
    expect(byId['u-three'].scope.specificity).toBe(3);
  });

  test('computes isValid: revoked=true -> false', async () => {
    isAdminFromEventMock.mockReturnValue(true);
    ddbMock.on(ScanCommand).resolves({
      Items: [makeUnitRow({ unitId: 'u-rev', revoked: true })],
    });

    const result = (await handler(
      makeEvent({
        fieldName: 'listAuthorityUnits',
        args: { includeRevoked: true },
      }),
    )) as Array<{ isValid: boolean; revoked: boolean }>;

    expect(result).toHaveLength(1);
    expect(result[0].revoked).toBe(true);
    expect(result[0].isValid).toBe(false);
  });

  test('computes isValid: expiry past -> false; future or null -> true', async () => {
    isAdminFromEventMock.mockReturnValue(true);
    const nowSec = Date.now() / 1000;
    ddbMock.on(ScanCommand).resolves({
      Items: [
        makeUnitRow({ unitId: 'u-past', expiryTimestamp: nowSec - 3600 }),
        makeUnitRow({ unitId: 'u-future', expiryTimestamp: nowSec + 3600 }),
        makeUnitRow({ unitId: 'u-none', expiryTimestamp: null }),
      ],
    });

    const result = (await handler(
      makeEvent({ fieldName: 'listAuthorityUnits' }),
    )) as Array<{ unitId: string; isValid: boolean }>;

    const byId = Object.fromEntries(result.map((u) => [u.unitId, u]));
    expect(byId['u-past'].isValid).toBe(false);
    expect(byId['u-future'].isValid).toBe(true);
    expect(byId['u-none'].isValid).toBe(true);
  });

  test('parses scope JSON and re-stringifies conditions/limits in the result', async () => {
    isAdminFromEventMock.mockReturnValue(true);
    ddbMock.on(ScanCommand).resolves({
      Items: [makeUnitRow()],
    });

    const result = (await handler(
      makeEvent({ fieldName: 'listAuthorityUnits' }),
    )) as Array<{
      scope: {
        decisionType: string;
        domain: string;
        conditions: string;
        limits: string;
        specificity: number;
      };
    }>;

    expect(result).toHaveLength(1);
    expect(result[0].scope.decisionType).toBe('invoke_agent');
    expect(result[0].scope.domain).toBe('payment');
    // conditions/limits are JSON strings on the wire
    expect(typeof result[0].scope.conditions).toBe('string');
    expect(typeof result[0].scope.limits).toBe('string');
    expect(JSON.parse(result[0].scope.conditions)).toEqual({ tier: 'gold' });
    expect(JSON.parse(result[0].scope.limits)).toEqual({ max_amount: 1000 });
    expect(result[0].scope.specificity).toBe(2);
  });

  test('parses scope when stored as a deserialised object (forward-compat)', async () => {
    isAdminFromEventMock.mockReturnValue(true);
    ddbMock.on(ScanCommand).resolves({
      Items: [
        makeUnitRow({
          scope: {
            decision_type: 'execute_tool',
            domain: 'fraud',
            conditions: { region: 'us' },
            limits: {},
          },
        }),
      ],
    });

    const result = (await handler(
      makeEvent({ fieldName: 'listAuthorityUnits' }),
    )) as Array<{ scope: { decisionType: string; specificity: number } }>;

    expect(result[0].scope.decisionType).toBe('execute_tool');
    expect(result[0].scope.specificity).toBe(1);
  });

  test('cache hit on identical args within 60s avoids second DDB scan', async () => {
    isAdminFromEventMock.mockReturnValue(true);
    ddbMock.on(ScanCommand).resolves({ Items: [makeUnitRow()] });

    await handler(
      makeEvent({
        fieldName: 'listAuthorityUnits',
        args: { registryId: 'reg-app-1' },
      }),
    );
    await handler(
      makeEvent({
        fieldName: 'listAuthorityUnits',
        args: { registryId: 'reg-app-1' },
      }),
    );

    expect(ddbMock.commandCalls(ScanCommand)).toHaveLength(1);
  });

  test('cache key separates includeRevoked variants', async () => {
    isAdminFromEventMock.mockReturnValue(true);
    ddbMock.on(ScanCommand).resolves({ Items: [] });

    await handler(makeEvent({ fieldName: 'listAuthorityUnits' }));
    await handler(
      makeEvent({
        fieldName: 'listAuthorityUnits',
        args: { includeRevoked: true },
      }),
    );

    // Different cache key → both scans execute.
    expect(ddbMock.commandCalls(ScanCommand)).toHaveLength(2);
  });

  test('5000-row truncation logs a warning', async () => {
    isAdminFromEventMock.mockReturnValue(true);
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation();

    // First page returns 5000 rows + LastEvaluatedKey so the loop would
    // continue if not truncated. The truncation cap kicks in mid-page.
    const bigPage = Array.from({ length: 5000 }, (_, i) =>
      makeUnitRow({ unitId: `u-${i}` }),
    );
    ddbMock.on(ScanCommand).resolves({
      Items: bigPage,
      LastEvaluatedKey: { unitId: 'u-4999' },
    });

    const result = (await handler(
      makeEvent({ fieldName: 'listAuthorityUnits' }),
    )) as unknown[];

    expect(result).toHaveLength(5000);
    expect(warnSpy).toHaveBeenCalled();
    const found = warnSpy.mock.calls.some((args) =>
      args.some((a) => typeof a === 'string' && a.includes('truncated at 5000')),
    );
    expect(found).toBe(true);
  });

  test('throws when AUTHORITY_UNITS_TABLE env var is not set', async () => {
    isAdminFromEventMock.mockReturnValue(true);
    const original = process.env.AUTHORITY_UNITS_TABLE;
    delete process.env.AUTHORITY_UNITS_TABLE;
    try {
      await expect(
        handler(makeEvent({ fieldName: 'listAuthorityUnits' })),
      ).rejects.toThrow('AUTHORITY_UNITS_TABLE env var is not set');
    } finally {
      process.env.AUTHORITY_UNITS_TABLE = original;
    }
  });
});

// ---------------------------------------------------------------------------
// listCompositionContracts — Wave 4.A
// ---------------------------------------------------------------------------

describe('listCompositionContracts', () => {
  function makeContractRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      contractId: 'c-1',
      partyA: 'agent-a',
      partyB: 'agent-b',
      authorityPrecedence: 'agent-a',
      conflictResolution: 'halt_and_escalate',
      invariants: ['no_pii_export'],
      stopRights: ['agent-a'],
      scope: JSON.stringify({
        decision_type: '*',
        domain: '*',
        conditions: {},
        limits: {},
      }),
      escalationPath: 'arn:aws:sqs:us-east-1:123:escalations',
      ...overrides,
    };
  }

  test('throws when caller is not admin', async () => {
    isAdminFromEventMock.mockReturnValue(false);

    await expect(
      handler(makeEvent({ fieldName: 'listCompositionContracts' })),
    ).rejects.toThrow('Forbidden: admin required');
  });

  test('returns [] when DDB scan returns no items', async () => {
    isAdminFromEventMock.mockReturnValue(true);
    ddbMock.on(ScanCommand).resolves({ Items: [] });

    const result = (await handler(
      makeEvent({ fieldName: 'listCompositionContracts' }),
    )) as unknown[];

    expect(result).toEqual([]);
  });

  test('projects all fields including parsed scope', async () => {
    isAdminFromEventMock.mockReturnValue(true);
    ddbMock.on(ScanCommand).resolves({
      Items: [
        makeContractRow({
          contractId: 'c-42',
          partyA: 'aa',
          partyB: 'bb',
          authorityPrecedence: 'bb',
          conflictResolution: 'precedence_resolution',
          scope: JSON.stringify({
            decision_type: 'invoke_agent',
            domain: 'risk',
            conditions: { region: 'eu' },
            limits: { max_qps: 10 },
          }),
          escalationPath: null,
        }),
      ],
    });

    const result = (await handler(
      makeEvent({ fieldName: 'listCompositionContracts' }),
    )) as Array<{
      contractId: string;
      partyA: string;
      partyB: string;
      authorityPrecedence: string;
      conflictResolution: string;
      scope: { decisionType: string; domain: string; specificity: number };
      escalationPath: string | null;
    }>;

    expect(result).toHaveLength(1);
    expect(result[0].contractId).toBe('c-42');
    expect(result[0].partyA).toBe('aa');
    expect(result[0].partyB).toBe('bb');
    expect(result[0].authorityPrecedence).toBe('bb');
    expect(result[0].conflictResolution).toBe('precedence_resolution');
    expect(result[0].scope.decisionType).toBe('invoke_agent');
    expect(result[0].scope.domain).toBe('risk');
    expect(result[0].scope.specificity).toBe(2);
    expect(result[0].escalationPath).toBeNull();
  });

  test('coerces invariants/stopRights to string[] from a native list', async () => {
    isAdminFromEventMock.mockReturnValue(true);
    ddbMock.on(ScanCommand).resolves({
      Items: [
        makeContractRow({
          invariants: ['inv-1', 'inv-2'],
          stopRights: ['agent-a', 'agent-b'],
        }),
      ],
    });

    const result = (await handler(
      makeEvent({ fieldName: 'listCompositionContracts' }),
    )) as Array<{ invariants: string[]; stopRights: string[] }>;

    expect(result[0].invariants).toEqual(['inv-1', 'inv-2']);
    expect(result[0].stopRights).toEqual(['agent-a', 'agent-b']);
  });

  test('coerces invariants/stopRights from a JSON-string encoding', async () => {
    isAdminFromEventMock.mockReturnValue(true);
    ddbMock.on(ScanCommand).resolves({
      Items: [
        makeContractRow({
          invariants: JSON.stringify(['inv-x']),
          stopRights: JSON.stringify([]),
        }),
      ],
    });

    const result = (await handler(
      makeEvent({ fieldName: 'listCompositionContracts' }),
    )) as Array<{ invariants: string[]; stopRights: string[] }>;

    expect(result[0].invariants).toEqual(['inv-x']);
    expect(result[0].stopRights).toEqual([]);
  });

  test('cache hit within 60s avoids a second DDB scan', async () => {
    isAdminFromEventMock.mockReturnValue(true);
    ddbMock.on(ScanCommand).resolves({ Items: [makeContractRow()] });

    await handler(makeEvent({ fieldName: 'listCompositionContracts' }));
    await handler(makeEvent({ fieldName: 'listCompositionContracts' }));

    expect(ddbMock.commandCalls(ScanCommand)).toHaveLength(1);
  });

  test('throws when COMPOSITION_CONTRACTS_TABLE env var is not set', async () => {
    isAdminFromEventMock.mockReturnValue(true);
    const original = process.env.COMPOSITION_CONTRACTS_TABLE;
    delete process.env.COMPOSITION_CONTRACTS_TABLE;
    try {
      await expect(
        handler(makeEvent({ fieldName: 'listCompositionContracts' })),
      ).rejects.toThrow('COMPOSITION_CONTRACTS_TABLE env var is not set');
    } finally {
      process.env.COMPOSITION_CONTRACTS_TABLE = original;
    }
  });
});

// ---------------------------------------------------------------------------
// getRevokeImpact — Wave 4.B (blast-radius approximation)
// ---------------------------------------------------------------------------

describe('getRevokeImpact', () => {
  function makePermitRow(
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      findingId: 'f-1',
      workflowId: 'wf-1',
      decision: 'permit',
      reason: 'scope_match:unit=u-1',
      requesting_agent: 'agent-a',
      target_agent: 'agent-b',
      scope_evaluated: 'u-1',
      contract_evaluated: null,
      escalation_target: null,
      residual_authority_denial: false,
      timestamp: 1715000000,
      ...overrides,
    };
  }

  test('throws when caller is not admin', async () => {
    isAdminFromEventMock.mockReturnValue(false);

    await expect(
      handler(
        makeEvent({
          fieldName: 'getRevokeImpact',
          args: { unitId: 'u-1' },
        }),
      ),
    ).rejects.toThrow('Forbidden: admin required');
  });

  test('uses default 1h window when sinceTs / untilTs omitted', async () => {
    isAdminFromEventMock.mockReturnValue(true);
    ddbMock.on(ScanCommand).resolves({ Items: [] });

    const before = Math.floor(Date.now() / 1000);
    const result = (await handler(
      makeEvent({
        fieldName: 'getRevokeImpact',
        args: { unitId: 'u-1' },
      }),
    )) as { sinceTs: number; untilTs: number };
    const after = Math.floor(Date.now() / 1000);

    // untilTs ~= now; sinceTs ~= now - 3600
    expect(result.untilTs).toBeGreaterThanOrEqual(before);
    expect(result.untilTs).toBeLessThanOrEqual(after);
    expect(result.untilTs - result.sinceTs).toBe(3600);
  });

  test('clamps a window > 24h to 24h', async () => {
    isAdminFromEventMock.mockReturnValue(true);
    ddbMock.on(ScanCommand).resolves({ Items: [] });

    const untilTs = 2_000_000;
    const sinceTs = untilTs - 7 * 24 * 3600; // 7 days back

    const result = (await handler(
      makeEvent({
        fieldName: 'getRevokeImpact',
        args: { unitId: 'u-1', sinceTs, untilTs },
      }),
    )) as { sinceTs: number; untilTs: number };

    expect(result.untilTs).toBe(untilTs);
    expect(result.untilTs - result.sinceTs).toBe(24 * 3600);
  });

  test('returns empty arrays + zero counts when no permits match', async () => {
    isAdminFromEventMock.mockReturnValue(true);
    ddbMock.on(ScanCommand).resolves({ Items: [] });

    const result = (await handler(
      makeEvent({
        fieldName: 'getRevokeImpact',
        args: { unitId: 'u-1' },
      }),
    )) as {
      totalPermits: number;
      distinctWorkflows: number;
      distinctAgentPairs: number;
      workflows: unknown[];
      agentPairs: unknown[];
      truncated: boolean;
    };

    expect(result.totalPermits).toBe(0);
    expect(result.distinctWorkflows).toBe(0);
    expect(result.distinctAgentPairs).toBe(0);
    expect(result.workflows).toEqual([]);
    expect(result.agentPairs).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  test('groups by workflowId and (requestingAgent, targetAgent) correctly', async () => {
    isAdminFromEventMock.mockReturnValue(true);
    ddbMock.on(ScanCommand).resolves({
      Items: [
        makePermitRow({
          findingId: 'f-1',
          workflowId: 'wf-1',
          requesting_agent: 'a',
          target_agent: 'b',
          timestamp: 100,
        }),
        makePermitRow({
          findingId: 'f-2',
          workflowId: 'wf-1',
          requesting_agent: 'a',
          target_agent: 'b',
          timestamp: 200,
        }),
        makePermitRow({
          findingId: 'f-3',
          workflowId: 'wf-2',
          requesting_agent: 'c',
          target_agent: 'd',
          timestamp: 150,
        }),
      ],
    });

    const result = (await handler(
      makeEvent({
        fieldName: 'getRevokeImpact',
        args: { unitId: 'u-1' },
      }),
    )) as {
      totalPermits: number;
      distinctWorkflows: number;
      distinctAgentPairs: number;
      workflows: Array<{
        workflowId: string;
        permitCount: number;
        lastTimestamp: number;
      }>;
      agentPairs: Array<{
        requestingAgent: string;
        targetAgent: string;
        permitCount: number;
      }>;
    };

    expect(result.totalPermits).toBe(3);
    expect(result.distinctWorkflows).toBe(2);
    expect(result.distinctAgentPairs).toBe(2);

    const wf1 = result.workflows.find((w) => w.workflowId === 'wf-1');
    expect(wf1?.permitCount).toBe(2);
    expect(wf1?.lastTimestamp).toBe(200);
    const wf2 = result.workflows.find((w) => w.workflowId === 'wf-2');
    expect(wf2?.permitCount).toBe(1);
    expect(wf2?.lastTimestamp).toBe(150);

    const pairAB = result.agentPairs.find(
      (p) => p.requestingAgent === 'a' && p.targetAgent === 'b',
    );
    expect(pairAB?.permitCount).toBe(2);
    const pairCD = result.agentPairs.find(
      (p) => p.requestingAgent === 'c' && p.targetAgent === 'd',
    );
    expect(pairCD?.permitCount).toBe(1);
  });

  test('sorts results by permitCount descending', async () => {
    isAdminFromEventMock.mockReturnValue(true);
    ddbMock.on(ScanCommand).resolves({
      Items: [
        // wf-low: 1 hit
        makePermitRow({ findingId: 'f-1', workflowId: 'wf-low' }),
        // wf-mid: 2 hits
        makePermitRow({ findingId: 'f-2', workflowId: 'wf-mid' }),
        makePermitRow({ findingId: 'f-3', workflowId: 'wf-mid' }),
        // wf-high: 3 hits
        makePermitRow({ findingId: 'f-4', workflowId: 'wf-high' }),
        makePermitRow({ findingId: 'f-5', workflowId: 'wf-high' }),
        makePermitRow({ findingId: 'f-6', workflowId: 'wf-high' }),
      ],
    });

    const result = (await handler(
      makeEvent({
        fieldName: 'getRevokeImpact',
        args: { unitId: 'u-1' },
      }),
    )) as {
      workflows: Array<{ workflowId: string; permitCount: number }>;
    };

    expect(result.workflows.map((w) => w.workflowId)).toEqual([
      'wf-high',
      'wf-mid',
      'wf-low',
    ]);
  });

  test('caps result lists at 50 each but reports the FULL distinct count', async () => {
    isAdminFromEventMock.mockReturnValue(true);
    // 75 distinct workflows × 1 hit each = 75 permits, 75 distinct
    // workflows; 75 distinct agent pairs (varied).
    const items: Record<string, unknown>[] = [];
    for (let i = 0; i < 75; i++) {
      items.push(
        makePermitRow({
          findingId: `f-${i}`,
          workflowId: `wf-${String(i).padStart(3, '0')}`,
          requesting_agent: `req-${i}`,
          target_agent: `tgt-${i}`,
        }),
      );
    }
    ddbMock.on(ScanCommand).resolves({ Items: items });

    const result = (await handler(
      makeEvent({
        fieldName: 'getRevokeImpact',
        args: { unitId: 'u-1' },
      }),
    )) as {
      totalPermits: number;
      distinctWorkflows: number;
      distinctAgentPairs: number;
      workflows: unknown[];
      agentPairs: unknown[];
    };

    expect(result.totalPermits).toBe(75);
    // distinct counts are pre-cap → full unique-set sizes.
    expect(result.distinctWorkflows).toBe(75);
    expect(result.distinctAgentPairs).toBe(75);
    // result lists capped at 50.
    expect(result.workflows).toHaveLength(50);
    expect(result.agentPairs).toHaveLength(50);
  });

  test('5000-row scan triggers truncated=true', async () => {
    isAdminFromEventMock.mockReturnValue(true);
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation();

    const bigPage = Array.from({ length: 5000 }, (_, i) =>
      makePermitRow({
        findingId: `f-${i}`,
        workflowId: `wf-${i}`,
        requesting_agent: `req-${i}`,
        target_agent: `tgt-${i}`,
      }),
    );
    ddbMock.on(ScanCommand).resolves({
      Items: bigPage,
      LastEvaluatedKey: { findingId: 'f-4999' },
    });

    const result = (await handler(
      makeEvent({
        fieldName: 'getRevokeImpact',
        args: { unitId: 'u-1' },
      }),
    )) as { truncated: boolean; totalPermits: number };

    expect(result.truncated).toBe(true);
    expect(result.totalPermits).toBe(5000);
    expect(warnSpy).toHaveBeenCalled();
    const found = warnSpy.mock.calls.some((args) =>
      args.some(
        (a) => typeof a === 'string' && a.includes('truncated at 5000'),
      ),
    );
    expect(found).toBe(true);
  });

  test('cache hit on identical args within 30s avoids second scan', async () => {
    isAdminFromEventMock.mockReturnValue(true);
    ddbMock.on(ScanCommand).resolves({ Items: [makePermitRow()] });

    await handler(
      makeEvent({
        fieldName: 'getRevokeImpact',
        args: { unitId: 'u-1', sinceTs: 100, untilTs: 200 },
      }),
    );
    await handler(
      makeEvent({
        fieldName: 'getRevokeImpact',
        args: { unitId: 'u-1', sinceTs: 100, untilTs: 200 },
      }),
    );

    expect(ddbMock.commandCalls(ScanCommand)).toHaveLength(1);
  });

  test('FilterExpression includes scope_evaluated, decision, timestamp BETWEEN', async () => {
    isAdminFromEventMock.mockReturnValue(true);
    ddbMock.on(ScanCommand).resolves({ Items: [] });

    await handler(
      makeEvent({
        fieldName: 'getRevokeImpact',
        args: { unitId: 'u-1', sinceTs: 100, untilTs: 200 },
      }),
    );

    const calls = ddbMock.commandCalls(ScanCommand);
    expect(calls).toHaveLength(1);
    const input = calls[0].args[0].input;
    expect(input.FilterExpression).toBe(
      'scope_evaluated = :uid AND decision = :permit AND #ts BETWEEN :since AND :until',
    );
    expect(input.ExpressionAttributeNames).toEqual({ '#ts': 'timestamp' });
    expect(input.ExpressionAttributeValues).toMatchObject({
      ':uid': 'u-1',
      ':permit': 'permit',
      ':since': 100,
      ':until': 200,
    });
  });

  test('throws when unitId is missing or empty', async () => {
    isAdminFromEventMock.mockReturnValue(true);

    await expect(
      handler(
        makeEvent({
          fieldName: 'getRevokeImpact',
          args: { unitId: '' },
        }),
      ),
    ).rejects.toThrow('unitId is required');
  });
});

// ---------------------------------------------------------------------------
// listConstitutionalLayers — Wave 4.C
// ---------------------------------------------------------------------------

describe('listConstitutionalLayers', () => {
  function makeLayerRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      layerId: 'layer-global',
      layerType: 'global',
      appliesTo: ['*'],
      rules: JSON.stringify([
        { field: 'pii_present', operator: 'eq', value: false },
      ]),
      parentLayerId: null,
      ...overrides,
    };
  }

  test('throws when caller is not admin', async () => {
    isAdminFromEventMock.mockReturnValue(false);

    await expect(
      handler(makeEvent({ fieldName: 'listConstitutionalLayers' })),
    ).rejects.toThrow('Forbidden: admin required');
  });

  test('returns [] when DDB scan returns no items', async () => {
    isAdminFromEventMock.mockReturnValue(true);
    ddbMock.on(ScanCommand).resolves({ Items: [] });

    const result = (await handler(
      makeEvent({ fieldName: 'listConstitutionalLayers' }),
    )) as unknown[];

    expect(result).toEqual([]);
  });

  test('sorts layers: pairwise > domain > global', async () => {
    isAdminFromEventMock.mockReturnValue(true);
    ddbMock.on(ScanCommand).resolves({
      Items: [
        makeLayerRow({ layerId: 'g1', layerType: 'global' }),
        makeLayerRow({ layerId: 'd1', layerType: 'domain' }),
        makeLayerRow({ layerId: 'p1', layerType: 'pairwise' }),
      ],
    });

    const result = (await handler(
      makeEvent({ fieldName: 'listConstitutionalLayers' }),
    )) as Array<{ layerId: string; layerType: string }>;

    expect(result.map((l) => l.layerType)).toEqual([
      'pairwise',
      'domain',
      'global',
    ]);
  });

  test('tie-broken alphabetical by layerId within the same type', async () => {
    isAdminFromEventMock.mockReturnValue(true);
    ddbMock.on(ScanCommand).resolves({
      Items: [
        makeLayerRow({ layerId: 'b-domain', layerType: 'domain' }),
        makeLayerRow({ layerId: 'a-domain', layerType: 'domain' }),
        makeLayerRow({ layerId: 'c-pairwise', layerType: 'pairwise' }),
        makeLayerRow({ layerId: 'a-pairwise', layerType: 'pairwise' }),
      ],
    });

    const result = (await handler(
      makeEvent({ fieldName: 'listConstitutionalLayers' }),
    )) as Array<{ layerId: string; layerType: string }>;

    // Pairwise first, alphabetical within; then domains alphabetical.
    expect(result.map((l) => l.layerId)).toEqual([
      'a-pairwise',
      'c-pairwise',
      'a-domain',
      'b-domain',
    ]);
  });

  test('rules projected with field/operator/value (value JSON-stringified)', async () => {
    isAdminFromEventMock.mockReturnValue(true);
    ddbMock.on(ScanCommand).resolves({
      Items: [
        makeLayerRow({
          rules: JSON.stringify([
            { field: 'tier', operator: 'eq', value: 'gold' },
            { field: 'amount', operator: 'gt', value: 100 },
          ]),
        }),
      ],
    });

    const result = (await handler(
      makeEvent({ fieldName: 'listConstitutionalLayers' }),
    )) as Array<{
      rules: Array<{ field: string; operator: string; value: string | null }>;
    }>;

    expect(result).toHaveLength(1);
    expect(result[0].rules).toHaveLength(2);
    expect(result[0].rules[0]).toEqual({
      field: 'tier',
      operator: 'eq',
      value: '"gold"',
    });
    expect(JSON.parse(result[0].rules[0].value as string)).toBe('gold');
    expect(result[0].rules[1]).toEqual({
      field: 'amount',
      operator: 'gt',
      value: '100',
    });
    expect(JSON.parse(result[0].rules[1].value as string)).toBe(100);
  });

  test('exists / not_exists operators have null value', async () => {
    isAdminFromEventMock.mockReturnValue(true);
    ddbMock.on(ScanCommand).resolves({
      Items: [
        makeLayerRow({
          rules: JSON.stringify([
            { field: 'session_id', operator: 'exists', value: 'ignored' },
            { field: 'override_flag', operator: 'not_exists' },
          ]),
        }),
      ],
    });

    const result = (await handler(
      makeEvent({ fieldName: 'listConstitutionalLayers' }),
    )) as Array<{
      rules: Array<{ field: string; operator: string; value: string | null }>;
    }>;

    expect(result[0].rules[0].value).toBeNull();
    expect(result[0].rules[1].value).toBeNull();
  });

  test('cache hit on identical args within 60s avoids second DDB scan', async () => {
    isAdminFromEventMock.mockReturnValue(true);
    ddbMock.on(ScanCommand).resolves({ Items: [makeLayerRow()] });

    await handler(makeEvent({ fieldName: 'listConstitutionalLayers' }));
    await handler(makeEvent({ fieldName: 'listConstitutionalLayers' }));

    expect(ddbMock.commandCalls(ScanCommand)).toHaveLength(1);
  });

  test('throws when CONSTITUTIONAL_LAYERS_TABLE env var is not set', async () => {
    isAdminFromEventMock.mockReturnValue(true);
    const original = process.env.CONSTITUTIONAL_LAYERS_TABLE;
    delete process.env.CONSTITUTIONAL_LAYERS_TABLE;
    try {
      await expect(
        handler(makeEvent({ fieldName: 'listConstitutionalLayers' })),
      ).rejects.toThrow('CONSTITUTIONAL_LAYERS_TABLE env var is not set');
    } finally {
      process.env.CONSTITUTIONAL_LAYERS_TABLE = original;
    }
  });
});

// ---------------------------------------------------------------------------
// getConstitutionalRuleStats — Wave 4.C
// ---------------------------------------------------------------------------

describe('getConstitutionalRuleStats', () => {
  function makeOverrideRow(
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      findingId: 'f-1',
      workflowId: 'wf-1',
      decision: 'deny',
      reason: 'constitutional_review:layer-1:invariant_violated:field-x',
      requesting_agent: 'agent-a',
      target_agent: 'agent-b',
      scope_evaluated: 'unit-1',
      contract_evaluated: null,
      escalation_target: null,
      residual_authority_denial: false,
      timestamp: 1715000000,
      ...overrides,
    };
  }

  test('throws when caller is not admin', async () => {
    isAdminFromEventMock.mockReturnValue(false);

    await expect(
      handler(makeEvent({ fieldName: 'getConstitutionalRuleStats' })),
    ).rejects.toThrow('Forbidden: admin required');
  });

  test('default 7-day window when args are omitted', async () => {
    isAdminFromEventMock.mockReturnValue(true);
    ddbMock.on(ScanCommand).resolves({ Items: [] });

    const before = Math.floor(Date.now() / 1000);
    const result = (await handler(
      makeEvent({ fieldName: 'getConstitutionalRuleStats' }),
    )) as { sinceTs: number; untilTs: number };
    const after = Math.floor(Date.now() / 1000);

    expect(result.untilTs).toBeGreaterThanOrEqual(before);
    expect(result.untilTs).toBeLessThanOrEqual(after);
    expect(result.untilTs - result.sinceTs).toBe(7 * 86400);
  });

  test('window > 30 days clamped to 30 days', async () => {
    isAdminFromEventMock.mockReturnValue(true);
    ddbMock.on(ScanCommand).resolves({ Items: [] });

    const untilTs = 1_700_000_000;
    const sinceTs = untilTs - 100 * 86400; // 100 days back

    const result = (await handler(
      makeEvent({
        fieldName: 'getConstitutionalRuleStats',
        args: { sinceTs, untilTs },
      }),
    )) as { sinceTs: number; untilTs: number };

    expect(result.untilTs).toBe(untilTs);
    expect(result.untilTs - result.sinceTs).toBe(30 * 86400);
  });

  test('returns empty stats when no findings match', async () => {
    isAdminFromEventMock.mockReturnValue(true);
    ddbMock.on(ScanCommand).resolves({ Items: [] });

    const result = (await handler(
      makeEvent({ fieldName: 'getConstitutionalRuleStats' }),
    )) as {
      totalOverrides: number;
      stats: unknown[];
      truncated: boolean;
    };

    expect(result.totalOverrides).toBe(0);
    expect(result.stats).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  test('parses constitutional_review:layer-1:invariant_violated:field-x reason', async () => {
    isAdminFromEventMock.mockReturnValue(true);
    ddbMock.on(ScanCommand).resolves({
      Items: [makeOverrideRow()],
    });

    const result = (await handler(
      makeEvent({ fieldName: 'getConstitutionalRuleStats' }),
    )) as {
      totalOverrides: number;
      stats: Array<{ layerId: string; field: string; count7d: number }>;
    };

    expect(result.totalOverrides).toBe(1);
    expect(result.stats).toHaveLength(1);
    expect(result.stats[0].layerId).toBe('layer-1');
    expect(result.stats[0].field).toBe('field-x');
    expect(result.stats[0].count7d).toBe(1);
  });

  test('groups multiple findings for same (layerId, field) with correct count7d', async () => {
    isAdminFromEventMock.mockReturnValue(true);
    ddbMock.on(ScanCommand).resolves({
      Items: [
        makeOverrideRow({ findingId: 'f-1', timestamp: 100 }),
        makeOverrideRow({ findingId: 'f-2', timestamp: 200 }),
        makeOverrideRow({ findingId: 'f-3', timestamp: 300 }),
      ],
    });

    const result = (await handler(
      makeEvent({ fieldName: 'getConstitutionalRuleStats' }),
    )) as {
      stats: Array<{
        layerId: string;
        field: string;
        count7d: number;
        firstFiredAt: number | null;
        lastFiredAt: number | null;
      }>;
    };

    expect(result.stats).toHaveLength(1);
    expect(result.stats[0].count7d).toBe(3);
    expect(result.stats[0].firstFiredAt).toBe(100);
    expect(result.stats[0].lastFiredAt).toBe(300);
  });

  test('topAffectedAgents top 5 by count', async () => {
    isAdminFromEventMock.mockReturnValue(true);
    // 7 distinct agents with varying counts: a×4, b×3, c×3, d×2, e×2, f×1, g×1
    const items: Record<string, unknown>[] = [];
    const counts: Record<string, number> = {
      a: 4,
      b: 3,
      c: 3,
      d: 2,
      e: 2,
      f: 1,
      g: 1,
    };
    let i = 0;
    for (const [agent, n] of Object.entries(counts)) {
      for (let k = 0; k < n; k++) {
        items.push(
          makeOverrideRow({
            findingId: `f-${i++}`,
            requesting_agent: agent,
            timestamp: 1000 + i,
          }),
        );
      }
    }
    ddbMock.on(ScanCommand).resolves({ Items: items });

    const result = (await handler(
      makeEvent({ fieldName: 'getConstitutionalRuleStats' }),
    )) as {
      stats: Array<{ topAffectedAgents: string[] }>;
    };

    expect(result.stats).toHaveLength(1);
    expect(result.stats[0].topAffectedAgents).toHaveLength(5);
    // Top one is 'a' (4 fires); the other four are some subset of
    // {b, c, d, e}. Tie-break is alphabetical by agent name when counts
    // are equal.
    expect(result.stats[0].topAffectedAgents[0]).toBe('a');
    expect(result.stats[0].topAffectedAgents.slice(1, 3).sort()).toEqual([
      'b',
      'c',
    ]);
    expect(result.stats[0].topAffectedAgents.slice(3, 5).sort()).toEqual([
      'd',
      'e',
    ]);
  });

  test('5000-item truncation flag set', async () => {
    isAdminFromEventMock.mockReturnValue(true);
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation();

    const bigPage = Array.from({ length: 5000 }, (_, i) =>
      makeOverrideRow({
        findingId: `f-${i}`,
        timestamp: 1000 + i,
      }),
    );
    ddbMock.on(ScanCommand).resolves({
      Items: bigPage,
      LastEvaluatedKey: { findingId: 'f-4999' },
    });

    const result = (await handler(
      makeEvent({ fieldName: 'getConstitutionalRuleStats' }),
    )) as { truncated: boolean; totalOverrides: number };

    expect(result.truncated).toBe(true);
    expect(result.totalOverrides).toBe(5000);
    expect(warnSpy).toHaveBeenCalled();
    const found = warnSpy.mock.calls.some((args) =>
      args.some(
        (a) => typeof a === 'string' && a.includes('truncated at 5000'),
      ),
    );
    expect(found).toBe(true);
  });

  test('sorts by count7d desc and caps at 200 entries', async () => {
    isAdminFromEventMock.mockReturnValue(true);

    // 210 distinct (layerId, field) groups with 1 hit each: total 210
    // items keeps us well under the 5000 scan cap. Cap-at-200 takes the
    // first 200 after the alphabetical-by-layerId tie-break.
    const items: Record<string, unknown>[] = [];
    for (let i = 0; i < 210; i++) {
      items.push(
        makeOverrideRow({
          findingId: `f-${i}`,
          reason: `constitutional_review:layer-${String(i).padStart(3, '0')}:invariant_violated:f`,
        }),
      );
    }
    // Add an extra batch of hits on layer-000 so it sorts to position 0
    // by count7d (verifies the primary sort key is count7d desc, not
    // alphabetical).
    for (let i = 0; i < 5; i++) {
      items.push(
        makeOverrideRow({
          findingId: `f-extra-${i}`,
          reason: 'constitutional_review:layer-000:invariant_violated:f',
        }),
      );
    }
    ddbMock.on(ScanCommand).resolves({ Items: items });

    const result = (await handler(
      makeEvent({ fieldName: 'getConstitutionalRuleStats' }),
    )) as {
      stats: Array<{ layerId: string; count7d: number }>;
    };

    expect(result.stats).toHaveLength(200);
    // Sorted descending by count7d.
    for (let i = 0; i < result.stats.length - 1; i++) {
      expect(result.stats[i].count7d).toBeGreaterThanOrEqual(
        result.stats[i + 1].count7d,
      );
    }
    // Top entry has the highest count.
    expect(result.stats[0].layerId).toBe('layer-000');
    expect(result.stats[0].count7d).toBe(6);
  });

  test('FilterExpression includes deny + begins_with(reason) + timestamp BETWEEN', async () => {
    isAdminFromEventMock.mockReturnValue(true);
    ddbMock.on(ScanCommand).resolves({ Items: [] });

    await handler(
      makeEvent({
        fieldName: 'getConstitutionalRuleStats',
        args: { sinceTs: 100, untilTs: 200 },
      }),
    );

    const calls = ddbMock.commandCalls(ScanCommand);
    expect(calls).toHaveLength(1);
    const input = calls[0].args[0].input;
    expect(input.FilterExpression).toBe(
      'decision = :deny AND begins_with(reason, :prefix) AND #ts BETWEEN :since AND :until',
    );
    expect(input.ExpressionAttributeNames).toEqual({ '#ts': 'timestamp' });
    expect(input.ExpressionAttributeValues).toMatchObject({
      ':deny': 'deny',
      ':prefix': 'constitutional_review:',
      ':since': 100,
      ':until': 200,
    });
  });

  test('malformed reason (no invariant_violated token) is silently skipped', async () => {
    isAdminFromEventMock.mockReturnValue(true);
    ddbMock.on(ScanCommand).resolves({
      Items: [
        // good
        makeOverrideRow({
          findingId: 'f-good',
          reason: 'constitutional_review:layer-a:invariant_violated:field-a',
        }),
        // bad: no `invariant_violated` token in slot 2
        makeOverrideRow({
          findingId: 'f-bad-1',
          reason: 'constitutional_review:noinvariantword:foo',
        }),
        // bad: too few tokens
        makeOverrideRow({
          findingId: 'f-bad-2',
          reason: 'constitutional_review:layer-x',
        }),
        // bad: missing field
        makeOverrideRow({
          findingId: 'f-bad-3',
          reason: 'constitutional_review::invariant_violated:',
        }),
      ],
    });

    const result = (await handler(
      makeEvent({ fieldName: 'getConstitutionalRuleStats' }),
    )) as {
      totalOverrides: number;
      stats: Array<{ layerId: string; field: string; count7d: number }>;
    };

    expect(result.totalOverrides).toBe(1);
    expect(result.stats).toHaveLength(1);
    expect(result.stats[0].layerId).toBe('layer-a');
    expect(result.stats[0].field).toBe('field-a');
  });

  test('cache hit on identical args within 30s avoids second scan', async () => {
    isAdminFromEventMock.mockReturnValue(true);
    ddbMock.on(ScanCommand).resolves({ Items: [makeOverrideRow()] });

    await handler(
      makeEvent({
        fieldName: 'getConstitutionalRuleStats',
        args: { sinceTs: 100, untilTs: 200 },
      }),
    );
    await handler(
      makeEvent({
        fieldName: 'getConstitutionalRuleStats',
        args: { sinceTs: 100, untilTs: 200 },
      }),
    );

    expect(ddbMock.commandCalls(ScanCommand)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// listCaseLaw — Wave 4.D (case-law timeline; admin-only, read-only)
// ---------------------------------------------------------------------------

describe('listCaseLaw', () => {
  function makeCaseRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      entryId: 'case-1',
      pattern: { agent: 'payments-agent', target: 'fraud-agent' },
      resolution: 'permit',
      createdAt: '2026-05-01T10:00:00.000Z',
      createdBy: 'operator@acme.com',
      scopeOfApplicability: { tenants: ['acme'] },
      precedence: 5,
      revoked: false,
      ...overrides,
    };
  }

  test('throws when caller is not admin', async () => {
    isAdminFromEventMock.mockReturnValue(false);

    await expect(
      handler(makeEvent({ fieldName: 'listCaseLaw' })),
    ).rejects.toThrow('Forbidden: admin required');
  });

  test('returns [] when DDB scan returns no items', async () => {
    isAdminFromEventMock.mockReturnValue(true);
    ddbMock.on(ScanCommand).resolves({ Items: [] });

    const result = (await handler(
      makeEvent({ fieldName: 'listCaseLaw' }),
    )) as unknown[];

    expect(result).toEqual([]);
  });

  test('sorts by precedence DESC then encodedAt DESC as tie-breaker', async () => {
    isAdminFromEventMock.mockReturnValue(true);
    ddbMock.on(ScanCommand).resolves({
      Items: [
        // Lower precedence — should come last.
        makeCaseRow({
          entryId: 'case-low',
          precedence: 1,
          createdAt: '2026-05-15T10:00:00.000Z',
        }),
        // Tied precedence with case-tie-newer; older encodedAt
        makeCaseRow({
          entryId: 'case-tie-older',
          precedence: 5,
          createdAt: '2026-05-01T10:00:00.000Z',
        }),
        // Highest precedence — top.
        makeCaseRow({
          entryId: 'case-top',
          precedence: 10,
          createdAt: '2026-05-10T10:00:00.000Z',
        }),
        // Tied precedence with case-tie-older; newer encodedAt
        makeCaseRow({
          entryId: 'case-tie-newer',
          precedence: 5,
          createdAt: '2026-05-12T10:00:00.000Z',
        }),
      ],
    });

    const result = (await handler(
      makeEvent({ fieldName: 'listCaseLaw' }),
    )) as Array<{ caseId: string; precedence: number; encodedAt: string }>;

    expect(result.map((r) => r.caseId)).toEqual([
      'case-top',
      'case-tie-newer',
      'case-tie-older',
      'case-low',
    ]);
  });

  test('excludes revoked rows by default; includes when includeRevoked=true', async () => {
    isAdminFromEventMock.mockReturnValue(true);
    ddbMock.on(ScanCommand).resolves({
      Items: [
        makeCaseRow({ entryId: 'case-active', revoked: false }),
        makeCaseRow({ entryId: 'case-revoked', revoked: true }),
      ],
    });

    // Default (includeRevoked omitted) — revoked rows hidden.
    let result = (await handler(
      makeEvent({ fieldName: 'listCaseLaw' }),
    )) as Array<{ caseId: string; revoked: boolean }>;
    expect(result.map((r) => r.caseId)).toEqual(['case-active']);

    // includeRevoked=true — both surface.
    __resetCaseLawCacheForTest();
    isAdminFromEventMock.mockReturnValue(true);
    ddbMock.reset();
    ddbMock.on(ScanCommand).resolves({
      Items: [
        makeCaseRow({ entryId: 'case-active', revoked: false }),
        makeCaseRow({ entryId: 'case-revoked', revoked: true }),
      ],
    });

    result = (await handler(
      makeEvent({ fieldName: 'listCaseLaw', args: { includeRevoked: true } }),
    )) as Array<{ caseId: string; revoked: boolean }>;
    const ids = result.map((r) => r.caseId).sort();
    expect(ids).toEqual(['case-active', 'case-revoked']);
    const revokedRow = result.find((r) => r.caseId === 'case-revoked');
    expect(revokedRow?.revoked).toBe(true);
  });

  test('pattern + scopeOfApplicability are JSON-stringified for transport', async () => {
    isAdminFromEventMock.mockReturnValue(true);
    // Mix of shapes: object pattern, JSON-string scopeOfApplicability.
    ddbMock.on(ScanCommand).resolves({
      Items: [
        makeCaseRow({
          entryId: 'case-1',
          pattern: { agent: 'a', target: 'b' },
          scopeOfApplicability: JSON.stringify({ tenants: ['acme'] }),
        }),
      ],
    });

    const result = (await handler(
      makeEvent({ fieldName: 'listCaseLaw' }),
    )) as Array<{ pattern: string; scopeOfApplicability: string }>;

    expect(result).toHaveLength(1);
    expect(typeof result[0].pattern).toBe('string');
    expect(typeof result[0].scopeOfApplicability).toBe('string');
    // Round-trip parse to verify the normalisation.
    expect(JSON.parse(result[0].pattern)).toEqual({ agent: 'a', target: 'b' });
    expect(JSON.parse(result[0].scopeOfApplicability)).toEqual({
      tenants: ['acme'],
    });
  });

  test('legacy float encodedAt is normalised to ISO-8601 string', async () => {
    isAdminFromEventMock.mockReturnValue(true);
    // Epoch seconds float, e.g. 1715000000 -> 2024-05-06T16:53:20Z
    ddbMock.on(ScanCommand).resolves({
      Items: [makeCaseRow({ entryId: 'case-legacy', createdAt: 1715000000 })],
    });

    const result = (await handler(
      makeEvent({ fieldName: 'listCaseLaw' }),
    )) as Array<{ encodedAt: string }>;

    expect(result).toHaveLength(1);
    expect(result[0].encodedAt).toBe(
      new Date(1715000000 * 1000).toISOString(),
    );
  });

  test('modern ISO encodedAt is passed through unchanged', async () => {
    isAdminFromEventMock.mockReturnValue(true);
    ddbMock.on(ScanCommand).resolves({
      Items: [
        makeCaseRow({
          entryId: 'case-iso',
          createdAt: '2026-05-19T06:30:00.000Z',
        }),
      ],
    });

    const result = (await handler(
      makeEvent({ fieldName: 'listCaseLaw' }),
    )) as Array<{ encodedAt: string }>;

    expect(result[0].encodedAt).toBe('2026-05-19T06:30:00.000Z');
  });

  test('unknown resolution coerces to "unknown" with a warning log', async () => {
    isAdminFromEventMock.mockReturnValue(true);
    ddbMock.on(ScanCommand).resolves({
      Items: [
        makeCaseRow({ entryId: 'case-bad', resolution: 'maybe' }),
        makeCaseRow({ entryId: 'case-good', resolution: 'permit' }),
      ],
    });

    const warnSpy = jest.spyOn(console, 'warn');
    const result = (await handler(
      makeEvent({ fieldName: 'listCaseLaw' }),
    )) as Array<{ caseId: string; resolution: string }>;

    const byId = Object.fromEntries(result.map((r) => [r.caseId, r]));
    expect(byId['case-bad'].resolution).toBe('unknown');
    expect(byId['case-good'].resolution).toBe('permit');
    expect(warnSpy).toHaveBeenCalled();
    const warnMessages = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(warnMessages.some((m) => m.includes('unknown resolution'))).toBe(
      true,
    );
  });

  test('encodedBy defaults to "unknown" when createdBy is missing', async () => {
    isAdminFromEventMock.mockReturnValue(true);
    ddbMock.on(ScanCommand).resolves({
      Items: [makeCaseRow({ entryId: 'case-no-author', createdBy: undefined })],
    });

    const result = (await handler(
      makeEvent({ fieldName: 'listCaseLaw' }),
    )) as Array<{ encodedBy: string }>;

    expect(result[0].encodedBy).toBe('unknown');
  });

  test('precedence defaults to 0 on missing or non-numeric input', async () => {
    isAdminFromEventMock.mockReturnValue(true);
    ddbMock.on(ScanCommand).resolves({
      Items: [
        makeCaseRow({ entryId: 'case-no-prec', precedence: undefined }),
        makeCaseRow({ entryId: 'case-string-prec', precedence: 'not-a-number' }),
      ],
    });

    const result = (await handler(
      makeEvent({ fieldName: 'listCaseLaw' }),
    )) as Array<{ caseId: string; precedence: number }>;

    const byId = Object.fromEntries(result.map((r) => [r.caseId, r]));
    expect(byId['case-no-prec'].precedence).toBe(0);
    expect(byId['case-string-prec'].precedence).toBe(0);
  });

  test('cache hit on same args within 60s avoids second DDB scan', async () => {
    isAdminFromEventMock.mockReturnValue(true);
    ddbMock.on(ScanCommand).resolves({ Items: [makeCaseRow()] });

    await handler(makeEvent({ fieldName: 'listCaseLaw' }));
    await handler(makeEvent({ fieldName: 'listCaseLaw' }));

    expect(ddbMock.commandCalls(ScanCommand)).toHaveLength(1);
  });

  test('different includeRevoked args use separate cache slots', async () => {
    isAdminFromEventMock.mockReturnValue(true);
    ddbMock.on(ScanCommand).resolves({ Items: [makeCaseRow()] });

    await handler(makeEvent({ fieldName: 'listCaseLaw' }));
    await handler(
      makeEvent({ fieldName: 'listCaseLaw', args: { includeRevoked: true } }),
    );

    // Two distinct cache keys → two scans.
    expect(ddbMock.commandCalls(ScanCommand)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// constitutionalRule mutations — Wave 4.C.2
// ---------------------------------------------------------------------------

describe('constitutionalRule mutations (Wave 4.C.2)', () => {
  const ACK_TEXT =
    'I understand this changes the constitutional layer used at engine step 8';

  function adminMutEvent(
    fieldName: 'addConstitutionalRule' | 'updateConstitutionalRule' | 'deleteConstitutionalRule',
    input: Record<string, unknown>,
  ): HandlerEvent {
    return makeEvent({
      fieldName,
      args: { input },
      identity: { sub: 'actor-admin-1', username: 'admin@example.com' },
    });
  }

  function makeStoredLayerRow(
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    // The engine writes rules with parsed primitive values (no JSON-string
    // around them) — mirror that format here.
    return {
      layerId: 'layer-global',
      layerType: 'global',
      appliesTo: ['*'],
      rules: JSON.stringify([
        { field: 'pii_present', operator: 'eq', value: false },
        { field: 'session_id', operator: 'exists' },
      ]),
      parentLayerId: null,
      ...overrides,
    };
  }

  beforeEach(() => {
    isAdminFromEventMock.mockReturnValue(true);
    ebMock.on(PutEventsCommand).resolves({});
    ddbMock.on(PutCommand).resolves({});
  });

  // ---- shared validation ----

  test.each([
    ['addConstitutionalRule', { layerId: 'l1', rule: { field: 'f', operator: 'eq', value: '"x"' }, acknowledgement: ACK_TEXT }],
    ['updateConstitutionalRule', { layerId: 'l1', ruleIndex: 0, newRule: { field: 'f', operator: 'eq', value: '"x"' }, acknowledgement: ACK_TEXT }],
    ['deleteConstitutionalRule', { layerId: 'l1', ruleIndex: 0, acknowledgement: ACK_TEXT }],
  ] as const)(
    '%s: admin gate throws Forbidden for non-admin',
    async (fieldName, input) => {
      isAdminFromEventMock.mockReturnValue(false);
      await expect(
        handler(adminMutEvent(fieldName, input)),
      ).rejects.toThrow('Forbidden: admin required');
    },
  );

  test.each([
    ['addConstitutionalRule', { layerId: 'l1', rule: { field: 'f', operator: 'eq', value: '"x"' }, acknowledgement: 'wrong' }],
    ['updateConstitutionalRule', { layerId: 'l1', ruleIndex: 0, newRule: { field: 'f', operator: 'eq', value: '"x"' }, acknowledgement: 'wrong' }],
    ['deleteConstitutionalRule', { layerId: 'l1', ruleIndex: 0, acknowledgement: 'wrong' }],
  ] as const)(
    '%s: acknowledgement string mismatch throws',
    async (fieldName, input) => {
      await expect(
        handler(adminMutEvent(fieldName, input)),
      ).rejects.toThrow('Acknowledgement string mismatch');
    },
  );

  test.each([
    ['addConstitutionalRule', { layerId: 'l1', rule: { field: 'f', operator: 'bogus', value: '"x"' }, acknowledgement: ACK_TEXT }],
    ['updateConstitutionalRule', { layerId: 'l1', ruleIndex: 0, newRule: { field: 'f', operator: 'bogus', value: '"x"' }, acknowledgement: ACK_TEXT }],
  ] as const)(
    '%s: invalid operator throws with allowlist message',
    async (fieldName, input) => {
      ddbMock.on(GetCommand).resolves({ Item: makeStoredLayerRow({ layerId: 'l1' }) });
      await expect(
        handler(adminMutEvent(fieldName, input)),
      ).rejects.toThrow('Invalid operator: bogus');
    },
  );

  test.each(['exists', 'not_exists'] as const)(
    'add: operator %s with non-null value throws',
    async (op) => {
      ddbMock.on(GetCommand).resolves({ Item: makeStoredLayerRow() });
      await expect(
        handler(
          adminMutEvent('addConstitutionalRule', {
            layerId: 'layer-global',
            rule: { field: 'f', operator: op, value: '"present"' },
            acknowledgement: ACK_TEXT,
          }),
        ),
      ).rejects.toThrow(`Operator ${op} must have null value`);
    },
  );

  test('add: gt with null value throws', async () => {
    ddbMock.on(GetCommand).resolves({ Item: makeStoredLayerRow() });
    await expect(
      handler(
        adminMutEvent('addConstitutionalRule', {
          layerId: 'layer-global',
          rule: { field: 'amount', operator: 'gt', value: null },
          acknowledgement: ACK_TEXT,
        }),
      ),
    ).rejects.toThrow('Operator gt requires a non-null value');
  });

  test('add: malformed JSON value rejected', async () => {
    ddbMock.on(GetCommand).resolves({ Item: makeStoredLayerRow() });
    await expect(
      handler(
        adminMutEvent('addConstitutionalRule', {
          layerId: 'layer-global',
          rule: { field: 'tier', operator: 'eq', value: 'not-json' },
          acknowledgement: ACK_TEXT,
        }),
      ),
    ).rejects.toThrow('value is not parseable JSON');
  });

  test('add: empty field throws', async () => {
    ddbMock.on(GetCommand).resolves({ Item: makeStoredLayerRow() });
    await expect(
      handler(
        adminMutEvent('addConstitutionalRule', {
          layerId: 'layer-global',
          rule: { field: '', operator: 'eq', value: '"x"' },
          acknowledgement: ACK_TEXT,
        }),
      ),
    ).rejects.toThrow('Rule field must be non-empty');
  });

  test('add: field over 256 chars throws', async () => {
    ddbMock.on(GetCommand).resolves({ Item: makeStoredLayerRow() });
    const huge = 'a'.repeat(257);
    await expect(
      handler(
        adminMutEvent('addConstitutionalRule', {
          layerId: 'layer-global',
          rule: { field: huge, operator: 'eq', value: '"x"' },
          acknowledgement: ACK_TEXT,
        }),
      ),
    ).rejects.toThrow('Rule field exceeds 256 characters');
  });

  test('non-existent layerId throws Layer not found', async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    await expect(
      handler(
        adminMutEvent('addConstitutionalRule', {
          layerId: 'missing',
          rule: { field: 'f', operator: 'eq', value: '"x"' },
          acknowledgement: ACK_TEXT,
        }),
      ),
    ).rejects.toThrow('Layer not found: missing');
  });

  // ---- add ----

  test('add: appends rule, layer.rules.length increases by 1, emits add event', async () => {
    ddbMock.on(GetCommand).resolves({ Item: makeStoredLayerRow() });

    const result = (await handler(
      adminMutEvent('addConstitutionalRule', {
        layerId: 'layer-global',
        rule: { field: 'tier', operator: 'eq', value: '"gold"' },
        acknowledgement: ACK_TEXT,
      }),
    )) as {
      ok: boolean;
      action: string;
      layer: { rules: Array<{ field: string; operator: string; value: string | null }> };
      emittedEventDetailType: string | null;
    };

    expect(result.ok).toBe(true);
    expect(result.action).toBe('add');
    // Original layer had 2 rules; one more was appended.
    expect(result.layer.rules).toHaveLength(3);
    expect(result.layer.rules[2]).toEqual({
      field: 'tier',
      operator: 'eq',
      value: '"gold"',
    });
    expect(result.emittedEventDetailType).toBe(
      'governance.constitutional.rule.changed',
    );

    // PutItem was called once with the new rules JSON.
    const puts = ddbMock.commandCalls(PutCommand);
    expect(puts).toHaveLength(1);
    const put = puts[0].args[0].input as { Item: { rules: string } };
    const writtenRules = JSON.parse(put.Item.rules);
    expect(writtenRules).toHaveLength(3);
    expect(writtenRules[2]).toEqual({
      field: 'tier',
      operator: 'eq',
      value: 'gold',
    });

    // Audit event has the right action / ruleIndex / oldRule / newRule shape.
    const ebCalls = ebMock.commandCalls(PutEventsCommand);
    expect(ebCalls).toHaveLength(1);
    const detail = JSON.parse(
      ebCalls[0].args[0].input.Entries![0].Detail!,
    );
    expect(detail.action).toBe('add');
    expect(detail.ruleIndex).toBe(2);
    expect(detail.oldRule).toBeNull();
    expect(detail.newRule).toEqual({
      field: 'tier',
      operator: 'eq',
      value: '"gold"',
    });
    expect(detail.actorSub).toBe('actor-admin-1');
  });

  // ---- update ----

  test('update: replaces rules[ruleIndex], emits update event with old + new', async () => {
    ddbMock.on(GetCommand).resolves({ Item: makeStoredLayerRow() });

    const result = (await handler(
      adminMutEvent('updateConstitutionalRule', {
        layerId: 'layer-global',
        ruleIndex: 0,
        newRule: { field: 'pii_present', operator: 'eq', value: 'true' },
        acknowledgement: ACK_TEXT,
      }),
    )) as {
      action: string;
      layer: { rules: Array<{ field: string; operator: string; value: string | null }> };
      emittedEventDetailType: string | null;
    };

    expect(result.action).toBe('update');
    expect(result.layer.rules[0]).toEqual({
      field: 'pii_present',
      operator: 'eq',
      value: 'true',
    });
    // Index 1 (the exists rule) should be untouched.
    expect(result.layer.rules[1]).toEqual({
      field: 'session_id',
      operator: 'exists',
      value: null,
    });
    expect(result.emittedEventDetailType).toBe(
      'governance.constitutional.rule.changed',
    );

    const ebCalls = ebMock.commandCalls(PutEventsCommand);
    const detail = JSON.parse(
      ebCalls[0].args[0].input.Entries![0].Detail!,
    );
    expect(detail.action).toBe('update');
    expect(detail.ruleIndex).toBe(0);
    expect(detail.oldRule).toEqual({
      field: 'pii_present',
      operator: 'eq',
      value: 'false',
    });
    expect(detail.newRule).toEqual({
      field: 'pii_present',
      operator: 'eq',
      value: 'true',
    });
  });

  test('update: out-of-range ruleIndex throws and does NOT call PutItem', async () => {
    ddbMock.on(GetCommand).resolves({ Item: makeStoredLayerRow() });

    await expect(
      handler(
        adminMutEvent('updateConstitutionalRule', {
          layerId: 'layer-global',
          ruleIndex: 99,
          newRule: { field: 'x', operator: 'eq', value: '"y"' },
          acknowledgement: ACK_TEXT,
        }),
      ),
    ).rejects.toThrow('Rule index out of range: 99');
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  // ---- delete ----

  test('delete: removes rules[ruleIndex], rules.length decreases by 1, emits delete', async () => {
    ddbMock.on(GetCommand).resolves({ Item: makeStoredLayerRow() });

    const result = (await handler(
      adminMutEvent('deleteConstitutionalRule', {
        layerId: 'layer-global',
        ruleIndex: 1,
        acknowledgement: ACK_TEXT,
      }),
    )) as {
      action: string;
      layer: { rules: Array<{ field: string; operator: string; value: string | null }> };
      emittedEventDetailType: string | null;
    };

    expect(result.action).toBe('delete');
    expect(result.layer.rules).toHaveLength(1);
    expect(result.layer.rules[0].field).toBe('pii_present');
    expect(result.emittedEventDetailType).toBe(
      'governance.constitutional.rule.changed',
    );

    const ebCalls = ebMock.commandCalls(PutEventsCommand);
    const detail = JSON.parse(
      ebCalls[0].args[0].input.Entries![0].Detail!,
    );
    expect(detail.action).toBe('delete');
    expect(detail.ruleIndex).toBe(1);
    expect(detail.oldRule).toEqual({
      field: 'session_id',
      operator: 'exists',
      value: null,
    });
    expect(detail.newRule).toBeNull();
  });

  test('delete: out-of-range ruleIndex throws and does NOT call PutItem', async () => {
    ddbMock.on(GetCommand).resolves({ Item: makeStoredLayerRow() });

    await expect(
      handler(
        adminMutEvent('deleteConstitutionalRule', {
          layerId: 'layer-global',
          ruleIndex: -1,
          acknowledgement: ACK_TEXT,
        }),
      ),
    ).rejects.toThrow('Rule index out of range: -1');
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  // ---- audit-event NON-blocking ----

  test('audit event failure does NOT roll back the rule write (returns null detail type)', async () => {
    ddbMock.on(GetCommand).resolves({ Item: makeStoredLayerRow() });
    ebMock.on(PutEventsCommand).rejects(new Error('eventbridge down'));

    const result = (await handler(
      adminMutEvent('addConstitutionalRule', {
        layerId: 'layer-global',
        rule: { field: 'tier', operator: 'eq', value: '"silver"' },
        acknowledgement: ACK_TEXT,
      }),
    )) as { ok: boolean; emittedEventDetailType: string | null };

    expect(result.ok).toBe(true);
    expect(result.emittedEventDetailType).toBeNull();
    // PutItem still happened — the rule write is the primary goal.
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(1);
  });

  // ---- empty rules attribute ----

  test('empty rules attribute: add succeeds (length goes 0 → 1)', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: makeStoredLayerRow({ rules: undefined }),
    });

    const result = (await handler(
      adminMutEvent('addConstitutionalRule', {
        layerId: 'layer-global',
        rule: { field: 'first', operator: 'eq', value: '"a"' },
        acknowledgement: ACK_TEXT,
      }),
    )) as { layer: { rules: unknown[] } };

    expect(result.layer.rules).toHaveLength(1);
  });

  test('empty rules attribute: update throws on any index', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: makeStoredLayerRow({ rules: undefined }),
    });

    await expect(
      handler(
        adminMutEvent('updateConstitutionalRule', {
          layerId: 'layer-global',
          ruleIndex: 0,
          newRule: { field: 'f', operator: 'eq', value: '"x"' },
          acknowledgement: ACK_TEXT,
        }),
      ),
    ).rejects.toThrow('Rule index out of range: 0');
  });

  test('empty rules attribute: delete throws on any index', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: makeStoredLayerRow({ rules: undefined }),
    });

    await expect(
      handler(
        adminMutEvent('deleteConstitutionalRule', {
          layerId: 'layer-global',
          ruleIndex: 0,
          acknowledgement: ACK_TEXT,
        }),
      ),
    ).rejects.toThrow('Rule index out of range: 0');
  });

  // ---- env var guard ----

  test('throws when CONSTITUTIONAL_LAYERS_TABLE env var is not set', async () => {
    const original = process.env.CONSTITUTIONAL_LAYERS_TABLE;
    delete process.env.CONSTITUTIONAL_LAYERS_TABLE;
    try {
      await expect(
        handler(
          adminMutEvent('addConstitutionalRule', {
            layerId: 'l',
            rule: { field: 'f', operator: 'eq', value: '"x"' },
            acknowledgement: ACK_TEXT,
          }),
        ),
      ).rejects.toThrow('CONSTITUTIONAL_LAYERS_TABLE env var is not set');
    } finally {
      process.env.CONSTITUTIONAL_LAYERS_TABLE = original;
    }
  });
});

// ---------------------------------------------------------------------------
// caseLaw mutations — Wave 4.D.2 (revoke / unrevoke / update-precedence)
// ---------------------------------------------------------------------------

describe('caseLaw mutations (Wave 4.D.2)', () => {
  const CASELAW_ACK_TEXT =
    'I understand this changes the case-law precedent used at engine step 1';

  function adminCaseLawEvent(
    fieldName:
      | 'revokeCaseLaw'
      | 'unrevokeCaseLaw'
      | 'updateCaseLawPrecedence',
    input: Record<string, unknown>,
  ): HandlerEvent {
    return makeEvent({
      fieldName,
      args: { input },
      identity: { sub: 'actor-admin-1', username: 'admin@example.com' },
    });
  }

  function makeStoredCaseRow(
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      entryId: 'case-1',
      pattern: { agent: 'a', target: 'b' },
      resolution: 'permit',
      createdAt: '2026-05-01T10:00:00.000Z',
      createdBy: 'operator@acme.com',
      scopeOfApplicability: { tenants: ['acme'] },
      precedence: 5,
      revoked: false,
      ...overrides,
    };
  }

  beforeEach(() => {
    isAdminFromEventMock.mockReturnValue(true);
    ebMock.on(PutEventsCommand).resolves({});
    // The mutations issue UpdateCommand which the document client routes
    // through the same client mock; resolves({}) keeps the call quiet.
    ddbMock.on(PutCommand).resolves({});
  });

  // ---- shared validation ----

  test.each([
    ['revokeCaseLaw', { caseId: 'case-1', acknowledgement: CASELAW_ACK_TEXT }],
    ['unrevokeCaseLaw', { caseId: 'case-1', acknowledgement: CASELAW_ACK_TEXT }],
    [
      'updateCaseLawPrecedence',
      { caseId: 'case-1', newPrecedence: 7, acknowledgement: CASELAW_ACK_TEXT },
    ],
  ] as const)(
    '%s: admin gate throws Forbidden for non-admin',
    async (fieldName, input) => {
      isAdminFromEventMock.mockReturnValue(false);
      await expect(
        handler(adminCaseLawEvent(fieldName, input)),
      ).rejects.toThrow('Forbidden: admin required');
    },
  );

  test.each([
    ['revokeCaseLaw', { caseId: 'case-1', acknowledgement: 'wrong' }],
    ['unrevokeCaseLaw', { caseId: 'case-1', acknowledgement: 'wrong' }],
    [
      'updateCaseLawPrecedence',
      { caseId: 'case-1', newPrecedence: 7, acknowledgement: 'wrong' },
    ],
  ] as const)(
    '%s: acknowledgement string mismatch throws',
    async (fieldName, input) => {
      await expect(
        handler(adminCaseLawEvent(fieldName, input)),
      ).rejects.toThrow('Acknowledgement string mismatch');
    },
  );

  test.each([
    ['revokeCaseLaw', { caseId: 'missing', acknowledgement: CASELAW_ACK_TEXT }],
    [
      'unrevokeCaseLaw',
      { caseId: 'missing', acknowledgement: CASELAW_ACK_TEXT },
    ],
    [
      'updateCaseLawPrecedence',
      { caseId: 'missing', newPrecedence: 7, acknowledgement: CASELAW_ACK_TEXT },
    ],
  ] as const)(
    '%s: non-existent caseId throws Case-law entry not found',
    async (fieldName, input) => {
      ddbMock.on(GetCommand).resolves({ Item: undefined });
      await expect(
        handler(adminCaseLawEvent(fieldName, input)),
      ).rejects.toThrow('Case-law entry not found: missing');
    },
  );

  test.each([
    ['revokeCaseLaw', { caseId: '', acknowledgement: CASELAW_ACK_TEXT }],
    ['unrevokeCaseLaw', { caseId: '', acknowledgement: CASELAW_ACK_TEXT }],
    [
      'updateCaseLawPrecedence',
      { caseId: '', newPrecedence: 7, acknowledgement: CASELAW_ACK_TEXT },
    ],
  ] as const)(
    '%s: empty caseId throws',
    async (fieldName, input) => {
      await expect(
        handler(adminCaseLawEvent(fieldName, input)),
      ).rejects.toThrow('caseId must be non-empty');
    },
  );

  // ---- revoke ----

  test('revoke: sets revoked=true; emits audit event with previousValue/newValue', async () => {
    // First GetCommand returns the existing un-revoked row; second
    // GetCommand (post-write re-projection) returns the same row with
    // revoked: true so the projection reflects the write.
    ddbMock
      .on(GetCommand)
      .resolvesOnce({ Item: makeStoredCaseRow({ revoked: false }) })
      .resolvesOnce({ Item: makeStoredCaseRow({ revoked: true }) });

    const result = (await handler(
      adminCaseLawEvent('revokeCaseLaw', {
        caseId: 'case-1',
        acknowledgement: CASELAW_ACK_TEXT,
        reason: 'precedent-superseded',
      }),
    )) as {
      ok: boolean;
      action: string;
      entry: { revoked: boolean; caseId: string };
      emittedEventDetailType: string | null;
    };

    expect(result.ok).toBe(true);
    expect(result.action).toBe('revoke');
    expect(result.entry.revoked).toBe(true);
    expect(result.emittedEventDetailType).toBe(
      'governance.caselaw.changed',
    );

    // Audit event has the right action / previousValue / newValue / reason / actorSub.
    const ebCalls = ebMock.commandCalls(PutEventsCommand);
    expect(ebCalls).toHaveLength(1);
    const detail = JSON.parse(
      ebCalls[0].args[0].input.Entries![0].Detail!,
    );
    expect(detail.caseId).toBe('case-1');
    expect(detail.action).toBe('revoke');
    expect(detail.previousValue).toEqual({ revoked: false });
    expect(detail.newValue).toEqual({ revoked: true });
    expect(detail.reason).toBe('precedent-superseded');
    expect(detail.actorSub).toBe('actor-admin-1');
  });

  test('revoke: idempotent on already-revoked row — skips UpdateItem and returns null detail type', async () => {
    ddbMock
      .on(GetCommand)
      .resolves({ Item: makeStoredCaseRow({ revoked: true }) });

    // Spy on the document client send call so we can assert the
    // mutation skipped the UpdateItem entirely.
    const sendSpy = jest.spyOn(
      DynamoDBDocumentClient.prototype,
      'send',
    );

    const result = (await handler(
      adminCaseLawEvent('revokeCaseLaw', {
        caseId: 'case-1',
        acknowledgement: CASELAW_ACK_TEXT,
      }),
    )) as { ok: boolean; emittedEventDetailType: string | null };

    expect(result.ok).toBe(true);
    expect(result.emittedEventDetailType).toBeNull();

    // Send was called exactly once (the GetCommand) — no UpdateItem,
    // no second GetCommand for re-projection. Assert by inspecting
    // every call's command name.
    const sendCallNames = sendSpy.mock.calls.map(
      (call) => (call[0] as object | undefined)?.constructor?.name ?? 'unknown',
    );
    expect(sendCallNames).toEqual(['GetCommand']);

    // No EventBridge audit emit on a no-op.
    expect(ebMock.commandCalls(PutEventsCommand)).toHaveLength(0);
    sendSpy.mockRestore();
  });

  // ---- unrevoke ----

  test('unrevoke: sets revoked=false; emits audit event', async () => {
    ddbMock
      .on(GetCommand)
      .resolvesOnce({ Item: makeStoredCaseRow({ revoked: true }) })
      .resolvesOnce({ Item: makeStoredCaseRow({ revoked: false }) });

    const result = (await handler(
      adminCaseLawEvent('unrevokeCaseLaw', {
        caseId: 'case-1',
        acknowledgement: CASELAW_ACK_TEXT,
      }),
    )) as {
      ok: boolean;
      action: string;
      entry: { revoked: boolean };
      emittedEventDetailType: string | null;
    };

    expect(result.ok).toBe(true);
    expect(result.action).toBe('unrevoke');
    expect(result.entry.revoked).toBe(false);
    expect(result.emittedEventDetailType).toBe(
      'governance.caselaw.changed',
    );

    const detail = JSON.parse(
      ebMock.commandCalls(PutEventsCommand)[0].args[0].input.Entries![0]
        .Detail!,
    );
    expect(detail.action).toBe('unrevoke');
    expect(detail.previousValue).toEqual({ revoked: true });
    expect(detail.newValue).toEqual({ revoked: false });
  });

  test('unrevoke: idempotent on not-revoked row — returns null detail type', async () => {
    ddbMock
      .on(GetCommand)
      .resolves({ Item: makeStoredCaseRow({ revoked: false }) });

    const result = (await handler(
      adminCaseLawEvent('unrevokeCaseLaw', {
        caseId: 'case-1',
        acknowledgement: CASELAW_ACK_TEXT,
      }),
    )) as { ok: boolean; emittedEventDetailType: string | null };

    expect(result.ok).toBe(true);
    expect(result.emittedEventDetailType).toBeNull();
    // No audit event on the no-op path.
    expect(ebMock.commandCalls(PutEventsCommand)).toHaveLength(0);
  });

  // ---- update-precedence ----

  test('update-precedence: updates precedence; emits with previousValue/newValue', async () => {
    ddbMock
      .on(GetCommand)
      .resolvesOnce({ Item: makeStoredCaseRow({ precedence: 5 }) })
      .resolvesOnce({ Item: makeStoredCaseRow({ precedence: 42 }) });

    const result = (await handler(
      adminCaseLawEvent('updateCaseLawPrecedence', {
        caseId: 'case-1',
        newPrecedence: 42,
        acknowledgement: CASELAW_ACK_TEXT,
      }),
    )) as {
      action: string;
      entry: { precedence: number };
      emittedEventDetailType: string | null;
    };

    expect(result.action).toBe('update-precedence');
    expect(result.entry.precedence).toBe(42);
    expect(result.emittedEventDetailType).toBe(
      'governance.caselaw.changed',
    );

    const detail = JSON.parse(
      ebMock.commandCalls(PutEventsCommand)[0].args[0].input.Entries![0]
        .Detail!,
    );
    expect(detail.action).toBe('update-precedence');
    expect(detail.previousValue).toEqual({ precedence: 5 });
    expect(detail.newValue).toEqual({ precedence: 42 });
  });

  test('update-precedence: same value as current is a no-op (returns null detail type)', async () => {
    ddbMock
      .on(GetCommand)
      .resolves({ Item: makeStoredCaseRow({ precedence: 5 }) });

    const result = (await handler(
      adminCaseLawEvent('updateCaseLawPrecedence', {
        caseId: 'case-1',
        newPrecedence: 5,
        acknowledgement: CASELAW_ACK_TEXT,
      }),
    )) as { ok: boolean; emittedEventDetailType: string | null };

    expect(result.ok).toBe(true);
    expect(result.emittedEventDetailType).toBeNull();
    expect(ebMock.commandCalls(PutEventsCommand)).toHaveLength(0);
  });

  test.each([
    ['below range', -1001],
    ['above range', 1001],
    ['non-integer', 3.14],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])(
    'update-precedence: %s newPrecedence rejected before any DDB write',
    async (_label, newPrecedence) => {
      // Pre-arm Get so that — if the resolver were buggy and skipped the
      // range check — we could observe the unintended write. The assertion
      // below verifies no write happened.
      ddbMock.on(GetCommand).resolves({ Item: makeStoredCaseRow() });

      const sendSpy = jest.spyOn(
        DynamoDBDocumentClient.prototype,
        'send',
      );

      await expect(
        handler(
          adminCaseLawEvent('updateCaseLawPrecedence', {
            caseId: 'case-1',
            newPrecedence,
            acknowledgement: CASELAW_ACK_TEXT,
          }),
        ),
      ).rejects.toThrow();

      // No DDB call at all — the range check fires before GetItem.
      expect(sendSpy).not.toHaveBeenCalled();
      sendSpy.mockRestore();
    },
  );

  // ---- audit-event NON-blocking ----

  test('audit event failure does NOT roll back the primary write (returns null detail type)', async () => {
    ddbMock
      .on(GetCommand)
      .resolvesOnce({ Item: makeStoredCaseRow({ revoked: false }) })
      .resolvesOnce({ Item: makeStoredCaseRow({ revoked: true }) });
    ebMock.on(PutEventsCommand).rejects(new Error('eventbridge down'));

    // Spy on send so we can assert the UpdateCommand was issued.
    const sendSpy = jest.spyOn(
      DynamoDBDocumentClient.prototype,
      'send',
    );

    const result = (await handler(
      adminCaseLawEvent('revokeCaseLaw', {
        caseId: 'case-1',
        acknowledgement: CASELAW_ACK_TEXT,
      }),
    )) as { ok: boolean; emittedEventDetailType: string | null };

    expect(result.ok).toBe(true);
    expect(result.emittedEventDetailType).toBeNull();

    // The UpdateCommand was issued — the primary write succeeded; only
    // the audit event emit failed.
    const sendCallNames = sendSpy.mock.calls.map(
      (call) => (call[0] as object | undefined)?.constructor?.name ?? 'unknown',
    );
    expect(sendCallNames).toContain('UpdateCommand');
    sendSpy.mockRestore();
  });

  // ---- env var guard ----

  test('throws when CASE_LAW_TABLE env var is not set', async () => {
    const original = process.env.CASE_LAW_TABLE;
    delete process.env.CASE_LAW_TABLE;
    try {
      await expect(
        handler(
          adminCaseLawEvent('revokeCaseLaw', {
            caseId: 'case-1',
            acknowledgement: CASELAW_ACK_TEXT,
          }),
        ),
      ).rejects.toThrow('CASE_LAW_TABLE env var is not set');
    } finally {
      process.env.CASE_LAW_TABLE = original;
    }
  });
});


// ---------------------------------------------------------------------------
// authorityGraphHistorySettings — Wave 4.E.A
// ---------------------------------------------------------------------------

describe('authorityGraphHistorySettings (Wave 4.E.A)', () => {
  const ACK_TEXT =
    'I understand this changes governance history retention and storage costs';
  const SETTINGS_PARAM_PREFIX =
    '/citadel/governance/authority-graph-history/';

  function settingsEvent(fieldName: string, args?: Record<string, unknown>): HandlerEvent {
    return makeEvent({
      fieldName,
      args: args ?? {},
      identity: { sub: 'actor-admin-1', username: 'admin@example.com' },
    });
  }

  function stubSettingsSsm(opts: {
    storedValue?: string | null;
    putShouldFail?: boolean;
  }) {
    const { putShouldFail } = opts;
    // Track the live value so a Put followed by a Get reflects the
    // freshly written JSON (mirrors the real SSM behaviour).
    let liveValue: string | null =
      opts.storedValue === undefined ? null : opts.storedValue;
    ssmMock.on(GetParameterCommand).callsFake((input: GetParameterCommandInput) => {
      const name: string = input?.Name ?? '';
      if (name.startsWith(SETTINGS_PARAM_PREFIX)) {
        if (liveValue === null) {
          return Promise.reject(new Error('ParameterNotFound'));
        }
        return Promise.resolve({ Parameter: { Value: liveValue } });
      }
      return Promise.resolve({});
    });
    ssmMock.on(PutParameterCommand).callsFake((input: PutParameterCommandInput) => {
      const name: string = input?.Name ?? '';
      if (name.startsWith(SETTINGS_PARAM_PREFIX)) {
        if (putShouldFail) {
          return Promise.reject(new Error('SSM put failed'));
        }
        // Mirror the write into the live value so subsequent Gets see it.
        if (typeof input?.Value === 'string') {
          liveValue = input.Value;
        }
      }
      return Promise.resolve({});
    });
  }

  beforeEach(() => {
    isAdminFromEventMock.mockReturnValue(true);
    ebMock.on(PutEventsCommand).resolves({});
    // Default: snapshots scan returns empty.
    ddbMock.on(ScanCommand).resolves({ Items: [] });
  });

  // ---- getAuthorityGraphHistorySettings ----

  test('getAuthorityGraphHistorySettings: admin gate throws Forbidden for non-admin', async () => {
    isAdminFromEventMock.mockReturnValue(false);
    await expect(
      handler(settingsEvent('getAuthorityGraphHistorySettings')),
    ).rejects.toThrow('Forbidden: admin required');
  });

  test('getAuthorityGraphHistorySettings: returns defaults when SSM not found', async () => {
    stubSettingsSsm({ storedValue: null });
    const result = (await handler(
      settingsEvent('getAuthorityGraphHistorySettings'),
    )) as {
      enabled: boolean;
      retentionDays: number;
      captureMode: string;
      lastSnapshotAt: string | null;
      snapshotCountInWindow: number;
      storageEstimate: string;
    };
    expect(result.enabled).toBe(false);
    expect(result.retentionDays).toBe(30);
    expect(result.captureMode).toBe('daily');
    expect(result.lastSnapshotAt).toBeNull();
    expect(result.snapshotCountInWindow).toBe(0);
    expect(result.storageEstimate).toBe('—');
  });

  test('getAuthorityGraphHistorySettings: returns parsed value when SSM present', async () => {
    stubSettingsSsm({
      storedValue:
        '{"enabled":true,"retentionDays":90,"captureMode":"daily"}',
    });
    const result = (await handler(
      settingsEvent('getAuthorityGraphHistorySettings'),
    )) as {
      enabled: boolean;
      retentionDays: number;
      captureMode: string;
    };
    expect(result.enabled).toBe(true);
    expect(result.retentionDays).toBe(90);
    expect(result.captureMode).toBe('daily');
  });

  test('getAuthorityGraphHistorySettings: lastSnapshotAt = max timestamp from scan', async () => {
    stubSettingsSsm({
      storedValue:
        '{"enabled":true,"retentionDays":7,"captureMode":"daily"}',
    });
    // Three rows; max timestamp = 1715000000.
    ddbMock.on(ScanCommand).resolves({
      Items: [
        { snapshotId: 's-1', timestamp: 1714000000 },
        { snapshotId: 's-2', timestamp: 1715000000 },
        { snapshotId: 's-3', timestamp: 1714500000 },
      ],
    });
    const result = (await handler(
      settingsEvent('getAuthorityGraphHistorySettings'),
    )) as {
      lastSnapshotAt: string | null;
      snapshotCountInWindow: number;
      storageEstimate: string;
    };
    expect(result.snapshotCountInWindow).toBe(3);
    expect(result.lastSnapshotAt).toBe(
      new Date(1715000000 * 1000).toISOString(),
    );
    expect(result.storageEstimate).toBe('~24KB');
  });

  test('getAuthorityGraphHistorySettings: scan filter expression bounds the retention window', async () => {
    stubSettingsSsm({
      storedValue:
        '{"enabled":true,"retentionDays":30,"captureMode":"daily"}',
    });
    ddbMock.on(ScanCommand).resolves({ Items: [] });

    await handler(settingsEvent('getAuthorityGraphHistorySettings'));

    const scanCalls = ddbMock.commandCalls(ScanCommand);
    expect(scanCalls).toHaveLength(1);
    const scanInput = scanCalls[0].args[0].input;
    expect(scanInput.TableName).toBe(
      'citadel-governance-graph-snapshots-test',
    );
    expect(scanInput.FilterExpression).toBe('#ts >= :since');
    expect(scanInput.ExpressionAttributeNames?.['#ts']).toBe('timestamp');
    // 30 days * 86400 seconds.
    expect(typeof scanInput.ExpressionAttributeValues?.[':since']).toBe(
      'number',
    );
    expect(scanInput.Limit).toBe(5000);
  });

  test('getAuthorityGraphHistorySettings: 30s in-process cache hits on a same-call repeat', async () => {
    stubSettingsSsm({
      storedValue:
        '{"enabled":true,"retentionDays":30,"captureMode":"daily"}',
    });
    await handler(settingsEvent('getAuthorityGraphHistorySettings'));
    await handler(settingsEvent('getAuthorityGraphHistorySettings'));

    // SSM GetParameter and DDB Scan only fire once across two calls.
    expect(ssmMock.commandCalls(GetParameterCommand)).toHaveLength(1);
    expect(ddbMock.commandCalls(ScanCommand)).toHaveLength(1);
  });

  // ---- updateAuthorityGraphHistorySettings ----

  test('updateAuthorityGraphHistorySettings: admin gate throws Forbidden for non-admin', async () => {
    isAdminFromEventMock.mockReturnValue(false);
    await expect(
      handler(
        settingsEvent('updateAuthorityGraphHistorySettings', {
          input: {
            enabled: true,
            retentionDays: 30,
            captureMode: 'daily',
            acknowledgement: ACK_TEXT,
          },
        }),
      ),
    ).rejects.toThrow('Forbidden: admin required');
  });

  test('updateAuthorityGraphHistorySettings: acknowledgement mismatch throws', async () => {
    await expect(
      handler(
        settingsEvent('updateAuthorityGraphHistorySettings', {
          input: {
            enabled: true,
            retentionDays: 30,
            captureMode: 'daily',
            acknowledgement: 'wrong',
          },
        }),
      ),
    ).rejects.toThrow('Acknowledgement string mismatch');
  });

  test.each([1, 14, 60, 180, 1000])(
    'updateAuthorityGraphHistorySettings: retentionDays=%i outside allowlist throws',
    async (retentionDays) => {
      await expect(
        handler(
          settingsEvent('updateAuthorityGraphHistorySettings', {
            input: {
              enabled: true,
              retentionDays,
              captureMode: 'daily',
              acknowledgement: ACK_TEXT,
            },
          }),
        ),
      ).rejects.toThrow('not in allowlist');
    },
  );

  test('updateAuthorityGraphHistorySettings: captureMode "on-change" accepted', async () => {
    stubSettingsSsm({
      storedValue:
        '{"enabled":false,"retentionDays":30,"captureMode":"daily"}',
    });
    const result = (await handler(
      settingsEvent('updateAuthorityGraphHistorySettings', {
        input: {
          enabled: true,
          retentionDays: 30,
          captureMode: 'on-change',
          acknowledgement: ACK_TEXT,
        },
      }),
    )) as {
      ok: boolean;
      settings: { captureMode: string };
      emittedEventDetailType: string | null;
    };
    expect(result.ok).toBe(true);
    expect(result.settings.captureMode).toBe('on-change');
    expect(result.emittedEventDetailType).toBe(
      'governance.authority-graph-history.config.changed',
    );
  });

  test('updateAuthorityGraphHistorySettings: captureMode "both" accepted', async () => {
    stubSettingsSsm({
      storedValue:
        '{"enabled":false,"retentionDays":30,"captureMode":"daily"}',
    });
    const result = (await handler(
      settingsEvent('updateAuthorityGraphHistorySettings', {
        input: {
          enabled: true,
          retentionDays: 30,
          captureMode: 'both',
          acknowledgement: ACK_TEXT,
        },
      }),
    )) as {
      ok: boolean;
      settings: { captureMode: string };
      emittedEventDetailType: string | null;
    };
    expect(result.ok).toBe(true);
    expect(result.settings.captureMode).toBe('both');
    expect(result.emittedEventDetailType).toBe(
      'governance.authority-graph-history.config.changed',
    );
  });

  test('updateAuthorityGraphHistorySettings: captureMode "daily" accepted', async () => {
    stubSettingsSsm({
      storedValue:
        '{"enabled":false,"retentionDays":30,"captureMode":"daily"}',
    });
    const result = (await handler(
      settingsEvent('updateAuthorityGraphHistorySettings', {
        input: {
          enabled: true,
          retentionDays: 30,
          captureMode: 'daily',
          acknowledgement: ACK_TEXT,
        },
      }),
    )) as {
      ok: boolean;
      settings: { enabled: boolean };
      emittedEventDetailType: string | null;
    };
    expect(result.ok).toBe(true);
    expect(result.settings.enabled).toBe(true);
    expect(result.emittedEventDetailType).toBe(
      'governance.authority-graph-history.config.changed',
    );
  });

  test('updateAuthorityGraphHistorySettings: same-config no-op skips SSM write + audit event', async () => {
    stubSettingsSsm({
      storedValue:
        '{"enabled":true,"retentionDays":30,"captureMode":"daily"}',
    });
    const result = (await handler(
      settingsEvent('updateAuthorityGraphHistorySettings', {
        input: {
          enabled: true,
          retentionDays: 30,
          captureMode: 'daily',
          acknowledgement: ACK_TEXT,
        },
      }),
    )) as { ok: boolean; emittedEventDetailType: string | null };
    expect(result.ok).toBe(true);
    expect(result.emittedEventDetailType).toBeNull();
    // No SSM write + no EventBridge emission.
    expect(ssmMock.commandCalls(PutParameterCommand)).toHaveLength(0);
    expect(ebMock.commandCalls(PutEventsCommand)).toHaveLength(0);
  });

  test('updateAuthorityGraphHistorySettings: different-config writes SSM + emits audit event', async () => {
    stubSettingsSsm({
      storedValue:
        '{"enabled":false,"retentionDays":30,"captureMode":"daily"}',
    });
    await handler(
      settingsEvent('updateAuthorityGraphHistorySettings', {
        input: {
          enabled: true,
          retentionDays: 90,
          captureMode: 'daily',
          acknowledgement: ACK_TEXT,
          reason: 'enabling-history-for-scrubber',
        },
      }),
    );
    const puts = ssmMock.commandCalls(PutParameterCommand);
    expect(puts).toHaveLength(1);
    const writtenJson = puts[0].args[0].input.Value as string;
    expect(JSON.parse(writtenJson)).toEqual({
      enabled: true,
      retentionDays: 90,
      captureMode: 'daily',
    });

    const ebCalls = ebMock.commandCalls(PutEventsCommand);
    expect(ebCalls).toHaveLength(1);
    const detail = JSON.parse(
      ebCalls[0].args[0].input.Entries![0].Detail!,
    );
    expect(detail.previousValue).toEqual({
      enabled: false,
      retentionDays: 30,
      captureMode: 'daily',
    });
    expect(detail.newValue).toEqual({
      enabled: true,
      retentionDays: 90,
      captureMode: 'daily',
    });
    expect(detail.reason).toBe('enabling-history-for-scrubber');
    expect(detail.actorSub).toBe('actor-admin-1');
  });

  test('updateAuthorityGraphHistorySettings: audit event failure does NOT roll back the SSM write', async () => {
    stubSettingsSsm({
      storedValue:
        '{"enabled":false,"retentionDays":30,"captureMode":"daily"}',
    });
    ebMock.on(PutEventsCommand).rejects(new Error('eventbridge down'));

    const result = (await handler(
      settingsEvent('updateAuthorityGraphHistorySettings', {
        input: {
          enabled: true,
          retentionDays: 30,
          captureMode: 'daily',
          acknowledgement: ACK_TEXT,
        },
      }),
    )) as { ok: boolean; emittedEventDetailType: string | null };

    expect(result.ok).toBe(true);
    expect(result.emittedEventDetailType).toBeNull();
    // SSM write still happened.
    expect(ssmMock.commandCalls(PutParameterCommand)).toHaveLength(1);
  });
});


// ---------------------------------------------------------------------------
// listAuthorityGraphSnapshots / getAuthorityGraphSnapshot — Wave 4.E.B
// ---------------------------------------------------------------------------

describe('listAuthorityGraphSnapshots (Wave 4.E.B)', () => {
  function snapshotEvent(args?: Record<string, unknown>): HandlerEvent {
    return makeEvent({
      fieldName: 'listAuthorityGraphSnapshots',
      args: args ?? {},
      identity: { sub: 'actor-admin-1', username: 'admin@example.com' },
    });
  }

  function makeSnapshotRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      snapshotId: 's-1',
      kind: 'full',
      timestamp: 1715000000,
      expiresAt: 1715000000 + 30 * 86400,
      partial: false,
      authorityUnits: [{ unitId: 'u-1' }, { unitId: 'u-2' }],
      compositionContracts: [{ contractId: 'c-1' }],
      constitutionalLayers: [],
      caseLaw: [{ caseId: 'cl-1' }, { caseId: 'cl-2' }, { caseId: 'cl-3' }],
      ...overrides,
    };
  }

  beforeEach(() => {
    isAdminFromEventMock.mockReturnValue(true);
  });

  test('admin gate throws Forbidden for non-admin', async () => {
    isAdminFromEventMock.mockReturnValue(false);
    await expect(handler(snapshotEvent())).rejects.toThrow(
      'Forbidden: admin required',
    );
  });

  test('default 365-day window when args omitted', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    await handler(snapshotEvent());
    const call = ddbMock.commandCalls(QueryCommand)[0];
    const input = call.args[0].input;
    expect(input.IndexName).toBe('kind-timestamp-index');
    expect(input.KeyConditionExpression).toBe(
      'kind = :full AND #ts BETWEEN :since AND :until',
    );
    expect(input.ExpressionAttributeValues?.[':full']).toBe('full');
    expect(input.ExpressionAttributeNames?.['#ts']).toBe('timestamp');
    const sinceTs = input.ExpressionAttributeValues?.[':since'] as number;
    const untilTs = input.ExpressionAttributeValues?.[':until'] as number;
    expect(typeof sinceTs).toBe('number');
    expect(typeof untilTs).toBe('number');
    // 365 day default window.
    expect(untilTs - sinceTs).toBe(365 * 86400);
  });

  test('returns [] when no snapshots in window', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    const result = (await handler(snapshotEvent())) as unknown[];
    expect(result).toEqual([]);
  });

  test('sorts ascending by timestamp', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        makeSnapshotRow({ snapshotId: 's-mid', timestamp: 1715000000 }),
        makeSnapshotRow({ snapshotId: 's-old', timestamp: 1714000000 }),
        makeSnapshotRow({ snapshotId: 's-new', timestamp: 1716000000 }),
      ],
    });
    const result = (await handler(snapshotEvent())) as Array<{
      snapshotId: string;
      timestamp: number;
    }>;
    expect(result.map((s) => s.snapshotId)).toEqual([
      's-old',
      's-mid',
      's-new',
    ]);
  });

  test('counts derived from row array lengths', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        makeSnapshotRow({
          snapshotId: 's-counts',
          authorityUnits: [{ unitId: 'u-1' }, { unitId: 'u-2' }, { unitId: 'u-3' }],
          compositionContracts: [{ contractId: 'c-1' }],
          constitutionalLayers: [{ layerId: 'l-1' }, { layerId: 'l-2' }],
          caseLaw: [],
        }),
      ],
    });
    const result = (await handler(snapshotEvent())) as Array<{
      authorityUnitsCount: number;
      compositionContractsCount: number;
      constitutionalLayersCount: number;
      caseLawCount: number;
    }>;
    expect(result).toHaveLength(1);
    expect(result[0].authorityUnitsCount).toBe(3);
    expect(result[0].compositionContractsCount).toBe(1);
    expect(result[0].constitutionalLayersCount).toBe(2);
    expect(result[0].caseLawCount).toBe(0);
  });

  test('handles JSON-string-encoded inner arrays (forward-compat)', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        makeSnapshotRow({
          snapshotId: 's-json',
          authorityUnits: JSON.stringify([
            { unitId: 'u-1' },
            { unitId: 'u-2' },
          ]),
          compositionContracts: JSON.stringify([{ contractId: 'c-1' }]),
          constitutionalLayers: JSON.stringify([]),
          caseLaw: JSON.stringify([{ caseId: 'cl-1' }]),
        }),
      ],
    });
    const result = (await handler(snapshotEvent())) as Array<{
      authorityUnitsCount: number;
      compositionContractsCount: number;
      constitutionalLayersCount: number;
      caseLawCount: number;
    }>;
    expect(result[0].authorityUnitsCount).toBe(2);
    expect(result[0].compositionContractsCount).toBe(1);
    expect(result[0].constitutionalLayersCount).toBe(0);
    expect(result[0].caseLawCount).toBe(1);
  });

  test('caps result at 500 entries', async () => {
    const bigPage = Array.from({ length: 600 }, (_, i) =>
      makeSnapshotRow({
        snapshotId: `s-${i}`,
        timestamp: 1715000000 + i,
      }),
    );
    ddbMock.on(QueryCommand).resolves({
      Items: bigPage,
      LastEvaluatedKey: { snapshotId: 's-599' },
    });
    const result = (await handler(snapshotEvent())) as unknown[];
    expect(result).toHaveLength(500);
  });

  test('cache hit on identical args within 60s avoids second DDB query', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [makeSnapshotRow()] });
    await handler(snapshotEvent({ sinceTs: 100, untilTs: 200 }));
    await handler(snapshotEvent({ sinceTs: 100, untilTs: 200 }));
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(1);
  });

  test('365-day window cap clamps an over-wide window', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    const untilTs = Math.floor(Date.now() / 1000);
    const sinceTs = untilTs - 1000 * 86400; // 1000 days back, > 365 cap
    await handler(snapshotEvent({ sinceTs, untilTs }));
    const input = ddbMock.commandCalls(QueryCommand)[0].args[0].input;
    const effectiveSince = input.ExpressionAttributeValues?.[':since'] as number;
    const effectiveUntil = input.ExpressionAttributeValues?.[':until'] as number;
    expect(effectiveUntil - effectiveSince).toBe(365 * 86400);
  });

  test('throws when GRAPH_SNAPSHOTS_TABLE env var is not set', async () => {
    const original = process.env.GRAPH_SNAPSHOTS_TABLE;
    delete process.env.GRAPH_SNAPSHOTS_TABLE;
    try {
      await expect(handler(snapshotEvent())).rejects.toThrow(
        'GRAPH_SNAPSHOTS_TABLE env var is not set',
      );
    } finally {
      process.env.GRAPH_SNAPSHOTS_TABLE = original;
    }
  });
});

describe('getAuthorityGraphSnapshot (Wave 4.E.B)', () => {
  function snapshotEvent(snapshotId: string): HandlerEvent {
    return makeEvent({
      fieldName: 'getAuthorityGraphSnapshot',
      args: { snapshotId },
      identity: { sub: 'actor-admin-1', username: 'admin@example.com' },
    });
  }

  function makeSnapshotRow(
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      snapshotId: 's-1',
      kind: 'full',
      timestamp: 1715000000,
      expiresAt: 1715000000 + 30 * 86400,
      partial: false,
      authorityUnits: [
        {
          unitId: 'u-1',
          agentId: 'agent-a',
          scope: JSON.stringify({
            decision_type: 'invoke_agent',
            domain: 'payment',
            conditions: { tier: 'gold' },
            limits: {},
          }),
          revoked: false,
          riskRating: 'low',
          registryId: 'reg-app-1',
          expiryTimestamp: null,
          delegationSource: null,
          canRedelegate: false,
        },
      ],
      compositionContracts: [
        {
          contractId: 'c-1',
          partyA: 'agent-a',
          partyB: 'agent-b',
          authorityPrecedence: 'agent-a',
          conflictResolution: 'halt_and_escalate',
          invariants: ['inv-1'],
          stopRights: ['agent-a'],
          scope: JSON.stringify({}),
          escalationPath: null,
        },
      ],
      constitutionalLayers: [{ layerId: 'l-1' }],
      caseLaw: [{ caseId: 'cl-1' }],
      ...overrides,
    };
  }

  beforeEach(() => {
    isAdminFromEventMock.mockReturnValue(true);
  });

  test('admin gate throws Forbidden for non-admin', async () => {
    isAdminFromEventMock.mockReturnValue(false);
    await expect(handler(snapshotEvent('s-1'))).rejects.toThrow(
      'Forbidden: admin required',
    );
  });

  test('returns null when snapshot not found', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    const result = (await handler(snapshotEvent('s-missing'))) as unknown;
    expect(result).toBeNull();
  });

  test('returns projected snapshot with authorityUnits + contracts only (no layers/case-law)', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [makeSnapshotRow()] });
    const result = (await handler(snapshotEvent('s-1'))) as Record<
      string,
      unknown
    >;
    expect(result).not.toBeNull();
    expect(result.snapshotId).toBe('s-1');
    expect(result.kind).toBe('full');
    expect(Array.isArray(result.authorityUnits)).toBe(true);
    expect(Array.isArray(result.compositionContracts)).toBe(true);
    // No layers / case-law in the response.
    expect(result).not.toHaveProperty('constitutionalLayers');
    expect(result).not.toHaveProperty('caseLaw');
    expect((result.authorityUnits as unknown[]).length).toBe(1);
    expect((result.compositionContracts as unknown[]).length).toBe(1);
  });

  test('isValid is computed against the SNAPSHOT timestamp not Date.now()', async () => {
    // Snapshot timestamp at 1_000_000 (epoch sec). Unit expiry sits AFTER
    // the snapshot timestamp but BEFORE Date.now() — isValid MUST be true
    // in the historical view.
    const snapshotTs = 1_000_000;
    const expiryAfterSnapshot = 1_500_000; // > snapshot, < Date.now()
    ddbMock.on(QueryCommand).resolves({
      Items: [
        makeSnapshotRow({
          timestamp: snapshotTs,
          authorityUnits: [
            {
              unitId: 'u-historical',
              agentId: 'agent-x',
              scope: JSON.stringify({
                decision_type: '*',
                domain: '*',
                conditions: {},
                limits: {},
              }),
              revoked: false,
              riskRating: 'low',
              expiryTimestamp: expiryAfterSnapshot,
              delegationSource: null,
              canRedelegate: false,
              registryId: 'reg-1',
            },
          ],
        }),
      ],
    });
    const result = (await handler(snapshotEvent('s-1'))) as {
      authorityUnits: Array<{ unitId: string; isValid: boolean }>;
    };
    expect(result.authorityUnits).toHaveLength(1);
    expect(result.authorityUnits[0].unitId).toBe('u-historical');
    expect(result.authorityUnits[0].isValid).toBe(true);

    // Sanity: a unit whose expiry is BEFORE the snapshot timestamp
    // must surface as isValid=false even though it would have been
    // newly minted at some earlier epoch.
    __resetGetAuthorityGraphSnapshotCacheForTest();
    ddbMock.reset();
    isAdminFromEventMock.mockReturnValue(true);
    ddbMock.on(QueryCommand).resolves({
      Items: [
        makeSnapshotRow({
          timestamp: snapshotTs,
          authorityUnits: [
            {
              unitId: 'u-pre-expired',
              agentId: 'agent-y',
              scope: JSON.stringify({}),
              revoked: false,
              expiryTimestamp: snapshotTs - 1,
              delegationSource: null,
              canRedelegate: false,
            },
          ],
        }),
      ],
    });
    const expiredResult = (await handler(snapshotEvent('s-1'))) as {
      authorityUnits: Array<{ isValid: boolean }>;
    };
    expect(expiredResult.authorityUnits[0].isValid).toBe(false);
  });

  test('computes scope specificity from conditions + limits keys', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        makeSnapshotRow({
          authorityUnits: [
            {
              unitId: 'u-spec',
              agentId: 'agent-a',
              scope: JSON.stringify({
                decision_type: 'invoke',
                domain: 'p',
                conditions: { a: 1, b: 2 },
                limits: { c: 3 },
              }),
              revoked: false,
              expiryTimestamp: null,
              delegationSource: null,
              canRedelegate: false,
            },
          ],
        }),
      ],
    });
    const result = (await handler(snapshotEvent('s-1'))) as {
      authorityUnits: Array<{ scope: { specificity: number } }>;
    };
    expect(result.authorityUnits[0].scope.specificity).toBe(3);
  });

  test('cache hit on the same snapshotId within 30s avoids second DDB query', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [makeSnapshotRow()] });
    await handler(snapshotEvent('s-1'));
    await handler(snapshotEvent('s-1'));
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(1);
  });

  test('cache also remembers null results so we do not re-query missing snapshots', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    const a = await handler(snapshotEvent('s-missing'));
    const b = await handler(snapshotEvent('s-missing'));
    expect(a).toBeNull();
    expect(b).toBeNull();
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// computeD4Recommendation pure helper — Wave 5.A
// ---------------------------------------------------------------------------

describe('computeD4Recommendation', () => {
  test('insufficientEvidence=true returns deferred-90d regardless of counts', () => {
    expect(
      computeD4Recommendation(
        {
          preFilterTotal: 100,
          toolHandlerTotal: 0,
          distinctPreFilter: 50,
          distinctToolHandler: 0,
          overlap: 0,
        },
        true,
      ),
    ).toBe('deferred-90d');
  });

  test('overlap > 0.90 returns re-debate', () => {
    expect(
      computeD4Recommendation(
        {
          preFilterTotal: 10,
          toolHandlerTotal: 10,
          distinctPreFilter: 10,
          distinctToolHandler: 10,
          overlap: 10,
        },
        false,
      ),
    ).toBe('re-debate');
  });

  test('overlap < 0.20 returns keep-both-strong-evidence', () => {
    expect(
      computeD4Recommendation(
        {
          preFilterTotal: 10,
          toolHandlerTotal: 10,
          distinctPreFilter: 10,
          distinctToolHandler: 10,
          overlap: 1,
        },
        false,
      ),
    ).toBe('keep-both-strong-evidence');
  });

  test('overlap in [0.20, 0.90] returns keep-both', () => {
    expect(
      computeD4Recommendation(
        {
          preFilterTotal: 10,
          toolHandlerTotal: 10,
          distinctPreFilter: 10,
          distinctToolHandler: 10,
          overlap: 5,
        },
        false,
      ),
    ).toBe('keep-both');
  });

  test('boundary: exactly 0.90 is keep-both (strict > used)', () => {
    expect(
      computeD4Recommendation(
        {
          preFilterTotal: 10,
          toolHandlerTotal: 10,
          distinctPreFilter: 10,
          distinctToolHandler: 10,
          overlap: 9,
        },
        false,
      ),
    ).toBe('keep-both');
  });

  test('boundary: exactly 0.20 is keep-both (strict < used)', () => {
    expect(
      computeD4Recommendation(
        {
          preFilterTotal: 10,
          toolHandlerTotal: 10,
          distinctPreFilter: 10,
          distinctToolHandler: 10,
          overlap: 2,
        },
        false,
      ),
    ).toBe('keep-both');
  });

  test('zero distinct sets use max(...,1) denominator → 0/1 = 0 → keep-both-strong-evidence', () => {
    // insufficientEvidence=false but no findings — defensive zero-denominator
    // guard mirrors the Python script's max(..., 1).
    expect(
      computeD4Recommendation(
        {
          preFilterTotal: 0,
          toolHandlerTotal: 1,
          distinctPreFilter: 0,
          distinctToolHandler: 0,
          overlap: 0,
        },
        false,
      ),
    ).toBe('keep-both-strong-evidence');
  });
});

// ---------------------------------------------------------------------------
// getD4RetrospectiveReport — Wave 5.A (D4 retrospective; admin-only)
// ---------------------------------------------------------------------------

describe('getD4RetrospectiveReport', () => {
  function makeD4Row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      findingId: 'f-' + Math.random().toString(36).slice(2, 8),
      workflow_id: 'wf-1',
      decision: 'deny',
      reason: 'rule:winner=X',
      scope_evaluated: 'worker-pre-filter',
      timestamp: Math.floor(Date.now() / 1000) - 100,
      ...overrides,
    };
  }

  test('throws when caller is not admin', async () => {
    isAdminFromEventMock.mockReturnValue(false);

    await expect(
      handler(makeEvent({ fieldName: 'getD4RetrospectiveReport', args: {} })),
    ).rejects.toThrow('Forbidden: admin required');
  });

  test('default windowDays=30 when arg omitted', async () => {
    isAdminFromEventMock.mockReturnValue(true);
    ddbMock.on(ScanCommand).resolves({ Items: [] });

    const result = (await handler(
      makeEvent({ fieldName: 'getD4RetrospectiveReport', args: {} }),
    )) as { windowDays: number; windowStart: number; windowEnd: number };

    expect(result.windowDays).toBe(30);
    expect(result.windowEnd - result.windowStart).toBe(30 * 86400);
  });

  test('windowDays outside the allowlist throws', async () => {
    isAdminFromEventMock.mockReturnValue(true);

    await expect(
      handler(
        makeEvent({
          fieldName: 'getD4RetrospectiveReport',
          args: { windowDays: 45 },
        }),
      ),
    ).rejects.toThrow('Invalid windowDays');
  });

  test.each([7, 14, 30, 60, 90])(
    'windowDays=%d is in the allowlist',
    async (days) => {
      isAdminFromEventMock.mockReturnValue(true);
      ddbMock.on(ScanCommand).resolves({ Items: [] });

      const result = (await handler(
        makeEvent({
          fieldName: 'getD4RetrospectiveReport',
          args: { windowDays: days },
        }),
      )) as { windowDays: number };
      expect(result.windowDays).toBe(days);
    },
  );

  test('returns insufficientEvidence=true and recommendation=deferred-90d when toolHandlerTotal=0', async () => {
    isAdminFromEventMock.mockReturnValue(true);
    // Three pre-filter rows, zero tool-handler rows.
    ddbMock.on(ScanCommand).resolves({
      Items: [
        makeD4Row({ workflow_id: 'wf-1', reason: 'r1' }),
        makeD4Row({ workflow_id: 'wf-2', reason: 'r2' }),
        makeD4Row({ workflow_id: 'wf-3', reason: 'r3' }),
      ],
    });

    const result = (await handler(
      makeEvent({ fieldName: 'getD4RetrospectiveReport', args: {} }),
    )) as {
      insufficientEvidence: boolean;
      recommendation: string;
      counts: { toolHandlerTotal: number };
    };

    expect(result.insufficientEvidence).toBe(true);
    expect(result.recommendation).toBe('deferred-90d');
    expect(result.counts.toolHandlerTotal).toBe(0);
  });

  test('distinctPreFilter dedupes by (workflow_id, reason): 3 rows / 2 unique tuples → distinctPreFilter=2', async () => {
    isAdminFromEventMock.mockReturnValue(true);
    ddbMock.on(ScanCommand).resolves({
      Items: [
        makeD4Row({ workflow_id: 'wf-1', reason: 'r1' }),
        // Duplicate tuple — should not bump distinct count.
        makeD4Row({ workflow_id: 'wf-1', reason: 'r1' }),
        makeD4Row({ workflow_id: 'wf-2', reason: 'r2' }),
        // Need at least one tool-handler row to avoid insufficient-evidence.
        makeD4Row({
          workflow_id: 'wf-th',
          reason: 'rt',
          scope_evaluated: 'worker-tool-handler',
        }),
      ],
    });

    const result = (await handler(
      makeEvent({ fieldName: 'getD4RetrospectiveReport', args: {} }),
    )) as {
      counts: {
        preFilterTotal: number;
        distinctPreFilter: number;
        distinctToolHandler: number;
      };
    };

    expect(result.counts.preFilterTotal).toBe(3);
    expect(result.counts.distinctPreFilter).toBe(2);
    expect(result.counts.distinctToolHandler).toBe(1);
  });

  test('overlap = (preFilter ∩ toolHandler).size — 3 overlapping + 2 disjoint', async () => {
    isAdminFromEventMock.mockReturnValue(true);
    ddbMock.on(ScanCommand).resolves({
      Items: [
        // 3 tuples in BOTH sets.
        makeD4Row({ workflow_id: 'a', reason: 'x', scope_evaluated: 'worker-pre-filter' }),
        makeD4Row({ workflow_id: 'a', reason: 'x', scope_evaluated: 'worker-tool-handler' }),
        makeD4Row({ workflow_id: 'b', reason: 'y', scope_evaluated: 'worker-pre-filter' }),
        makeD4Row({ workflow_id: 'b', reason: 'y', scope_evaluated: 'worker-tool-handler' }),
        makeD4Row({ workflow_id: 'c', reason: 'z', scope_evaluated: 'worker-pre-filter' }),
        makeD4Row({ workflow_id: 'c', reason: 'z', scope_evaluated: 'worker-tool-handler' }),
        // 2 disjoint pre-filter-only tuples.
        makeD4Row({ workflow_id: 'd', reason: 'w', scope_evaluated: 'worker-pre-filter' }),
        makeD4Row({ workflow_id: 'e', reason: 'v', scope_evaluated: 'worker-pre-filter' }),
      ],
    });

    const result = (await handler(
      makeEvent({ fieldName: 'getD4RetrospectiveReport', args: {} }),
    )) as { counts: { overlap: number; distinctPreFilter: number; distinctToolHandler: number }; overlapRatio: number };

    expect(result.counts.overlap).toBe(3);
    expect(result.counts.distinctPreFilter).toBe(5);
    expect(result.counts.distinctToolHandler).toBe(3);
    // overlap / max(5, 3, 1) = 3/5 = 0.6
    expect(result.overlapRatio).toBeCloseTo(0.6, 5);
  });

  test('recommendation: overlap=10 / max=10 → re-debate', async () => {
    isAdminFromEventMock.mockReturnValue(true);
    const items: Record<string, unknown>[] = [];
    for (let i = 0; i < 10; i++) {
      items.push(
        makeD4Row({
          workflow_id: `w-${i}`,
          reason: `r-${i}`,
          scope_evaluated: 'worker-pre-filter',
        }),
      );
      items.push(
        makeD4Row({
          workflow_id: `w-${i}`,
          reason: `r-${i}`,
          scope_evaluated: 'worker-tool-handler',
        }),
      );
    }
    ddbMock.on(ScanCommand).resolves({ Items: items });

    const result = (await handler(
      makeEvent({ fieldName: 'getD4RetrospectiveReport', args: {} }),
    )) as { recommendation: string; overlapRatio: number };

    expect(result.overlapRatio).toBe(1);
    expect(result.recommendation).toBe('re-debate');
  });

  test('recommendation: overlap=1 / max=10 → keep-both-strong-evidence', async () => {
    isAdminFromEventMock.mockReturnValue(true);
    const items: Record<string, unknown>[] = [];
    // 10 distinct pre-filter tuples.
    for (let i = 0; i < 10; i++) {
      items.push(
        makeD4Row({
          workflow_id: `w-${i}`,
          reason: `r-${i}`,
          scope_evaluated: 'worker-pre-filter',
        }),
      );
    }
    // 1 tool-handler tuple that overlaps with the first pre-filter tuple.
    items.push(
      makeD4Row({
        workflow_id: 'w-0',
        reason: 'r-0',
        scope_evaluated: 'worker-tool-handler',
      }),
    );
    ddbMock.on(ScanCommand).resolves({ Items: items });

    const result = (await handler(
      makeEvent({ fieldName: 'getD4RetrospectiveReport', args: {} }),
    )) as { recommendation: string; overlapRatio: number };

    expect(result.overlapRatio).toBeCloseTo(0.1, 5);
    expect(result.recommendation).toBe('keep-both-strong-evidence');
  });

  test('recommendation: overlap=5 / max=10 → keep-both', async () => {
    isAdminFromEventMock.mockReturnValue(true);
    const items: Record<string, unknown>[] = [];
    // 10 distinct pre-filter tuples.
    for (let i = 0; i < 10; i++) {
      items.push(
        makeD4Row({
          workflow_id: `w-${i}`,
          reason: `r-${i}`,
          scope_evaluated: 'worker-pre-filter',
        }),
      );
    }
    // 5 tool-handler tuples; all overlap with pre-filter w-0..w-4.
    for (let i = 0; i < 5; i++) {
      items.push(
        makeD4Row({
          workflow_id: `w-${i}`,
          reason: `r-${i}`,
          scope_evaluated: 'worker-tool-handler',
        }),
      );
    }
    ddbMock.on(ScanCommand).resolves({ Items: items });

    const result = (await handler(
      makeEvent({ fieldName: 'getD4RetrospectiveReport', args: {} }),
    )) as { recommendation: string; overlapRatio: number };

    expect(result.overlapRatio).toBeCloseTo(0.5, 5);
    expect(result.recommendation).toBe('keep-both');
  });

  test('truncation flag set when scanned items exceed 5000', async () => {
    isAdminFromEventMock.mockReturnValue(true);
    const items: Record<string, unknown>[] = [];
    for (let i = 0; i < 5500; i++) {
      items.push(
        makeD4Row({
          workflow_id: `w-${i}`,
          reason: `r-${i}`,
          scope_evaluated: i % 2 === 0 ? 'worker-pre-filter' : 'worker-tool-handler',
        }),
      );
    }
    ddbMock.on(ScanCommand).resolves({ Items: items });

    const warnSpy = jest.spyOn(console, 'warn');
    const result = (await handler(
      makeEvent({ fieldName: 'getD4RetrospectiveReport', args: {} }),
    )) as {
      truncated: boolean;
      counts: { preFilterTotal: number; toolHandlerTotal: number };
    };

    expect(result.truncated).toBe(true);
    // preFilter + toolHandler raw totals must add up to the cap.
    expect(
      result.counts.preFilterTotal + result.counts.toolHandlerTotal,
    ).toBe(5000);
    expect(
      warnSpy.mock.calls.some((call) => String(call[0]).includes('truncated')),
    ).toBe(true);
  });

  test('cache hit on same windowDays within 5min avoids second DDB scan', async () => {
    isAdminFromEventMock.mockReturnValue(true);
    ddbMock.on(ScanCommand).resolves({
      Items: [
        makeD4Row({
          workflow_id: 'a',
          reason: 'x',
          scope_evaluated: 'worker-tool-handler',
        }),
      ],
    });

    await handler(
      makeEvent({ fieldName: 'getD4RetrospectiveReport', args: {} }),
    );
    await handler(
      makeEvent({ fieldName: 'getD4RetrospectiveReport', args: {} }),
    );

    expect(ddbMock.commandCalls(ScanCommand)).toHaveLength(1);
  });

  test('different windowDays use separate cache slots', async () => {
    isAdminFromEventMock.mockReturnValue(true);
    ddbMock.on(ScanCommand).resolves({
      Items: [
        makeD4Row({
          workflow_id: 'a',
          reason: 'x',
          scope_evaluated: 'worker-tool-handler',
        }),
      ],
    });

    await handler(
      makeEvent({
        fieldName: 'getD4RetrospectiveReport',
        args: { windowDays: 7 },
      }),
    );
    await handler(
      makeEvent({
        fieldName: 'getD4RetrospectiveReport',
        args: { windowDays: 30 },
      }),
    );

    expect(ddbMock.commandCalls(ScanCommand)).toHaveLength(2);
  });

  test('FilterExpression includes decision=:deny AND scope_evaluated IN ... AND #ts BETWEEN ...', async () => {
    isAdminFromEventMock.mockReturnValue(true);
    ddbMock.on(ScanCommand).resolves({ Items: [] });

    await handler(
      makeEvent({
        fieldName: 'getD4RetrospectiveReport',
        args: { windowDays: 7 },
      }),
    );

    const calls = ddbMock.commandCalls(ScanCommand);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const input = calls[0].args[0].input as {
      FilterExpression?: string;
      ExpressionAttributeNames?: Record<string, string>;
      ExpressionAttributeValues?: Record<string, unknown>;
    };
    expect(input.FilterExpression).toContain('decision = :deny');
    expect(input.FilterExpression).toContain('scope_evaluated IN');
    expect(input.FilterExpression).toContain('#ts BETWEEN :since AND :until');
    expect(input.ExpressionAttributeNames).toEqual({ '#ts': 'timestamp' });
    expect(input.ExpressionAttributeValues).toMatchObject({
      ':deny': 'deny',
      ':preFilter': 'worker-pre-filter',
      ':toolHandler': 'worker-tool-handler',
    });
  });
});

// ===========================================================================
// Wave 5.C.1 — getTrustPath
// ===========================================================================

describe('parseTrustPolicyPrincipals', () => {
  test('handles string Principal.AWS', () => {
    const trust = JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Principal: { AWS: 'arn:aws:iam::123:role/r1' },
          Action: 'sts:AssumeRole',
        },
      ],
    });
    expect(parseTrustPolicyPrincipals(trust)).toEqual([
      'arn:aws:iam::123:role/r1',
    ]);
  });

  test('handles array Principal.AWS', () => {
    const trust = JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Principal: {
            AWS: [
              'arn:aws:iam::123:role/r1',
              'arn:aws:iam::123:role/r2',
            ],
          },
          Action: 'sts:AssumeRole',
        },
      ],
    });
    expect(parseTrustPolicyPrincipals(trust)).toEqual([
      'arn:aws:iam::123:role/r1',
      'arn:aws:iam::123:role/r2',
    ]);
  });

  test('returns empty array on malformed JSON', () => {
    expect(parseTrustPolicyPrincipals('{not-json')).toEqual([]);
  });

  test('returns empty array when document is undefined', () => {
    expect(parseTrustPolicyPrincipals(undefined)).toEqual([]);
  });
});

describe('projectInlinePolicyDocument', () => {
  test('coerces string Action / Resource to arrays', () => {
    const doc = JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        { Effect: 'Allow', Action: 's3:GetObject', Resource: 'arn:aws:s3:::b/*' },
      ],
    });
    expect(projectInlinePolicyDocument(doc)).toEqual([
      {
        effect: 'Allow',
        actions: ['s3:GetObject'],
        resources: ['arn:aws:s3:::b/*'],
        conditionsJson: null,
      },
    ]);
  });

  test('preserves Condition as conditionsJson', () => {
    const doc = JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Action: ['s3:GetObject'],
          Resource: ['arn:aws:s3:::b/*'],
          Condition: { StringEquals: { 'aws:RequestTag/team': 'platform' } },
        },
      ],
    });
    const result = projectInlinePolicyDocument(doc);
    expect(result).toHaveLength(1);
    expect(JSON.parse(result[0].conditionsJson as string)).toEqual({
      StringEquals: { 'aws:RequestTag/team': 'platform' },
    });
  });

  test('returns empty array on malformed JSON', () => {
    expect(projectInlinePolicyDocument('{not-json')).toEqual([]);
  });
});

describe('extractCrossAccountRoleArn', () => {
  test('reads top-level field', () => {
    expect(
      extractCrossAccountRoleArn({
        crossAccountRoleArn: 'arn:aws:iam::999:role/x',
      }),
    ).toBe('arn:aws:iam::999:role/x');
  });

  test('reads nested config.crossAccountRoleArn', () => {
    expect(
      extractCrossAccountRoleArn({
        config: { crossAccountRoleArn: 'arn:aws:iam::999:role/x' },
      }),
    ).toBe('arn:aws:iam::999:role/x');
  });

  test('returns null when absent', () => {
    expect(extractCrossAccountRoleArn({ name: 'foo' })).toBeNull();
    expect(extractCrossAccountRoleArn(null)).toBeNull();
  });
});

describe('getTrustPath', () => {
  const ACCOUNT_ID = '123456789012';

  // Default ARN matches the env var set at the top of this test file.
  const LAMBDA_ROLE_ARN = 'arn:aws:iam::123456789012:role/citadel-governance-ui-resolver-test';

  function makeTrustPolicy(principals: string | string[]): string {
    return JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Principal: { AWS: principals },
          Action: 'sts:AssumeRole',
        },
      ],
    });
  }

  function makeInlinePolicy(actions: string[], resources: string[]): string {
    return JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        { Effect: 'Allow', Action: actions, Resource: resources },
      ],
    });
  }

  function armSts() {
    stsMock.on(GetCallerIdentityCommand).resolves({ Account: ACCOUNT_ID });
  }

  test('throws when caller is not admin', async () => {
    isAdminFromEventMock.mockReturnValue(false);
    await expect(
      handler(
        makeEvent({
          fieldName: 'getTrustPath',
          args: { resourceType: 'datastore', resourceId: 'ds-1' },
        }),
      ),
    ).rejects.toThrow('Forbidden: admin required');
  });

  test('rejects an invalid resourceType', async () => {
    isAdminFromEventMock.mockReturnValue(true);
    await expect(
      handler(
        makeEvent({
          fieldName: 'getTrustPath',
          args: { resourceType: 'workflow', resourceId: 'ds-1' },
        }),
      ),
    ).rejects.toThrow('Invalid resourceType');
  });

  test('rejects an empty resourceId', async () => {
    isAdminFromEventMock.mockReturnValue(true);
    await expect(
      handler(
        makeEvent({
          fieldName: 'getTrustPath',
          args: { resourceType: 'datastore', resourceId: '' },
        }),
      ),
    ).rejects.toThrow('Invalid resourceId');
  });

  test('rejects a resourceId longer than 256 chars', async () => {
    isAdminFromEventMock.mockReturnValue(true);
    await expect(
      handler(
        makeEvent({
          fieldName: 'getTrustPath',
          args: {
            resourceType: 'datastore',
            resourceId: 'x'.repeat(257),
          },
        }),
      ),
    ).rejects.toThrow('Invalid resourceId');
  });

  test('returns report with note + hops=[Lambda] when datastore not found', async () => {
    isAdminFromEventMock.mockReturnValue(true);
    armSts();
    iamMock.on(GetRoleCommand).resolves({
      Role: {
        RoleName: 'citadel-governance-ui-resolver-test',
        AssumeRolePolicyDocument: makeTrustPolicy('arn:aws:iam::123:role/lambda'),
        Arn: LAMBDA_ROLE_ARN,
        Path: '/',
        RoleId: 'AID',
        CreateDate: new Date(),
      },
    });
    iamMock.on(GetRolePolicyCommand).resolves({
      RoleName: 'citadel-governance-ui-resolver-test',
      PolicyName: 'DataStoreAccess',
      PolicyDocument: makeInlinePolicy(['s3:GetObject'], ['*']),
    });
    ddbMock.on(GetCommand, { TableName: 'citadel-datastores-test' }).resolves({});

    const result = (await handler(
      makeEvent({
        fieldName: 'getTrustPath',
        args: { resourceType: 'datastore', resourceId: 'missing-ds' },
      }),
    )) as { hops: unknown[]; notes: string[]; resourceType: string; resourceId: string };

    expect(result.hops).toHaveLength(1);
    expect(result.notes).toContain('Resource not found: datastore/missing-ds');
    expect(result.resourceType).toBe('datastore');
    expect(result.resourceId).toBe('missing-ds');
  });

  test('datastore without crossAccountRoleArn → hops = [lambda, scoped]', async () => {
    isAdminFromEventMock.mockReturnValue(true);
    armSts();
    iamMock.on(GetRoleCommand).callsFake(async (input: GetRoleCommandInput) => ({
      Role: {
        RoleName: input.RoleName,
        AssumeRolePolicyDocument: makeTrustPolicy('arn:aws:iam::1:role/x'),
        Arn: `arn:aws:iam::${ACCOUNT_ID}:role/${input.RoleName}`,
        Path: '/',
        RoleId: 'AID',
        CreateDate: new Date(),
      },
    }));
    iamMock.on(GetRolePolicyCommand).callsFake(async (input: GetRolePolicyCommandInput) => ({
      RoleName: input.RoleName,
      PolicyName: 'DataStoreAccess',
      PolicyDocument: makeInlinePolicy(['s3:GetObject'], ['arn:aws:s3:::b/*']),
    }));
    ddbMock.on(GetCommand, { TableName: 'citadel-datastores-test' }).resolves({
      Item: { dataStoreId: 'ds-1', name: 'My DS' },
    });

    const result = (await handler(
      makeEvent({
        fieldName: 'getTrustPath',
        args: { resourceType: 'datastore', resourceId: 'ds-1' },
      }),
    )) as { hops: Array<{ scope: string; arn: string }> };

    expect(result.hops).toHaveLength(2);
    expect(result.hops[0].scope).toBe('lambda');
    expect(result.hops[1].scope).toBe('datastore');
    expect(result.hops[1].arn).toBe(
      `arn:aws:iam::${ACCOUNT_ID}:role/citadel-ds-ds-1`,
    );
  });

  test('datastore with crossAccountRoleArn → hops = [lambda, cross-account, scoped]', async () => {
    isAdminFromEventMock.mockReturnValue(true);
    armSts();
    iamMock.on(GetRoleCommand).callsFake(async (input: GetRoleCommandInput) => ({
      Role: {
        RoleName: input.RoleName,
        AssumeRolePolicyDocument: makeTrustPolicy('arn:aws:iam::1:role/x'),
        Arn: `arn:aws:iam::${ACCOUNT_ID}:role/${input.RoleName}`,
        Path: '/',
        RoleId: 'AID',
        CreateDate: new Date(),
      },
    }));
    iamMock.on(GetRolePolicyCommand).resolves({
      PolicyName: 'DataStoreAccess',
      PolicyDocument: makeInlinePolicy(['s3:GetObject'], ['*']),
    });
    ddbMock.on(GetCommand, { TableName: 'citadel-datastores-test' }).resolves({
      Item: {
        dataStoreId: 'ds-1',
        config: { crossAccountRoleArn: 'arn:aws:iam::999:role/cross' },
      },
    });

    const result = (await handler(
      makeEvent({
        fieldName: 'getTrustPath',
        args: { resourceType: 'datastore', resourceId: 'ds-1' },
      }),
    )) as { hops: Array<{ scope: string; arn: string }> };

    expect(result.hops).toHaveLength(3);
    expect(result.hops[0].scope).toBe('lambda');
    expect(result.hops[1].scope).toBe('cross-account');
    expect(result.hops[1].arn).toBe('arn:aws:iam::999:role/cross');
    expect(result.hops[2].scope).toBe('datastore');
  });

  test('integration path queries by GSI and emits scoped role with citadel-int- prefix', async () => {
    isAdminFromEventMock.mockReturnValue(true);
    armSts();
    iamMock.on(GetRoleCommand).callsFake(async (input: GetRoleCommandInput) => ({
      Role: {
        RoleName: input.RoleName,
        AssumeRolePolicyDocument: makeTrustPolicy('arn:aws:iam::1:role/x'),
        Arn: `arn:aws:iam::${ACCOUNT_ID}:role/${input.RoleName}`,
        Path: '/',
        RoleId: 'AID',
        CreateDate: new Date(),
      },
    }));
    iamMock.on(GetRolePolicyCommand).resolves({
      PolicyName: 'DataStoreAccess',
      PolicyDocument: makeInlinePolicy(['s3:GetObject'], ['*']),
    });
    ddbMock
      .on(QueryCommand, { TableName: 'citadel-integrations-test' })
      .resolves({
        Items: [{ integrationId: 'int-1', name: 'My Integration' }],
      });

    const result = (await handler(
      makeEvent({
        fieldName: 'getTrustPath',
        args: { resourceType: 'integration', resourceId: 'int-1' },
      }),
    )) as { hops: Array<{ scope: string; arn: string }> };

    expect(result.hops).toHaveLength(2);
    expect(result.hops[1].scope).toBe('integration');
    expect(result.hops[1].arn).toBe(
      `arn:aws:iam::${ACCOUNT_ID}:role/citadel-int-int-1`,
    );
  });

  test('agent path uses RegistryService and emits citadel-agent- prefix', async () => {
    isAdminFromEventMock.mockReturnValue(true);
    armSts();
    iamMock.on(GetRoleCommand).callsFake(async (input: GetRoleCommandInput) => ({
      Role: {
        RoleName: input.RoleName,
        AssumeRolePolicyDocument: makeTrustPolicy('arn:aws:iam::1:role/x'),
        Arn: `arn:aws:iam::${ACCOUNT_ID}:role/${input.RoleName}`,
        Path: '/',
        RoleId: 'AID',
        CreateDate: new Date(),
      },
    }));
    iamMock.on(GetRolePolicyCommand).resolves({
      PolicyName: 'DataStoreAccess',
      PolicyDocument: makeInlinePolicy(['s3:GetObject'], ['*']),
    });
    getResourceMock.mockResolvedValue({
      recordId: 'agent-1',
      name: 'My Agent',
      status: 'ACTIVE',
    });

    const result = (await handler(
      makeEvent({
        fieldName: 'getTrustPath',
        args: { resourceType: 'agent', resourceId: 'agent-1' },
      }),
    )) as { hops: Array<{ scope: string; arn: string }> };

    expect(result.hops).toHaveLength(2);
    expect(result.hops[1].scope).toBe('agent');
    expect(result.hops[1].arn).toBe(
      `arn:aws:iam::${ACCOUNT_ID}:role/citadel-agent-agent-1`,
    );
    expect(getResourceMock).toHaveBeenCalledWith('agent', 'agent-1');
  });

  test('GetRole missing → hop has empty principals + note "Role <arn> not found"', async () => {
    isAdminFromEventMock.mockReturnValue(true);
    armSts();
    // Lambda role lookup succeeds; scoped role lookup throws NoSuchEntity.
    iamMock.on(GetRoleCommand).callsFake(async (input: GetRoleCommandInput) => {
      if (input.RoleName === 'citadel-ds-ds-1') {
        const err = new Error('NoSuchEntity');
        err.name = 'NoSuchEntityException';
        throw err;
      }
      return {
        Role: {
          RoleName: input.RoleName,
          AssumeRolePolicyDocument: makeTrustPolicy('arn:aws:iam::1:role/x'),
          Arn: `arn:aws:iam::${ACCOUNT_ID}:role/${input.RoleName}`,
          Path: '/',
          RoleId: 'AID',
          CreateDate: new Date(),
        },
      };
    });
    iamMock.on(GetRolePolicyCommand).resolves({
      PolicyName: 'DataStoreAccess',
      PolicyDocument: makeInlinePolicy(['s3:GetObject'], ['*']),
    });
    ddbMock.on(GetCommand, { TableName: 'citadel-datastores-test' }).resolves({
      Item: { dataStoreId: 'ds-1' },
    });

    const result = (await handler(
      makeEvent({
        fieldName: 'getTrustPath',
        args: { resourceType: 'datastore', resourceId: 'ds-1' },
      }),
    )) as { hops: Array<{ scope: string; trustPolicyPrincipals: string[]; arn: string }>; notes: string[] };

    const scopedHop = result.hops.find((h) => h.scope === 'datastore');
    expect(scopedHop).toBeDefined();
    expect(scopedHop!.trustPolicyPrincipals).toEqual([]);
    expect(
      result.notes.some((n) => n.includes('not found') && n.includes(scopedHop!.arn)),
    ).toBe(true);
  });

  test('GetRolePolicy missing → hop has empty inlinePolicy + note', async () => {
    isAdminFromEventMock.mockReturnValue(true);
    armSts();
    iamMock.on(GetRoleCommand).callsFake(async (input: GetRoleCommandInput) => ({
      Role: {
        RoleName: input.RoleName,
        AssumeRolePolicyDocument: makeTrustPolicy('arn:aws:iam::1:role/x'),
        Arn: `arn:aws:iam::${ACCOUNT_ID}:role/${input.RoleName}`,
        Path: '/',
        RoleId: 'AID',
        CreateDate: new Date(),
      },
    }));
    iamMock.on(GetRolePolicyCommand).callsFake(async (input: GetRolePolicyCommandInput) => {
      if (input.RoleName === 'citadel-ds-ds-1') {
        const err = new Error('NoSuchEntity');
        err.name = 'NoSuchEntityException';
        throw err;
      }
      return {
        PolicyName: 'DataStoreAccess',
        PolicyDocument: makeInlinePolicy(['s3:GetObject'], ['*']),
      };
    });
    ddbMock.on(GetCommand, { TableName: 'citadel-datastores-test' }).resolves({
      Item: { dataStoreId: 'ds-1' },
    });

    const result = (await handler(
      makeEvent({
        fieldName: 'getTrustPath',
        args: { resourceType: 'datastore', resourceId: 'ds-1' },
      }),
    )) as { hops: Array<{ scope: string; inlinePolicy: unknown[]; inlinePolicyName: string | null; arn: string }>; notes: string[] };

    const scopedHop = result.hops.find((h) => h.scope === 'datastore');
    expect(scopedHop!.inlinePolicy).toEqual([]);
    expect(scopedHop!.inlinePolicyName).toBeNull();
    expect(
      result.notes.some(
        (n) => n.includes('Inline policy not present') && n.includes(scopedHop!.arn),
      ),
    ).toBe(true);
  });

  test('totalActions / totalResources reflect inline policy contents', async () => {
    isAdminFromEventMock.mockReturnValue(true);
    armSts();
    iamMock.on(GetRoleCommand).callsFake(async (input: GetRoleCommandInput) => ({
      Role: {
        RoleName: input.RoleName,
        AssumeRolePolicyDocument: makeTrustPolicy('arn:aws:iam::1:role/x'),
        Arn: `arn:aws:iam::${ACCOUNT_ID}:role/${input.RoleName}`,
        Path: '/',
        RoleId: 'AID',
        CreateDate: new Date(),
      },
    }));
    iamMock.on(GetRolePolicyCommand).resolves({
      PolicyName: 'DataStoreAccess',
      PolicyDocument: makeInlinePolicy(
        ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
        ['arn:aws:s3:::b1/*', 'arn:aws:s3:::b2/*'],
      ),
    });
    ddbMock.on(GetCommand, { TableName: 'citadel-datastores-test' }).resolves({
      Item: { dataStoreId: 'ds-1' },
    });

    const result = (await handler(
      makeEvent({
        fieldName: 'getTrustPath',
        args: { resourceType: 'datastore', resourceId: 'ds-1' },
      }),
    )) as { hops: Array<{ scope: string; totalActions: number; totalResources: number }> };

    const scopedHop = result.hops.find((h) => h.scope === 'datastore');
    expect(scopedHop!.totalActions).toBe(3);
    expect(scopedHop!.totalResources).toBe(2);
  });

  test('trust policy parses Principal.AWS array shape', async () => {
    isAdminFromEventMock.mockReturnValue(true);
    armSts();
    iamMock.on(GetRoleCommand).callsFake(async (input: GetRoleCommandInput) => ({
      Role: {
        RoleName: input.RoleName,
        AssumeRolePolicyDocument: makeTrustPolicy([
          'arn:aws:iam::1:role/a',
          'arn:aws:iam::1:role/b',
        ]),
        Arn: `arn:aws:iam::${ACCOUNT_ID}:role/${input.RoleName}`,
        Path: '/',
        RoleId: 'AID',
        CreateDate: new Date(),
      },
    }));
    iamMock.on(GetRolePolicyCommand).resolves({
      PolicyName: 'DataStoreAccess',
      PolicyDocument: makeInlinePolicy(['s3:GetObject'], ['*']),
    });
    ddbMock.on(GetCommand, { TableName: 'citadel-datastores-test' }).resolves({
      Item: { dataStoreId: 'ds-1' },
    });

    const result = (await handler(
      makeEvent({
        fieldName: 'getTrustPath',
        args: { resourceType: 'datastore', resourceId: 'ds-1' },
      }),
    )) as { hops: Array<{ scope: string; trustPolicyPrincipals: string[] }> };

    const scopedHop = result.hops.find((h) => h.scope === 'datastore');
    expect(scopedHop!.trustPolicyPrincipals).toEqual([
      'arn:aws:iam::1:role/a',
      'arn:aws:iam::1:role/b',
    ]);
  });

  test('5-min cache: same args within window avoid second GetRole call', async () => {
    isAdminFromEventMock.mockReturnValue(true);
    armSts();
    iamMock.on(GetRoleCommand).callsFake(async (input: GetRoleCommandInput) => ({
      Role: {
        RoleName: input.RoleName,
        AssumeRolePolicyDocument: makeTrustPolicy('arn:aws:iam::1:role/x'),
        Arn: `arn:aws:iam::${ACCOUNT_ID}:role/${input.RoleName}`,
        Path: '/',
        RoleId: 'AID',
        CreateDate: new Date(),
      },
    }));
    iamMock.on(GetRolePolicyCommand).resolves({
      PolicyName: 'DataStoreAccess',
      PolicyDocument: makeInlinePolicy(['s3:GetObject'], ['*']),
    });
    ddbMock.on(GetCommand, { TableName: 'citadel-datastores-test' }).resolves({
      Item: { dataStoreId: 'ds-1' },
    });

    await handler(
      makeEvent({
        fieldName: 'getTrustPath',
        args: { resourceType: 'datastore', resourceId: 'ds-1' },
      }),
    );
    const callsAfterFirst = iamMock.commandCalls(GetRoleCommand).length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    await handler(
      makeEvent({
        fieldName: 'getTrustPath',
        args: { resourceType: 'datastore', resourceId: 'ds-1' },
      }),
    );
    // Second invocation should NOT increase the GetRole call count.
    expect(iamMock.commandCalls(GetRoleCommand).length).toBe(callsAfterFirst);
  });

  test('LAMBDA_EXEC_ROLE_ARN unset → fallback note "Lambda execution role unresolvable..."', async () => {
    isAdminFromEventMock.mockReturnValue(true);
    armSts();
    const saved = process.env.LAMBDA_EXEC_ROLE_ARN;
    delete process.env.LAMBDA_EXEC_ROLE_ARN;
    try {
      ddbMock.on(GetCommand, { TableName: 'citadel-datastores-test' }).resolves({
        Item: { dataStoreId: 'ds-1' },
      });
      iamMock.on(GetRoleCommand).callsFake(async (input: GetRoleCommandInput) => ({
        Role: {
          RoleName: input.RoleName,
          AssumeRolePolicyDocument: makeTrustPolicy('arn:aws:iam::1:role/x'),
          Arn: `arn:aws:iam::${ACCOUNT_ID}:role/${input.RoleName}`,
          Path: '/',
          RoleId: 'AID',
          CreateDate: new Date(),
        },
      }));
      iamMock.on(GetRolePolicyCommand).resolves({
        PolicyName: 'DataStoreAccess',
        PolicyDocument: makeInlinePolicy(['s3:GetObject'], ['*']),
      });

      const result = (await handler(
        makeEvent({
          fieldName: 'getTrustPath',
          args: { resourceType: 'datastore', resourceId: 'ds-1' },
        }),
      )) as { hops: Array<{ scope: string; arn: string }>; notes: string[] };

      expect(
        result.notes.some((n) =>
          n.includes('Lambda execution role unresolvable'),
        ),
      ).toBe(true);
      // Hop 1 still emitted as UNKNOWN to keep chain length consistent.
      expect(result.hops[0].scope).toBe('lambda');
      expect(result.hops[0].arn).toBe('unknown');
    } finally {
      process.env.LAMBDA_EXEC_ROLE_ARN = saved;
    }
  });
});


// ===========================================================================
// Wave 5.C — getResourceIamDrift
// ===========================================================================

describe('getResourceIamDrift', () => {
  const ACCOUNT_ID = '123456789012';
  const getUnifiedRegistryMock = getUnifiedRegistry as jest.MockedFunction<
    typeof getUnifiedRegistry
  >;

  /**
   * Build a URL-encoded inline policy document of the same shape IAM
   * returns from GetRolePolicy. The resolver decodes + parses this
   * before deriving the effective action set.
   */
  function encodedInlineDoc(
    statements: Array<{
      Action: string | string[];
      Resource: string | string[];
    }>,
  ): string {
    return encodeURIComponent(
      JSON.stringify({
        Version: '2012-10-17',
        Statement: statements.map((s) => ({
          Effect: 'Allow',
          Action: s.Action,
          Resource: s.Resource,
        })),
      }),
    );
  }

  function armSts() {
    stsMock.on(GetCallerIdentityCommand).resolves({ Account: ACCOUNT_ID });
  }

  // Default adapter stub: declared = `s3:GetObject` on `arn:aws:s3:::b/*`.
  // Tests that need a different fixture override the mockReturnValue.
  let requiredPoliciesMock: jest.Mock;

  beforeEach(() => {
    requiredPoliciesMock = jest.fn().mockReturnValue({
      connect: [
        { actions: ['s3:GetObject'], resources: ['arn:aws:s3:::b/*'] },
      ],
    });
    getUnifiedRegistryMock.mockReset();
    getUnifiedRegistryMock.mockReturnValue({
      getAdapter: jest.fn().mockReturnValue({
        requiredPolicies: requiredPoliciesMock,
      }),
    } as unknown as ReturnType<typeof getUnifiedRegistry>);
  });

  test('throws when caller is not admin', async () => {
    isAdminFromEventMock.mockReturnValue(false);

    await expect(
      handler(
        makeEvent({
          fieldName: 'getResourceIamDrift',
          args: { resourceType: 'datastore', resourceId: 'ds-1' },
        }),
      ),
    ).rejects.toThrow('Forbidden: admin required');
  });

  test('throws on invalid resourceType', async () => {
    isAdminFromEventMock.mockReturnValue(true);

    await expect(
      handler(
        makeEvent({
          fieldName: 'getResourceIamDrift',
          args: { resourceType: 'workflow', resourceId: 'ds-1' },
        }),
      ),
    ).rejects.toThrow(/Invalid resourceType/);
  });

  test('throws on empty resourceId', async () => {
    isAdminFromEventMock.mockReturnValue(true);

    await expect(
      handler(
        makeEvent({
          fieldName: 'getResourceIamDrift',
          args: { resourceType: 'datastore', resourceId: '' },
        }),
      ),
    ).rejects.toThrow();
  });

  test('returns degraded report when resource not found', async () => {
    isAdminFromEventMock.mockReturnValue(true);
    // Datastore lookup returns no Item → loadTrustPathResource yields null.
    ddbMock
      .on(GetCommand, { TableName: 'citadel-datastores-test' })
      .resolves({});

    const result = (await handler(
      makeEvent({
        fieldName: 'getResourceIamDrift',
        args: { resourceType: 'datastore', resourceId: 'missing-ds' },
      }),
    )) as {
      groups: unknown[];
      notes: string[];
      hasDrift: boolean;
      totalExcess: number;
    };

    expect(result.groups).toEqual([]);
    expect(result.hasDrift).toBe(false);
    expect(result.totalExcess).toBe(0);
    expect(
      result.notes.some((n) => n.includes('Resource not found:')),
    ).toBe(true);
  });

  test('returns degraded report when inline policy missing', async () => {
    isAdminFromEventMock.mockReturnValue(true);
    armSts();
    ddbMock
      .on(GetCommand, { TableName: 'citadel-datastores-test' })
      .resolves({
        Item: { dataStoreId: 'ds-1', type: 's3', config: {} },
      });
    const noSuch = new Error('NoSuchEntity');
    noSuch.name = 'NoSuchEntityException';
    iamMock.on(GetRolePolicyCommand).rejects(noSuch);

    const result = (await handler(
      makeEvent({
        fieldName: 'getResourceIamDrift',
        args: { resourceType: 'datastore', resourceId: 'ds-1' },
      }),
    )) as { groups: unknown[]; notes: string[] };

    expect(result.groups).toEqual([]);
    expect(
      result.notes.some((n) =>
        n.includes('Inline policy DataStoreAccess not present on'),
      ),
    ).toBe(true);
  });

  test('returns degraded report when adapter not registered', async () => {
    isAdminFromEventMock.mockReturnValue(true);
    armSts();
    ddbMock
      .on(GetCommand, { TableName: 'citadel-datastores-test' })
      .resolves({
        Item: { dataStoreId: 'ds-1', type: 's3', config: {} },
      });
    iamMock.on(GetRolePolicyCommand).resolves({
      RoleName: 'citadel-ds-ds-1',
      PolicyName: 'DataStoreAccess',
      PolicyDocument: encodedInlineDoc([
        { Action: ['s3:GetObject'], Resource: ['arn:aws:s3:::b/*'] },
      ]),
    });
    // Override the adapter mock so getAdapter throws.
    getUnifiedRegistryMock.mockReturnValue({
      getAdapter: jest.fn(() => {
        throw new Error('No adapter for type s3');
      }),
    } as unknown as ReturnType<typeof getUnifiedRegistry>);

    const result = (await handler(
      makeEvent({
        fieldName: 'getResourceIamDrift',
        args: { resourceType: 'datastore', resourceId: 'ds-1' },
      }),
    )) as { groups: unknown[]; notes: string[] };

    expect(result.groups).toEqual([]);
    expect(
      result.notes.some((n) =>
        n.includes('Adapter not registered for type'),
      ),
    ).toBe(true);
  });

  test('no drift when declared equals effective', async () => {
    isAdminFromEventMock.mockReturnValue(true);
    armSts();
    ddbMock
      .on(GetCommand, { TableName: 'citadel-datastores-test' })
      .resolves({
        Item: { dataStoreId: 'ds-1', type: 's3', config: {} },
      });
    iamMock.on(GetRolePolicyCommand).resolves({
      RoleName: 'citadel-ds-ds-1',
      PolicyName: 'DataStoreAccess',
      PolicyDocument: encodedInlineDoc([
        { Action: ['s3:GetObject'], Resource: ['arn:aws:s3:::b/*'] },
      ]),
    });
    requiredPoliciesMock.mockReturnValue({
      connect: [
        { actions: ['s3:GetObject'], resources: ['arn:aws:s3:::b/*'] },
      ],
    });

    const result = (await handler(
      makeEvent({
        fieldName: 'getResourceIamDrift',
        args: { resourceType: 'datastore', resourceId: 'ds-1' },
      }),
    )) as {
      hasDrift: boolean;
      totalExcess: number;
      totalMissing: number;
      groups: Array<{ excessActions: string[]; missingActions: string[] }>;
    };

    expect(result.hasDrift).toBe(false);
    expect(result.totalExcess).toBe(0);
    expect(result.totalMissing).toBe(0);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].excessActions).toEqual([]);
    expect(result.groups[0].missingActions).toEqual([]);
  });

  test('detects excess actions', async () => {
    isAdminFromEventMock.mockReturnValue(true);
    armSts();
    ddbMock
      .on(GetCommand, { TableName: 'citadel-datastores-test' })
      .resolves({
        Item: { dataStoreId: 'ds-1', type: 's3', config: {} },
      });
    iamMock.on(GetRolePolicyCommand).resolves({
      RoleName: 'citadel-ds-ds-1',
      PolicyName: 'DataStoreAccess',
      PolicyDocument: encodedInlineDoc([
        {
          Action: ['s3:GetObject', 's3:PutObject'],
          Resource: ['arn:aws:s3:::b/*'],
        },
      ]),
    });
    requiredPoliciesMock.mockReturnValue({
      connect: [
        { actions: ['s3:GetObject'], resources: ['arn:aws:s3:::b/*'] },
      ],
    });

    const result = (await handler(
      makeEvent({
        fieldName: 'getResourceIamDrift',
        args: { resourceType: 'datastore', resourceId: 'ds-1' },
      }),
    )) as {
      hasDrift: boolean;
      totalExcess: number;
      groups: Array<{ excessActions: string[] }>;
    };

    expect(result.hasDrift).toBe(true);
    expect(result.totalExcess).toBe(1);
    expect(result.groups[0].excessActions).toEqual(['s3:PutObject']);
  });

  test('detects missing actions', async () => {
    isAdminFromEventMock.mockReturnValue(true);
    armSts();
    ddbMock
      .on(GetCommand, { TableName: 'citadel-datastores-test' })
      .resolves({
        Item: { dataStoreId: 'ds-1', type: 's3', config: {} },
      });
    iamMock.on(GetRolePolicyCommand).resolves({
      RoleName: 'citadel-ds-ds-1',
      PolicyName: 'DataStoreAccess',
      PolicyDocument: encodedInlineDoc([
        { Action: ['s3:GetObject'], Resource: ['arn:aws:s3:::b/*'] },
      ]),
    });
    requiredPoliciesMock.mockReturnValue({
      connect: [
        {
          actions: ['s3:GetObject', 's3:PutObject'],
          resources: ['arn:aws:s3:::b/*'],
        },
      ],
    });

    const result = (await handler(
      makeEvent({
        fieldName: 'getResourceIamDrift',
        args: { resourceType: 'datastore', resourceId: 'ds-1' },
      }),
    )) as {
      hasDrift: boolean;
      totalMissing: number;
      groups: Array<{ missingActions: string[] }>;
    };

    expect(result.hasDrift).toBe(true);
    expect(result.totalMissing).toBe(1);
    expect(result.groups[0].missingActions).toEqual(['s3:PutObject']);
  });

  test('groups sorted ascending by resourceArnPattern', async () => {
    isAdminFromEventMock.mockReturnValue(true);
    armSts();
    ddbMock
      .on(GetCommand, { TableName: 'citadel-datastores-test' })
      .resolves({
        Item: { dataStoreId: 'ds-1', type: 's3', config: {} },
      });
    // Two distinct resources in the inline policy, intentionally
    // out-of-order: the resolver MUST sort returned groups by
    // resourceArnPattern.
    iamMock.on(GetRolePolicyCommand).resolves({
      RoleName: 'citadel-ds-ds-1',
      PolicyName: 'DataStoreAccess',
      PolicyDocument: encodedInlineDoc([
        { Action: ['s3:GetObject'], Resource: ['arn:b'] },
        { Action: ['s3:GetObject'], Resource: ['arn:a'] },
      ]),
    });
    requiredPoliciesMock.mockReturnValue({ connect: [] });

    const result = (await handler(
      makeEvent({
        fieldName: 'getResourceIamDrift',
        args: { resourceType: 'datastore', resourceId: 'ds-1' },
      }),
    )) as { groups: Array<{ resourceArnPattern: string }> };

    expect(result.groups).toHaveLength(2);
    expect(result.groups[0].resourceArnPattern).toBe('arn:a');
    expect(result.groups[1].resourceArnPattern).toBe('arn:b');
  });
});
