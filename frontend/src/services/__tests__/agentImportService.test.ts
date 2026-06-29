/**
 * agentImportService Tests (US-IMP)
 *
 * Covers the typed GraphQL wrapper for agent import:
 *  - discoverAgents query (input passthrough + candidate array)
 *  - describeAgentCandidate query (AWSJSON descriptor parse + malformed error)
 *  - importAgent mutation (success + conflict result shapes, parsed config)
 *  - attestAgentImport mutation (returns attested agent, parsed config)
 *  - GraphQL error surfacing consistent with agentConfigService
 *
 * The GraphQL client (`../server`) is mocked exactly as agentConfigService's
 * tests do — query/mutate are jest.fn()s whose resolved value is the `data`
 * envelope the real client returns.
 */

jest.mock('../server', () => ({
  __esModule: true,
  default: {
    query: jest.fn(),
    mutate: jest.fn(),
    subscribe: jest.fn(),
  },
}));

import serverService from '../server';
import { agentImportService } from '../agentImportService';
import type {
  AgentCandidate,
  AgentCapabilityDescriptor,
  DiscoverAgentsInput,
  ImportAgentInput,
  ImportTestResult,
  TestImportedAgentInput,
} from '../../types/agentImport';

const query = serverService.query as jest.Mock;
const mutate = serverService.mutate as jest.Mock;

describe('agentImportService', () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    // Several tests exercise error / parse-failure paths; silence the expected
    // console.error noise without hiding real assertion failures.
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  describe('discoverAgents', () => {
    it('sends the discoverAgents query with the input variables and returns the candidate array', async () => {
      const input: DiscoverAgentsInput = {
        source: 'SCAN',
        region: 'us-west-2',
        tagKey: 'team',
        tagValue: 'ai',
      };
      const candidates: AgentCandidate[] = [
        {
          displayName: 'Forecast Bot',
          reference: 'arn:aws:bedrock-agentcore:us-west-2:111122223333:runtime/fc',
          substrate: 'AGENTCORE_RUNTIME',
          sourceArn: 'arn:aws:bedrock-agentcore:us-west-2:111122223333:runtime/fc',
          region: 'us-west-2',
          account: '111122223333',
          ownership: 'external',
          discoveredAt: '2026-06-28T00:00:00.000Z',
        },
      ];
      query.mockResolvedValue({ discoverAgents: candidates });

      const result = await agentImportService.discoverAgents(input);

      expect(query).toHaveBeenCalledWith(
        expect.stringContaining('discoverAgents'),
        { input }
      );
      expect(result).toEqual(candidates);
    });

    it('returns an empty array when the query yields no candidates', async () => {
      query.mockResolvedValue({ discoverAgents: null });

      const result = await agentImportService.discoverAgents({ source: 'SCAN' });

      expect(result).toEqual([]);
    });

    it('surfaces GraphQL errors', async () => {
      query.mockRejectedValue(new Error('AccessDenied: tagging scan'));

      await expect(
        agentImportService.discoverAgents({ source: 'SCAN' })
      ).rejects.toThrow('AccessDenied: tagging scan');
    });

    it('forwards cross-account discovery fields (discoveryRoleArn/discoveryExternalId) verbatim in the input', async () => {
      const input: DiscoverAgentsInput = {
        source: 'SCAN',
        region: 'us-west-2',
        discoveryRoleArn: 'arn:aws:iam::444455556666:role/citadel-discovery-readonly',
        discoveryExternalId: 'citadel-ext-scan-1',
      };
      query.mockResolvedValue({ discoverAgents: [] });

      await agentImportService.discoverAgents(input);

      // discoverAgents passes the whole input through unchanged
      expect(query).toHaveBeenCalledWith(
        expect.stringContaining('discoverAgents'),
        { input }
      );
    });
  });

  describe('describeAgentCandidate', () => {
    const descriptor: AgentCapabilityDescriptor = {
      name: 'Forecast Bot',
      description: 'Weather forecasting agent',
      version: '1.0.0',
      skills: ['forecast', 'summarize'],
      categories: ['weather'],
      inputSchema: { type: 'object', properties: { city: { type: 'string' } } },
      outputSchema: { type: 'object' },
      invocation: {
        protocol: 'AGENTCORE_RUNTIME',
        target: 'arn:aws:bedrock-agentcore:us-west-2:111122223333:runtime/fc',
        auth: { mode: 'SIGV4' },
        mode: 'sync',
        region: 'us-west-2',
        account: '111122223333',
      },
      origin: {
        sourceArn: 'arn:aws:bedrock-agentcore:us-west-2:111122223333:runtime/fc',
        account: '111122223333',
        region: 'us-west-2',
        substrate: 'AGENTCORE_RUNTIME',
        discoveredAt: '2026-06-28T00:00:00.000Z',
        ownership: 'external',
      },
      fieldConfidence: { inputSchema: 'medium' },
    };

    it('sends the query and JSON-parses the AWSJSON descriptor string', async () => {
      query.mockResolvedValue({ describeAgentCandidate: JSON.stringify(descriptor) });

      const result = await agentImportService.describeAgentCandidate('ref-123');

      expect(query).toHaveBeenCalledWith(
        expect.stringContaining('describeAgentCandidate'),
        { ref: 'ref-123' }
      );
      expect(result).toEqual(descriptor);
    });

    it('throws a clear error when the AWSJSON descriptor string is malformed', async () => {
      query.mockResolvedValue({ describeAgentCandidate: '{ not valid json' });

      await expect(
        agentImportService.describeAgentCandidate('ref-bad')
      ).rejects.toThrow(/parse/i);
    });

    it('surfaces GraphQL errors', async () => {
      query.mockRejectedValue(new Error('NotFound: ref'));

      await expect(
        agentImportService.describeAgentCandidate('missing')
      ).rejects.toThrow('NotFound: ref');
    });

    it('sends discoveryRoleArn/discoveryExternalId as query variables when provided (cross-account describe)', async () => {
      query.mockResolvedValue({ describeAgentCandidate: JSON.stringify(descriptor) });

      const result = await agentImportService.describeAgentCandidate('ref-xacct', {
        discoveryRoleArn: 'arn:aws:iam::444455556666:role/citadel-discovery-readonly',
        discoveryExternalId: 'citadel-ext-scan-1',
      });

      expect(query).toHaveBeenCalledWith(
        expect.stringContaining('describeAgentCandidate'),
        {
          ref: 'ref-xacct',
          discoveryRoleArn: 'arn:aws:iam::444455556666:role/citadel-discovery-readonly',
          discoveryExternalId: 'citadel-ext-scan-1',
        }
      );
      expect(result).toEqual(descriptor);
    });

    it('omits discovery variables entirely when no opts are passed (back-compat: variables are exactly { ref })', async () => {
      query.mockResolvedValue({ describeAgentCandidate: JSON.stringify(descriptor) });

      await agentImportService.describeAgentCandidate('ref-plain');

      expect(query.mock.calls[0][1]).toEqual({ ref: 'ref-plain' });
    });

    it('only sends the provided discovery values, omitting blank ones', async () => {
      query.mockResolvedValue({ describeAgentCandidate: JSON.stringify(descriptor) });

      await agentImportService.describeAgentCandidate('ref-partial', {
        discoveryRoleArn: 'arn:aws:iam::444455556666:role/r',
        discoveryExternalId: '',
      });

      expect(query.mock.calls[0][1]).toEqual({
        ref: 'ref-partial',
        discoveryRoleArn: 'arn:aws:iam::444455556666:role/r',
      });
    });
  });

  describe('importAgent', () => {
    const baseInput: ImportAgentInput = {
      name: 'Forecast Bot',
      invocationProtocol: 'AGENTCORE_RUNTIME',
      invocationTarget: 'arn:aws:bedrock-agentcore:us-west-2:111122223333:runtime/fc',
      invocationAuthMode: 'SIGV4',
      invocationMode: 'sync',
      region: 'us-west-2',
      account: '111122223333',
      sourceArn: 'arn:aws:bedrock-agentcore:us-west-2:111122223333:runtime/fc',
      substrate: 'AGENTCORE_RUNTIME',
      categories: ['weather'],
      onConflict: 'LINK',
    };

    it('sends the importAgent mutation with the input and returns the success result with parsed config', async () => {
      mutate.mockResolvedValue({
        importAgent: {
          agent: {
            agentId: 'agent-1',
            name: 'Forecast Bot',
            config: JSON.stringify({ name: 'Forecast Bot', kind: 'imported' }),
            state: 'active',
            categories: ['weather'],
          },
          conflict: false,
          existingId: null,
          reason: null,
          options: null,
        },
      });

      const result = await agentImportService.importAgent(baseInput);

      expect(mutate).toHaveBeenCalledWith(
        expect.stringContaining('importAgent'),
        { input: baseInput }
      );
      expect(result.conflict).toBe(false);
      expect(result.agent).not.toBeNull();
      expect(result.agent?.agentId).toBe('agent-1');
      expect(result.agent?.config).toEqual({ name: 'Forecast Bot', kind: 'imported' });
    });

    it('returns the conflict result shape (agent null) when conflict is true', async () => {
      mutate.mockResolvedValue({
        importAgent: {
          agent: null,
          conflict: true,
          existingId: 'existing-9',
          reason: 'sourceArn already imported',
          options: ['LINK', 'REPLACE', 'COPY'],
        },
      });

      const result = await agentImportService.importAgent(baseInput);

      expect(result.conflict).toBe(true);
      expect(result.agent).toBeNull();
      expect(result.existingId).toBe('existing-9');
      expect(result.reason).toBe('sourceArn already imported');
      expect(result.options).toEqual(['LINK', 'REPLACE', 'COPY']);
    });

    it('surfaces GraphQL errors', async () => {
      mutate.mockRejectedValue(new Error('ValidationError: protocol required'));

      await expect(agentImportService.importAgent(baseInput)).rejects.toThrow(
        'ValidationError: protocol required'
      );
    });
  });

  describe('attestAgentImport', () => {
    it('sends the attestAgentImport mutation with the agentId and returns the attested agent with parsed config', async () => {
      mutate.mockResolvedValue({
        attestAgentImport: {
          agentId: 'agent-1',
          name: 'Forecast Bot',
          config: JSON.stringify({ attested: true }),
          state: 'active',
          categories: ['weather'],
        },
      });

      const result = await agentImportService.attestAgentImport('agent-1');

      expect(mutate).toHaveBeenCalledWith(
        expect.stringContaining('attestAgentImport'),
        { agentId: 'agent-1' }
      );
      expect(result.agentId).toBe('agent-1');
      expect(result.config).toEqual({ attested: true });
    });

    it('surfaces GraphQL errors', async () => {
      mutate.mockRejectedValue(new Error('Forbidden'));

      await expect(agentImportService.attestAgentImport('agent-1')).rejects.toThrow(
        'Forbidden'
      );
    });
  });

  describe('testImportedAgent', () => {
    const input: TestImportedAgentInput = {
      invocationProtocol: 'HTTP_ENDPOINT',
      invocationTarget: 'https://api.example.com/agent',
      invocationAuthMode: 'API_KEY',
      invocationAuthHeader: 'x-api-key',
      invocationSecret: 'sk-test-123',
      invocationMode: 'sync',
      region: 'us-west-2',
      account: '111122223333',
      prompt: 'ping',
    };

    it('sends the testImportedAgent mutation with the input and returns the typed result', async () => {
      const result: ImportTestResult = {
        ok: true,
        output: 'pong: {"status":"ok"}',
        error: null,
        latencyMs: 142,
      };
      mutate.mockResolvedValue({ testImportedAgent: result });

      const out = await agentImportService.testImportedAgent(input);

      expect(mutate).toHaveBeenCalledWith(
        expect.stringContaining('testImportedAgent'),
        { input }
      );
      expect(out).toEqual(result);
    });

    it('returns an ok:false result verbatim (a reachability failure is not thrown)', async () => {
      const result: ImportTestResult = {
        ok: false,
        output: null,
        error: 'Endpoint returned 403 Forbidden',
        latencyMs: 60,
      };
      mutate.mockResolvedValue({ testImportedAgent: result });

      const out = await agentImportService.testImportedAgent(input);

      expect(out.ok).toBe(false);
      expect(out.error).toBe('Endpoint returned 403 Forbidden');
    });

    it('surfaces GraphQL/transport errors', async () => {
      mutate.mockRejectedValue(new Error('NetworkError: connection reset'));

      await expect(agentImportService.testImportedAgent(input)).rejects.toThrow(
        'NetworkError: connection reset'
      );
    });
  });
});
