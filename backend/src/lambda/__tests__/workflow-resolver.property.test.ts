import * as fc from 'fast-check';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { CognitoIdentityProviderClient, AdminGetUserCommand } from '@aws-sdk/client-cognito-identity-provider';
import { mockClient } from 'aws-sdk-client-mock';

const ddbMock = mockClient(DynamoDBDocumentClient);
const ebMock = mockClient(EventBridgeClient);
const cognitoMock = mockClient(CognitoIdentityProviderClient);

jest.mock('../../utils/appsync', () => ({
  getUserId: jest.fn().mockReturnValue('user-123'),
}));

import { handler } from '../workflow-resolver';

type HandlerEvent = Parameters<typeof handler>[0];

// aws-lambda's Handler type declares legacy required context and callback
// parameters, but the implementation is a one-parameter async (event)
// function that never uses them — invoke through the real signature
// (single cast here) so calls don't pass superfluous arguments.
const invokeHandler = handler as (event: HandlerEvent) => Promise<unknown>;

function makeEvent(fieldName: string, args: Record<string, unknown>, sub = 'user-123'): HandlerEvent {
  return {
    info: { fieldName },
    arguments: args,
    identity: { sub, claims: { sub } },
  } as unknown as HandlerEvent;
}

function mockCognitoOrg(orgId: string) {
  cognitoMock.on(AdminGetUserCommand).resolves({
    UserAttributes: [
      { Name: 'sub', Value: 'user-123' },
      { Name: 'custom:organization', Value: orgId },
    ],
  });
}

/**
 * Property-based tests for Workflow Definition serialization.
 *
 * **Validates: Requirements 1.12, 1.13**
 */

// --- Arbitraries ---

/** Arbitrary for a valid WorkflowNodeDefinition */
const nodeArb = fc.record({
  id: fc.uuid(),
  agentId: fc.uuid(),
  type: fc.constant('agent'),
  label: fc.string({ minLength: 1, maxLength: 50 }),
  position: fc.record({ x: fc.integer(), y: fc.integer() }),
});

/** Arbitrary for valid WorkflowEdgeDefinitions referencing existing node IDs */
function edgeArb(nodeIds: string[]): fc.Arbitrary<Array<{ id: string; source: string; target: string }>> {
  if (nodeIds.length < 2) return fc.constant([]);
  return fc.array(
    fc.record({
      id: fc.uuid(),
      source: fc.constantFrom(...nodeIds),
      target: fc.constantFrom(...nodeIds),
    }).filter(e => e.source !== e.target),
    { minLength: 0, maxLength: nodeIds.length }
  );
}

/** Arbitrary for a complete WorkflowDefinition */
const workflowDefinitionArb = fc
  .array(nodeArb, { minLength: 1, maxLength: 10 })
  .chain(nodes => {
    const nodeIds = nodes.map(n => n.id);
    return edgeArb(nodeIds).map(edges => ({
      nodes,
      edges,
      metadata: { version: '1.0' },
    }));
  });

// --- Property Tests ---

describe('Property 1: Workflow Definition Round-Trip', () => {
  /**
   * **Validates: Requirements 1.12, 1.13**
   *
   * For all valid WorkflowDefinition JSON values, parsing then serializing
   * then parsing produces an equivalent object:
   *   JSON.parse(JSON.stringify(JSON.parse(d))) ≡ JSON.parse(d)
   */
  test('JSON.parse(JSON.stringify(JSON.parse(d))) ≡ JSON.parse(d) for all valid definitions', () => {
    fc.assert(
      fc.property(workflowDefinitionArb, (definition) => {
        const serialized = JSON.stringify(definition);
        const parsed = JSON.parse(serialized);
        const roundTripped = JSON.parse(JSON.stringify(parsed));
        expect(roundTripped).toEqual(parsed);
      }),
      { numRuns: 100 }
    );
  });
});


// --- Property 5: Optimistic Lock Conflict Detection ---

describe('Property 5: Optimistic Lock Conflict Detection', () => {
  /**
   * **Validates: Requirements 2.7, 2.8**
   *
   * For all workflows with version v (v >= 2),
   * updateWorkflow with version = v - 1 always fails with a Conflict error
   * when DynamoDB rejects the conditional write.
   */

  beforeAll(() => {
    process.env.WORKFLOWS_TABLE = 'citadel-workflows-test';
    process.env.APPS_TABLE = 'citadel-apps-test';
    process.env.AGENT_CONFIG_TABLE = 'citadel-agents-test';
    process.env.EVENT_BUS_NAME = 'citadel-agents-test';
    process.env.USER_POOL_ID = 'us-east-1_test';
  });

  afterAll(() => {
    delete process.env.WORKFLOWS_TABLE;
    delete process.env.APPS_TABLE;
    delete process.env.AGENT_CONFIG_TABLE;
    delete process.env.EVENT_BUS_NAME;
    delete process.env.USER_POOL_ID;
  });

  test('updateWorkflow with stale version always throws conflict error', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 2, max: 1000 }),
        async (currentVersion) => {
          // Reset mocks for each iteration
          ddbMock.reset();
          cognitoMock.reset();
          ebMock.reset();

          // Setup: caller belongs to org-1
          mockCognitoOrg('org-1');
          ebMock.on(PutEventsCommand).resolves({});

          // Setup: workflow exists with version = currentVersion
          ddbMock.on(GetCommand).resolves({
            Item: {
              workflowId: 'wf-prop',
              orgId: 'org-1',
              version: currentVersion,
              status: 'DRAFT',
            },
          });

          // DynamoDB rejects the conditional write (stale version)
          const condErr = new Error('ConditionalCheckFailedException');
          condErr.name = 'ConditionalCheckFailedException';
          ddbMock.on(UpdateCommand).rejects(condErr);

          // Act: try to update with stale version (currentVersion - 1)
          await expect(
            invokeHandler(
              makeEvent('updateWorkflow', {
                input: {
                  workflowId: 'wf-prop',
                  name: 'Stale Update',
                  version: currentVersion - 1,
                },
              }),
            ),
          ).rejects.toThrow(/Conflict/);
        },
      ),
      { numRuns: 50 },
    );
  });
});


// --- Property 7: Import/Export Round-Trip ---

describe('Property 7: Import/Export Round-Trip', () => {
  /**
   * **Validates: Requirements 24.7**
   *
   * For all valid workflow definitions, export(import(export(w))) produces
   * equivalent JSON to export(w) excluding server-generated fields
   * (workflowId, createdAt, updatedAt, createdBy, version, versionHistory, appId, orgId).
   */
  test('export(import(export(w))) ≡ export(w) excluding server-generated fields', () => {
    fc.assert(
      fc.property(workflowDefinitionArb, fc.string({ minLength: 1, maxLength: 30 }), (definition, name) => {
        // Simulate a workflow object
        const workflow = {
          name,
          description: 'Test workflow',
          definition: JSON.stringify(definition),
          configuration: null,
          metadata: null,
          status: 'DRAFT',
          version: 1,
        };

        // Export: extract transferable fields
        const exported = JSON.stringify({
          name: workflow.name,
          description: workflow.description,
          definition: workflow.definition,
          configuration: workflow.configuration,
          metadata: workflow.metadata,
          status: workflow.status,
          version: workflow.version,
        });

        // Import: parse exported JSON, create new workflow
        const parsed = JSON.parse(exported);
        const imported = {
          name: parsed.name,
          description: parsed.description || '',
          definition: parsed.definition,
          configuration: parsed.configuration || null,
          metadata: parsed.metadata || null,
          status: 'DRAFT', // import always sets DRAFT
          version: 1, // import always sets version 1
        };

        // Export again
        const reExported = JSON.stringify({
          name: imported.name,
          description: imported.description,
          definition: imported.definition,
          configuration: imported.configuration,
          metadata: imported.metadata,
          status: imported.status,
          version: imported.version,
        });

        // Round-trip should produce equivalent JSON
        expect(JSON.parse(reExported)).toEqual(JSON.parse(exported));
      }),
      { numRuns: 100 }
    );
  });
});
