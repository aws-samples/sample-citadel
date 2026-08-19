/**
 * Tests for auto-rollback-finding-writer.ts — write-once GovernanceFinding
 * row for an automated rollback (decision D6, no schema change D7).
 */
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { createHash } from "crypto";

import {
  RELEASE_ROLLBACK_DECIDED_BY,
  writeAutoRollbackFinding,
  type AutoRollbackFindingInput,
  type RollbackEvidence,
} from "../auto-rollback-finding-writer";

const ddbMock = mockClient(DynamoDBDocumentClient);

function evidence(overrides: Partial<RollbackEvidence> = {}): RollbackEvidence {
  return {
    metric: "costPerInvocation",
    arm: "candidate",
    observedValue: 1500,
    threshold: 1000,
    sampleCount: 100,
    windowStart: "2026-08-18T20:00:00.000Z",
    windowEnd: "2026-08-18T20:15:00.000Z",
    candidateReleaseId: "rel-candidate",
    stableReleaseId: "rel-stable",
    fromReleaseId: "rel-stable",
    toReleaseId: "rel-stable",
    action: "AUTO_ABORT_CANARY",
    fromVersion: 7,
    ...overrides,
  };
}

function input(
  overrides: Partial<AutoRollbackFindingInput> = {},
): AutoRollbackFindingInput {
  return {
    orgId: "org-1",
    agentTargetId: "agent-1",
    environment: "staging",
    fromVersion: 7,
    action: "AUTO_ABORT_CANARY",
    evidence: evidence(),
    ...overrides,
  };
}

beforeEach(() => {
  ddbMock.reset();
  process.env.GOVERNANCE_LEDGER_TABLE = "test-governance-ledger";
});

afterEach(() => {
  delete process.env.GOVERNANCE_LEDGER_TABLE;
});

describe("writeAutoRollbackFinding", () => {
  it("attaches metric evidence and a server-minted decided_by to the finding", async () => {
    ddbMock.on(PutCommand).resolves({});
    await writeAutoRollbackFinding(input());

    const call = ddbMock.commandCalls(PutCommand)[0];
    const item = call.args[0].input.Item as Record<string, unknown>;
    expect(item.category).toBe("auto-rollback");
    expect(item.decided_by).toBe(RELEASE_ROLLBACK_DECIDED_BY);
    expect(item.rollback_evidence).toMatchObject({
      metric: "costPerInvocation",
      arm: "candidate",
      observedValue: 1500,
      threshold: 1000,
      sampleCount: 100,
      fromReleaseId: "rel-stable",
      toReleaseId: "rel-stable",
    });
    expect(call.args[0].input.ConditionExpression).toBe(
      "attribute_not_exists(findingId)",
    );
  });

  it("derives a deterministic findingId keyed on org#agent#env#fromVersion#action", async () => {
    ddbMock.on(PutCommand).resolves({});
    await writeAutoRollbackFinding(input());
    const item = ddbMock.commandCalls(PutCommand)[0].args[0].input
      .Item as Record<string, unknown>;
    const expected = createHash("sha256")
      .update("org-1#agent-1#staging#7#AUTO_ABORT_CANARY")
      .digest("hex");
    expect(item.findingId).toBe(expected);
  });

  it("swallows the write-once dedupe rejection (idempotent re-write)", async () => {
    const dedupeErr = Object.assign(new Error("dup"), {
      name: "ConditionalCheckFailedException",
    });
    ddbMock.on(PutCommand).rejects(dedupeErr);
    await expect(writeAutoRollbackFinding(input())).resolves.toBeUndefined();
  });

  it("rethrows any non-dedupe error so the evaluator can alarm on it", async () => {
    ddbMock.on(PutCommand).rejects(new Error("ProvisionedThroughputExceeded"));
    await expect(writeAutoRollbackFinding(input())).rejects.toThrow(
      "ProvisionedThroughputExceeded",
    );
  });
});
