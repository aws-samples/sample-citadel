/**
 * Unit tests for RegistryService custom metadata serialization:
 * - serializeCustomMetadata: metadata object → JSON string
 * - deserializeCustomMetadata: JSON string → metadata object with safe defaults
 *
 * Validates: Requirements 2.1, 2.2, 2.3, 2.4
 */

import {
  RegistryService,
  AgentCustomMetadata,
  ToolCustomMetadata,
} from '../registry-service';

jest.mock('@aws-sdk/client-bedrock-agentcore-control', () => ({
  BedrockAgentCoreControlClient: jest.fn().mockImplementation(() => ({})),
  CreateRegistryRecordCommand: jest.fn(),
  GetRegistryRecordCommand: jest.fn(),
  UpdateRegistryRecordCommand: jest.fn(),
  UpdateRegistryRecordStatusCommand: jest.fn(),
  DeleteRegistryRecordCommand: jest.fn(),
  ListRegistryRecordsCommand: jest.fn(),
}));

const AGENT_DEFAULTS: AgentCustomMetadata = {
  categories: [],
  icon: '',
  state: 'active',
  appId: undefined,
  manifest: undefined,
};

const TOOL_DEFAULTS: ToolCustomMetadata = {
  categories: [],
  icon: '',
  state: 'active',
  integrationBindings: undefined,
  dataStoreBindings: undefined,
  appId: undefined,
};

describe('RegistryService custom metadata serialization', () => {
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

  // -- serializeCustomMetadata ---------------------------------------------

  describe('serializeCustomMetadata', () => {
    it('serializes agent metadata to valid JSON', () => {
      const meta: AgentCustomMetadata = {
        categories: ['nlp', 'chat'],
        icon: 'bot-icon',
        state: 'active',
        appId: 'app-123',
        manifest: { version: '1.0' },
      };
      const json = service.serializeCustomMetadata(meta);
      expect(JSON.parse(json)).toEqual(meta);
    });

    it('serializes tool metadata with bindings to valid JSON', () => {
      const meta: ToolCustomMetadata = {
        categories: ['data'],
        icon: 'tool-icon',
        state: 'inactive',
        integrationBindings: [
          {
            integrationId: 'int-1',
            integrationType: 'REST',
            operations: ['read'],
            direction: 'INPUT',
          },
        ],
        dataStoreBindings: [
          {
            dataStoreId: 'ds-1',
            dataStoreType: 'S3',
            operations: ['write'],
            direction: 'OUTPUT',
          },
        ],
        appId: 'app-456',
      };
      const json = service.serializeCustomMetadata(meta);
      expect(JSON.parse(json)).toEqual(meta);
    });

    it('serializes metadata with empty optional fields', () => {
      const meta: AgentCustomMetadata = {
        categories: [],
        icon: '',
        state: 'maintenance',
      };
      const json = service.serializeCustomMetadata(meta);
      expect(JSON.parse(json)).toEqual(meta);
    });
  });

  // -- deserializeCustomMetadata -------------------------------------------

  describe('deserializeCustomMetadata', () => {
    it('returns defaults for null input', () => {
      expect(
        service.deserializeCustomMetadata(null, AGENT_DEFAULTS),
      ).toEqual(AGENT_DEFAULTS);
    });

    it('returns defaults for undefined input', () => {
      expect(
        service.deserializeCustomMetadata(undefined, AGENT_DEFAULTS),
      ).toEqual(AGENT_DEFAULTS);
    });

    it('returns defaults for empty string input', () => {
      expect(
        service.deserializeCustomMetadata('', TOOL_DEFAULTS),
      ).toEqual(TOOL_DEFAULTS);
    });

    it('returns defaults for malformed JSON and logs warning', () => {
      expect(
        service.deserializeCustomMetadata('{bad json', AGENT_DEFAULTS),
      ).toEqual(AGENT_DEFAULTS);
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('Failed to parse custom metadata JSON'),
      );
    });

    it('returns defaults for JSON array and logs warning', () => {
      expect(
        service.deserializeCustomMetadata('[1,2,3]', AGENT_DEFAULTS),
      ).toEqual(AGENT_DEFAULTS);
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('not a plain object'),
      );
    });

    it('returns defaults for JSON primitive and logs warning', () => {
      expect(
        service.deserializeCustomMetadata('"just a string"', TOOL_DEFAULTS),
      ).toEqual(TOOL_DEFAULTS);
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('not a plain object'),
      );
    });

    it('merges valid JSON with defaults', () => {
      const json = JSON.stringify({
        categories: ['search'],
        icon: 'magnifier',
        state: 'inactive',
      });
      const result = service.deserializeCustomMetadata(json, AGENT_DEFAULTS);
      expect(result).toEqual({
        categories: ['search'],
        icon: 'magnifier',
        state: 'inactive',
        appId: undefined,
        manifest: undefined,
      });
    });

    it('partial JSON fills missing fields from defaults', () => {
      const json = JSON.stringify({ categories: ['ops'] });
      const result = service.deserializeCustomMetadata(json, TOOL_DEFAULTS);
      expect(result.categories).toEqual(['ops']);
      expect(result.icon).toBe('');
      expect(result.state).toBe('active');
      expect(result.integrationBindings).toBeUndefined();
    });

    it('round-trips agent metadata through serialize/deserialize', () => {
      const meta: AgentCustomMetadata = {
        categories: ['ai', 'ml'],
        icon: 'brain',
        state: 'active',
        appId: 'app-789',
        manifest: { steps: [1, 2, 3] },
      };
      const json = service.serializeCustomMetadata(meta);
      const result = service.deserializeCustomMetadata(json, AGENT_DEFAULTS);
      expect(result).toEqual(meta);
    });

    it('round-trips tool metadata through serialize/deserialize', () => {
      const meta: ToolCustomMetadata = {
        categories: ['db'],
        icon: 'database',
        state: 'maintenance',
        integrationBindings: [
          { integrationId: 'i1', integrationType: 'SQL' },
        ],
        dataStoreBindings: [
          { dataStoreId: 'd1', dataStoreType: 'DynamoDB' },
        ],
        appId: 'app-000',
      };
      const json = service.serializeCustomMetadata(meta);
      const result = service.deserializeCustomMetadata(json, TOOL_DEFAULTS);
      expect(result).toEqual(meta);
    });
  });
});
