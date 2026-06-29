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

  // --- Tier-3 ACCEPT-state fields promoted into the shared type ------------
  // The accept step advances reviewState to 'accepted' and stamps
  // reviewedBy/reviewedAt. These are now first-class on ProposedManifestMetadata
  // (no local widened type / boundary cast in the resolver), so they round-trip
  // through serialize → deserialize and surface READ-ONLY via mapToAgentConfig.

  it('round-trips an accepted proposedManifest (reviewedBy/reviewedAt) and surfaces it read-only', () => {
    const meta: AgentCustomMetadata = {
      categories: [],
      icon: '',
      state: 'maintenance',
      manifest: { name: 'promoted' },
      proposedManifest: {
        manifest: { name: 'promoted' },
        confidence: 'low',
        reviewState: 'accepted',
        source: 'llm_tier3',
        proposedAt: '2026-06-29T00:00:00.000Z',
        reviewedBy: 'admin-1',
        reviewedAt: '2026-06-30T00:00:00.000Z',
      },
    };
    const record: RegistryRecord = {
      recordId: 'imp-2',
      name: 'agent',
      status: 'DRAFT',
      customDescriptorContent: service.serializeCustomMetadata(meta),
    };

    const config = service.mapToAgentConfig(record);
    expect(config.proposedManifest).toBeDefined();
    expect(config.proposedManifest!.reviewState).toBe('accepted');
    expect(config.proposedManifest!.reviewedBy).toBe('admin-1');
    expect(config.proposedManifest!.reviewedAt).toBe('2026-06-30T00:00:00.000Z');
    expect(config.proposedManifest!.source).toBe('llm_tier3');
  });

  it('omits reviewedBy/reviewedAt when the proposal has not been reviewed', () => {
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
    const serialized = service.serializeCustomMetadata(meta);
    const record: RegistryRecord = {
      recordId: 'imp-3',
      name: 'agent',
      status: 'DRAFT',
      customDescriptorContent: serialized,
    };

    const config = service.mapToAgentConfig(record);
    expect(config.proposedManifest).toBeDefined();
    expect(config.proposedManifest!.reviewState).toBe('pending_review');
    expect(config.proposedManifest!.reviewedBy).toBeUndefined();
    expect(config.proposedManifest!.reviewedAt).toBeUndefined();
    // Absent audit fields must not be serialized as keys.
    const parsed = JSON.parse(serialized);
    expect(parsed.proposedManifest).not.toHaveProperty('reviewedBy');
    expect(parsed.proposedManifest).not.toHaveProperty('reviewedAt');
  });
});
