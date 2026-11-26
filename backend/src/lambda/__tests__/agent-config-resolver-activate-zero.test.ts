/**
 * activateProjectAgents must throw a ValidationError when
 * findProjectAgentRecords returns zero records, so the panel and intake
 * tool can report "No agents found for this project yet" rather than a
 * misleading empty success.
 */
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';

const dynamoMock = mockClient(DynamoDBDocumentClient);

// ── Mock RegistryService ──────────────────────────────────────────────────
const mockGetResource = jest.fn();
const mockSubmitForApproval = jest.fn();
const mockDeserializeCustomMetadata = jest.fn(
  (json: string | null, defaults: Record<string, unknown>) => {
    if (!json) return defaults;
    try { return { ...defaults, ...JSON.parse(json) }; } catch { return defaults; }
  },
);

jest.mock('../../services/registry-service', () => {
  const MockRS = jest.fn().mockImplementation(() => ({
    getResource: mockGetResource,
    submitForApproval: mockSubmitForApproval,
    deserializeCustomMetadata: mockDeserializeCustomMetadata,
    listResources: jest.fn(),
    listResourcesChecked: jest.fn(),
    serializeCustomMetadata: jest.fn((meta: unknown) => JSON.stringify(meta)),
    updateResource: jest.fn(),
    updateResourceStatus: jest.fn(),
    toRegistryStatus: jest.fn(),
    mapToAgentConfig: jest.fn(),
  }));
  MockRS.isThrottlingError = () => false;
  return {
    __esModule: true,
    RegistryService: MockRS,
    RegistryRecordStatusValues: {
      DRAFT: 'DRAFT',
      PENDING_APPROVAL: 'PENDING_APPROVAL',
      APPROVED: 'APPROVED',
      REJECTED: 'REJECTED',
      DEPRECATED: 'DEPRECATED',
      CREATING: 'CREATING',
    },
    RegistryThrottledError: class extends Error {
      retryable = true;
      retryAfterMs: number;
      constructor(message: string, retryAfterMs = 5000) {
        super(message);
        this.name = 'RegistryThrottledError';
        this.retryAfterMs = retryAfterMs;
      }
    },
    getRegistryService: () => new MockRS(),
  };
});

// ── Mock trust-path ───────────────────────────────────────────────────────
jest.mock('../../utils/trust-path', () => ({
  ...jest.requireActual('../../utils/trust-path'),
  computeTrustPath: jest.fn(),
  assumeAnalysisRoleClient: jest.fn(),
}));

// ── Mock governance-flag ──────────────────────────────────────────────────
jest.mock('../../utils/governance-flag', () => ({
  getGovernanceEnforce: jest.fn().mockResolvedValue('permissive'),
}));

// ── Mock events ───────────────────────────────────────────────────────────
jest.mock('../../utils/events', () => ({
  publishEvent: jest.fn(),
}));

// ── Mock CloudWatch ───────────────────────────────────────────────────────
jest.mock('@aws-sdk/client-cloudwatch', () => ({
  CloudWatchClient: jest.fn().mockImplementation(() => ({ send: jest.fn() })),
  PutMetricDataCommand: jest.fn(),
}));

// ── Env ───────────────────────────────────────────────────────────────────
process.env.AGENT_CONFIG_TABLE = 'test-agents';
process.env.REGISTRY_ENABLED = 'true';
process.env.REGISTRY_ID = 'test-registry';

import { activateProjectAgents } from '../agent-config-resolver';

describe('activateProjectAgents – zero records', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    dynamoMock.reset();
    // GSI query returns zero items → findProjectAgentRecords returns [].
    dynamoMock.on(QueryCommand).resolves({ Items: [] });
  });

  it('throws a ValidationError when no agent records exist for the project', async () => {
    await expect(activateProjectAgents('proj-no-agents')).rejects.toThrow(
      /ValidationError.*[Nn]o.*agent/,
    );
  });

  it('the error message includes the project id for debuggability', async () => {
    await expect(activateProjectAgents('proj-no-agents')).rejects.toThrow(
      /proj-no-agents/,
    );
  });
});
