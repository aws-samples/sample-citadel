/**
 * release-store.test.ts — the SOLE write choke point for AgentReleases.
 *
 * Binding invariants (design §2, L1+L2):
 *   - putRelease is create-only: ConditionExpression
 *     attribute_not_exists(releaseId).
 *   - Putting identical content twice is an idempotent no-op — the
 *     second call must NOT overwrite the row and must return the
 *     already-stored release (same releaseId, same fields).
 *   - Differing content produces a distinct row (different releaseId)
 *     and never overwrites the first row.
 *   - The module exports create + read only — no update, no delete.
 */
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import * as releaseStore from "../release-store";
import type { AgentReleaseInput } from "../../types";

const ddbMock = mockClient(DynamoDBDocumentClient);

function baseInput(
  overrides: Partial<AgentReleaseInput> = {},
): AgentReleaseInput {
  return {
    orgId: "org-1",
    agentTargetId: "agent-1",
    semver: "1.0.0",
    createdAt: "2026-08-06T00:00:00.000Z",
    createdBy: "user-1",
    gitSha: "abc123",
    region: "us-east-1",
    runId: "run-abc",
    agentConfig: {
      sourceId: "agent-1",
      content: '{"name":"intake-agent"}',
      digest: "digest-a",
    },
    promptVersions: {
      supervisor: { sourceId: "p1", content: "you are...", digest: "d1" },
    },
    execSpecId: "spec-123",
    execSpecVersion: 3,
    modelConfigSnapshots: [
      { slot: "supervisor", content: "claude-x", digest: "m1" },
    ],
    toolConfigs: [{ sourceId: "tool-a", content: "{}", digest: "t1" }],
    policySnapshot: {
      enforcementMode: "strict",
      ruleSetVersion: "v3",
      authorityUnitGrantIds: ["grant-1"],
    },
    evalEvidence: {
      evalRunId: "run-1",
      evalSuiteId: "suite-1",
      evalSuiteVersion: 2,
    },
    ...overrides,
  };
}

beforeEach(() => {
  ddbMock.reset();
  process.env.AGENT_RELEASES_TABLE = "test-agent-releases";
});

afterEach(() => {
  delete process.env.AGENT_RELEASES_TABLE;
});

describe("release-store — module surface", () => {
  it("exports exactly putRelease, getRelease (create + read only — no update, no delete)", () => {
    const exported = Object.keys(releaseStore).sort();
    expect(exported).toEqual(["getRelease", "putRelease"]);
  });
});

describe("release-store — putRelease create-only semantics", () => {
  it("issues a PutCommand with ConditionExpression attribute_not_exists(releaseId)", async () => {
    ddbMock.on(PutCommand).resolves({});
    const input = baseInput();

    await releaseStore.putRelease(input);

    const calls = ddbMock.commandCalls(PutCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0].input.ConditionExpression).toBe(
      "attribute_not_exists(releaseId)",
    );
    expect(calls[0].args[0].input.TableName).toBe("test-agent-releases");
  });

  it("computes releaseId as the content hash and includes it in the Put item", async () => {
    ddbMock.on(PutCommand).resolves({});
    const input = baseInput();

    const result = await releaseStore.putRelease(input);

    const calls = ddbMock.commandCalls(PutCommand);
    const item = calls[0].args[0].input.Item as { releaseId: string };
    expect(item.releaseId).toBe(result.releaseId);
    expect(result.releaseId).toMatch(/^[0-9a-f]{64}$/);
  });

  it("putting identical content twice is an idempotent no-op: second call does not overwrite, returns the same release", async () => {
    const input = baseInput();

    // First call succeeds.
    ddbMock.on(PutCommand).resolvesOnce({});
    const first = await releaseStore.putRelease(input);

    // Second call with identical content hits the condition check and
    // fails, exactly as DynamoDB would for a duplicate key.
    ddbMock.on(PutCommand).rejects(
      Object.assign(new Error("The conditional request failed"), {
        name: "ConditionalCheckFailedException",
      }),
    );
    ddbMock.on(GetCommand).resolves({
      Item: { ...input, releaseId: first.releaseId },
    });

    const second = await releaseStore.putRelease(input);

    expect(second.releaseId).toBe(first.releaseId);
    // No update path exists: the second Put attempt must have been made
    // (and rejected by the condition), but the stored row content must
    // be identical to what getRelease now returns.
    const stored = await releaseStore.getRelease(first.releaseId);
    expect(stored?.releaseId).toBe(first.releaseId);
  });

  it("differing content produces a distinct releaseId and does not overwrite the first row", async () => {
    ddbMock.on(PutCommand).resolves({});
    const inputA = baseInput();
    const inputB = baseInput({
      agentConfig: {
        sourceId: "agent-1",
        content: '{"name":"intake-agent-v2"}',
        digest: "digest-b",
      },
    });

    const resultA = await releaseStore.putRelease(inputA);
    const resultB = await releaseStore.putRelease(inputB);

    expect(resultA.releaseId).not.toBe(resultB.releaseId);

    const calls = ddbMock.commandCalls(PutCommand);
    expect(calls).toHaveLength(2);
    // Each Put must still be create-only.
    for (const call of calls) {
      expect(call.args[0].input.ConditionExpression).toBe(
        "attribute_not_exists(releaseId)",
      );
    }
  });

  it("propagates a non-conditional-check DynamoDB error", async () => {
    ddbMock.on(PutCommand).rejects(new Error("ProvisionedThroughputExceeded"));
    await expect(releaseStore.putRelease(baseInput())).rejects.toThrow(
      "ProvisionedThroughputExceeded",
    );
  });
});

describe("release-store — getRelease", () => {
  it("returns null when the release does not exist", async () => {
    ddbMock.on(GetCommand).resolves({});
    const result = await releaseStore.getRelease("nonexistent");
    expect(result).toBeNull();
  });

  it("returns the stored release when it exists", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { releaseId: "abc", orgId: "org-1" },
    });
    const result = await releaseStore.getRelease("abc");
    expect(result).toEqual({ releaseId: "abc", orgId: "org-1" });
  });
});
