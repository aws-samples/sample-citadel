/**
 * Unit + property tests for the agent-import descriptor extension (US-IMP-001):
 *   - AgentInvocationBlock / AgentOrigin shapes on AgentCustomMetadata
 *   - getInvocationProtocol back-compat default (AGENTCORE_RUNTIME)
 *   - serialize → deserialize round-trip identity over random valid metadata
 *
 * Validates: US-IMP-001 acceptance criteria (back-compat invariant 6, RD1).
 */

import * as fc from 'fast-check';
import {
  RegistryService,
  getInvocationProtocol,
  type AgentCustomMetadata,
  type AgentInvocationBlock,
  type AgentOrigin,
  type AgentInvocationProtocol,
  type AgentInvocationAuthMode,
  type AgentInvocationMode,
} from '../registry-service';

jest.mock('@aws-sdk/client-bedrock-agentcore-control', () => ({
  BedrockAgentCoreControlClient: jest.fn().mockImplementation(() => ({})),
  CreateRegistryRecordCommand: jest.fn(),
  GetRegistryRecordCommand: jest.fn(),
  UpdateRegistryRecordCommand: jest.fn(),
  UpdateRegistryRecordStatusCommand: jest.fn(),
  DeleteRegistryRecordCommand: jest.fn(),
  ListRegistryRecordsCommand: jest.fn(),
  SubmitRegistryRecordForApprovalCommand: jest.fn(),
}));

// Defaults mirror RegistryService.AGENT_METADATA_DEFAULTS, with the new
// invocation/origin fields added as undefined (back-compat).
const AGENT_DEFAULTS: AgentCustomMetadata = {
  categories: [],
  icon: '',
  state: 'active',
  appId: undefined,
  manifest: undefined,
  orgId: undefined,
  invocation: undefined,
  origin: undefined,
};

describe('agent-import descriptor extension (US-IMP-001)', () => {
  let service: RegistryService;

  beforeEach(() => {
    service = new RegistryService({
      registryId: 'test-registry',
      region: 'us-east-1',
    });
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // -- getInvocationProtocol back-compat ------------------------------------

  describe('getInvocationProtocol', () => {
    it('defaults to AGENTCORE_RUNTIME when no invocation block is present', () => {
      expect(getInvocationProtocol({})).toBe('AGENTCORE_RUNTIME');
    });

    it('returns the explicit protocol when an invocation block is present', () => {
      const invocation: AgentInvocationBlock = {
        protocol: 'LAMBDA_INVOKE',
        target: 'arn:aws:lambda:us-east-1:123456789012:function:agent',
        auth: { mode: 'SIGV4' },
        mode: 'sync',
      };
      expect(getInvocationProtocol({ invocation })).toBe('LAMBDA_INVOKE');
    });
  });

  // -- legacy back-compat (invariant 6) -------------------------------------

  it('legacy metadata with no invocation/origin deserializes and maps to AGENTCORE_RUNTIME', () => {
    const legacyJson = JSON.stringify({
      categories: ['nlp'],
      icon: 'bot',
      state: 'active',
      orgId: 'org-1',
    });

    const meta = service.deserializeCustomMetadata<AgentCustomMetadata>(
      legacyJson,
      AGENT_DEFAULTS,
    );

    expect(meta.invocation).toBeUndefined();
    expect(meta.origin).toBeUndefined();
    expect(getInvocationProtocol(meta)).toBe('AGENTCORE_RUNTIME');
  });

  it('round-trips a fully-populated imported descriptor (deterministic)', () => {
    const meta: AgentCustomMetadata = {
      categories: ['ops', 'chat'],
      icon: 'bot',
      state: 'active',
      appId: 'app-1',
      orgId: 'org-1',
      invocation: {
        protocol: 'HTTP_ENDPOINT',
        target: 'https://example.com/agent',
        auth: { mode: 'OAUTH2', secretRef: '/citadel/secret/abc' },
        mode: 'async_callback',
        region: 'us-east-1',
        account: '123456789012',
        roleArn: 'arn:aws:iam::123456789012:role/citadel-agent-invoke-x',
        externalId: 'ext-123',
      },
      origin: {
        sourceArn: 'arn:aws:execute-api:us-east-1:123456789012:abc/agent',
        account: '123456789012',
        region: 'us-east-1',
        substrate: 'http_endpoint',
        discoveredAt: '2026-06-25T00:00:00.000Z',
        ownership: 'external',
      },
    };

    const json = service.serializeCustomMetadata(meta);
    const result = service.deserializeCustomMetadata<AgentCustomMetadata>(
      json,
      AGENT_DEFAULTS,
    );
    expect(result).toEqual(meta);
  });

  // -- property: round-trip identity (500 runs) -----------------------------

  describe('serialize → deserialize round-trip identity (property, 500 runs)', () => {
    const PROTOCOLS: readonly AgentInvocationProtocol[] = [
      'AGENTCORE_RUNTIME',
      'BEDROCK_AGENT',
      'LAMBDA_INVOKE',
      'HTTP_ENDPOINT',
      'MCP',
      'A2A',
      'STEP_FUNCTIONS',
      'SAGEMAKER_ENDPOINT',
      'SQS_ASYNC',
    ];
    const AUTH_MODES: readonly AgentInvocationAuthMode[] = [
      'SIGV4',
      'API_KEY',
      'OAUTH2',
      'COGNITO',
      'NONE',
    ];
    const MODES: readonly AgentInvocationMode[] = ['sync', 'async_callback'];

    // Keep string lengths short to avoid pathological payloads while still
    // exercising unicode/empty-string round-tripping through JSON.
    const shortString = fc.string({ maxLength: 24 });

    const protocolArb: fc.Arbitrary<AgentInvocationProtocol> =
      fc.constantFrom(...PROTOCOLS);
    const authModeArb: fc.Arbitrary<AgentInvocationAuthMode> =
      fc.constantFrom(...AUTH_MODES);
    const modeArb: fc.Arbitrary<AgentInvocationMode> = fc.constantFrom(...MODES);
    const stateArb = fc.constantFrom<AgentCustomMetadata['state']>(
      'active',
      'inactive',
      'maintenance',
    );

    const invocationArb: fc.Arbitrary<AgentInvocationBlock> = fc.record(
      {
        protocol: protocolArb,
        target: shortString,
        auth: fc.record(
          { mode: authModeArb, secretRef: shortString },
          { requiredKeys: ['mode'] },
        ),
        mode: modeArb,
        region: shortString,
        account: shortString,
        roleArn: shortString,
        externalId: shortString,
      },
      { requiredKeys: ['protocol', 'target', 'auth', 'mode'] },
    );

    const originArb: fc.Arbitrary<AgentOrigin> = fc.record(
      {
        sourceArn: shortString,
        account: shortString,
        region: shortString,
        substrate: shortString,
        discoveredAt: fc
          .date({ noInvalidDate: true })
          .map((d) => d.toISOString()),
        ownership: fc.constant<'external'>('external'),
      },
      { requiredKeys: ['substrate', 'discoveredAt', 'ownership'] },
    );

    const metadataArb: fc.Arbitrary<AgentCustomMetadata> = fc.record(
      {
        categories: fc.array(shortString, { maxLength: 5 }),
        icon: shortString,
        state: stateArb,
        appId: shortString,
        manifest: fc.dictionary(shortString, shortString, { maxKeys: 4 }),
        orgId: shortString,
        invocation: invocationArb,
        origin: originArb,
      },
      { requiredKeys: ['categories', 'icon', 'state', 'invocation', 'origin'] },
    );

    it('serialize then deserialize deep-equals the original', () => {
      fc.assert(
        fc.property(metadataArb, (meta) => {
          const json = service.serializeCustomMetadata(meta);
          const result = service.deserializeCustomMetadata<AgentCustomMetadata>(
            json,
            AGENT_DEFAULTS,
          );
          expect(result).toEqual(meta);
        }),
        { numRuns: 500 },
      );
    });
  });
});
