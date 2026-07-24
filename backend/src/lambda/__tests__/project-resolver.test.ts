/**
 * Tests for project-resolver Lambda — GovernanceArchetype coverage.
 *
 * Scope of this test file:
 *  - createProject writes archetypeStatus='PENDING', archetype absent, archetypeConfidence absent.
 *  - updateProject persists {archetype, archetypeConfidence, archetypeStatus} passthrough.
 *  - getProject normalises a missing archetypeStatus in the DDB item to 'PENDING'
 *    (grandfathering pre-existing projects — DynamoDB is schemaless so rows
 *    written before this story do not carry the attribute).
 *  - fast-check property tests confirm the TS enums are frozen at their declared values.
 */
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  QueryCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  EventBridgeClient,
  PutEventsCommand,
} from "@aws-sdk/client-eventbridge";
import {
  CognitoIdentityProviderClient,
  AdminGetUserCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import { mockClient } from "aws-sdk-client-mock";
import * as fc from "fast-check";

import {
  GovernanceArchetype,
  ProjectArchetypeStatus,
  type Project,
} from "../../types";
// Namespace imports so jest.spyOn can patch the sibling resolver modules the
// phase-transition gates call at runtime (same module-registry objects the
// previous require() calls returned).
import * as adrResolver from "../adr-resolver";
import * as execspecResolver from "../execspec-resolver";
import * as assessmentResolver from "../agent-design-assessment-resolver";
import { __resetGovernanceNotifierForTest } from "../../utils/notifier-base";
import { __resetGovernanceFlagCacheForTest } from "../../utils/governance-flag";

const dynamoMock = mockClient(DynamoDBDocumentClient);
const eventBridgeMock = mockClient(EventBridgeClient);
const cognitoMock = mockClient(CognitoIdentityProviderClient);
const ssmMock = mockClient(SSMClient);

jest.mock("../../utils/appsync", () => ({
  getUserId: jest.fn().mockReturnValue("user-123"),
}));

jest.mock("uuid", () => ({ v4: jest.fn().mockReturnValue("project-uuid-1") }));

// Import after mocks are registered
import { handler } from "../project-resolver";

type HandlerEvent = Parameters<typeof handler>[0];

// aws-lambda's Handler type declares legacy required context and callback
// parameters, but the implementation is a one-parameter async (event)
// function that never uses them — invoke through the real signature
// (single cast here) so calls don't pass superfluous arguments. Every
// operation exercised in this file resolves a Project.
const invokeHandler = handler as (event: HandlerEvent) => Promise<Project>;

const makeEvent = (fieldName: string, args: Record<string, unknown>) =>
  ({
    info: { fieldName },
    arguments: args,
    identity: { sub: "user-123" },
  }) as unknown as HandlerEvent;

describe("project-resolver — archetype attributes", () => {
  beforeEach(() => {
    dynamoMock.reset();
    eventBridgeMock.reset();
    cognitoMock.reset();
    process.env.PROJECTS_TABLE = "test-projects";
    process.env.EVENT_BUS_NAME = "test-bus";
    process.env.USER_POOL_ID = "test-pool";

    // Default: no organization on the user — getProject's org-based access
    // path simply falls back to owner-based checks, which is all we need here.
    cognitoMock.on(AdminGetUserCommand).resolves({ UserAttributes: [] });
    eventBridgeMock.on(PutEventsCommand).resolves({});
  });

  afterEach(() => {
    delete process.env.PROJECTS_TABLE;
    delete process.env.EVENT_BUS_NAME;
    delete process.env.USER_POOL_ID;
  });

  describe("createProject", () => {
    test("new project is created with archetypeStatus=PENDING and no archetype/confidence", async () => {
      dynamoMock.on(PutCommand).resolves({});

      const result = await invokeHandler(
        makeEvent("createProject", {
          input: { name: "Legacy DB migration", description: "Mono schema" },
        }),
      );

      // Response shape
      expect(result.archetypeStatus).toBe("PENDING");
      expect(result.archetype ?? null).toBeNull();
      expect(result.archetypeConfidence ?? null).toBeNull();

      // Persisted shape — inspect the PutCommand payload
      const putCalls = dynamoMock.commandCalls(PutCommand);
      expect(putCalls).toHaveLength(1);
      const persisted = putCalls[0].args[0].input.Item as Record<
        string,
        unknown
      >;
      expect(persisted.archetypeStatus).toBe("PENDING");
      expect(persisted.archetype).toBeUndefined();
      expect(persisted.archetypeConfidence).toBeUndefined();
    });
  });

  describe("updateProject", () => {
    test("persists archetype, archetypeConfidence and archetypeStatus passthrough", async () => {
      const existing = {
        id: "proj-1",
        name: "Existing",
        status: "CREATED",
        owner: "user-123",
        version: 0,
        createdAt: "2025-01-01T00:00:00Z",
        updatedAt: "2025-01-01T00:00:00Z",
      };

      // getProject inside updateProject
      dynamoMock.on(GetCommand).resolves({ Item: existing });
      // UpdateCommand returns the merged item
      dynamoMock.on(UpdateCommand).resolves({
        Attributes: {
          ...existing,
          archetype: "MONOLITHIC_DB",
          archetypeConfidence: 0.85,
          archetypeStatus: "CLASSIFIED",
          version: 1,
        },
      });

      const result = await invokeHandler(
        makeEvent("updateProject", {
          id: "proj-1",
          input: {
            archetype: "MONOLITHIC_DB",
            archetypeConfidence: 0.85,
            archetypeStatus: "CLASSIFIED",
          },
        }),
      );

      expect(result.archetype).toBe("MONOLITHIC_DB");
      expect(result.archetypeConfidence).toBeCloseTo(0.85);
      expect(result.archetypeStatus).toBe("CLASSIFIED");

      // Confirm the UpdateCommand's expression carried the new attrs through
      const updateCalls = dynamoMock.commandCalls(UpdateCommand);
      expect(updateCalls).toHaveLength(1);
      const updateInput = updateCalls[0].args[0].input;
      const values = updateInput.ExpressionAttributeValues as Record<
        string,
        unknown
      >;
      expect(values[":archetype"]).toBe("MONOLITHIC_DB");
      expect(values[":archetypeConfidence"]).toBeCloseTo(0.85);
      expect(values[":archetypeStatus"]).toBe("CLASSIFIED");
    });
  });

  describe("getProject", () => {
    test("grandfathers legacy rows: missing archetypeStatus normalises to PENDING", async () => {
      // Simulate a pre-existing DDB item.
      dynamoMock.on(GetCommand).resolves({
        Item: {
          id: "legacy-1",
          name: "Legacy",
          status: "CREATED",
          owner: "user-123",
          createdAt: "2024-12-01T00:00:00Z",
          updatedAt: "2024-12-01T00:00:00Z",
        },
      });

      const result = await invokeHandler(
        makeEvent("getProject", { id: "legacy-1" }),
      );

      expect(result.archetypeStatus).toBe("PENDING");
      expect(result.archetype ?? null).toBeNull();
      expect(result.archetypeConfidence ?? null).toBeNull();
    });

    test("claim-first path: reads custom:organization from identity and skips Cognito", async () => {
      dynamoMock.on(GetCommand).resolves({
        Item: {
          id: "proj-claim",
          name: "Claim Project",
          status: "CREATED",
          owner: "someone-else",
          organization: "org-claim",
          createdAt: "2025-01-01T00:00:00Z",
          updatedAt: "2025-01-01T00:00:00Z",
          archetypeStatus: "PENDING",
        },
      });

      const claimEvent = {
        info: { fieldName: "getProject" },
        arguments: { id: "proj-claim" },
        identity: { sub: "user-123", "custom:organization": "org-claim" },
      };

      const result = await invokeHandler(claimEvent as unknown as HandlerEvent);

      expect(result.id).toBe("proj-claim");
      expect(cognitoMock.commandCalls(AdminGetUserCommand).length).toBe(0);
    });
  });
});

describe("project-resolver — organization scoping", () => {
  beforeEach(() => {
    dynamoMock.reset();
    eventBridgeMock.reset();
    cognitoMock.reset();
    process.env.PROJECTS_TABLE = "test-projects";
    process.env.EVENT_BUS_NAME = "test-bus";
    process.env.USER_POOL_ID = "test-pool";

    cognitoMock.on(AdminGetUserCommand).resolves({ UserAttributes: [] });
    eventBridgeMock.on(PutEventsCommand).resolves({});
  });

  afterEach(() => {
    delete process.env.PROJECTS_TABLE;
    delete process.env.EVENT_BUS_NAME;
    delete process.env.USER_POOL_ID;
  });

  const makeEventWithIdentity = (
    fieldName: string,
    args: Record<string, unknown>,
    identity: Record<string, unknown>,
  ) =>
    ({
      info: { fieldName },
      arguments: args,
      identity,
    }) as unknown as HandlerEvent;

  test("admin sees all projects across orgs via a full table scan", async () => {
    const crossOrgItems = [
      {
        id: "proj-org-a",
        name: "Org A project",
        status: "CREATED",
        owner: "user-a",
        organization: "org-a",
        createdAt: "2025-01-01T00:00:00Z",
        updatedAt: "2025-01-01T00:00:00Z",
      },
      {
        id: "proj-org-b",
        name: "Org B project",
        status: "CREATED",
        owner: "user-b",
        organization: "org-b",
        createdAt: "2025-01-02T00:00:00Z",
        updatedAt: "2025-01-02T00:00:00Z",
      },
    ];
    dynamoMock.on(ScanCommand).resolves({ Items: crossOrgItems });

    const result = (await invokeHandler(
      makeEventWithIdentity(
        "listProjects",
        {},
        { sub: "admin-1", "custom:role": "admin" },
      ),
    )) as unknown as { items: Array<{ id: string; archetypeStatus: string }> };

    // Admin path must scan, never query the OrganizationIndex.
    expect(dynamoMock.commandCalls(ScanCommand)).toHaveLength(1);
    expect(dynamoMock.commandCalls(QueryCommand)).toHaveLength(0);

    const ids = result.items.map((p) => p.id).sort();
    expect(ids).toEqual(["proj-org-a", "proj-org-b"]);
    // normaliseArchetype still applied on the admin path.
    expect(result.items.every((p) => p.archetypeStatus === "PENDING")).toBe(
      true,
    );
  });

  test("user with no org claim gets Default org projects via OrganizationIndex", async () => {
    const defaultOrgItems = [
      {
        id: "proj-default-1",
        name: "Default org project",
        status: "CREATED",
        owner: "user-123",
        organization: "Default",
        createdAt: "2025-01-01T00:00:00Z",
        updatedAt: "2025-01-01T00:00:00Z",
      },
    ];
    dynamoMock.on(QueryCommand).resolves({ Items: defaultOrgItems });

    const result = (await invokeHandler(
      makeEventWithIdentity("listProjects", {}, { sub: "user-123" }),
    )) as unknown as { items: Array<{ id: string }> };

    expect(dynamoMock.commandCalls(ScanCommand)).toHaveLength(0);
    const queryCalls = dynamoMock.commandCalls(QueryCommand);
    expect(queryCalls).toHaveLength(1);
    const queryInput = queryCalls[0].args[0].input;
    expect(queryInput.IndexName).toBe("OrganizationIndex");
    expect(
      (queryInput.ExpressionAttributeValues as Record<string, unknown>)[":org"],
    ).toBe("Default");

    expect(result.items.map((p) => p.id)).toEqual(["proj-default-1"]);
  });

  test("createProject always stamps organization (never undefined) when org claim is missing", async () => {
    dynamoMock.on(PutCommand).resolves({});

    const result = (await invokeHandler(
      makeEventWithIdentity(
        "createProject",
        { input: { name: "No-org project" } },
        { sub: "user-123" },
      ),
    )) as unknown as { organization?: string };

    expect(result.organization).toBe("Default");

    const putCalls = dynamoMock.commandCalls(PutCommand);
    expect(putCalls).toHaveLength(1);
    const persisted = putCalls[0].args[0].input.Item as Record<string, unknown>;
    expect(persisted.organization).toBe("Default");
    expect(persisted.organization).not.toBeUndefined();
  });

  test("createProject stamps the claim organization when present (never undefined)", async () => {
    dynamoMock.on(PutCommand).resolves({});

    const result = (await invokeHandler(
      makeEventWithIdentity(
        "createProject",
        { input: { name: "Org-claim project" } },
        { sub: "user-123", "custom:organization": "org-claim" },
      ),
    )) as unknown as { organization?: string };

    expect(result.organization).toBe("org-claim");

    const putCalls = dynamoMock.commandCalls(PutCommand);
    const persisted = putCalls[0].args[0].input.Item as Record<string, unknown>;
    expect(persisted.organization).toBe("org-claim");
  });

  test("admin can getProject on a project owned by, and scoped to, a different org", async () => {
    dynamoMock.on(GetCommand).resolves({
      Item: {
        id: "proj-org-b",
        name: "Org B project",
        status: "CREATED",
        owner: "user-b",
        organization: "org-b",
        createdAt: "2025-01-02T00:00:00Z",
        updatedAt: "2025-01-02T00:00:00Z",
      },
    });

    const result = (await invokeHandler(
      makeEventWithIdentity(
        "getProject",
        { id: "proj-org-b" },
        { sub: "admin-1", "custom:role": "admin" },
      ),
    )) as unknown as { id: string };

    expect(result.id).toBe("proj-org-b");
  });

  test("non-admin still denied access to a project outside their org", async () => {
    dynamoMock.on(GetCommand).resolves({
      Item: {
        id: "proj-org-b",
        name: "Org B project",
        status: "CREATED",
        owner: "user-b",
        organization: "org-b",
        createdAt: "2025-01-02T00:00:00Z",
        updatedAt: "2025-01-02T00:00:00Z",
      },
    });

    await expect(
      invokeHandler(
        makeEventWithIdentity(
          "getProject",
          { id: "proj-org-b" },
          { sub: "user-123", "custom:organization": "org-a" },
        ),
      ),
    ).rejects.toThrow(/Access denied/);
  });

  test("admin listProjects passes nextToken through as ExclusiveStartKey and returns LastEvaluatedKey", async () => {
    const priorKey = { id: "proj-page-boundary" };
    dynamoMock.on(ScanCommand).resolves({
      Items: [
        {
          id: "proj-org-a",
          name: "Org A project",
          status: "CREATED",
          owner: "user-a",
          organization: "org-a",
          createdAt: "2025-01-01T00:00:00Z",
          updatedAt: "2025-01-01T00:00:00Z",
        },
      ],
      LastEvaluatedKey: { id: "proj-next-page" },
    });

    const result = (await invokeHandler(
      makeEventWithIdentity(
        "listProjects",
        { nextToken: JSON.stringify(priorKey) },
        { sub: "admin-1", "custom:role": "admin" },
      ),
    )) as unknown as { items: Array<{ id: string }>; nextToken?: string };

    const scanCalls = dynamoMock.commandCalls(ScanCommand);
    expect(scanCalls).toHaveLength(1);
    expect(scanCalls[0].args[0].input.ExclusiveStartKey).toEqual(priorKey);

    expect(result.nextToken).toBe(JSON.stringify({ id: "proj-next-page" }));
  });

  test("non-admin listProjects passes nextToken through as ExclusiveStartKey on the OrganizationIndex query and returns LastEvaluatedKey", async () => {
    const priorKey = { organization: "Default", id: "proj-page-boundary" };
    dynamoMock.on(QueryCommand).resolves({
      Items: [
        {
          id: "proj-default-2",
          name: "Default org project 2",
          status: "CREATED",
          owner: "user-123",
          organization: "Default",
          createdAt: "2025-01-03T00:00:00Z",
          updatedAt: "2025-01-03T00:00:00Z",
        },
      ],
      LastEvaluatedKey: { organization: "Default", id: "proj-next-page" },
    });

    const result = (await invokeHandler(
      makeEventWithIdentity(
        "listProjects",
        { nextToken: JSON.stringify(priorKey) },
        { sub: "user-123" },
      ),
    )) as unknown as { items: Array<{ id: string }>; nextToken?: string };

    const queryCalls = dynamoMock.commandCalls(QueryCommand);
    expect(queryCalls).toHaveLength(1);
    expect(queryCalls[0].args[0].input.ExclusiveStartKey).toEqual(priorKey);

    expect(result.nextToken).toBe(
      JSON.stringify({ organization: "Default", id: "proj-next-page" }),
    );
    expect(result.items.map((p) => p.id)).toEqual(["proj-default-2"]);
  });
});

describe("GovernanceArchetype enum — property tests", () => {
  const ALLOWED = ["MONOLITHIC_DB", "ENTERPRISE_APP_SPRAWL", "HYBRID_IT_OT"];
  const enumValues = Object.values(GovernanceArchetype) as string[];

  test("enum contains exactly the three allowed values", () => {
    expect(enumValues.sort()).toEqual([...ALLOWED].sort());
  });

  test("any random string not in the allowlist is rejected by the enum", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        fc.pre(!ALLOWED.includes(s));
        return !enumValues.includes(s);
      }),
      { numRuns: 100 },
    );
  });
});

describe("ProjectArchetypeStatus enum — property tests", () => {
  const ALLOWED = ["PENDING", "CLASSIFIED", "PENDING_ESCALATION"];
  const enumValues = Object.values(ProjectArchetypeStatus) as string[];

  test("enum contains exactly the three allowed values", () => {
    expect(enumValues.sort()).toEqual([...ALLOWED].sort());
  });

  test("any random string not in the allowlist is rejected by the enum", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        fc.pre(!ALLOWED.includes(s));
        return !enumValues.includes(s);
      }),
      { numRuns: 100 },
    );
  });
});

describe("phase-transition gates", () => {
  // Gate effective_at cutoff used by SSM mock. Any project with
  // createdAt < EFFECTIVE_AT is grandfathered; >= is non-grandfathered.
  const EFFECTIVE_AT = "2026-01-01T00:00:00Z";
  const NON_GF_CREATED_AT = "2026-06-01T00:00:00Z"; // after cutoff → gated
  const GF_CREATED_AT = "2025-06-01T00:00:00Z"; // before cutoff → bypass

  let adrSpy: jest.SpyInstance;
  let specSpy: jest.SpyInstance;
  let assessmentSpy: jest.SpyInstance;

  const makeExistingProject = (overrides: Record<string, unknown> = {}) => ({
    id: "proj-gate-1",
    name: "Gate Test",
    description: "fixture",
    status: "CREATED",
    owner: "user-123",
    version: 0,
    createdAt: NON_GF_CREATED_AT,
    updatedAt: NON_GF_CREATED_AT,
    archetypeStatus: "PENDING",
    ...overrides,
  });

  beforeEach(() => {
    dynamoMock.reset();
    eventBridgeMock.reset();
    cognitoMock.reset();
    ssmMock.reset();
    __resetGovernanceNotifierForTest();
    __resetGovernanceFlagCacheForTest();

    process.env.PROJECTS_TABLE = "test-projects";
    process.env.EVENT_BUS_NAME = "test-bus";
    process.env.USER_POOL_ID = "test-pool";
    process.env.ENVIRONMENT = "dev";

    cognitoMock.on(AdminGetUserCommand).resolves({ UserAttributes: [] });
    eventBridgeMock.on(PutEventsCommand).resolves({});

    // SSM returns shadow + a populated effective_at so isGrandfathered()
    // compares project.createdAt against EFFECTIVE_AT (not the null bypass).
    ssmMock
      .on(GetParameterCommand, { Name: "/citadel/governance/enforce/dev" })
      .resolves({ Parameter: { Value: "shadow" } });
    ssmMock
      .on(GetParameterCommand, { Name: "/citadel/governance/effective_at/dev" })
      .resolves({ Parameter: { Value: EFFECTIVE_AT } });

    // Spy on sibling resolver modules (C7/C10/C3 data sources). Each test
    // overrides the return value as needed. Default: empty arrays / null.
    adrSpy = jest
      .spyOn(adrResolver, "listADRsForProject")
      .mockResolvedValue([]);
    specSpy = jest
      .spyOn(execspecResolver, "listExecutionSpecifications")
      .mockResolvedValue([]);
    assessmentSpy = jest
      .spyOn(assessmentResolver, "getAgentDesignAssessment")
      .mockResolvedValue(null);
  });

  afterEach(() => {
    adrSpy.mockRestore();
    specSpy.mockRestore();
    assessmentSpy.mockRestore();
    delete process.env.PROJECTS_TABLE;
    delete process.env.EVENT_BUS_NAME;
    delete process.env.USER_POOL_ID;
    delete process.env.ENVIRONMENT;
  });

  /** Count bypass events in the EventBridge mock's call log. */
  const bypassEvents = () => {
    const out: Array<Record<string, unknown>> = [];
    for (const call of eventBridgeMock.commandCalls(PutEventsCommand)) {
      const entries = call.args[0].input.Entries ?? [];
      for (const e of entries) {
        if (e.DetailType === "governance.grandfathered.bypass") {
          out.push(JSON.parse(e.Detail as string));
        }
      }
    }
    return out;
  };

  // ---- C7_adr_required -----------------------------------------------------

  test("C7: non-grandfathered project with zero LOCKED ADRs rejects DESIGN_COMPLETE → PLANNING_COMPLETE", async () => {
    const existing = makeExistingProject({ status: "DESIGN_COMPLETE" });
    dynamoMock.on(GetCommand).resolves({ Item: existing });
    adrSpy.mockResolvedValue([{ status: "PROPOSED" }, { status: "REOPENED" }]);

    await expect(
      invokeHandler(
        makeEvent("updateProject", {
          id: existing.id,
          input: { status: "PLANNING_COMPLETE" },
        }),
      ),
    ).rejects.toThrow(/PLANNING_COMPLETE requires at least one LOCKED ADR/);

    // No DDB Update should have been issued.
    expect(dynamoMock.commandCalls(UpdateCommand)).toHaveLength(0);
    // No bypass event either.
    expect(bypassEvents()).toHaveLength(0);
  });

  test("C7: non-grandfathered project with one LOCKED ADR resolves and issues Update", async () => {
    const existing = makeExistingProject({ status: "DESIGN_COMPLETE" });
    dynamoMock.on(GetCommand).resolves({ Item: existing });
    adrSpy.mockResolvedValue([{ status: "LOCKED" }]);
    dynamoMock.on(UpdateCommand).resolves({
      Attributes: { ...existing, status: "PLANNING_COMPLETE", version: 1 },
    });

    const result = await invokeHandler(
      makeEvent("updateProject", {
        id: existing.id,
        input: { status: "PLANNING_COMPLETE" },
      }),
    );

    expect(result.status).toBe("PLANNING_COMPLETE");
    expect(dynamoMock.commandCalls(UpdateCommand)).toHaveLength(1);
    expect(bypassEvents()).toHaveLength(0);
  });

  test("C7: grandfathered project with zero LOCKED ADRs resolves, fires Update, emits exactly one bypass event", async () => {
    const existing = makeExistingProject({
      status: "DESIGN_COMPLETE",
      createdAt: GF_CREATED_AT, // pre-cutoff → grandfathered
    });
    dynamoMock.on(GetCommand).resolves({ Item: existing });
    adrSpy.mockResolvedValue([]); // zero LOCKED ADRs
    dynamoMock.on(UpdateCommand).resolves({
      Attributes: { ...existing, status: "PLANNING_COMPLETE", version: 1 },
    });

    const result = await invokeHandler(
      makeEvent("updateProject", {
        id: existing.id,
        input: { status: "PLANNING_COMPLETE" },
      }),
    );

    expect(result.status).toBe("PLANNING_COMPLETE");
    expect(dynamoMock.commandCalls(UpdateCommand)).toHaveLength(1);

    const bypasses = bypassEvents();
    expect(bypasses).toHaveLength(1);
    expect(bypasses[0].bypassedGate).toBe("C7_adr_required");
    expect(bypasses[0].projectId).toBe(existing.id);
    expect(bypasses[0].projectCreatedAt).toBe(GF_CREATED_AT);
    expect(bypasses[0].effectiveAt).toBe(EFFECTIVE_AT);
  });

  // ---- C3_assessment_required ---------------------------------------------

  test("C3: non-grandfathered project with no AgentDesignAssessment rejects CREATED → IN_PROGRESS", async () => {
    const existing = makeExistingProject({ status: "CREATED" });
    dynamoMock.on(GetCommand).resolves({ Item: existing });
    assessmentSpy.mockResolvedValue(null);

    await expect(
      invokeHandler(
        makeEvent("updateProject", {
          id: existing.id,
          input: { status: "IN_PROGRESS" },
        }),
      ),
    ).rejects.toThrow(/IN_PROGRESS requires a completed AgentDesignAssessment/);

    expect(dynamoMock.commandCalls(UpdateCommand)).toHaveLength(0);
    expect(bypassEvents()).toHaveLength(0);
  });

  test("C3: grandfathered project with no assessment resolves and emits bypass event", async () => {
    const existing = makeExistingProject({
      status: "CREATED",
      createdAt: GF_CREATED_AT,
    });
    dynamoMock.on(GetCommand).resolves({ Item: existing });
    assessmentSpy.mockResolvedValue(null);
    dynamoMock.on(UpdateCommand).resolves({
      Attributes: { ...existing, status: "IN_PROGRESS", version: 1 },
    });

    const result = await invokeHandler(
      makeEvent("updateProject", {
        id: existing.id,
        input: { status: "IN_PROGRESS" },
      }),
    );

    expect(result.status).toBe("IN_PROGRESS");
    expect(dynamoMock.commandCalls(UpdateCommand)).toHaveLength(1);

    const bypasses = bypassEvents();
    expect(bypasses).toHaveLength(1);
    expect(bypasses[0].bypassedGate).toBe("C3_assessment_required");
  });

  // ---- C10_spec_required --------------------------------------------------

  test("C10: non-grandfathered project with no APPROVED ExecSpec rejects PLANNING_COMPLETE → IMPLEMENTATION_READY", async () => {
    const existing = makeExistingProject({ status: "PLANNING_COMPLETE" });
    dynamoMock.on(GetCommand).resolves({ Item: existing });
    specSpy.mockResolvedValue([{ status: "DRAFT" }, { status: "IN_REVIEW" }]);

    await expect(
      invokeHandler(
        makeEvent("updateProject", {
          id: existing.id,
          input: { status: "IMPLEMENTATION_READY" },
        }),
      ),
    ).rejects.toThrow(
      /IMPLEMENTATION_READY requires at least one APPROVED ExecutionSpecification/,
    );

    expect(dynamoMock.commandCalls(UpdateCommand)).toHaveLength(0);
    expect(bypassEvents()).toHaveLength(0);
  });

  test("C10: grandfathered project with no APPROVED ExecSpec resolves and emits bypass event", async () => {
    const existing = makeExistingProject({
      status: "PLANNING_COMPLETE",
      createdAt: GF_CREATED_AT,
    });
    dynamoMock.on(GetCommand).resolves({ Item: existing });
    specSpy.mockResolvedValue([]);
    dynamoMock.on(UpdateCommand).resolves({
      Attributes: { ...existing, status: "IMPLEMENTATION_READY", version: 1 },
    });

    const result = await invokeHandler(
      makeEvent("updateProject", {
        id: existing.id,
        input: { status: "IMPLEMENTATION_READY" },
      }),
    );

    expect(result.status).toBe("IMPLEMENTATION_READY");
    expect(dynamoMock.commandCalls(UpdateCommand)).toHaveLength(1);

    const bypasses = bypassEvents();
    expect(bypasses).toHaveLength(1);
    expect(bypasses[0].bypassedGate).toBe("C10_spec_required");
  });

  // ---- Non-gated transitions pass through ---------------------------------

  test("non-gated transition ASSESSMENT_COMPLETE → DESIGN_COMPLETE resolves with no bypass event", async () => {
    const existing = makeExistingProject({ status: "ASSESSMENT_COMPLETE" });
    dynamoMock.on(GetCommand).resolves({ Item: existing });
    dynamoMock.on(UpdateCommand).resolves({
      Attributes: { ...existing, status: "DESIGN_COMPLETE", version: 1 },
    });

    const result = await invokeHandler(
      makeEvent("updateProject", {
        id: existing.id,
        input: { status: "DESIGN_COMPLETE" },
      }),
    );

    expect(result.status).toBe("DESIGN_COMPLETE");
    expect(dynamoMock.commandCalls(UpdateCommand)).toHaveLength(1);
    expect(bypassEvents()).toHaveLength(0);

    // None of the gate data sources should have been consulted for a
    // non-gated transition.
    expect(adrSpy).not.toHaveBeenCalled();
    expect(specSpy).not.toHaveBeenCalled();
    expect(assessmentSpy).not.toHaveBeenCalled();
  });
});
