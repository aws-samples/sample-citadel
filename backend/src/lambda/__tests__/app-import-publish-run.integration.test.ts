/**
 * Cross-resolver integration test for the create → import → publish → run
 * seam where two live bugs occurred:
 *
 *   1. Empty-description hazard: the AgentCore Registry rejects records with
 *      description length 0; createApp must default an absent description to
 *      the app name (Import Blueprint "New App" mode sends only {name, orgId}).
 *   2. Identity-chain break: the registry assigns its OWN 12-char recordId
 *      (discarding the caller uuid); createApp must return THAT id — the key
 *      the AppsTable #META mirror row is written under — or the immediately
 *      following importBlueprint GetItem misses with "App not found".
 *
 * Unlike the sibling unit tests (which stub each DynamoDB command's response
 * in isolation), this test drives the REAL handler functions of all three
 * resolvers against ONE shared in-memory fake DynamoDB, so the row written by
 * one resolver is the row the next resolver reads:
 *
 *   registry-agent-record-resolver.createApp
 *     → workflow-resolver.importBlueprint (agentMapping → demo-echo-agent)
 *       → workflow-resolver.publishWorkflow (agent-existence gate)
 *         → execution-resolver.startExecution (execution row + event)
 *
 * The fake implements only the command shapes these paths use:
 * Get / Put / BatchGet, and Update limited to simple `SET a = :v` clauses
 * plus the `list_append(if_not_exists(...))` form importBlueprint uses to
 * append workflowIds. Anything else throws loudly.
 *
 * TEST-ONLY: no production file is modified. If this flow exposes a product
 * bug, the expectation documents current-correct behavior and the bug is
 * reported, not patched here.
 */
// Env vars MUST be set BEFORE importing the resolvers — each module captures
// its table names / bus name at load time (see sibling tests).
process.env.REGISTRY_ID = 'test-registry-id';
process.env.APPS_TABLE = 'citadel-apps-test';
process.env.WORKFLOWS_TABLE = 'citadel-workflows-test';
process.env.AGENT_CONFIG_TABLE = 'citadel-agents-test';
process.env.EXECUTIONS_TABLE = 'citadel-executions-test';
process.env.EVENT_BUS_NAME = 'citadel-agents-test';
process.env.USER_POOL_ID = 'us-east-1_test';
process.env.AWS_REGION = 'us-east-1';
// Keep authority grant/revoke as no-ops inside createApp (no DDB mock needed
// for that path) — same convention as the identity-chain tests.
delete process.env.AUTHORITY_UNITS_TABLE;

import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  BatchGetCommand,
} from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';

const ebMock = mockClient(EventBridgeClient);
const ddbMock = mockClient(DynamoDBDocumentClient);

/** The 12-char id the (mocked) registry assigns, ignoring the caller's uuid. */
const REGISTRY_ASSIGNED_ID = 'rec123456789';

jest.mock('../../services/registry-service', () => {
  interface MockRegistryRecord {
    recordId: string;
    name?: string;
    description?: string;
    status?: string;
    customDescriptorContent?: string;
    createdAt?: Date;
    updatedAt?: Date;
  }
  interface MockRegistryWriteInput {
    name?: string;
    description?: string;
    customMetadata?: string;
  }
  const records = new Map<string, MockRegistryRecord>();
  const createInputs: MockRegistryWriteInput[] = [];
  const svc = {
    async getResource(type: string, id: string) {
      return records.get(`${type}:${id}`) ?? null;
    },
    async createResource(type: string, _callerId: string, input: MockRegistryWriteInput) {
      // Mimic the REAL registry: the caller-supplied id is DISCARDED and a
      // registry-assigned 12-char recordId is used instead. The exact input
      // is captured so the test can assert on the description that reached
      // the registry (the empty-description live bug).
      createInputs.push(input);
      const record = {
        recordId: 'rec123456789',
        name: input.name,
        description: input.description,
        status: 'DRAFT',
        customDescriptorContent: input.customMetadata,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      records.set(`${type}:${record.recordId}`, record);
      return record;
    },
    async updateResource(type: string, id: string, input: MockRegistryWriteInput) {
      const existing = records.get(`${type}:${id}`);
      if (!existing) throw new Error(`Record not found: ${type}:${id}`);
      const updated = {
        ...existing,
        ...(input.name !== undefined && { name: input.name }),
        ...(input.description !== undefined && { description: input.description }),
        ...(input.customMetadata !== undefined && {
          customDescriptorContent: input.customMetadata,
        }),
        recordId: id,
        updatedAt: new Date(),
      };
      records.set(`${type}:${id}`, updated);
      return updated;
    },
    async updateResourceStatus(type: string, id: string, status: string) {
      const existing = records.get(`${type}:${id}`);
      if (!existing) throw new Error(`Record not found: ${type}:${id}`);
      const updated = { ...existing, status, updatedAt: new Date() };
      records.set(`${type}:${id}`, updated);
      return updated;
    },
    async deleteResource(type: string, id: string) {
      records.delete(`${type}:${id}`);
    },
    async resolveRecordId(_type: string, id: string) {
      return id;
    },
  };
  class TypeMismatchError extends Error {}
  class RegistryLifecycleError extends Error {
    code: string;
    constructor(message: string, code: string) {
      super(message);
      this.code = code;
    }
  }
  return {
    RegistryService: jest.fn().mockImplementation(() => svc),
    getRegistryService: jest.fn(() => svc),
    isRegistryEnabled: jest.fn(() => true),
    TypeMismatchError,
    RegistryLifecycleError,
    __get: (type: string, id: string) => records.get(`${type}:${id}`),
    __createInputs: createInputs,
    __reset: () => {
      records.clear();
      createInputs.length = 0;
    },
  };
});

jest.mock('../../utils/appsync', () => ({
  getUserId: jest.fn().mockReturnValue('user-123'),
}));

jest.mock('../../utils/appsync-publish', () => ({
  publishAppStatusEvent: jest.fn().mockResolvedValue(undefined),
}));

import { handler as registryHandler } from '../registry-agent-record-resolver';
import { handler as workflowHandler } from '../workflow-resolver';
import { handler as executionHandler } from '../execution-resolver';

import * as registryServiceMockedModule from '../../services/registry-service';

// jest.mock above replaces the module, so this namespace import resolves to
// the mock factory's return value (which carries the __get/__createInputs/
// __reset test hooks not present on the real module's type).
const registryMock = registryServiceMockedModule as unknown as {
  __get: (type: string, id: string) => Record<string, unknown> | undefined;
  __createInputs: { name?: string; description?: string; customMetadata?: string }[];
  __reset: () => void;
};

// aws-lambda's Handler type declares legacy required context and callback
// parameters, but each resolver implementation is a one-parameter async
// (event) function that never uses them — invoke through the real signature
// (single cast per handler) so calls don't pass superfluous arguments.
const invokeRegistryHandler = registryHandler as (
  event: Parameters<typeof registryHandler>[0],
) => Promise<unknown>;
const invokeWorkflowHandler = workflowHandler as (
  event: Parameters<typeof workflowHandler>[0],
) => Promise<unknown>;
const invokeExecutionHandler = executionHandler as (
  event: Parameters<typeof executionHandler>[0],
) => Promise<unknown>;

// ─── Shared in-memory fake DynamoDB ─────────────────────────────────────────

/** Table name → primary-key attribute. All four tables are single-PK. */
const KEY_ATTR: Record<string, string> = {
  'citadel-apps-test': 'appId',
  'citadel-workflows-test': 'workflowId',
  'citadel-agents-test': 'agentId',
  'citadel-executions-test': 'executionId',
};

const stores = new Map<string, Map<string, Record<string, unknown>>>();

function store(tableName: string): Map<string, Record<string, unknown>> {
  let s = stores.get(tableName);
  if (!s) {
    s = new Map();
    stores.set(tableName, s);
  }
  return s;
}

function keyAttrOf(tableName: string): string {
  const attr = KEY_ATTR[tableName];
  if (!attr) throw new Error(`fake ddb: unknown table ${tableName}`);
  return attr;
}

/** Splits an UpdateExpression clause list on top-level commas only. */
function splitTopLevel(expr: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of expr) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

/**
 * Minimal UpdateCommand interpreter covering exactly the expressions the
 * resolvers under test emit:
 *   - `SET #a = :v, b = :w, ...`                       (upsertAppMeta, publishWorkflow)
 *   - `SET #x = list_append(if_not_exists(#x, :empty), :new)` (importBlueprint)
 * Upsert semantics (creates the row when absent) match DynamoDB UpdateItem.
 */
interface FakeUpdateInput {
  TableName?: string;
  Key?: Record<string, string>;
  ExpressionAttributeNames?: Record<string, string>;
  ExpressionAttributeValues?: Record<string, unknown>;
  UpdateExpression?: string;
  ReturnValues?: string;
}

function applyUpdate(input: FakeUpdateInput): { Attributes?: Record<string, unknown> } {
  const tableName = input.TableName as string;
  const attr = keyAttrOf(tableName);
  const keyVal = input.Key![attr];
  const s = store(tableName);
  const item: Record<string, unknown> = { ...(s.get(keyVal) ?? { [attr]: keyVal }) };
  const names: Record<string, string> = input.ExpressionAttributeNames ?? {};
  const values: Record<string, unknown> = input.ExpressionAttributeValues ?? {};
  const resolveName = (token: string) =>
    token.startsWith('#') ? names[token] : token;

  const expr = String(input.UpdateExpression ?? '');
  if (!/^SET\s/i.test(expr)) {
    throw new Error(`fake ddb: unsupported UpdateExpression: ${expr}`);
  }
  for (const clause of splitTopLevel(expr.replace(/^SET\s+/i, ''))) {
    const eq = clause.indexOf('=');
    const lhs = resolveName(clause.slice(0, eq).trim());
    const rhs = clause.slice(eq + 1).trim();
    const listAppend = rhs.match(
      /^list_append\(\s*if_not_exists\(\s*([#\w]+)\s*,\s*(:\w+)\s*\)\s*,\s*(:\w+)\s*\)$/,
    );
    if (listAppend) {
      const baseAttr = resolveName(listAppend[1]);
      const base = (item[baseAttr] ?? values[listAppend[2]]) as unknown[];
      item[lhs] = [...base, ...(values[listAppend[3]] as unknown[])];
    } else if (rhs.startsWith(':')) {
      item[lhs] = values[rhs];
    } else {
      throw new Error(`fake ddb: unsupported SET rhs: ${rhs}`);
    }
  }
  s.set(keyVal, item);
  return input.ReturnValues === 'ALL_NEW' ? { Attributes: item } : {};
}

/** (Re)installs the fake handlers — must run after every ddbMock.reset(). */
function installFakeDdb(): void {
  ddbMock.on(GetCommand).callsFake((input: { TableName: string; Key: Record<string, string> }) => {
    const attr = keyAttrOf(input.TableName);
    return { Item: store(input.TableName).get(input.Key[attr]) };
  });
  ddbMock.on(PutCommand).callsFake((input: { TableName: string; Item: Record<string, unknown> }) => {
    const attr = keyAttrOf(input.TableName);
    store(input.TableName).set(input.Item[attr] as string, { ...input.Item });
    return {};
  });
  ddbMock.on(UpdateCommand).callsFake((input: FakeUpdateInput) => applyUpdate(input));
  ddbMock.on(BatchGetCommand).callsFake((input: { RequestItems: Record<string, { Keys: Record<string, string>[] }> }) => {
    const responses: Record<string, Record<string, unknown>[]> = {};
    for (const [tableName, spec] of Object.entries(input.RequestItems)) {
      const attr = keyAttrOf(tableName);
      responses[tableName] = spec.Keys.map((k) =>
        store(tableName).get(k[attr]),
      ).filter((row): row is Record<string, unknown> => Boolean(row));
    }
    return { Responses: responses };
  });
}

// ─── Event / seed helpers ───────────────────────────────────────────────────

/**
 * Claim-first identity: `custom:organization` on the identity makes
 * extractOrgFromEvent resolve the org without a Cognito round-trip (the
 * claim-first path pinned by the sibling workflow/execution tests).
 */
function makeEvent<E>(fieldName: string, args: Record<string, unknown>, sub = 'user-123'): E {
  return {
    info: { fieldName },
    arguments: args,
    identity: { sub, claims: { sub }, 'custom:organization': 'org-1' },
  } as unknown as E;
}

const BLUEPRINT_ID = 'bp-echo-1';

function seedBlueprint(): void {
  store('citadel-workflows-test').set(BLUEPRINT_ID, {
    workflowId: BLUEPRINT_ID,
    orgId: 'org-1',
    name: 'Echo Blueprint',
    description: 'Two-node echo template',
    status: 'PUBLISHED',
    isBlueprint: 'true',
    definition: JSON.stringify({
      nodes: [
        { id: 'node-a', agentId: 'placeholder-a', type: 'agent' },
        { id: 'node-b', agentId: 'placeholder-b', type: 'agent' },
      ],
      edges: [{ id: 'edge-1', source: 'node-a', target: 'node-b' }],
    }),
    configuration: null,
    version: 1,
    versionHistory: [],
    appId: null,
    createdBy: 'seed',
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    metadata: null,
  });
}

function seedEchoAgent(): void {
  store('citadel-agents-test').set('demo-echo-agent', {
    agentId: 'demo-echo-agent',
    orgId: 'org-1',
    name: 'Demo Echo Agent',
    status: 'ACTIVE',
  });
}

/** All EventBridge entries with the given DetailType, across all calls. */
function eventsOfType(detailType: string) {
  return ebMock
    .commandCalls(PutEventsCommand)
    .flatMap((c) => c.args[0].input.Entries ?? [])
    .filter((e) => e.DetailType === detailType);
}

/** Loose row view for asserting on resolver results in this seam test. */
interface TestRow {
  [key: string]: unknown;
  appId?: string;
  workflowId?: string;
  executionId?: string;
  status?: string;
  definition?: string;
}

/** Runs createApp + importBlueprint and returns { appId, workflow }. */
async function createAppAndImport(): Promise<{ appId: string; workflow: TestRow }> {
  const app = (await invokeRegistryHandler(
    makeEvent('createApp', {
      input: { name: 'Import Test App', orgId: 'org-1' },
    }),
  )) as TestRow;

  const workflow = (await invokeWorkflowHandler(
    makeEvent('importBlueprint', {
      blueprintId: BLUEPRINT_ID,
      appId: app.appId,
      name: undefined,
      agentMapping: {
        'placeholder-a': 'demo-echo-agent',
        'placeholder-b': 'demo-echo-agent',
      },
    }),
  )) as TestRow;

  return { appId: app.appId, workflow };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('cross-resolver integration — createApp → importBlueprint → publishWorkflow → startExecution', () => {
  beforeEach(() => {
    stores.clear();
    registryMock.__reset();
    ebMock.reset();
    ddbMock.reset();
    ebMock.on(PutEventsCommand).resolves({});
    installFakeDdb();
    seedBlueprint();
    seedEchoAgent();
  });

  afterAll(() => {
    delete process.env.REGISTRY_ID;
    delete process.env.APPS_TABLE;
    delete process.env.WORKFLOWS_TABLE;
    delete process.env.AGENT_CONFIG_TABLE;
    delete process.env.EXECUTIONS_TABLE;
    delete process.env.EVENT_BUS_NAME;
    delete process.env.USER_POOL_ID;
  });

  test('full flow: descriptionless createApp yields an importable appId, mapped import publishes and executes end to end', async () => {
    // ── Step 2: createApp with NO description ──────────────────────────────
    const app = (await invokeRegistryHandler(
      makeEvent('createApp', {
        input: { name: 'Import Test App', orgId: 'org-1' },
      }),
    )) as TestRow;

    // Live bug #1: the description that reached the registry must be
    // non-empty — defaulted to the app name.
    expect(registryMock.__createInputs).toHaveLength(1);
    expect(registryMock.__createInputs[0].description).toBe('Import Test App');

    // Live bug #2: returned appId === registry recordId === the key the
    // AppsTable mirror row was actually written under.
    expect(app.appId).toBe(REGISTRY_ASSIGNED_ID);
    const mirrorRow = store('citadel-apps-test').get(REGISTRY_ASSIGNED_ID);
    expect(mirrorRow).toBeDefined();
    expect(mirrorRow.appId).toBe(app.appId);
    expect(mirrorRow.orgId).toBe('org-1');
    expect(mirrorRow.description).toBe('Import Test App');

    // ── Step 3: importBlueprint with agentMapping ──────────────────────────
    const imported = (await invokeWorkflowHandler(
      makeEvent('importBlueprint', {
        blueprintId: BLUEPRINT_ID,
        appId: app.appId,
        name: undefined,
        agentMapping: {
          'placeholder-a': 'demo-echo-agent',
          'placeholder-b': 'demo-echo-agent',
        },
      }),
    )) as TestRow;

    // The regression this seam test exists for: the id handed back by
    // createApp resolves — no 'App not found'.
    expect(imported.status).toBe('DRAFT');
    expect(imported.appId).toBe(app.appId);
    const importedDef = JSON.parse(imported.definition);
    expect(importedDef.nodes).toHaveLength(2);
    for (const node of importedDef.nodes) {
      expect(node.agentId).toBe('demo-echo-agent');
    }
    // The app's workflowIds picked up the new workflow (list_append path).
    const appRowAfterImport = store('citadel-apps-test').get(app.appId);
    expect(appRowAfterImport.workflowIds).toContain(imported.workflowId);

    // ── Step 4: publishWorkflow (agent exists → PUBLISHED) ─────────────────
    const published = (await invokeWorkflowHandler(
      makeEvent('publishWorkflow', { workflowId: imported.workflowId }),
    )) as TestRow;

    expect(published.status).toBe('PUBLISHED');
    expect(
      store('citadel-workflows-test').get(imported.workflowId).status,
    ).toBe('PUBLISHED');

    // ── Step 5: startExecution ─────────────────────────────────────────────
    const execution = (await invokeExecutionHandler(
      makeEvent('startExecution', { workflowId: imported.workflowId }),
    )) as TestRow;

    expect(execution.executionId).toBeDefined();
    expect(execution.workflowId).toBe(imported.workflowId);
    expect(execution.status).toBe('pending');
    expect(execution.appId).toBe(app.appId);

    // Execution row persisted with per-node pending results.
    const executionRow = store('citadel-executions-test').get(
      execution.executionId,
    );
    expect(executionRow).toBeDefined();
    expect(executionRow.nodeResults['node-a']).toMatchObject({
      nodeId: 'node-a',
      agentId: 'demo-echo-agent',
      status: 'pending',
    });
    expect(executionRow.nodeResults['node-b']).toMatchObject({
      nodeId: 'node-b',
      agentId: 'demo-echo-agent',
      status: 'pending',
    });

    // execution.start.requested emitted with the right ids.
    const startEvents = eventsOfType('execution.start.requested');
    expect(startEvents).toHaveLength(1);
    expect(startEvents[0].Source).toBe('citadel.workflows');
    const detail = JSON.parse(startEvents[0].Detail!);
    expect(detail.executionId).toBe(execution.executionId);
    expect(detail.workflowId).toBe(imported.workflowId);
  });

  test('negative: publishing when the mapped agent row is absent throws and the workflow stays DRAFT', async () => {
    // Same create + import seam, but the agent the mapping points at does
    // not exist in the agents table.
    store('citadel-agents-test').delete('demo-echo-agent');
    const { workflow } = await createAppAndImport();

    await expect(
      invokeWorkflowHandler(
        makeEvent('publishWorkflow', { workflowId: workflow.workflowId }),
      ),
    ).rejects.toThrow(/agents that do not exist.*demo-echo-agent/);

    expect(
      store('citadel-workflows-test').get(workflow.workflowId).status,
    ).toBe('DRAFT');
  });
});
