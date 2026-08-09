/**
 * release-gate-finding-writer.test.ts — write-once GovernanceFinding
 * writer for a release-promotion gate decision.
 *
 * Red-Green-Refactor: written before release-gate-finding-writer.ts
 * exists.
 *
 * Contract under test (see design item 5, "ORDERING AND FAILURE"):
 *  - The finding carries a machine-readable `decision`, `reason`
 *    (embedding the gate's ReleaseGateReason[] and score detail) so a
 *    promotion decision is auditable after the fact.
 *  - Unlike eval-drift-finding-writer.ts's best-effort log-and-drop
 *    catch (an observability side channel), THIS writer rethrows any
 *    non-dedupe error. In shadow mode the ledger finding is the ONLY
 *    record of a would-block outcome — a swallowed write failure there
 *    would silently erase the sole evidence. The dedupe case
 *    (ConditionalCheckFailedException on the write-once key) is the one
 *    expected, intentionally-absorbed outcome — same as the drift
 *    writer — because it means a finding for this exact decision
 *    already exists, not a failure.
 */
process.env.GOVERNANCE_LEDGER_TABLE = "citadel-governance-ledger-test";

import { readFileSync } from "fs";
import { resolve } from "path";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import {
  writeReleaseGateFinding,
  type ReleaseGateFindingInput,
} from "../release-gate-finding-writer";

const ddbMock = mockClient(DynamoDBDocumentClient);

beforeEach(() => {
  ddbMock.reset();
});

function findingInput(
  overrides: Partial<ReleaseGateFindingInput> = {},
): ReleaseGateFindingInput {
  return {
    orgId: "org-1",
    agentTargetId: "agent-1",
    environment: "PROD",
    releaseId: "release-1",
    decidedBy: "user-architect",
    decision: "deny",
    reasons: ["MATERIAL_REGRESSION", "THRESHOLD_FAILED"],
    scoreVector: [
      { dimension: "task_success", passRate: 0.5, scoredCount: 10 },
    ],
    mode: "strict",
    ...overrides,
  };
}

describe("writeReleaseGateFinding", () => {
  test("writes a finding with machine-readable reason and score detail", async () => {
    ddbMock.on(PutCommand).resolves({});

    await writeReleaseGateFinding(findingInput());

    const calls = ddbMock.commandCalls(PutCommand);
    expect(calls).toHaveLength(1);
    const item = calls[0].args[0].input.Item as Record<string, unknown>;

    expect(item.decision).toBe("deny");
    expect(item.requesting_agent).toBe("release-quality-gate");
    expect(item.target_agent).toBe("agent-1");
    expect(typeof item.reason).toBe("string");
    expect(item.reason as string).toContain("MATERIAL_REGRESSION");
    expect(item.reason as string).toContain("THRESHOLD_FAILED");
    // Score detail must be present and re-derivable, not summarized away.
    expect(item.reason as string).toContain("task_success");
    expect(item.score_vector).toBeDefined();
  });

  test("uses the caller's PutCommand table name from GOVERNANCE_LEDGER_TABLE", async () => {
    ddbMock.on(PutCommand).resolves({});
    await writeReleaseGateFinding(findingInput());
    const call = ddbMock.commandCalls(PutCommand)[0].args[0].input;
    expect(call.TableName).toBe("citadel-governance-ledger-test");
  });

  test("write-once: is idempotent via attribute_not_exists(findingId) condition", async () => {
    ddbMock.on(PutCommand).resolves({});
    await writeReleaseGateFinding(findingInput());
    const call = ddbMock.commandCalls(PutCommand)[0].args[0].input;
    expect(call.ConditionExpression).toBe("attribute_not_exists(findingId)");
  });

  test("swallows the expected ConditionalCheckFailedException (dedupe, not a failure)", async () => {
    const conditionalError = Object.assign(
      new Error("The conditional request failed"),
      { name: "ConditionalCheckFailedException" },
    );
    ddbMock.on(PutCommand).rejects(conditionalError);

    await expect(
      writeReleaseGateFinding(findingInput()),
    ).resolves.toBeUndefined();
  });

  test("rethrows any OTHER DynamoDB error — never swallowed, unlike eval-drift-finding-writer's best-effort drop", async () => {
    ddbMock
      .on(PutCommand)
      .rejects(new Error("ProvisionedThroughputExceededException"));

    await expect(writeReleaseGateFinding(findingInput())).rejects.toThrow(
      /ProvisionedThroughputExceededException/,
    );
  });

  test("same decision inputs produce the same findingId (deterministic dedupe key)", async () => {
    ddbMock.on(PutCommand).resolves({});
    await writeReleaseGateFinding(findingInput());
    await writeReleaseGateFinding(findingInput());

    const calls = ddbMock.commandCalls(PutCommand);
    const id1 = (calls[0].args[0].input.Item as Record<string, unknown>)
      .findingId;
    const id2 = (calls[1].args[0].input.Item as Record<string, unknown>)
      .findingId;
    expect(id1).toBe(id2);
  });

  test("a different releaseId produces a different findingId", async () => {
    ddbMock.on(PutCommand).resolves({});
    await writeReleaseGateFinding(findingInput({ releaseId: "release-1" }));
    await writeReleaseGateFinding(findingInput({ releaseId: "release-2" }));

    const calls = ddbMock.commandCalls(PutCommand);
    const id1 = (calls[0].args[0].input.Item as Record<string, unknown>)
      .findingId;
    const id2 = (calls[1].args[0].input.Item as Record<string, unknown>)
      .findingId;
    expect(id1).not.toBe(id2);
  });

  test("decidedBy is carried verbatim onto the finding for auditability", async () => {
    ddbMock.on(PutCommand).resolves({});
    await writeReleaseGateFinding(findingInput({ decidedBy: "user-abc" }));
    const item = ddbMock.commandCalls(PutCommand)[0].args[0].input
      .Item as Record<string, unknown>;
    expect(item.decided_by).toBe("user-abc");
  });

  test("identifiers absent -> persisted item is byte-identical to the pre-stamping shape", async () => {
    ddbMock.on(PutCommand).resolves({});
    await writeReleaseGateFinding(findingInput());
    const item = ddbMock.commandCalls(PutCommand)[0].args[0].input
      .Item as Record<string, unknown>;

    // No null placeholders, no empty strings — the keys must be entirely
    // absent, matching Python's _serialize_finding None-stripping.
    expect(Object.prototype.hasOwnProperty.call(item, "traceId")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(item, "runId")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(item, "evalRunId")).toBe(false);

    // Exhaustive shape check: the pre-stamping key set, nothing more.
    expect(Object.keys(item).sort()).toEqual(
      [
        "findingId",
        "workflowId",
        "timestamp",
        "workflow_id",
        "decision",
        "requesting_agent",
        "target_agent",
        "reason",
        "finding_id",
        "decided_by",
        "category",
        "org_id",
        "environment",
        "release_id",
        "enforcement_mode",
        "score_vector",
        "gate_reasons",
        "ttl",
      ].sort(),
    );
  });

  test("identifiers present -> stamped verbatim onto the persisted item", async () => {
    ddbMock.on(PutCommand).resolves({});
    await writeReleaseGateFinding(
      findingInput({
        traceId: "1-abcdef01-0123456789abcdef01234567",
        runId: "run-abc-123",
      }),
    );
    const item = ddbMock.commandCalls(PutCommand)[0].args[0].input
      .Item as Record<string, unknown>;

    expect(item.traceId).toBe("1-abcdef01-0123456789abcdef01234567");
    expect(item.runId).toBe("run-abc-123");
  });

  test("only traceId present -> only traceId is stamped, runId stays absent", async () => {
    ddbMock.on(PutCommand).resolves({});
    await writeReleaseGateFinding(
      findingInput({ traceId: "1-abcdef01-0123456789abcdef01234567" }),
    );
    const item = ddbMock.commandCalls(PutCommand)[0].args[0].input
      .Item as Record<string, unknown>;

    expect(item.traceId).toBe("1-abcdef01-0123456789abcdef01234567");
    expect(Object.prototype.hasOwnProperty.call(item, "runId")).toBe(false);
  });

  test("field-name parity: TS identifier field names match Python's _serialize_finding aliases", () => {
    // Drift guard: if the Python ledger serializer's camelCase aliases
    // ever change, this assertion fails a test rather than silently
    // breaking the cross-runtime join. Source of truth read directly
    // from the checked-in Python serializer at
    // arbiter/governance/ledger.py::_serialize_finding.
    const ledgerPySource = readFileSync(
      resolve(__dirname, "../../../../../arbiter/governance/ledger.py"),
      "utf-8",
    );
    expect(ledgerPySource).toContain('item["traceId"] = finding.trace_id');
    expect(ledgerPySource).toContain('item["runId"] = finding.run_id');

    // The TS-side field names this writer accepts and persists verbatim.
    const tsFieldNames: Array<keyof ReleaseGateFindingInput> = [
      "traceId",
      "runId",
    ];
    expect(tsFieldNames).toEqual(["traceId", "runId"]);
  });
});
