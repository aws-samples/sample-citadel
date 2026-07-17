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

type HandlerEvent = Parameters<typeof handler>[0];

function makeEvent(fieldName: string, args: Record<string, unknown>, sub = 'user-123'): HandlerEvent {
  return {
    info: { fieldName },
    arguments: args,
    identity: { sub, claims: { sub } },
  } as unknown as HandlerEvent;
}

// aws-lambda's Handler type declares legacy required context and callback
// parameters, but the implementation is a one-parameter async (event)
// function that never uses them — invoke through the real signature
// (single cast here) so calls don't pass superfluous arguments.
const invokeHandler = handler as (event: HandlerEvent) => Promise<unknown>;

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
        for (const node of bp.definition.nodes as Array<{ data?: { agentId?: unknown } }>) {
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
        invokeHandler(
          makeEvent('publishWorkflow', { workflowId: 'wf-shape-1' }),
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
        await invokeHandler(
          makeEvent('publishWorkflow', { workflowId: 'wf-shape-2' }),
        );
      } catch (err) {
        expect(String((err as Error)?.message ?? err)).not.toMatch(/missing agentId/i);
      }
    });

    test('Echo Demo Workflow (a real seeded blueprint) passes publish validation', async () => {
      // The demo references a real seeded agentId and forms a minimal
      // connected acyclic DAG, so validateDefinition must accept it. It is the
      // one seed blueprint intended to be publishable as-is (the others are
      // placeholder templates rejected by design). Assert no validation error
      // surfaces — placeholder / disconnected / circular / missing agentId.
      const demo = SEED_BLUEPRINTS.find((b) => b.name === 'Echo Demo Workflow')!;
      expect(demo).toBeDefined();

      ddbMock.on(GetCommand).resolves({
        Item: {
          workflowId: 'wf-demo-echo',
          orgId: 'org-1',
          status: 'DRAFT',
          definition: JSON.stringify(demo.definition),
          version: 1,
        },
      });

      try {
        await invokeHandler(
          makeEvent('publishWorkflow', { workflowId: 'wf-demo-echo' }),
        );
      } catch (err) {
        expect(String((err as Error)?.message ?? err)).not.toMatch(
          /placeholder|disconnected|circular|missing agentId|validation failed/i,
        );
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
        invokeHandler(
          makeEvent('publishWorkflow', { workflowId: 'wf-shape-3' }),
        ),
      ).rejects.toThrow(/missing agentId/i);
    });
  });
});
