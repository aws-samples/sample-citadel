/**
 * Tests for design-progress-resolver (finding 195b2a58 item a).
 *
 * Mutation.publishDesignProgress was a bare pass-through echo reachable
 * with any authenticated Cognito identity. Fix mirrors
 * intake-orchestration-resolver.ts's isIamIdentity guard: only an
 * IAM-authed invocation (the confirmed publisher, design-progress-notifier.ts)
 * may publish.
 */
import { AppSyncResolverEvent } from "aws-lambda";
import { handler, DesignProgressInput } from "../design-progress-resolver";

function makeEvent(
  identity: unknown,
  input: DesignProgressInput,
): AppSyncResolverEvent<{ input: DesignProgressInput }> {
  return {
    arguments: { input },
    info: {
      fieldName: "publishDesignProgress",
      parentTypeName: "Mutation",
      variables: {},
      selectionSetList: [],
      selectionSetGraphQL: "",
    },
    identity,
    source: null,
    request: { headers: {}, domainName: null },
    prev: null,
    stash: {},
  } as unknown as AppSyncResolverEvent<{ input: DesignProgressInput }>;
}

const validInput: DesignProgressInput = {
  projectId: "proj-1",
  sectionId: "architecture",
  completionPercentage: 50,
  timestamp: "2026-01-01T00:00:00Z",
};

describe("design-progress-resolver", () => {
  it("rejects a Cognito user-pool identity (has sub) — end users can no longer publish", async () => {
    await expect(
      handler(makeEvent({ sub: "user-123" }, validInput)),
    ).rejects.toThrow("IAM-only");
  });

  it("rejects an OIDC identity (has claims)", async () => {
    await expect(
      handler(makeEvent({ claims: { sub: "user-123" } }, validInput)),
    ).rejects.toThrow("IAM-only");
  });

  it("rejects a missing/null identity (fail closed)", async () => {
    await expect(handler(makeEvent(null, validInput))).rejects.toThrow(
      "IAM-only",
    );
  });

  it("rejects a malformed identity object with no accountId", async () => {
    await expect(handler(makeEvent({}, validInput))).rejects.toThrow(
      "IAM-only",
    );
  });

  it("allows an IAM identity (has accountId, no sub/claims) — design-progress-notifier's publish path", async () => {
    const result = await handler(
      makeEvent({ accountId: "123456789012" }, validInput),
    );
    expect(result).toEqual(validInput);
  });
});
