/**
 * End-to-end name sanitization through the REAL createApp core and REAL
 * RegistryService, against a registry SDK mock that enforces the live
 * bedrock-agentcore name constraint:
 *
 *   ValidationException: Value at 'name' failed to satisfy constraint:
 *   Member must satisfy regular expression pattern:
 *   [a-zA-Z0-9][a-zA-Z0-9_\-\./]*
 *
 * Log-verified live failure: the intake path passed 'Test - Ingest' /
 * 'Test Ingest 1' verbatim (spaces are illegal). These tests reproduce the
 * live rejection at the SDK boundary, so they are RED until the shared
 * sanitizer lands in RegistryService and GREEN after — for BOTH the intake
 * (intakeCreateApp → createApp) and the Cognito/UI (createApp) paths.
 */
// Env vars MUST be set BEFORE the resolver imports — module-load capture.
process.env.REGISTRY_ID = 'test-registry-id';
process.env.APPS_TABLE = 'citadel-apps-test';
process.env.PROJECTS_TABLE = 'citadel-projects-test';
process.env.CONVERSATIONS_TABLE = 'citadel-conversations-test';
process.env.WORKFLOWS_TABLE = 'citadel-workflows-test';
process.env.EVENT_BUS_NAME = 'citadel-agents-test';
process.env.USER_POOL_ID = 'us-west-2_testpool';
process.env.AWS_REGION = 'us-east-1';
// Authority grant becomes a no-op without this table (see resolver comment).
delete process.env.AUTHORITY_UNITS_TABLE;

import {
  BedrockAgentCoreControlClient,
  CreateRegistryRecordCommand,
  GetRegistryRecordCommand,
} from '@aws-sdk/client-bedrock-agentcore-control';
import { EventBridgeClient } from '@aws-sdk/client-eventbridge';
import {
  DynamoDBDocumentClient,
  GetCommand,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';

const registryMock = mockClient(BedrockAgentCoreControlClient);
const ddbMock = mockClient(DynamoDBDocumentClient);
const ebMock = mockClient(EventBridgeClient);

// NOTE: deliberately NO jest.mock of ../services/registry-service or
// ../registry-agent-record-resolver — this suite exercises the real classes.
import { createApp } from '../registry-agent-record-resolver';
import { handler as intakeHandler } from '../intake-orchestration-resolver';

const NAME_CONSTRAINT = /^[a-zA-Z0-9][a-zA-Z0-9_\-./]*$/;
const RECORD_ID = 'rec123456789';

/**
 * Installs a CreateRegistryRecord mock that rejects illegal names exactly
 * like the live service, and a GetRegistryRecord mock returning the created
 * record (manifest-bearing so getResource's agent type-check passes).
 */
function seedValidatingRegistry(): { created: () => string | undefined } {
  let createdName: string | undefined;
  registryMock.on(CreateRegistryRecordCommand).callsFake((input) => {
    const name = input.name as string;
    if (!NAME_CONSTRAINT.test(name)) {
      return Promise.reject(
        Object.assign(
          new Error(
            `1 validation error detected: Value at 'name' failed to satisfy constraint: ` +
              `Member must satisfy regular expression pattern: [a-zA-Z0-9][a-zA-Z0-9_\\-\\./]*`,
          ),
          { name: 'ValidationException', $metadata: { httpStatusCode: 400 } },
        ),
      );
    }
    createdName = name;
    return Promise.resolve({
      recordArn: `arn:aws:bedrock-agentcore:us-east-1:123:registry/test-registry-id/record/${RECORD_ID}`,
      status: 'DRAFT',
    });
  });
  registryMock.on(GetRegistryRecordCommand).callsFake(() =>
    Promise.resolve({
      recordId: RECORD_ID,
      name: createdName ?? 'unset',
      description: 'd',
      status: 'DRAFT',
      descriptors: {
        custom: {
          inlineContent: JSON.stringify({
            manifest: { orgId: 'org-1', version: 1, status: 'DRAFT' },
          }),
        },
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
  );
  return { created: () => createdName };
}

const IAM_IDENTITY = {
  accountId: '123456789012',
  userArn: 'arn:aws:sts::123456789012:assumed-role/intake-runtime-role/session',
  username: 'AROAEXAMPLE:session',
  sourceIp: ['10.0.0.1'],
};

describe('name sanitization end-to-end (live-constraint registry mock)', () => {
  beforeEach(() => {
    registryMock.reset();
    ddbMock.reset();
    ebMock.reset();
    ddbMock.on(UpdateCommand).resolves({});
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('createApp core (UI/Cognito path) succeeds with a spaced name and creates a valid record', async () => {
    const registry = seedValidatingRegistry();

    const result = (await createApp(
      { orgId: 'org-1', name: 'Test - Ingest', description: 'human description' },
      'user-123',
    )) as { appId: string; name: string };

    expect(result.appId).toBe(RECORD_ID);
    expect(registry.created()).toBe('Test-Ingest');
    expect(NAME_CONSTRAINT.test(registry.created() as string)).toBe(true);
  });

  it('createApp mirrors the CREATED (sanitized) name to the AppsTable #META row', async () => {
    seedValidatingRegistry();

    await createApp(
      { orgId: 'org-1', name: 'Test - Ingest', description: 'human description' },
      'user-123',
    );

    const metaWrites = ddbMock
      .commandCalls(UpdateCommand)
      .filter((c) => c.args[0].input.TableName === 'citadel-apps-test');
    expect(metaWrites.length).toBeGreaterThan(0);
    const values = metaWrites[0].args[0].input.ExpressionAttributeValues as Record<
      string,
      unknown
    >;
    expect(values[':v_name']).toBe('Test-Ingest');
  });

  it('intakeCreateApp (intake path) succeeds with "Test - Ingest" and the record name is valid', async () => {
    const registry = seedValidatingRegistry();
    // Session → project linkage for org derivation.
    ddbMock
      .on(ScanCommand, { TableName: 'citadel-conversations-test' })
      .resolves({ Items: [{ projectId: 'proj-1' }] });
    // Pre-create idempotency lookup (findAppBySourceProjectId) scans the
    // AppsTable — no existing app for this session, so create proceeds.
    ddbMock
      .on(ScanCommand, { TableName: 'citadel-apps-test' })
      .resolves({ Items: [] });
    ddbMock
      .on(GetCommand, { TableName: 'citadel-projects-test' })
      .resolves({
        Item: { id: 'proj-1', name: 'Test - Ingest', organization: 'org-1', owner: 'owner-1' },
      });

    const result = (await intakeHandler({
      info: { fieldName: 'intakeCreateApp' },
      arguments: {
        sessionId: 'sess-1111',
        name: 'Test - Ingest',
        description: 'Agents and workflow captured from an intake session',
      },
      identity: IAM_IDENTITY,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)) as { appId: string; name: string };

    expect(result.appId).toBe(RECORD_ID);
    expect(registry.created()).toBe('Test-Ingest');
    expect(NAME_CONSTRAINT.test(registry.created() as string)).toBe(true);
    expect(result.name).toBe('Test-Ingest');
  });
});
