/**
 * replay-package-builder.test.ts — assembleReplayPackage (CIT-026 design
 * §4/§5). Assembles the versioned envelope from mocked table reads,
 * enforces per-row orgId filtering (cross-org row -> refused), and asserts
 * `toolResults` is honestly modelled as partial/nullable with a provenance
 * note (design's honest gap, CIT-121 not yet built).
 */
import { mockClient } from "aws-sdk-client-mock";
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import * as fs from "fs";
import {
  assembleReplayPackage,
  CrossOrgRowError,
} from "../replay-package-builder";
import { scanForSecrets } from "../../../utils/secret-patterns";

const ddbMock = mockClient(DynamoDBDocumentClient);

beforeEach(() => {
  ddbMock.reset();
  process.env.EXECUTIONS_TABLE = "executions-test";
  process.env.WORKFLOWS_TABLE = "workflows-test";
  process.env.AGENT_CONFIG_TABLE = "agent-config-test";
  process.env.EXECUTION_SPECS_TABLE = "execspec-test";
  process.env.MODEL_CONFIG_TABLE = "model-config-test";
  process.env.GOVERNANCE_LEDGER_TABLE = "governance-ledger-test";
  process.env.COST_LEDGER_TABLE = "cost-ledger-test";
  process.env.CONVERSATIONS_TABLE = "conversations-test";
  process.env.COMMIT_SHA = "abc1234";
});

function baseExecutionItem(orgId: string) {
  return {
    executionId: "exec-1",
    orgId,
    workflowId: "wf-1",
    workflowVersion: 3,
    status: "completed",
    startedAt: "2026-07-01T00:00:00.000Z",
    completedAt: "2026-07-01T00:05:00.000Z",
    nodeResults: {
      "node-1": {
        nodeId: "node-1",
        status: "completed",
        output: "hello",
        startedAt: "2026-07-01T00:00:01.000Z",
        completedAt: "2026-07-01T00:01:00.000Z",
      },
    },
    usageTotals: {
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
      callCount: 1,
    },
  };
}

describe("assembleReplayPackage — envelope shape", () => {
  test("builds a versioned envelope with the expected top-level fields", async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    ddbMock.on(GetCommand, { TableName: "executions-test" }).resolves({
      Item: baseExecutionItem("org-1"),
    });
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const result = await assembleReplayPackage("org-1", "execution", "exec-1");

    expect(result.schemaVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(result.kind).toBe("execution");
    expect(result.correlationId).toBe("exec-1");
    expect(result.orgId).toBe("org-1");
    expect(result.producerCommit).toBe("abc1234");
    expect(result.sanitisation.gate).toBe("passed");
    expect(typeof result.generatedAt).toBe("string");
  });

  test("producerCommit is null (honest) when COMMIT_SHA is unset", async () => {
    delete process.env.COMMIT_SHA;
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    ddbMock.on(GetCommand, { TableName: "executions-test" }).resolves({
      Item: baseExecutionItem("org-1"),
    });
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const result = await assembleReplayPackage("org-1", "execution", "exec-1");
    expect(result.producerCommit).toBeNull();
  });
});

describe("assembleReplayPackage — cross-org refusal", () => {
  test("throws CrossOrgRowError when the execution row's orgId does not match the resolved orgId", async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    ddbMock.on(GetCommand, { TableName: "executions-test" }).resolves({
      Item: baseExecutionItem("org-OTHER"),
    });

    await expect(
      assembleReplayPackage("org-1", "execution", "exec-1"),
    ).rejects.toThrow(CrossOrgRowError);
  });

  test("throws when a governance-ledger finding row belongs to a different org", async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    ddbMock.on(GetCommand, { TableName: "executions-test" }).resolves({
      Item: baseExecutionItem("org-1"),
    });
    ddbMock.on(QueryCommand).resolves({
      Items: [
        {
          findingId: "f-1",
          workflowId: "wf-1",
          orgId: "org-OTHER",
          decision: "PERMIT",
        },
      ],
    });

    await expect(
      assembleReplayPackage("org-1", "execution", "exec-1"),
    ).rejects.toThrow(CrossOrgRowError);
  });
});

describe("assembleReplayPackage — unknown execution", () => {
  test("throws a not-found-shaped error when the execution row does not exist", async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });

    await expect(
      assembleReplayPackage("org-1", "execution", "does-not-exist"),
    ).rejects.toThrow(/not.?found/i);
  });
});

describe("assembleReplayPackage — toolResults honest partial gap (CIT-121)", () => {
  test("sections.toolResults is present, marked partial, and carries a provenance note", async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    ddbMock.on(GetCommand, { TableName: "executions-test" }).resolves({
      Item: baseExecutionItem("org-1"),
    });
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const result = await assembleReplayPackage("org-1", "execution", "exec-1");
    expect(result.sections.toolResults).toBeDefined();
    expect(result.sections.toolResults.partial).toBe(true);
    expect(result.sections.toolResults.provenance).toMatch(/CIT-121/);
    // The provenance note MAY mention logs to document the exclusion (it
    // must say results are never backfilled FROM logs); what matters is
    // that the builder itself has no log-reading code path (asserted in
    // the next test), not that the word "logs" is absent from the prose.
    expect(result.sections.toolResults.provenance).toMatch(/never.*logs/i);
  });

  test("toolResults is never sourced from CloudWatch logs (no log-reading dependency imported)", () => {
    const builderSource = fs.readFileSync(
      require.resolve("../replay-package-builder"),
      "utf-8",
    );
    expect(builderSource).not.toMatch(/cloudwatch-logs|CloudWatchLogsClient/i);
  });
});

describe("assembleReplayPackage — output is gate-clean", () => {
  test("the assembled bundle, once serialized, contains no secret-pattern hits", async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    ddbMock.on(GetCommand, { TableName: "executions-test" }).resolves({
      Item: {
        ...baseExecutionItem("org-1"),
        nodeResults: {
          "node-1": {
            nodeId: "node-1",
            status: "completed",
            output: "leaked token=supersecretvalue123",
          },
        },
      },
    });
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const result = await assembleReplayPackage("org-1", "execution", "exec-1");
    expect(scanForSecrets(JSON.stringify(result))).toEqual([]);
  });
});
// --- conversation-kind assembly (closes the ReplayNotFoundError gap) ---
//
// Feasibility (see docs/REPLAY_PACKAGE.md "Conversation-kind" section):
// conversationId == projectId (resolveConversationOwnership resolves via
// PROJECTS_TABLE Key={id: conversationId}). Messages are queryable by
// projectId (CONVERSATIONS_TABLE partition key). Usage/cost is queryable
// via COST_LEDGER_TABLE's GSI1 (GSI1PK = PROJECT#<projectId>), since
// state.py's publish_usage_event stamps projectId = sessionId. Governance
// findings key on workflowId/orchestrationId — NOT conversationId/projectId
// — so findings are honestly modelled as an explicit partial section with
// provenance, never invented, never joined by guesswork.
function conversationMessageItem(
  projectId: string,
  timestamp: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    projectId,
    timestamp,
    id: `msg-${timestamp}`,
    agentId: "agent-1",
    message: "hello",
    messageType: "USER_INPUT",
    userId: "user-1",
    ...overrides,
  };
}

describe("assembleReplayPackage — conversation kind", () => {
  test("builds a versioned envelope for a conversation id (no longer throws ReplayNotFoundError)", async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    ddbMock.on(QueryCommand).callsFake((input) => {
      if (input.TableName === "conversations-test") {
        return {
          Items: [
            conversationMessageItem("conv-1", "2026-07-01T00:00:00.000Z"),
            conversationMessageItem("conv-1", "2026-07-01T00:01:00.000Z", {
              messageType: "AGENT_RESPONSE",
            }),
          ],
        };
      }
      if (
        input.TableName === "cost-ledger-test" &&
        input.IndexName === "ProjectIndex"
      ) {
        return { Items: [] };
      }
      return { Items: [] };
    });

    const result = await assembleReplayPackage(
      "org-1",
      "conversation",
      "conv-1",
    );

    expect(result.kind).toBe("conversation");
    expect(result.correlationId).toBe("conv-1");
    expect(result.orgId).toBe("org-1");
    expect(result.sanitisation.gate).toBe("passed");
  });

  test("messages section is populated from CONVERSATIONS_TABLE, ordered chronologically", async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    ddbMock.on(QueryCommand).callsFake((input) => {
      if (input.TableName === "conversations-test") {
        return {
          Items: [
            conversationMessageItem("conv-1", "2026-07-01T00:01:00.000Z", {
              messageType: "AGENT_RESPONSE",
              message: "second",
            }),
            conversationMessageItem("conv-1", "2026-07-01T00:00:00.000Z", {
              message: "first",
            }),
          ],
        };
      }
      return { Items: [] };
    });

    const result = await assembleReplayPackage(
      "org-1",
      "conversation",
      "conv-1",
    );

    expect(result.sections.messages).toBeDefined();
    const messages = result.sections.messages as Array<{
      message: string;
      timestamp: string;
    }>;
    expect(messages.map((m) => m.message)).toEqual(["first", "second"]);
  });

  test("usageTotals for a conversation are aggregated from COST_LEDGER_TABLE GSI1 (PROJECT#<conversationId>)", async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    ddbMock.on(QueryCommand).callsFake((input) => {
      if (input.TableName === "conversations-test") return { Items: [] };
      if (
        input.TableName === "cost-ledger-test" &&
        input.IndexName === "ProjectIndex"
      ) {
        expect(input.ExpressionAttributeValues[":pk"]).toBe("PROJECT#conv-1");
        return {
          Items: [
            {
              orgId: "org-1",
              projectId: "conv-1",
              inputTokens: 5,
              outputTokens: 7,
              totalTokens: 12,
            },
            {
              orgId: "org-1",
              projectId: "conv-1",
              inputTokens: 3,
              outputTokens: 1,
              totalTokens: 4,
            },
          ],
        };
      }
      return { Items: [] };
    });

    const result = await assembleReplayPackage(
      "org-1",
      "conversation",
      "conv-1",
    );

    expect(result.sections.usageTotals).toEqual({
      inputTokens: 8,
      outputTokens: 8,
      totalTokens: 16,
      callCount: 2,
    });
  });

  test("findings section is explicitly partial for conversation kind — no join key exists (honest gap)", async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const result = await assembleReplayPackage(
      "org-1",
      "conversation",
      "conv-1",
    );

    expect(result.sections.findings).toEqual({
      partial: true,
      results: [],
      provenance: expect.stringMatching(/orchestrationId|workflowId/i),
    });
  });

  test("Pass 2 (design §4): runId-confirmed findings JOIN properly and move OUT of the unjoinable section when a runId is present on both conversation messages and a ledger finding", async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    ddbMock.on(QueryCommand).callsFake((input) => {
      if (input.TableName === "conversations-test") {
        return {
          Items: [
            conversationMessageItem("conv-1", "2026-07-01T00:00:00.000Z", {
              runId: "run-11111111-1111-1111-1111-111111111111",
            }),
          ],
        };
      }
      return { Items: [] };
    });
    ddbMock.on(ScanCommand).resolves({
      Items: [
        {
          findingId: "f-runid-1",
          workflowId: "wf-unrelated",
          orgId: "org-1",
          decision: "PERMIT",
          runId: "run-11111111-1111-1111-1111-111111111111",
        },
      ],
    });

    const result = await assembleReplayPackage(
      "org-1",
      "conversation",
      "conv-1",
    );

    // runId-confirmed finding is now a real, joined array entry — not
    // wrapped in the partial/unjoinable shape.
    expect(Array.isArray(result.sections.findings)).toBe(true);
    const findings = result.sections.findings as Array<Record<string, unknown>>;
    expect(findings).toHaveLength(1);
    expect(findings[0].findingId).toBe("f-runid-1");
  });

  test("Pass 2: NO runId on any conversation message -> findings section stays the honest partial shape (unchanged pre-runId behavior)", async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    ddbMock.on(QueryCommand).callsFake((input) => {
      if (input.TableName === "conversations-test") {
        return {
          Items: [
            conversationMessageItem("conv-1", "2026-07-01T00:00:00.000Z"),
          ],
        };
      }
      return { Items: [] };
    });

    const result = await assembleReplayPackage(
      "org-1",
      "conversation",
      "conv-1",
    );

    expect(result.sections.findings).toEqual({
      partial: true,
      results: [],
      provenance: expect.stringMatching(/orchestrationId|workflowId/i),
    });
    // No runId present anywhere -> the ledger must never be scanned by
    // runId (would be a wasted, unbounded-cost Scan for no possible match).
    expect(ddbMock.commandCalls(ScanCommand)).toHaveLength(0);
  });

  test("Pass 2: cross-org refusal still applies to a runId-confirmed finding row from another org", async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    ddbMock.on(QueryCommand).callsFake((input) => {
      if (input.TableName === "conversations-test") {
        return {
          Items: [
            conversationMessageItem("conv-1", "2026-07-01T00:00:00.000Z", {
              runId: "run-22222222-2222-2222-2222-222222222222",
            }),
          ],
        };
      }
      return { Items: [] };
    });
    ddbMock.on(ScanCommand).resolves({
      Items: [
        {
          findingId: "f-runid-2",
          workflowId: "wf-x",
          orgId: "org-OTHER",
          decision: "PERMIT",
          runId: "run-22222222-2222-2222-2222-222222222222",
        },
      ],
    });

    await expect(
      assembleReplayPackage("org-1", "conversation", "conv-1"),
    ).rejects.toThrow(CrossOrgRowError);
  });

  test("cross-org refusal: a conversation message row belonging to a different org is refused", async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    ddbMock.on(QueryCommand).callsFake((input) => {
      if (input.TableName === "conversations-test") {
        return {
          Items: [
            conversationMessageItem("conv-1", "2026-07-01T00:00:00.000Z", {
              orgId: "org-OTHER",
            }),
          ],
        };
      }
      return { Items: [] };
    });

    await expect(
      assembleReplayPackage("org-1", "conversation", "conv-1"),
    ).rejects.toThrow(CrossOrgRowError);
  });

  test("cross-org refusal: a cost-ledger usage row belonging to a different org is refused", async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    ddbMock.on(QueryCommand).callsFake((input) => {
      if (input.TableName === "conversations-test") return { Items: [] };
      if (
        input.TableName === "cost-ledger-test" &&
        input.IndexName === "ProjectIndex"
      ) {
        return {
          Items: [{ orgId: "org-OTHER", projectId: "conv-1" }],
        };
      }
      return { Items: [] };
    });

    await expect(
      assembleReplayPackage("org-1", "conversation", "conv-1"),
    ).rejects.toThrow(CrossOrgRowError);
  });

  test("toolResults is partial/honest for conversation kind too", async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const result = await assembleReplayPackage(
      "org-1",
      "conversation",
      "conv-1",
    );

    expect(result.sections.toolResults.partial).toBe(true);
    expect(result.sections.toolResults.provenance).toMatch(/CIT-121/);
  });

  test("conversation-kind output is gate-clean (no secret-pattern hits after sanitisation)", async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    ddbMock.on(QueryCommand).callsFake((input) => {
      if (input.TableName === "conversations-test") {
        return {
          Items: [
            conversationMessageItem("conv-1", "2026-07-01T00:00:00.000Z", {
              message: "leaked token=supersecretvalue123",
            }),
          ],
        };
      }
      return { Items: [] };
    });

    const result = await assembleReplayPackage(
      "org-1",
      "conversation",
      "conv-1",
    );
    expect(scanForSecrets(JSON.stringify(result))).toEqual([]);
  });

  test("agentConfig/workflow/execSpec/modelConfig sections are null for conversation kind (no execution row to derive them from)", async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const result = await assembleReplayPackage(
      "org-1",
      "conversation",
      "conv-1",
    );

    expect(result.sections.agentConfig).toBeNull();
    expect(result.sections.workflow).toBeNull();
    expect(result.sections.execSpec).toBeNull();
    expect(result.sections.modelConfig).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Branch tests for finding 6de8908c: per-source-table cross-org refusal,
// related-section population arms, runId-Scan pagination/cap/chunking, and
// usage-row numeric coercion. Behavior-asserting only.
// ---------------------------------------------------------------------------

/** Execution item wired so every related read has a key to follow. */
function fullyLinkedExecutionItem(orgId: string) {
  return {
    ...baseExecutionItem(orgId),
    specId: "spec-1",
    modelConfigScope: "scope-1",
    governanceMode: "strict",
    nodeResults: {
      "node-1": {
        nodeId: "node-1",
        agentId: "agent-1",
        status: "completed",
        output: "hello",
      },
    },
  };
}

/** Routes GetCommand by table, letting one table return a chosen row. */
function mockLinkedGets(rows: Record<string, Record<string, unknown>>) {
  ddbMock.on(GetCommand).callsFake((input) => {
    const item = rows[input.TableName as string];
    return { Item: item };
  });
}

describe("assembleReplayPackage — per-source-table cross-org refusal (execution kind)", () => {
  const crossOrgCases: Array<[string, string]> = [
    ["workflows-test", "workflow row"],
    ["execspec-test", "execution-spec row"],
    ["model-config-test", "model-config row"],
    ["agent-config-test", "agent-config row"],
  ];

  test.each(crossOrgCases)(
    "a cross-org %s (%s) is refused with CrossOrgRowError",
    async (tableName) => {
      const rows: Record<string, Record<string, unknown>> = {
        "executions-test": fullyLinkedExecutionItem("org-1"),
        "workflows-test": { workflowId: "wf-1", orgId: "org-1" },
        "execspec-test": { specId: "spec-1", orgId: "org-1" },
        "model-config-test": { scope: "scope-1", orgId: "org-1" },
        "agent-config-test": { agentId: "agent-1", orgId: "org-1" },
      };
      rows[tableName] = { ...rows[tableName], orgId: "org-OTHER" };
      mockLinkedGets(rows);
      ddbMock.on(QueryCommand).resolves({ Items: [] });

      await expect(
        assembleReplayPackage("org-1", "execution", "exec-1"),
      ).rejects.toThrow(CrossOrgRowError);
    },
  );

  test("a cross-org cost-ledger usage row (execution kind, WorkflowIndex) is refused", async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    ddbMock.on(GetCommand, { TableName: "executions-test" }).resolves({
      Item: baseExecutionItem("org-1"),
    });
    ddbMock.on(QueryCommand).callsFake((input) => {
      if (
        input.TableName === "cost-ledger-test" &&
        input.IndexName === "WorkflowIndex"
      ) {
        return { Items: [{ orgId: "org-OTHER", ledgerId: "l-1" }] };
      }
      return { Items: [] };
    });

    await expect(
      assembleReplayPackage("org-1", "execution", "exec-1"),
    ).rejects.toThrow(CrossOrgRowError);
  });

  test("a row with a non-string orgId is NOT treated as cross-org (org filter only applies to string orgIds)", async () => {
    mockLinkedGets({
      "executions-test": baseExecutionItem("org-1"),
      "workflows-test": { workflowId: "wf-1", orgId: 42 },
    });
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const result = await assembleReplayPackage("org-1", "execution", "exec-1");
    expect(result.orgId).toBe("org-1");
  });
});

describe("assembleReplayPackage — related-section population (execution kind)", () => {
  test("workflow/execSpec/modelConfig/agentConfig sections populate from same-org rows", async () => {
    mockLinkedGets({
      "executions-test": fullyLinkedExecutionItem("org-1"),
      "workflows-test": { workflowId: "wf-1", orgId: "org-1", name: "wf" },
      "execspec-test": { specId: "spec-1", orgId: "org-1", title: "spec" },
      "model-config-test": { scope: "scope-1", orgId: "org-1", model: "m" },
      "agent-config-test": { agentId: "agent-1", orgId: "org-1", role: "a" },
    });
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const result = await assembleReplayPackage("org-1", "execution", "exec-1");
    expect(result.sections.workflow).toMatchObject({ workflowId: "wf-1" });
    expect(result.sections.execSpec).toMatchObject({ specId: "spec-1" });
    expect(result.sections.modelConfig).toMatchObject({ scope: "scope-1" });
    expect(result.sections.agentConfig).toMatchObject({ agentId: "agent-1" });
    expect(result.sections.governanceMode).toBe("strict");
  });

  test("execution without workflowId/nodeResults/usageTotals -> null sections, empty nodes, and NO governance query issued", async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    ddbMock.on(GetCommand, { TableName: "executions-test" }).resolves({
      Item: {
        executionId: "exec-bare",
        orgId: "org-1",
        status: "completed",
      },
    });
    const queries: string[] = [];
    ddbMock.on(QueryCommand).callsFake((input) => {
      queries.push(`${input.TableName}:${input.IndexName ?? "-"}`);
      return { Items: [] };
    });

    const result = await assembleReplayPackage(
      "org-1",
      "execution",
      "exec-bare",
    );
    expect(result.sections.workflow).toBeNull();
    expect(result.sections.execSpec).toBeNull();
    expect(result.sections.modelConfig).toBeNull();
    expect(result.sections.agentConfig).toBeNull();
    expect(result.sections.nodes).toEqual([]);
    expect(result.sections.usageTotals).toBeNull();
    expect(result.sections.findings).toEqual([]);
    // No workflowId -> the governance workflow-index Query must not happen.
    expect(queries).not.toContain("governance-ledger-test:workflow-index");
  });

  test("node entry without nodeId falls back to its map key; missing output/status/retryCount/usage default to null/0", async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    ddbMock.on(GetCommand, { TableName: "executions-test" }).resolves({
      Item: {
        ...baseExecutionItem("org-1"),
        nodeResults: { "key-only-node": { status: null } },
      },
    });
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const result = await assembleReplayPackage("org-1", "execution", "exec-1");
    expect(result.sections.nodes).toEqual([
      {
        nodeId: "key-only-node",
        inputs: null,
        outputs: null,
        status: null,
        retries: 0,
        usage: null,
        startedAt: null,
        completedAt: null,
        agentId: null,
      },
    ]);
  });

  test("Phase 1 additive projection: startedAt/completedAt/agentId pass through nodes[] as ordering anchors for trajectory scoring", async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    ddbMock.on(GetCommand, { TableName: "executions-test" }).resolves({
      Item: {
        ...baseExecutionItem("org-1"),
        nodeResults: {
          "node-1": {
            nodeId: "node-1",
            agentId: "coder",
            status: "COMPLETED",
            output: "ok",
            startedAt: "2026-07-01T00:00:00.000Z",
            completedAt: "2026-07-01T00:00:03.500Z",
          },
        },
      },
    });
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const result = await assembleReplayPackage("org-1", "execution", "exec-1");
    expect(result.sections.nodes).toEqual([
      {
        nodeId: "node-1",
        inputs: null,
        outputs: "ok",
        status: "COMPLETED",
        retries: 0,
        usage: null,
        startedAt: "2026-07-01T00:00:00.000Z",
        completedAt: "2026-07-01T00:00:03.500Z",
        agentId: "coder",
      },
    ]);
  });
});

describe("readGovernanceFindingsByRunIds — pagination, cap, chunking (conversation kind)", () => {
  function runIdMessages(runIds: Array<string | number | undefined>) {
    return runIds.map((runId, i) =>
      conversationMessageItem("conv-1", "2026-07-01T00:00:00.000Z", {
        id: `msg-${i}`,
        ...(runId === undefined ? {} : { runId }),
      }),
    );
  }

  function mockConversationQueries(
    messages: Array<Record<string, unknown>>,
  ): void {
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    ddbMock.on(QueryCommand).callsFake((input) => {
      if (input.TableName === "conversations-test") {
        return { Items: messages };
      }
      // Covers the `result.Items ?? []` arm: no Items key at all.
      return {};
    });
  }

  test("paginated Scan follows LastEvaluatedKey and merges both pages of runId-confirmed findings", async () => {
    mockConversationQueries(runIdMessages(["run-A", "", 7]));
    ddbMock
      .on(ScanCommand)
      .resolvesOnce({
        Items: [{ findingId: "f-1", orgId: "org-1", runId: "run-A" }],
        LastEvaluatedKey: { pk: "cursor" },
      })
      .resolves({
        Items: [{ findingId: "f-2", orgId: "org-1", runId: "run-A" }],
      });

    const result = await assembleReplayPackage(
      "org-1",
      "conversation",
      "conv-1",
    );

    const findings = result.sections.findings as Array<Record<string, unknown>>;
    expect(findings.map((f) => f.findingId)).toEqual(["f-1", "f-2"]);
    const scans = ddbMock.commandCalls(ScanCommand);
    expect(scans).toHaveLength(2);
    expect(scans[1].args[0].input.ExclusiveStartKey).toEqual({ pk: "cursor" });
    // Empty-string and non-string runIds never join.
    expect(scans[0].args[0].input.FilterExpression).toBe("runId IN (:r0)");
  });

  test("scan cap bounds joined findings at 1000 and stops paging", async () => {
    mockConversationQueries(runIdMessages(["run-A"]));
    const bigPage = Array.from({ length: 1005 }, (_, i) => ({
      findingId: `f-${i}`,
      orgId: "org-1",
      runId: "run-A",
    }));
    ddbMock.on(ScanCommand).resolves({
      Items: bigPage,
      LastEvaluatedKey: { pk: "never-followed" },
    });

    const result = await assembleReplayPackage(
      "org-1",
      "conversation",
      "conv-1",
    );

    const findings = result.sections.findings as unknown[];
    expect(findings).toHaveLength(1000);
    // Cap reached inside the first page -> the LastEvaluatedKey cursor is
    // never followed (exactly one Scan issued).
    expect(ddbMock.commandCalls(ScanCommand)).toHaveLength(1);
  });

  test("more than 100 distinct runIds chunk into multiple filtered Scans (IN() 100-value limit)", async () => {
    const manyRunIds = Array.from({ length: 101 }, (_, i) => `run-${i}`);
    mockConversationQueries(runIdMessages(manyRunIds));
    ddbMock.on(ScanCommand).resolves({ Items: [] });

    const result = await assembleReplayPackage(
      "org-1",
      "conversation",
      "conv-1",
    );

    // runIds were present but nothing matched: a REAL empty array (joinable,
    // zero found) — not the partial/unjoinable marker.
    expect(result.sections.findings).toEqual([]);
    const scans = ddbMock.commandCalls(ScanCommand);
    expect(scans).toHaveLength(2);
    const firstExpr = scans[0].args[0].input.FilterExpression as string;
    const secondExpr = scans[1].args[0].input.FilterExpression as string;
    expect(firstExpr.match(/:r\d+/g)).toHaveLength(100);
    expect(secondExpr).toBe("runId IN (:r0)");
  });

  test("duplicate runIds across messages are de-duplicated into a single filter placeholder", async () => {
    mockConversationQueries(runIdMessages(["run-A", "run-A", "run-A"]));
    ddbMock.on(ScanCommand).resolves({ Items: [] });

    await assembleReplayPackage("org-1", "conversation", "conv-1");

    const scans = ddbMock.commandCalls(ScanCommand);
    expect(scans).toHaveLength(1);
    expect(scans[0].args[0].input.FilterExpression).toBe("runId IN (:r0)");
  });

  test("a Scan page without an Items key is treated as empty (findings stay a real joined array)", async () => {
    mockConversationQueries(runIdMessages(["run-A"]));
    ddbMock.on(ScanCommand).resolves({});

    const result = await assembleReplayPackage(
      "org-1",
      "conversation",
      "conv-1",
    );
    expect(result.sections.findings).toEqual([]);
    expect(ddbMock.commandCalls(ScanCommand)).toHaveLength(1);
  });
});

describe("conversation usage coercion — cost rows crossing the table-read boundary", () => {
  test("string numerics parse; junk, negative, and non-numeric values clamp to 0", async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    ddbMock.on(QueryCommand).callsFake((input) => {
      if (input.TableName === "conversations-test") return { Items: [] };
      if (
        input.TableName === "cost-ledger-test" &&
        input.IndexName === "ProjectIndex"
      ) {
        return {
          Items: [
            {
              orgId: "org-1",
              inputTokens: "5",
              outputTokens: "7.5",
              totalTokens: "abc",
            },
            {
              orgId: "org-1",
              inputTokens: -3,
              outputTokens: null,
              totalTokens: 4,
            },
          ],
        };
      }
      return { Items: [] };
    });

    const result = await assembleReplayPackage(
      "org-1",
      "conversation",
      "conv-1",
    );

    expect(result.sections.usageTotals).toEqual({
      inputTokens: 5, // "5" parsed; -3 clamped to 0
      outputTokens: 7.5, // "7.5" parsed; null -> 0
      totalTokens: 4, // "abc" -> 0; 4 kept
      callCount: 2,
    });
  });
});

describe("defensive read-result handling", () => {
  test("query results without an Items key are treated as empty (execution kind: governance + cost reads)", async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    ddbMock.on(GetCommand, { TableName: "executions-test" }).resolves({
      Item: baseExecutionItem("org-1"),
    });
    ddbMock.on(QueryCommand).resolves({});

    const result = await assembleReplayPackage("org-1", "execution", "exec-1");
    expect(result.sections.findings).toEqual([]);
    expect(result.kind).toBe("execution");
  });

  test("query results without an Items key are treated as empty (conversation kind: messages + cost reads)", async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    ddbMock.on(QueryCommand).resolves({});

    const result = await assembleReplayPackage(
      "org-1",
      "conversation",
      "conv-1",
    );
    expect(result.sections.messages).toEqual([]);
    expect(result.sections.usageTotals).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      callCount: 0,
    });
  });

  test("messages with non-string timestamps still order deterministically (empty-string sort fallback)", async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    ddbMock.on(QueryCommand).callsFake((input) => {
      if (input.TableName === "conversations-test") {
        return {
          Items: [
            { projectId: "conv-1", timestamp: 222, message: "num-a" },
            { projectId: "conv-1", timestamp: 111, message: "num-b" },
          ],
        };
      }
      return { Items: [] };
    });

    const result = await assembleReplayPackage(
      "org-1",
      "conversation",
      "conv-1",
    );
    const messages = result.sections.messages as Array<{ message: string }>;
    // Both fall back to "" (equal) -> stable original order preserved.
    expect(messages.map((m) => m.message)).toEqual(["num-a", "num-b"]);
  });
});
