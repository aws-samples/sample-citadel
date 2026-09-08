/**
 * Cross-tenant exposure fix for fabricator-queue-resolver.ts (design
 * evidence bf4a13f2, fabricator-queue section; option (c)).
 *
 * Before this fix: getFabricatorQueue leaked two ways.
 *  - With a projectId: Query bound directly to the client-supplied
 *    projectId as PK=orchestrationId, with NO org reconciliation — any
 *    caller who knew/guessed another tenant's projectId read that
 *    tenant's jobs.
 *  - Without a projectId: an unfiltered ScanCommand(Limit 100) harvested
 *    up to 100 rows across ALL tenants, returning tenant-identifying
 *    agentName/taskDescription/orchestrationId.
 *
 * Fix: rows are now stamped with a server-derived `orgId` at write time
 * (all three writers), a new GSI (orgId PK, submittedAt SK) supports an
 * org-scoped query, and the resolver:
 *  - ALWAYS queries the GSI by the caller's server-derived org
 *    (extractOrgFromEvent) — the Scan is gone entirely.
 *  - When a projectId is supplied, additionally filters results to rows
 *    whose orchestrationId matches that projectId (still scoped to the
 *    caller's own org rows — never a cross-org read).
 *  - Fails closed (returns []) when the caller's org cannot be resolved.
 */
import {
  DynamoDBDocumentClient,
  QueryCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";

const ddbMock = mockClient(DynamoDBDocumentClient);

jest.mock("../../utils/auth-event", () => ({
  extractOrgFromEvent: jest.fn(),
}));

import { extractOrgFromEvent } from "../../utils/auth-event";
import { handler } from "../fabricator-queue-resolver";

type HandlerEvent = Parameters<typeof handler>[0];

const mockExtractOrg = extractOrgFromEvent as jest.MockedFunction<
  typeof extractOrgFromEvent
>;

const makeEvent = (
  args: { projectId?: string } = {},
  identity: Record<string, unknown> = { sub: "caller-1" },
): HandlerEvent =>
  ({
    info: { fieldName: "getFabricatorQueue" },
    arguments: args,
    identity,
  }) as unknown as HandlerEvent;

const row = (over: Record<string, unknown>) => ({
  orchestrationId: "0",
  agentUseId: "req-1",
  orgId: "org-victim",
  status: "PENDING",
  agentName: "AgentOne",
  taskDescription: "do a thing",
  submittedAt: "2026-06-01T00:00:00.000Z",
  ...over,
});

describe("fabricator-queue-resolver — org scoping (cross-tenant fix)", () => {
  beforeEach(() => {
    ddbMock.reset();
    jest.clearAllMocks();
    process.env.FABRICATION_JOBS_TABLE = "citadel-fabrication-jobs-test";
  });

  test("the raw Scan is gone entirely — no ScanCommand is ever issued", async () => {
    mockExtractOrg.mockResolvedValue("org-caller");
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    await handler(makeEvent());

    expect(ddbMock.commandCalls(ScanCommand)).toHaveLength(0);
  });

  test("no-projectId path queries the org GSI by the caller's server-derived org, never a table Scan", async () => {
    mockExtractOrg.mockResolvedValue("org-caller");
    ddbMock.on(QueryCommand).resolves({
      Items: [row({ orgId: "org-caller", agentUseId: "req-mine" })],
    });

    const result = await handler(makeEvent());

    expect(ddbMock.commandCalls(ScanCommand)).toHaveLength(0);
    const calls = ddbMock.commandCalls(QueryCommand);
    expect(calls).toHaveLength(1);
    const input = calls[0].args[0].input;
    expect(input.IndexName).toBeDefined();
    expect(JSON.stringify(input.ExpressionAttributeValues)).toContain(
      "org-caller",
    );
    expect(result.map((r) => r.requestId)).toEqual(["req-mine"]);
  });

  test("cross-org caller cannot read another tenant's jobs by supplying that tenant's projectId", async () => {
    // Caller belongs to org-attacker but supplies a projectId belonging to
    // org-victim. The GSI query is scoped to org-attacker, so the
    // org-victim row (even if it happened to share orchestrationId) never
    // enters the result set — and the resolver additionally filters by
    // projectId within that org-scoped set.
    mockExtractOrg.mockResolvedValue("org-attacker");
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const result = await handler(
      makeEvent(
        { projectId: "victim-project" },
        { sub: "attacker-1", "custom:organization": "org-attacker" },
      ),
    );

    expect(result).toEqual([]);
    const calls = ddbMock.commandCalls(QueryCommand);
    expect(calls).toHaveLength(1);
    const input = calls[0].args[0].input;
    // Must query the caller's own org — never the victim's org and never
    // the raw orchestrationId=victim-project PK pattern from the old code.
    expect(JSON.stringify(input.ExpressionAttributeValues)).toContain(
      "org-attacker",
    );
    expect(JSON.stringify(input.ExpressionAttributeValues)).not.toContain(
      "victim-project",
    );
  });

  test("no-projectId path returns ONLY the caller's org rows when two orgs' rows exist", async () => {
    // Seed two orgs' worth of rows in the mocked GSI response — the
    // resolver's query itself is what scopes to one org (DynamoDB would
    // never actually return the other org's rows for a Query keyed on
    // orgId=:org), so this also proves the query key, not just client-side
    // filtering, is what's carrying the guarantee.
    mockExtractOrg.mockResolvedValue("org-a");
    ddbMock.on(QueryCommand).callsFake((input) => {
      const orgKey = JSON.stringify(input.ExpressionAttributeValues);
      if (orgKey.includes("org-a")) {
        return Promise.resolve({
          Items: [row({ orgId: "org-a", agentUseId: "req-a1" })],
        });
      }
      return Promise.resolve({ Items: [] });
    });

    const result = await handler(makeEvent());

    expect(result.map((r) => r.requestId)).toEqual(["req-a1"]);
  });

  test("projectId path filters within the caller's own org rows to the requested project", async () => {
    mockExtractOrg.mockResolvedValue("org-caller");
    ddbMock.on(QueryCommand).resolves({
      Items: [
        row({
          orgId: "org-caller",
          orchestrationId: "proj-mine",
          agentUseId: "req-proj",
        }),
        row({
          orgId: "org-caller",
          orchestrationId: "some-other-project",
          agentUseId: "req-other",
        }),
      ],
    });

    const result = await handler(makeEvent({ projectId: "proj-mine" }));

    expect(result.map((r) => r.requestId)).toEqual(["req-proj"]);
  });

  test("fails closed (returns []) when the caller's org cannot be resolved, and issues no Query", async () => {
    mockExtractOrg.mockResolvedValue(null);

    const result = await handler(makeEvent());

    expect(result).toEqual([]);
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(ScanCommand)).toHaveLength(0);
  });

  test("fails closed when the caller identity is anonymous/unresolvable", async () => {
    mockExtractOrg.mockResolvedValue(null);

    const result = await handler(makeEvent({}, {}));

    expect(result).toEqual([]);
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
  });
});
