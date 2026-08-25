/**
 * Tests for approval-required tool gating — the decideToolApproval resolver +
 * grant writer (finding c947aa77).
 *
 * Covers the settled security constraints:
 *   * authz: tool:approve permission required (missing ⇒ Unauthorized);
 *   * org match: a caller may only grant for their OWN org (cross-org ⇒
 *     Unauthorized);
 *   * decidedBy is SERVER-DERIVED from Cognito and can NEVER be caller-
 *     supplied — a hostile-cast `decidedBy` in the arguments is dropped and
 *     the persisted row carries the identity's userId (hostile-cast red proof);
 *   * write-once dedupe is swallowed (idempotent grant); other errors rethrow
 *     (fail-closed).
 */
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";

// extractOrgFromEvent hits Cognito; stub it to a deterministic caller org.
jest.mock("../../utils/auth-event", () => ({
  extractOrgFromEvent: jest.fn(),
}));
import { extractOrgFromEvent } from "../../utils/auth-event";

import { handler } from "../tool-approval-resolver";
import { grantFindingId } from "../utils/tool-approval-grant-writer";

const ddbMock = mockClient(DynamoDBDocumentClient);

const CALLER_ORG = "org-caller";

beforeEach(() => {
  ddbMock.reset();
  (extractOrgFromEvent as jest.Mock).mockReset();
  process.env.GOVERNANCE_LEDGER_TABLE = "gov-ledger-test";
  ddbMock.on(PutCommand).resolves({});
});

function architectEvent(inputOverrides: Record<string, unknown> = {}) {
  return {
    info: { fieldName: "decideToolApproval" },
    identity: {
      sub: "user-alice",
      username: "alice",
      "custom:role": "architect",
    },
    arguments: {
      input: {
        workflowDefinitionId: "wf-def-1",
        nodeId: "node-1",
        toolName: "gated_tool",
        ...inputOverrides,
      },
    },
  } as never;
}

describe("decideToolApproval — authz", () => {
  test("missing tool:approve permission ⇒ Unauthorized (developer role)", async () => {
    const event = {
      info: { fieldName: "decideToolApproval" },
      identity: { sub: "u", username: "u", "custom:role": "developer" },
      arguments: {
        input: { workflowDefinitionId: "w", nodeId: "n", toolName: "t" },
      },
    } as never;
    (extractOrgFromEvent as jest.Mock).mockResolvedValue(CALLER_ORG);
    await expect(handler(event)).rejects.toThrow(/UnauthorizedError/);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0); // never written
  });

  test("architect role is permitted and the grant is written", async () => {
    (extractOrgFromEvent as jest.Mock).mockResolvedValue(CALLER_ORG);
    const res = (await handler(architectEvent())) as { decidedBy: string };
    expect(res.decidedBy).toBe("user-alice");
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(1);
  });

  test("cross-org grant attempt ⇒ Unauthorized, nothing written", async () => {
    (extractOrgFromEvent as jest.Mock).mockResolvedValue(CALLER_ORG);
    await expect(
      handler(architectEvent({ orgId: "some-OTHER-org" })),
    ).rejects.toThrow(/different organization/);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  test("matching orgId in input is accepted", async () => {
    (extractOrgFromEvent as jest.Mock).mockResolvedValue(CALLER_ORG);
    await handler(architectEvent({ orgId: CALLER_ORG }));
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(1);
  });

  test("caller org cannot be determined ⇒ ValidationError", async () => {
    (extractOrgFromEvent as jest.Mock).mockResolvedValue(null);
    await expect(handler(architectEvent())).rejects.toThrow(
      /organization could not be determined/,
    );
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });
});

describe("decideToolApproval — decidedBy is server-derived (hostile-cast red proof)", () => {
  test("a caller-supplied decidedBy in the arguments cannot be persisted", async () => {
    (extractOrgFromEvent as jest.Mock).mockResolvedValue(CALLER_ORG);
    // Hostile cast: stuff a decidedBy into the input (not in the typed schema).
    const event = architectEvent({
      decidedBy: "attacker-impersonated-admin",
    } as never);
    await handler(event);
    const put = ddbMock.commandCalls(PutCommand)[0].args[0].input as {
      Item: Record<string, unknown>;
    };
    // The persisted decided_by is the Cognito identity's userId, NEVER the
    // caller-supplied value. There is no code path that reads input.decidedBy.
    expect(put.Item.decided_by).toBe("user-alice");
    expect(put.Item.decided_by).not.toBe("attacker-impersonated-admin");
    // And the persisted orgId is the server-derived caller org.
    expect(put.Item.orgId).toBe(CALLER_ORG);
  });

  test("decidedBy is the identity even when username differs from sub", async () => {
    (extractOrgFromEvent as jest.Mock).mockResolvedValue(CALLER_ORG);
    const event = {
      info: { fieldName: "decideToolApproval" },
      identity: { sub: "sub-123", username: "bob", "custom:role": "architect" },
      arguments: {
        input: { workflowDefinitionId: "w", nodeId: "n", toolName: "t" },
      },
    } as never;
    const res = (await handler(event)) as { decidedBy: string };
    expect(res.decidedBy).toBe("sub-123"); // sub preferred over username
  });
});

describe("tool-approval grant writer — write-once + id derivation", () => {
  test("deterministic findingId over the FULL tuple, prefixed, no prefix collision", () => {
    const base = grantFindingId({
      orgId: "o",
      workflowDefinitionId: "w",
      nodeId: "n",
      toolName: "t",
    });
    expect(base.startsWith("tool-approval:")).toBe(true);
    expect(base).not.toBe(
      grantFindingId({
        orgId: "o",
        workflowDefinitionId: "w",
        nodeId: "n",
        toolName: "t2",
      }),
    );
    expect(base).not.toBe(
      grantFindingId({
        orgId: "o2",
        workflowDefinitionId: "w",
        nodeId: "n",
        toolName: "t",
      }),
    );
  });

  test("write-once dedupe (ConditionalCheckFailedException) is swallowed, not thrown", async () => {
    (extractOrgFromEvent as jest.Mock).mockResolvedValue(CALLER_ORG);
    const condErr = Object.assign(new Error("dup"), {
      name: "ConditionalCheckFailedException",
    });
    ddbMock.on(PutCommand).rejects(condErr);
    // Idempotent: a duplicate grant for the exact tuple resolves cleanly.
    await expect(handler(architectEvent())).resolves.toBeDefined();
  });

  test("a non-dedupe write error is rethrown (fail-closed)", async () => {
    (extractOrgFromEvent as jest.Mock).mockResolvedValue(CALLER_ORG);
    ddbMock.on(PutCommand).rejects(new Error("throttled"));
    await expect(handler(architectEvent())).rejects.toThrow(/throttled/);
  });

  test("expiresAt and ttl are integer epochs and DISTINCT (validity != retention)", async () => {
    (extractOrgFromEvent as jest.Mock).mockResolvedValue(CALLER_ORG);
    await handler(architectEvent({ validitySeconds: 600 }));
    const put = ddbMock.commandCalls(PutCommand)[0].args[0].input as {
      Item: Record<string, number>;
    };
    expect(Number.isInteger(put.Item.expiresAt as number)).toBe(true);
    expect(Number.isInteger(put.Item.ttl as number)).toBe(true);
    // 90-day retention ttl is far beyond the short application validity.
    expect(put.Item.ttl).toBeGreaterThan(put.Item.expiresAt);
  });
});
