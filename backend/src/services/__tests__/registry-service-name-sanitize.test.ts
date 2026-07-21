/**
 * RegistryService name sanitization at the shared choke point.
 *
 * bedrock-agentcore CreateRegistryRecord / UpdateRegistryRecord reject any
 * `name` failing ^[a-zA-Z0-9][a-zA-Z0-9_\-./]*$ with a ValidationException
 * (live-verified: 'Test - Ingest' fails — spaces are illegal). Every create
 * caller (createApp UI + intake, agent import, agent/tool config) flows
 * through createResource, so sanitization here protects them all.
 */
import {
  BedrockAgentCoreControlClient,
  CreateRegistryRecordCommand,
  GetRegistryRecordCommand,
  UpdateRegistryRecordCommand,
} from '@aws-sdk/client-bedrock-agentcore-control';
import { mockClient } from 'aws-sdk-client-mock';
import { RegistryService } from '../registry-service';

const sdkMock = mockClient(BedrockAgentCoreControlClient);

const REGISTRY_CONSTRAINT = /^[a-zA-Z0-9][a-zA-Z0-9_\-./]*$/;

describe('RegistryService name sanitization', () => {
  let service: RegistryService;

  beforeEach(() => {
    sdkMock.reset();
    service = new RegistryService({
      registryId: 'test-registry',
      region: 'us-east-1',
    });
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function seedCreate(recordName: string): void {
    sdkMock.on(CreateRegistryRecordCommand).resolves({
      recordArn:
        'arn:aws:bedrock-agentcore:us-east-1:123:registry/test-registry/record/rec123456789',
      status: 'DRAFT',
    });
    sdkMock.on(GetRegistryRecordCommand).resolves({
      recordId: 'rec123456789',
      name: recordName,
      description: 'd',
      status: 'DRAFT',
      descriptors: { custom: { inlineContent: '{"manifest":{}}' } },
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  it('createResource sanitizes a name with spaces before calling CreateRegistryRecord', async () => {
    seedCreate('Test-Ingest');

    await service.createResource('agent', 'app-1', {
      name: 'Test - Ingest',
      description: 'd',
      customMetadata: '{"manifest":{}}',
    });

    const calls = sdkMock.commandCalls(CreateRegistryRecordCommand);
    expect(calls).toHaveLength(1);
    const sentName = calls[0].args[0].input.name as string;
    expect(sentName).toBe('Test-Ingest');
    expect(REGISTRY_CONSTRAINT.test(sentName)).toBe(true);
  });

  it('createResource passes an already-legal name through unchanged', async () => {
    seedCreate('ok_name-1.2/x');

    await service.createResource('agent', 'app-1', {
      name: 'ok_name-1.2/x',
      description: 'd',
      customMetadata: '{"manifest":{}}',
    });

    const calls = sdkMock.commandCalls(CreateRegistryRecordCommand);
    expect(calls[0].args[0].input.name).toBe('ok_name-1.2/x');
  });

  it('createResource fallback return (get fails) carries the sanitized name, not the raw input', async () => {
    sdkMock.on(CreateRegistryRecordCommand).resolves({
      recordArn:
        'arn:aws:bedrock-agentcore:us-east-1:123:registry/test-registry/record/rec123456789',
      status: 'DRAFT',
    });
    // GetRegistryRecord 404s → createResource falls back to constructing
    // the record from its input.
    sdkMock.on(GetRegistryRecordCommand).rejects(
      Object.assign(new Error('not found'), {
        name: 'ResourceNotFoundException',
        $metadata: { httpStatusCode: 404 },
      }),
    );

    const record = await service.createResource('agent', 'app-1', {
      name: 'Test Ingest 1',
      description: 'd',
      customMetadata: '{"manifest":{}}',
    });

    expect(record.name).toBe('Test-Ingest-1');
  });

  it('updateResource sanitizes a renamed name before calling UpdateRegistryRecord', async () => {
    sdkMock.on(UpdateRegistryRecordCommand).resolves({
      recordId: 'rec123456789',
      name: 'My-Renamed-App',
      status: 'DRAFT',
    });

    await service.updateResource('agent', 'rec123456789', {
      name: 'My Renamed App',
      description: 'd',
    });

    const calls = sdkMock.commandCalls(UpdateRegistryRecordCommand);
    expect(calls).toHaveLength(1);
    const sentName = calls[0].args[0].input.name as string;
    expect(sentName).toBe('My-Renamed-App');
    expect(REGISTRY_CONSTRAINT.test(sentName)).toBe(true);
  });
});
