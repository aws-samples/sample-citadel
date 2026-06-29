/**
 * US-IMP-017b: a DRAFT import record carries a best-effort reachability probe
 * result under customMetadata.reachability. These tests pin the additive
 * contract on RegistryService:
 *   - updateResource round-trips reachability without disturbing the trusted
 *     manifest / invocation.
 *   - mapToAgentConfig surfaces reachability READ-ONLY so the UI can render the
 *     classification + checkedAt.
 *   - reachability is omitted from AgentConfig when absent.
 */
import {
  BedrockAgentCoreControlClient,
  UpdateRegistryRecordCommand,
} from '@aws-sdk/client-bedrock-agentcore-control';
import { mockClient } from 'aws-sdk-client-mock';
import { RegistryService, AgentCustomMetadata, RegistryRecord } from '../registry-service';

const sdkMock = mockClient(BedrockAgentCoreControlClient);

describe('RegistryService reachability (US-IMP-017b)', () => {
  let service: RegistryService;

  beforeEach(() => {
    sdkMock.reset();
    service = new RegistryService({ registryId: 'r', region: 'us-east-1' });
  });

  it('round-trips reachability through updateResource, preserving manifest + invocation', async () => {
    const meta: AgentCustomMetadata = {
      categories: [],
      icon: '',
      state: 'maintenance',
      manifest: { name: 'trusted' },
      invocation: {
        protocol: 'HTTP_ENDPOINT',
        target: 'https://agent.example.com/invoke',
        auth: { mode: 'NONE' },
        mode: 'sync',
      },
      reachability: {
        reachable: true,
        classification: 'reachable',
        detail: 'HTTP 200',
        checkedAt: '2026-06-30T00:00:00.000Z',
      },
    };
    const serialized = service.serializeCustomMetadata(meta);
    sdkMock.on(UpdateRegistryRecordCommand).resolves({
      recordId: 'imp-1',
      name: 'agent',
      status: 'DRAFT',
      descriptors: { custom: { inlineContent: serialized } },
    });

    const updated = await service.updateResource('agent', 'imp-1', {
      customMetadata: serialized,
    });
    const parsed = JSON.parse(updated.customDescriptorContent!);
    expect(parsed.reachability.classification).toBe('reachable');
    expect(parsed.reachability.reachable).toBe(true);
    expect(parsed.reachability.detail).toBe('HTTP 200');
    expect(parsed.reachability.checkedAt).toBe('2026-06-30T00:00:00.000Z');
    // The trusted manifest and invocation are untouched by the reachability write.
    expect(parsed.manifest).toEqual({ name: 'trusted' });
    expect(parsed.invocation.target).toBe('https://agent.example.com/invoke');
  });

  it('mapToAgentConfig surfaces reachability read-only', () => {
    const meta: AgentCustomMetadata = {
      categories: [],
      icon: '',
      state: 'maintenance',
      manifest: { name: 'trusted' },
      reachability: {
        reachable: false,
        classification: 'unverifiable_private',
        detail: 'needs VPC peering/PrivateLink — out of scope',
        checkedAt: '2026-06-30T00:00:00.000Z',
      },
    };
    const record: RegistryRecord = {
      recordId: 'imp-1',
      name: 'agent',
      status: 'DRAFT',
      customDescriptorContent: JSON.stringify(meta),
    };

    const config = service.mapToAgentConfig(record);
    expect(config.reachability).toBeDefined();
    expect(config.reachability!.classification).toBe('unverifiable_private');
    expect(config.reachability!.reachable).toBe(false);
    expect(config.reachability!.checkedAt).toBe('2026-06-30T00:00:00.000Z');
  });

  it('mapToAgentConfig omits reachability when absent', () => {
    const meta: AgentCustomMetadata = {
      categories: [],
      icon: '',
      state: 'active',
      manifest: { name: 'trusted' },
    };
    const record: RegistryRecord = {
      recordId: 'a-1',
      name: 'agent',
      status: 'APPROVED',
      customDescriptorContent: JSON.stringify(meta),
    };
    const config = service.mapToAgentConfig(record);
    expect(config.reachability).toBeUndefined();
  });
});
