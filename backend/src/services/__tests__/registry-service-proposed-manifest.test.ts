/**
 * Tier-3 agent-import (B1): the DRAFT import record carries an UNTRUSTED
 * LLM-proposed manifest under customMetadata.proposedManifest. These tests pin
 * the additive contract on RegistryService:
 *   - updateResource round-trips proposedManifest without disturbing the
 *     trusted manifest.
 *   - mapToAgentConfig surfaces proposedManifest READ-ONLY so the UI can read
 *     manifest + reviewState + confidence + source + proposedAt.
 */
import {
  BedrockAgentCoreControlClient,
  UpdateRegistryRecordCommand,
} from '@aws-sdk/client-bedrock-agentcore-control';
import { mockClient } from 'aws-sdk-client-mock';
import { RegistryService, AgentCustomMetadata, RegistryRecord } from '../registry-service';

const sdkMock = mockClient(BedrockAgentCoreControlClient);

describe('RegistryService proposedManifest (Tier-3 agent import B1)', () => {
  let service: RegistryService;

  beforeEach(() => {
    sdkMock.reset();
    service = new RegistryService({ registryId: 'r', region: 'us-east-1' });
  });

  it('round-trips proposedManifest through updateResource, preserving the trusted manifest', async () => {
    const meta: AgentCustomMetadata = {
      categories: [],
      icon: '',
      state: 'maintenance',
      manifest: { name: 'trusted' },
      proposedManifest: {
        manifest: { name: 'llm-proposed' },
        confidence: 'low',
        reviewState: 'pending_review',
        source: 'llm_tier3',
        fieldConfidence: { name: 'low' },
        proposedAt: '2026-06-29T00:00:00.000Z',
        correlationId: 'corr-1',
        sanitized: true,
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
    expect(parsed.proposedManifest.reviewState).toBe('pending_review');
    expect(parsed.proposedManifest.source).toBe('llm_tier3');
    expect(parsed.proposedManifest.confidence).toBe('low');
    expect(parsed.proposedManifest.manifest).toEqual({ name: 'llm-proposed' });
    // The trusted manifest is untouched by the proposed-manifest write.
    expect(parsed.manifest).toEqual({ name: 'trusted' });
  });

  it('mapToAgentConfig surfaces proposedManifest read-only', () => {
    const meta: AgentCustomMetadata = {
      categories: [],
      icon: '',
      state: 'maintenance',
      manifest: { name: 'trusted' },
      proposedManifest: {
        manifest: { name: 'llm-proposed' },
        confidence: 'low',
        reviewState: 'pending_review',
        source: 'llm_tier3',
        proposedAt: '2026-06-29T00:00:00.000Z',
      },
    };
    const record: RegistryRecord = {
      recordId: 'imp-1',
      name: 'agent',
      status: 'DRAFT',
      customDescriptorContent: JSON.stringify(meta),
    };

    const config = service.mapToAgentConfig(record);
    expect(config.proposedManifest).toBeDefined();
    expect(config.proposedManifest!.reviewState).toBe('pending_review');
    expect(config.proposedManifest!.source).toBe('llm_tier3');
    expect(config.proposedManifest!.confidence).toBe('low');
    expect(config.proposedManifest!.manifest).toEqual({ name: 'llm-proposed' });
  });

  it('mapToAgentConfig omits proposedManifest when absent', () => {
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
    expect(config.proposedManifest).toBeUndefined();
  });
});
