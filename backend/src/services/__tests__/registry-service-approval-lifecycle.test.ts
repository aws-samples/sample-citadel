/**
 * Unit tests for the agent-record approval lifecycle gate in
 * RegistryService.updateResourceStatus:
 *   - no auto-approval (SubmitRegistryRecordForApproval must never be called)
 *   - validated transitions when currentStatus is supplied
 *   - callers that omit currentStatus are unaffected (back-compat for the
 *     tri-state active/inactive/maintenance callers)
 */

import {
  BedrockAgentCoreControlClient,
  UpdateRegistryRecordStatusCommand,
  SubmitRegistryRecordForApprovalCommand,
  GetRegistryRecordCommand,
} from '@aws-sdk/client-bedrock-agentcore-control';
import { mockClient } from 'aws-sdk-client-mock';
import {
  RegistryService,
  RegistryRecordStatusValues,
  RegistryLifecycleError,
} from '../registry-service';

const sdkMock = mockClient(BedrockAgentCoreControlClient);

describe('RegistryService.updateResourceStatus — approval lifecycle gate', () => {
  let service: RegistryService;

  beforeEach(() => {
    sdkMock.reset();
    service = new RegistryService({ registryId: 'test-registry', region: 'us-east-1' });
    // waitForStableState issues a GetRegistryRecordCommand first; keep it stable.
    sdkMock.on(GetRegistryRecordCommand).resolves({ status: 'DRAFT' });
  });

  it('never calls SubmitRegistryRecordForApprovalCommand for an APPROVED transition', async () => {
    sdkMock.on(UpdateRegistryRecordStatusCommand).resolves({
      recordId: 'agent-1',
      status: 'APPROVED',
    });

    await service.updateResourceStatus(
      'agent',
      'agent-1',
      RegistryRecordStatusValues.APPROVED,
      'approved by admin',
      'PENDING_APPROVAL',
    );

    expect(sdkMock.commandCalls(SubmitRegistryRecordForApprovalCommand)).toHaveLength(0);
    const calls = sdkMock.commandCalls(UpdateRegistryRecordStatusCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0].input).toEqual({
      registryId: 'test-registry',
      recordId: 'agent-1',
      status: 'APPROVED',
      statusReason: 'approved by admin',
    });
  });

  it('throws RegistryLifecycleError with code INVALID_TRANSITION for an illegal transition', async () => {
    await expect(
      service.updateResourceStatus(
        'agent',
        'agent-1',
        RegistryRecordStatusValues.APPROVED,
        'reason',
        'DRAFT',
      ),
    ).rejects.toMatchObject({
      name: 'RegistryLifecycleError',
      code: 'INVALID_TRANSITION',
    });

    expect(sdkMock.commandCalls(UpdateRegistryRecordStatusCommand)).toHaveLength(0);
  });

  it('is an instance of RegistryLifecycleError for illegal transitions', async () => {
    await expect(
      service.updateResourceStatus('agent', 'agent-1', RegistryRecordStatusValues.APPROVED, 'r', 'DRAFT'),
    ).rejects.toBeInstanceOf(RegistryLifecycleError);
  });

  it.each([
    ['DRAFT', 'PENDING_APPROVAL'],
    ['PENDING_APPROVAL', 'APPROVED'],
    ['PENDING_APPROVAL', 'REJECTED'],
    ['REJECTED', 'DRAFT'],
    ['REJECTED', 'DEPRECATED'],
    ['APPROVED', 'DEPRECATED'],
    ['DRAFT', 'DEPRECATED'],
  ])('allows the legal transition %s -> %s', async (current, next) => {
    sdkMock.on(UpdateRegistryRecordStatusCommand).resolves({
      recordId: 'agent-1',
      status: next,
    });

    await expect(
      service.updateResourceStatus(
        'agent',
        'agent-1',
        next as never,
        'reason',
        current,
      ),
    ).resolves.toBeDefined();
  });

  it.each([
    ['DRAFT', 'APPROVED'],
    ['DRAFT', 'REJECTED'],
    ['APPROVED', 'DRAFT'],
    ['APPROVED', 'PENDING_APPROVAL'],
    ['DEPRECATED', 'DRAFT'],
    ['DEPRECATED', 'APPROVED'],
    ['PENDING_APPROVAL', 'DRAFT'],
  ])('rejects the illegal transition %s -> %s', async (current, next) => {
    await expect(
      service.updateResourceStatus('agent', 'agent-1', next as never, 'reason', current),
    ).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
  });

  it('skips validation when currentStatus is omitted (back-compat for tri-state callers)', async () => {
    sdkMock.on(UpdateRegistryRecordStatusCommand).resolves({
      recordId: 'agent-1',
      status: 'APPROVED',
    });

    // No currentStatus passed — agent-config-resolver.ts / tool-config-resolver.ts
    // call this way and must be unaffected by the lifecycle gate.
    await expect(
      service.updateResourceStatus('agent', 'agent-1', RegistryRecordStatusValues.APPROVED),
    ).resolves.toBeDefined();

    expect(sdkMock.commandCalls(SubmitRegistryRecordForApprovalCommand)).toHaveLength(0);
    expect(sdkMock.commandCalls(UpdateRegistryRecordStatusCommand)).toHaveLength(1);
  });

  it('idempotent same-status transition is allowed when currentStatus is supplied', async () => {
    sdkMock.on(UpdateRegistryRecordStatusCommand).resolves({
      recordId: 'agent-1',
      status: 'DRAFT',
    });

    await expect(
      service.updateResourceStatus('agent', 'agent-1', RegistryRecordStatusValues.DRAFT, 'r', 'DRAFT'),
    ).resolves.toBeDefined();
  });
});
