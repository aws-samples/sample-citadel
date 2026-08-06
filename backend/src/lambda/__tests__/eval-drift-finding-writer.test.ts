/**
 * eval-drift-finding-writer.test.ts (Phase 3 §3.3) — consumes
 * governance.eval.drift.detected and writes a write-once
 * GovernanceFinding row into GOVERNANCE_LEDGER_TABLE (the SAME table
 * the Python arbiter's ledger.py writes; see the writer's own module
 * doc for the exact field-mapping rationale onto that schema).
 *
 * Jest + aws-sdk-client-mock (established convention, see
 * eval-sample-scorer.test.ts). No AWS SDK v3 for Python-owned semantics
 * to fake — this Lambda writes the same DDB item shape the Python
 * ledger.py::_serialize_finding produces, verified against the field
 * list read directly from arbiter/governance/models.py::GovernanceFinding
 * and arbiter/governance/ledger.py::_serialize_finding.
 */
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";

process.env.GOVERNANCE_LEDGER_TABLE = "governance-ledger-test";

const ddbMock = mockClient(DynamoDBDocumentClient);

import {
  handleDriftDetected,
  type DriftDetectedDetail,
} from "../eval-drift-finding-writer";

function detail(
  overrides: Partial<DriftDetectedDetail> = {},
): DriftDetectedDetail {
  return {
    agentId: "agent-1",
    dimension: "policy_compliance",
    baseline: { passRate: 0.95, sampleCount: 50 },
    current: { passRate: 0.6, sampleCount: 50 },
    delta: 0.35,
    window: { from: "2026-08-03T12", to: "2026-08-04T12" },
    ...overrides,
  };
}

describe("handleDriftDetected", () => {
  beforeEach(() => {
    ddbMock.reset();
  });

  it("writes a write-once GovernanceFinding row matching the Python ledger schema", async () => {
    ddbMock.on(PutCommand).resolves({});

    await handleDriftDetected(detail());

    expect(ddbMock.calls()).toHaveLength(1);
    const putInput = ddbMock.call(0).args[0].input as {
      TableName?: string;
      Item?: Record<string, unknown>;
      ConditionExpression?: string;
    };
    expect(putInput.TableName).toBe("governance-ledger-test");
    // Write-once, same discipline as ledger.py::write_finding.
    expect(putInput.ConditionExpression).toBe(
      "attribute_not_exists(findingId)",
    );

    const item = putInput.Item!;
    // Key-schema aliases (camelCase), required per ledger.py::_serialize_finding.
    expect(typeof item.findingId).toBe("string");
    expect(item.workflowId).toBe("EVAL_DRIFT#agent-1#policy_compliance");
    expect(typeof item.timestamp).toBe("number");
    // Dataclass field names (snake_case), same as the Python writer.
    expect(item.workflow_id).toBe("EVAL_DRIFT#agent-1#policy_compliance");
    expect(item.decision).toBe("escalate");
    expect(item.requesting_agent).toBe("eval-drift-detector");
    expect(item.target_agent).toBe("agent-1");
    expect(typeof item.reason).toBe("string");
    expect(item.reason).toContain("policy_compliance");
    expect(typeof item.ttl).toBe("number");
    expect(item.category).toBe("eval-drift");
  });

  it("is idempotent per (agent, dimension, window): a duplicate emission is dropped, not retried destructively", async () => {
    const condFail = Object.assign(new Error("dupe"), {
      name: "ConditionalCheckFailedException",
    });
    ddbMock.on(PutCommand).rejects(condFail);

    await expect(handleDriftDetected(detail())).resolves.not.toThrow();
  });

  it("produces the same findingId (dedupe key) for the same (agent, dimension, window) on repeated emission", async () => {
    ddbMock.on(PutCommand).resolves({});
    await handleDriftDetected(detail());
    await handleDriftDetected(detail());

    expect(ddbMock.calls()).toHaveLength(2);
    const item1 = ddbMock.call(0).args[0].input.Item as Record<string, unknown>;
    const item2 = ddbMock.call(1).args[0].input.Item as Record<string, unknown>;
    expect(item1.findingId).toBe(item2.findingId);
  });

  it("produces a different findingId for a different window (new cycle -> new finding)", async () => {
    ddbMock.on(PutCommand).resolves({});
    await handleDriftDetected(detail({ window: { from: "a", to: "b" } }));
    await handleDriftDetected(detail({ window: { from: "c", to: "d" } }));

    const item1 = ddbMock.call(0).args[0].input.Item as Record<string, unknown>;
    const item2 = ddbMock.call(1).args[0].input.Item as Record<string, unknown>;
    expect(item1.findingId).not.toBe(item2.findingId);
  });

  it("never throws on an unexpected DDB error — logs and drops rather than failing the EventBridge delivery", async () => {
    ddbMock.on(PutCommand).rejects(new Error("network blip"));
    await expect(handleDriftDetected(detail())).resolves.not.toThrow();
  });

  it("includes evidence (baseline/current/delta) in the finding reason for legibility", async () => {
    ddbMock.on(PutCommand).resolves({});
    await handleDriftDetected(
      detail({
        delta: 0.42,
        baseline: { passRate: 0.9, sampleCount: 20 },
        current: { passRate: 0.48, sampleCount: 20 },
      }),
    );
    const item = ddbMock.call(0).args[0].input.Item as Record<string, unknown>;
    expect(item.reason as string).toContain("0.42");
  });
});
