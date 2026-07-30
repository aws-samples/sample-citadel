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
