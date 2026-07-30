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
