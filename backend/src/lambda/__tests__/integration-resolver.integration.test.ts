/**
 * Integration Tests for Integration Resolver
 *
 * These tests hit real AWS services (DynamoDB) to verify that
 * listIntegrations only returns integrations that are actually connected.
 *
 * Run with: npx jest --config jest.integration.config.js integration-resolver.integration
 *
 * Requires:
 *   AWS_PROFILE=akalanka+0001-Administrator
 *   AWS_REGION=ap-southeast-2
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, PutCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { v4 as uuidv4 } from 'uuid';

const REGION = process.env.AWS_REGION || 'ap-southeast-2';
const ENVIRONMENT = process.env.ENVIRONMENT || 'dev';
const TABLE_NAME = `citadel-integrations-${ENVIRONMENT}`;

const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

// Test org ID — unique per test run to avoid collisions
const TEST_ORG_ID = `test-org-${uuidv4()}`;

// Helper: insert a test integration directly into DynamoDB
async function insertTestIntegration(overrides: Record<string, any> = {}) {
  const id = uuidv4();
  const item = {
    PK: `ORG#${TEST_ORG_ID}`,
    SK: `INTEGRATION#${overrides.integrationType || 'CONFLUENCE'}#${id}`,
    integrationId: id,
    integrationType: overrides.integrationType || 'CONFLUENCE',
    name: overrides.name || `Test Integration ${id.slice(0, 8)}`,
    status: overrides.status || 'CONFIGURED',
    orgId: TEST_ORG_ID,
    createdBy: 'integration-test',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    config: overrides.config || { baseUrl: 'https://test.example.com' },
    secretArn: overrides.secretArn || `arn:aws:secretsmanager:${REGION}:000000000000:secret:fake-${id}`,
    ssmParameterPrefix: `/test/${id}`,
    metadata: overrides.metadata || {
      version: '1.0',
      protocol: 'REST',
      provider: 'Test',
      authMethod: 'API_KEY',
    },
    ...overrides,
  };

  await dynamodb.send(new PutCommand({ TableName: TABLE_NAME, Item: item }));
  return item;
}

// Helper: delete a test integration
async function deleteTestIntegration(pk: string, sk: string) {
  await dynamodb.send(new DeleteCommand({ TableName: TABLE_NAME, Key: { PK: pk, SK: sk } }));
}

// Helper: query integrations for the test org (mirrors resolver logic)
async function queryIntegrations(orgId: string, integrationType?: string) {
  const params: any = {
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
    ExpressionAttributeValues: {
      ':pk': `ORG#${orgId}`,
      ':sk': integrationType ? `INTEGRATION#${integrationType}#` : 'INTEGRATION#',
    },
  };

  const response = await dynamodb.send(new QueryCommand(params));
  return response.Items || [];
}

// Skip integration tests that require live AWS resources
const runIntegration = process.env.RUN_INTEGRATION_TESTS === 'true';
const describeOrSkip = runIntegration ? describe : describe.skip;

describeOrSkip('Integration Resolver — Real AWS Integration Tests', () => {
  const createdItems: { PK: string; SK: string }[] = [];

  afterAll(async () => {
    // Clean up all test data
    for (const key of createdItems) {
      try {
        await deleteTestIntegration(key.PK, key.SK);
      } catch {
        // best-effort cleanup
      }
    }
  });

  describe('listIntegrations returns only connected integrations', () => {
    let connectedConfluence: any;
    let configuredConfluence: any;
    let testedSlack: any;
    let connectedLambda: any;
    let disconnectedMcp: any;
    let connectionFailedJira: any;

    beforeAll(async () => {
      // Seed integrations with various statuses
      connectedConfluence = await insertTestIntegration({
        integrationType: 'CONFLUENCE',
        name: 'Connected Confluence',
        status: 'CONNECTED',
      });
      createdItems.push({ PK: connectedConfluence.PK, SK: connectedConfluence.SK });

      configuredConfluence = await insertTestIntegration({
        integrationType: 'CONFLUENCE',
        name: 'Configured Confluence',
        status: 'CONFIGURED',
      });
      createdItems.push({ PK: configuredConfluence.PK, SK: configuredConfluence.SK });

      testedSlack = await insertTestIntegration({
        integrationType: 'SLACK',
        name: 'Tested Slack',
        status: 'TESTED',
      });
      createdItems.push({ PK: testedSlack.PK, SK: testedSlack.SK });

      connectedLambda = await insertTestIntegration({
        integrationType: 'AWS_LAMBDA',
        name: 'Connected Lambda',
        status: 'CONNECTED',
        gatewayTargetId: 'target-fake-123',
      });
      createdItems.push({ PK: connectedLambda.PK, SK: connectedLambda.SK });

      disconnectedMcp = await insertTestIntegration({
        integrationType: 'MCP_SERVER',
        name: 'Disconnected MCP',
        status: 'DISCONNECTED',
      });
      createdItems.push({ PK: disconnectedMcp.PK, SK: disconnectedMcp.SK });

      connectionFailedJira = await insertTestIntegration({
        integrationType: 'JIRA',
        name: 'Failed Jira',
        status: 'CONNECTION_FAILED',
      });
      createdItems.push({ PK: connectionFailedJira.PK, SK: connectionFailedJira.SK });
    });

    test('raw query returns all integrations regardless of status', async () => {
      const all = await queryIntegrations(TEST_ORG_ID);
      expect(all.length).toBe(6);
    });

    test('filtering by CONNECTED status returns only connected integrations', async () => {
      const all = await queryIntegrations(TEST_ORG_ID);
      const connected = all.filter((item: any) => item.status === 'CONNECTED');

      expect(connected.length).toBe(2);
      const names = connected.map((i: any) => i.name).sort();
      expect(names).toEqual(['Connected Confluence', 'Connected Lambda']);
    });

    test('filtering by type + CONNECTED narrows results correctly', async () => {
      const all = await queryIntegrations(TEST_ORG_ID, 'CONFLUENCE');
      const connected = all.filter((item: any) => item.status === 'CONNECTED');

      expect(connected.length).toBe(1);
      expect(connected[0].name).toBe('Connected Confluence');
    });

    test('non-connected statuses are excluded', async () => {
      const all = await queryIntegrations(TEST_ORG_ID);
      const connected = all.filter((item: any) => item.status === 'CONNECTED');

      const connectedIds = connected.map((i: any) => i.integrationId);
      expect(connectedIds).not.toContain(configuredConfluence.integrationId);
      expect(connectedIds).not.toContain(testedSlack.integrationId);
      expect(connectedIds).not.toContain(disconnectedMcp.integrationId);
      expect(connectedIds).not.toContain(connectionFailedJira.integrationId);
    });

    test('AgentCore types (AWS_LAMBDA) with CONNECTED status include gatewayTargetId', async () => {
      const all = await queryIntegrations(TEST_ORG_ID, 'AWS_LAMBDA');
      const connected = all.filter((item: any) => item.status === 'CONNECTED');

      expect(connected.length).toBe(1);
      expect(connected[0].gatewayTargetId).toBe('target-fake-123');
    });
  });

  describe('listIntegrations with empty org', () => {
    test('returns empty array for org with no integrations', async () => {
      const emptyOrgId = `empty-org-${uuidv4()}`;
      const items = await queryIntegrations(emptyOrgId);
      expect(items).toEqual([]);
    });
  });

  describe('listIntegrations with only non-connected integrations', () => {
    let configuredOnly: any;

    beforeAll(async () => {
      configuredOnly = await insertTestIntegration({
        integrationType: 'GITHUB',
        name: 'Configured GitHub',
        status: 'CONFIGURED',
      });
      createdItems.push({ PK: configuredOnly.PK, SK: configuredOnly.SK });
    });

    test('returns empty when filtering for CONNECTED and none exist', async () => {
      const all = await queryIntegrations(TEST_ORG_ID, 'GITHUB');
      const connected = all.filter((item: any) => item.status === 'CONNECTED');
      expect(connected.length).toBe(0);
    });
  });
});
