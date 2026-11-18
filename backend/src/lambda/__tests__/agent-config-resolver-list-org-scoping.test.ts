/**
 * Tests for listAgentConfigsRegistry org scoping — PR-3 update: the explicit
 * `ALL_ORGS` ("All Organizations") sentinel is system-shared; a blank or
 * absent orgId is fail-closed and NEVER a cross-tenant wildcard.
 *
 * Seeded system agents (e.g. demo-echo-agent) carry orgId=ALL_ORGS and must
 * be visible to every org-scoped (non-admin) caller alongside that caller's
 * own-org agents, on BOTH the Registry filter path and the legacy-DynamoDB
 * merge path. A legacy row with NO orgId (unstamped) must NOT be visible to
 * a foreign-org caller — that is the Continuum CRITICAL finding this test
 * file now pins closed. Admin behavior (sees all), the non-admin-without-
 * orgId empty-list behavior, cross-org isolation, and dedupe-by-name are
 * locked down as regression guards.
 */
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";

const dynamoMock = mockClient(DynamoDBDocumentClient);

const ALL_ORGS = "All Organizations";

// ---------------------------------------------------------------------------
// Mock RegistryService — only the members used by listAgentConfigsRegistry.
// mapToAgentConfig mirrors the REAL mapping's PR-3 org handling: orgId comes
// from the deserialized customDescriptorContent, left undefined (with
// orgUnknown:true) when absent — never collapsed to "".
// ---------------------------------------------------------------------------

interface TestRegistryRecord {
  recordId: string;
  name: string;
  status: string;
  description: string;
  customDescriptorContent: string;
}

const mockListResources = jest.fn();
const mockMapToAgentConfig = jest.fn((record: TestRegistryRecord) => {
  const meta = JSON.parse(record.customDescriptorContent) as {
    orgId?: string;
  };
  return {
    agentId: record.recordId,
    name: record.name,
    orgId: meta.orgId,
    ...(meta.orgId === undefined ? { orgUnknown: true } : {}),
    config: record.description,
    state: "active",
    categories: [] as string[],
  };
});

jest.mock("../../services/registry-service", () => ({
  RegistryService: jest.fn().mockImplementation(() => ({
    listResources: mockListResources,
    mapToAgentConfig: mockMapToAgentConfig,
  })),
  RegistryRecordStatusValues: {
    DRAFT: "DRAFT",
    PENDING_APPROVAL: "PENDING_APPROVAL",
    APPROVED: "APPROVED",
    REJECTED: "REJECTED",
    DEPRECATED: "DEPRECATED",
    CREATING: "CREATING",
    UPDATING: "UPDATING",
    CREATE_FAILED: "CREATE_FAILED",
    UPDATE_FAILED: "UPDATE_FAILED",
  },
}));

import {
  listAgentConfigsRegistry,
  _resetRegistryService,
} from "../agent-config-resolver";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const registryRecord = (
  recordId: string,
  name: string,
  orgId: string,
): TestRegistryRecord => ({
  recordId,
  name,
  status: "APPROVED",
  description: JSON.stringify({ name }),
  customDescriptorContent: JSON.stringify({ orgId, citadelKind: "agent" }),
});

// Registry records: one own-org, one system-shared (orgId=ALL_ORGS), one
// other-org, one UNSTAMPED (blank orgId — must fail closed, not leak).
const REGISTRY_RECORDS: TestRegistryRecord[] = [
  registryRecord("reg-own", "OwnOrgAgent", "org-a"),
  registryRecord("reg-system", "Echo Demo Agent", ALL_ORGS),
  registryRecord("reg-other", "OtherOrgAgent", "org-b"),
  registryRecord("reg-unstamped", "UnstampedAgent", ""),
];

// Legacy DynamoDB items: one own-org, one system-shared (explicit
// orgId=ALL_ORGS), one other-org, one UNSTAMPED (no orgId attribute at all —
// must fail closed for a foreign-org caller, per the Continuum CRITICAL
// finding this test pins closed).
const DYNAMO_ITEMS = [
  {
    agentId: "dyn-own",
    orgId: "org-a",
    config: '{"name":"LegacyOwn"}',
    state: "active",
  },
  {
    agentId: "dyn-system",
    orgId: ALL_ORGS,
    config: '{"name":"LegacyShared"}',
    state: "active",
  },
  {
    agentId: "dyn-other",
    orgId: "org-b",
    config: '{"name":"LegacyOther"}',
    state: "active",
  },
  {
    agentId: "dyn-unstamped",
    config: '{"name":"LegacyUnstamped"}',
    state: "active",
  },
];

const nonAdminEvent = (orgId: string) => ({
  identity: { claims: { "custom:organization": orgId } },
});
const adminEvent = {
  identity: {
    claims: { "custom:role": "admin", "cognito:groups": ["admin"] },
  },
};
const noOrgEvent = { identity: {} };

const agentIdsOf = (configs: Array<{ agentId: string }>): string[] =>
  configs.map((c) => c.agentId).sort();

describe("listAgentConfigsRegistry — orgId scoping with system-shared agents (PR-3)", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      REGISTRY_ENABLED: "true",
      REGISTRY_ID: "test-registry",
      AGENT_CONFIG_TABLE: "test-agents",
    };
    _resetRegistryService();
    jest.clearAllMocks();
    dynamoMock.reset();
    mockListResources.mockResolvedValue(REGISTRY_RECORDS);
    dynamoMock.on(ScanCommand).resolves({ Items: DYNAMO_ITEMS });
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test("(a) non-admin with orgId sees own-org registry agents", async () => {
    const result = await listAgentConfigsRegistry(nonAdminEvent("org-a"));

    expect(agentIdsOf(result)).toContain("reg-own");
  });

  test("(b) non-admin with orgId also sees system-shared (orgId=ALL_ORGS) registry agents", async () => {
    const result = await listAgentConfigsRegistry(nonAdminEvent("org-a"));

    expect(agentIdsOf(result)).toContain("reg-system");
  });

  test("(c) non-admin with orgId never sees other-org agents (registry or legacy)", async () => {
    const result = await listAgentConfigsRegistry(nonAdminEvent("org-a"));

    const ids = agentIdsOf(result);
    expect(ids).not.toContain("reg-other");
    expect(ids).not.toContain("dyn-other");
  });

  test("(c2) PR-3 CRITICAL: non-admin never sees an unstamped (blank/absent orgId) agent — fail closed, not a wildcard", async () => {
    const result = await listAgentConfigsRegistry(nonAdminEvent("org-a"));

    const ids = agentIdsOf(result);
    expect(ids).not.toContain("reg-unstamped");
    expect(ids).not.toContain("dyn-unstamped");
  });

  test("(d) admin sees all agents across all orgs, including system-shared and unstamped (unchanged)", async () => {
    const result = await listAgentConfigsRegistry(adminEvent);

    expect(agentIdsOf(result)).toEqual(
      [
        "reg-own",
        "reg-system",
        "reg-other",
        "reg-unstamped",
        "dyn-own",
        "dyn-system",
        "dyn-other",
        "dyn-unstamped",
      ].sort(),
    );
  });

  test("(e) non-admin without orgId still gets an empty list and no registry fetch", async () => {
    const result = await listAgentConfigsRegistry(noOrgEvent);

    expect(result).toEqual([]);
    expect(mockListResources).not.toHaveBeenCalled();
  });

  test("(f) legacy-Dynamo merge path: non-admin with orgId sees own-org AND system-shared (orgId=ALL_ORGS) legacy agents, never unstamped", async () => {
    const result = await listAgentConfigsRegistry(nonAdminEvent("org-a"));

    const ids = agentIdsOf(result);
    expect(ids).toContain("dyn-own");
    expect(ids).toContain("dyn-system");
    expect(ids).not.toContain("dyn-unstamped");
    // Full expected visibility for org-a: own-org + system-shared from both
    // sources. Unstamped rows from either source are excluded.
    expect(ids).toEqual(
      ["dyn-own", "dyn-system", "reg-own", "reg-system"].sort(),
    );
  });

  test("(g) dedupe-by-name still holds when a system-shared registry agent and a legacy agent share a name", async () => {
    // Legacy duplicate of the system-shared registry agent, sharing the
    // config name 'Echo Demo Agent'. Registry must win; the legacy row
    // must be dropped from the merged result.
    dynamoMock.on(ScanCommand).resolves({
      Items: [
        ...DYNAMO_ITEMS,
        {
          agentId: "dyn-echo-dup",
          orgId: ALL_ORGS,
          config: '{"name":"Echo Demo Agent"}',
          state: "active",
        },
      ],
    });

    const result = await listAgentConfigsRegistry(nonAdminEvent("org-a"));

    const ids = agentIdsOf(result);
    expect(ids).toContain("reg-system");
    expect(ids).not.toContain("dyn-echo-dup");
  });
});
