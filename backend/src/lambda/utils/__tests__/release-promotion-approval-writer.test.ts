/**
 * release-promotion-approval-writer.test.ts — write-once GovernanceFinding
 * writer for an interim human-approval decision on a release promotion.
 *
 * This file did not exist before decision 2dd461f6, slice 1. It was added
 * as part of that slice because the writer's item shape is directly
 * relevant to the attribute-naming unification (org_id -> orgId) and had
 * no dedicated test coverage prior to this change — see
 * release-gate-finding-writer.test.ts (its sibling/template) for the
 * conventions mirrored here.
 */
process.env.GOVERNANCE_LEDGER_TABLE = "citadel-governance-ledger-test";

import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import {
  writeReleasePromotionApprovalFinding,
  type ReleasePromotionApprovalInput,
} from "../release-promotion-approval-writer";

const ddbMock = mockClient(DynamoDBDocumentClient);

beforeEach(() => {
  ddbMock.reset();
});

function approvalInput(
  overrides: Partial<ReleasePromotionApprovalInput> = {},
): ReleasePromotionApprovalInput {
  return {
    orgId: "org-1",
    agentTargetId: "agent-1",
    environment: "PROD",
    releaseId: "release-1",
    decidedBy: "user-architect",
    decision: "permit",
    ...overrides,
  };
}

describe("writeReleasePromotionApprovalFinding", () => {
  test("writes a finding with the approval category, distinct from the gate's own category", async () => {
    ddbMock.on(PutCommand).resolves({});
    await writeReleasePromotionApprovalFinding(approvalInput());

    const calls = ddbMock.commandCalls(PutCommand);
    expect(calls).toHaveLength(1);
    const item = calls[0].args[0].input.Item as Record<string, unknown>;

    expect(item.category).toBe("release-promotion-approval");
    expect(item.decision).toBe("permit");
    expect(item.requesting_agent).toBe("release-promotion-approval");
    expect(item.target_agent).toBe("agent-1");
    expect(item.decided_by).toBe("user-architect");
  });

  test("write-once: is idempotent via attribute_not_exists(findingId) condition", async () => {
    ddbMock.on(PutCommand).resolves({});
    await writeReleasePromotionApprovalFinding(approvalInput());
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
      writeReleasePromotionApprovalFinding(approvalInput()),
    ).resolves.toBeUndefined();
  });

  test("rethrows any OTHER DynamoDB error — FAIL-CLOSED, same standing decision as the gate finding", async () => {
    ddbMock
      .on(PutCommand)
      .rejects(new Error("ProvisionedThroughputExceededException"));

    await expect(
      writeReleasePromotionApprovalFinding(approvalInput()),
    ).rejects.toThrow(/ProvisionedThroughputExceededException/);
  });

  test("same decision inputs produce the same findingId (deterministic dedupe key), distinct from the gate's findingId for the same release", async () => {
    ddbMock.on(PutCommand).resolves({});
    await writeReleasePromotionApprovalFinding(approvalInput());
    await writeReleasePromotionApprovalFinding(approvalInput());

    const calls = ddbMock.commandCalls(PutCommand);
    const id1 = (calls[0].args[0].input.Item as Record<string, unknown>)
      .findingId;
    const id2 = (calls[1].args[0].input.Item as Record<string, unknown>)
      .findingId;
    expect(id1).toBe(id2);
  });

  test("optional justification/traceId/runId/diff are stamped verbatim when present, absent otherwise", async () => {
    ddbMock.on(PutCommand).resolves({});
    await writeReleasePromotionApprovalFinding(
      approvalInput({
        justification: "verified by hand",
        traceId: "1-abcdef01-0123456789abcdef01234567",
        runId: "run-abc-123",
        diff: { added: 1 },
      }),
    );
    const item = ddbMock.commandCalls(PutCommand)[0].args[0].input
      .Item as Record<string, unknown>;
    expect(item.justification).toBe("verified by hand");
    expect(item.traceId).toBe("1-abcdef01-0123456789abcdef01234567");
    expect(item.runId).toBe("run-abc-123");
    expect(item.diff).toEqual({ added: 1 });
  });

  test("identifiers absent -> persisted item is byte-identical to the pre-stamping shape, unified camelCase convention (decision 2dd461f6, slice 1)", async () => {
    ddbMock.on(PutCommand).resolves({});
    await writeReleasePromotionApprovalFinding(approvalInput());
    const item = ddbMock.commandCalls(PutCommand)[0].args[0].input
      .Item as Record<string, unknown>;

    expect(Object.prototype.hasOwnProperty.call(item, "traceId")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(item, "runId")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(item, "diff")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(item, "justification")).toBe(
      false,
    );

    // Legacy snake_case duplicates (finding_id/workflow_id/org_id) are
    // retired — findingId/workflowId/orgId are now the ONLY forms. See
    // governance-ledger-attribute-convention.test.ts, which pins this
    // structurally across all three TS writers.
    expect(Object.keys(item).sort()).toEqual(
      [
        "findingId",
        "workflowId",
        "timestamp",
        "decision",
        "requesting_agent",
        "target_agent",
        "reason",
        "decided_by",
        "category",
        "orgId",
        "environment",
        "release_id",
        "ttl",
      ].sort(),
    );
  });
});
