/**
 * node-shape.test.ts — locks the canonical workflow node shape.
 *
 * The persisted WorkflowNodeDefinition uses TOP-LEVEL `agentId` (not
 * `node.data.agentId`). Evidence:
 *   - frontend/src/types/workflow.ts:                  `WorkflowNodeDefinition.agentId` is top-level.
 *   - frontend/src/services/workflowService.ts:        explicitly maps `node.data.agentId`
 *                                                       → top-level on serialization.
 *   - backend/src/lambda/seed-blueprints/index.ts:     all seed blueprints use top-level.
 *   - backend/src/lambda/workflow-resolver.ts:         `validateDefinition` checks `node.agentId`.
 *   - backend/src/lambda/execution-resolver.ts:        copies `node.agentId` → nodeResults.
 *   - arbiter/stepRunner/executor.py:                   reads `node.get('agentId', '')`
 *                                                       (post-fix; pre-fix it read the
 *                                                        ReactFlow runtime shape and would
 *                                                        always get '' in production).
 *
 * These tests guard against the shape regressing back to a `node.data.agentId`
 * mismatch by asserting:
 *   1. Every seed-blueprint node has top-level `agentId` and NOT `data.agentId`.
 *   2. `validateDefinition` (via publishWorkflow) rejects nodes that only carry
 *      `data.agentId` with no top-level `agentId`.
 *   3. `validateDefinition` accepts nodes that carry top-level `agentId`.
 */
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import {
  CognitoIdentityProviderClient,
  AdminGetUserCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { mockClient } from 'aws-sdk-client-mock';

const ddbMock = mockClient(DynamoDBDocumentClient);
const ebMock = mockClient(EventBridgeClient);
const cognitoMock = mockClient(CognitoIdentityProviderClient);

jest.mock('../../utils/appsync', () => ({
  getUserId: jest.fn().mockReturnValue('user-123'),
}));

import { handler } from '../workflow-resolver';
import { SEED_BLUEPRINTS } from '../seed-blueprints';

function makeEvent(fieldName: string, args: any, sub = 'user-123') {
  return {
    info: { fieldName },
    arguments: args,
    identity: { sub, claims: { sub } },
  } as any;
}

function mockCognitoOrg(orgId: string) {
  cognitoMock.on(AdminGetUserCommand).resolves({
    UserAttributes: [
      { Name: 'sub', Value: 'user-123' },
      { Name: 'custom:organization', Value: orgId },
    ],
  });
}

describe('canonical workflow node agentId shape', () => {
  beforeAll(() => {
    process.env.WORKFLOWS_TABLE = 'citadel-workflows-test';
    process.env.APPS_TABLE = 'citadel-apps-test';
    process.env.AGENT_CONFIG_TABLE = 'citadel-agents-test';
    process.env.EVENT_BUS_NAME = 'citadel-agents-test';
    process.env.USER_POOL_ID = 'us-east-1_test';
  });

  beforeEach(() => {
    ddbMock.reset();
    ebMock.reset();
    cognitoMock.reset();
    mockCognitoOrg('org-1');
    ebMock.on(PutEventsCommand).resolves({});
  });

  afterAll(() => {
    delete process.env.WORKFLOWS_TABLE;
    delete process.env.APPS_TABLE;
    delete process.env.AGENT_CONFIG_TABLE;
    delete process.env.EVENT_BUS_NAME;
    delete process.env.USER_POOL_ID;
  });

  describe('seed-blueprints conform to canonical shape', () => {
    test('every seed-blueprint node carries top-level agentId (string)', () => {
      expect(SEED_BLUEPRINTS.length).toBeGreaterThan(0);
      for (const bp of SEED_BLUEPRINTS) {
        for (const node of bp.definition.nodes) {
          expect(typeof node.agentId).toBe('string');
          expect(node.agentId.length).toBeGreaterThan(0);
        }
      }
    });

    test('no seed-blueprint node uses the data-nested shape (data.agentId)', () => {
      for (const bp of SEED_BLUEPRINTS) {
        for (const node of bp.definition.nodes as any[]) {
          // The persisted definition must NOT carry agentId under node.data.
          // The data-nested shape is the frontend's ReactFlow runtime
          // representation only (see frontend/src/types/workflow.ts).
          if (node.data) {
            expect(node.data.agentId).toBeUndefined();
          }
        }
      }
    });
  });

  describe('validateDefinition shape guard (via publishWorkflow)', () => {
    test('rejects a node that only carries data.agentId (no top-level agentId)', async () => {
      const dataNestedOnly = JSON.stringify({
        nodes: [
          // wrong shape: agentId hidden under node.data — must be rejected
          { id: 'n1', type: 'agent', data: { agentId: 'a1b2c3d4e5f6' } },
        ],
        edges: [],
      });
      ddbMock.on(GetCommand).resolves({
        Item: {
          workflowId: 'wf-shape-1',
          orgId: 'org-1',
          status: 'DRAFT',
          definition: dataNestedOnly,
          version: 1,
        },
      });

      await expect(
        handler(
          makeEvent('publishWorkflow', { workflowId: 'wf-shape-1' }),
          {} as any,
          {} as any,
        ),
      ).rejects.toThrow(/missing agentId/i);
    });

    test('accepts a node that carries top-level agentId', async () => {
      const topLevel = JSON.stringify({
        nodes: [
          { id: 'n1', type: 'agent', agentId: 'a1b2c3d4e5f6' },
        ],
        edges: [],
      });
      ddbMock.on(GetCommand).resolves({
        Item: {
          workflowId: 'wf-shape-2',
          orgId: 'org-1',
          status: 'DRAFT',
          definition: topLevel,
          version: 1,
        },
      });

      // Should not throw a validation error. We don't assert the full
      // success path here (publishWorkflow does additional DB writes that
      // are not relevant to the shape contract); we only assert the shape
      // check itself passes by checking the validation error message
      // does NOT mention "missing agentId".
      try {
        await handler(
          makeEvent('publishWorkflow', { workflowId: 'wf-shape-2' }),
          {} as any,
          {} as any,
        );
      } catch (err: any) {
        expect(String(err?.message ?? err)).not.toMatch(/missing agentId/i);
      }
    });

    test('rejects a node with both shapes set but only data.agentId populated (top-level empty)', async () => {
      const emptyTopLevel = JSON.stringify({
        nodes: [
          // Top-level agentId is intentionally falsy; only data.agentId is set.
          // This must still be rejected: the validator only honours the
          // canonical top-level field.
          { id: 'n1', type: 'agent', agentId: '', data: { agentId: 'a1b2c3d4e5f6' } },
        ],
        edges: [],
      });
      ddbMock.on(GetCommand).resolves({
        Item: {
          workflowId: 'wf-shape-3',
          orgId: 'org-1',
          status: 'DRAFT',
          definition: emptyTopLevel,
          version: 1,
        },
      });

      await expect(
        handler(
          makeEvent('publishWorkflow', { workflowId: 'wf-shape-3' }),
          {} as any,
          {} as any,
        ),
      ).rejects.toThrow(/missing agentId/i);
    });
  });
});
