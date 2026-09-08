/**
 * governance-ledger-attribute-convention.test.ts — pins the unified
 * attribute-naming convention for the governance ledger table (decision
 * 2dd461f6, slice 1: naming/readability only, NOT filtering).
 *
 * Convention chosen: camelCase for every attribute this table's writers
 * emit and its readers project — `findingId`, `workflowId`, `orgId` —
 * matching (a) the table's OWN key schema, where `findingId` is already
 * the HASH key and `workflowId` the `workflow-index` GSI HASH key
 * (arbiter/governance/ledger.py::_serialize_finding's own comment), and
 * (b) the dominant convention across the REST of the repo's DynamoDB
 * tables: 16 CDK table definitions use `orgId` as a literal attribute/key
 * name versus zero tables using `org_id` anywhere in a key schema.
 *
 * This is a STRUCTURAL check, not a string search over source text: each
 * writer is invoked with a real input and the *actual PutCommand Item* it
 * sends to DynamoDB is inspected. A future writer that reintroduces
 * `org_id` / `finding_id` / `workflow_id` (the pre-slice-1 legacy
 * snake_case duplicates for these three attributes) fails this test the
 * moment it's wired up, regardless of what the source code text looks
 * like.
 *
 * NOT covered here (deliberately, per slice 1 scope):
 *  - eval-drift-finding-writer.ts has no org field at all (never did) —
 *    it is covered by its own test file's shape assertion, not duplicated
 *    here.
 *  - The Python writer (arbiter/governance/ledger.py) is NOT covered by
 *    this file — it is a separate runtime/test toolchain (pytest, not
 *    Vitest) and covering it structurally here is not practical. The
 *    Python side already emits ONLY camelCase key-schema aliases
 *    (findingId/workflowId) via `_serialize_finding` and never emits an
 *    org attribute today (models.py::GovernanceFinding has no org field),
 *    so there is nothing to pin snake-case-wise on that side yet; slice 2
 *    (which adds the org value) is where a Python-side pin belongs.
 *  - Readers' OLD-name fallback (this slice's compatibility requirement)
 *    is covered in governance-ui-resolver.test.ts, not here — this file
 *    only pins what NEW writes look like.
 */
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";

process.env.GOVERNANCE_LEDGER_TABLE = "citadel-governance-ledger-test";

import { writeReleaseGateFinding } from "../release-gate-finding-writer";
import { writeReleasePromotionApprovalFinding } from "../release-promotion-approval-writer";
import { writeAutoRollbackFinding } from "../auto-rollback-finding-writer";

const ddbMock = mockClient(DynamoDBDocumentClient);

beforeEach(() => {
  ddbMock.reset();
  ddbMock.on(PutCommand).resolves({});
});

/** The pre-slice-1 legacy snake_case duplicates being retired by this
 * slice. A writer item must never contain these keys going forward —
 * only their camelCase equivalents (`findingId`, `workflowId`, `orgId`). */
const BANNED_LEGACY_DUPLICATE_KEYS = ["finding_id", "workflow_id", "org_id"];

function assertUnifiedConvention(item: Record<string, unknown>): void {
  for (const bannedKey of BANNED_LEGACY_DUPLICATE_KEYS) {
    expect(Object.prototype.hasOwnProperty.call(item, bannedKey)).toBe(false);
  }
  // The camelCase forms MUST be present — this isn't just "absence of the
  // old name", it's "presence of the unified name".
  expect(typeof item.findingId).toBe("string");
  expect(typeof item.workflowId).toBe("string");
  expect(typeof item.orgId).toBe("string");
}

describe("governance ledger attribute-naming convention (decision 2dd461f6, slice 1)", () => {
  test("release-gate-finding-writer emits only the unified camelCase attributes", async () => {
    await writeReleaseGateFinding({
      orgId: "org-1",
      agentTargetId: "agent-1",
      environment: "PROD",
      releaseId: "release-1",
      decidedBy: "user-architect",
      decision: "deny",
      reasons: ["MATERIAL_REGRESSION"],
      scoreVector: [
        { dimension: "task_success", passRate: 0.5, scoredCount: 10 },
      ],
      mode: "strict",
    });
    const item = ddbMock.commandCalls(PutCommand)[0].args[0].input
      .Item as Record<string, unknown>;
    assertUnifiedConvention(item);
  });

  test("release-promotion-approval-writer emits only the unified camelCase attributes", async () => {
    await writeReleasePromotionApprovalFinding({
      orgId: "org-1",
      agentTargetId: "agent-1",
      environment: "PROD",
      releaseId: "release-1",
      decidedBy: "user-architect",
      decision: "permit",
    });
    const item = ddbMock.commandCalls(PutCommand)[0].args[0].input
      .Item as Record<string, unknown>;
    assertUnifiedConvention(item);
  });

  test("auto-rollback-finding-writer emits only the unified camelCase attributes", async () => {
    await writeAutoRollbackFinding({
      orgId: "org-1",
      agentTargetId: "agent-1",
      environment: "PROD",
      fromVersion: 3,
      action: "AUTO_ROLLBACK",
      evidence: {
        metric: "errorRate",
        arm: "candidate",
        observedValue: 0.5,
        threshold: 0.1,
        sampleCount: 100,
        windowStart: "2026-01-01T00:00:00Z",
        windowEnd: "2026-01-01T01:00:00Z",
        candidateReleaseId: "release-2",
        stableReleaseId: "release-1",
        fromReleaseId: "release-1",
        toReleaseId: "release-2",
        action: "AUTO_ROLLBACK",
        fromVersion: 3,
      },
    });
    const item = ddbMock.commandCalls(PutCommand)[0].args[0].input
      .Item as Record<string, unknown>;
    assertUnifiedConvention(item);
  });
});
