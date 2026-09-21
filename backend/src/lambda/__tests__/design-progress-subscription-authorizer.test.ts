/**
 * Tests for design-progress-subscription-authorizer (finding 195b2a58
 * item b).
 *
 * The `onDesignProgress(projectId: ID!)` subscription field gains a
 * connect-time authorization gate, mirroring chatter-subscription-authorizer.ts
 * but scoped by PROJECT (via the shared assertProjectAccess gate) rather
 * than by org, since onDesignProgress's implicit filter argument is
 * projectId, not orgId.
 */
import { AppSyncResolverEvent } from "aws-lambda";
import {
  handler,
  CrossOrgDesignProgressSubscriptionError,
} from "../design-progress-subscription-authorizer";

const assertProjectAccessMock = jest.fn();
jest.mock("../../utils/project-access", () => ({
  assertProjectAccess: (...args: unknown[]) => assertProjectAccessMock(...args),
}));

jest.mock("../../utils/appsync", () => ({
  getUserId: jest.fn().mockReturnValue("user-123"),
}));

function makeEvent(
  requestedProjectId: string | undefined,
): AppSyncResolverEvent<{ projectId: string }> {
  return {
    arguments: { projectId: requestedProjectId as string },
    info: {
      fieldName: "onDesignProgress",
      parentTypeName: "Subscription",
      variables: {},
      selectionSetList: [],
      selectionSetGraphQL: "",
    },
    identity: { sub: "user-123" },
    source: null,
    request: { headers: {}, domainName: null },
    prev: null,
    stash: {},
  } as unknown as AppSyncResolverEvent<{ projectId: string }>;
}

beforeEach(() => {
  assertProjectAccessMock.mockReset();
});

describe("design-progress-subscription-authorizer", () => {
  it("rejects when assertProjectAccess denies (cross-project/cross-org caller)", async () => {
    assertProjectAccessMock.mockRejectedValue(new Error("Access denied"));

    await expect(handler(makeEvent("victim-proj"))).rejects.toBeInstanceOf(
      CrossOrgDesignProgressSubscriptionError,
    );
  });

  it("rejects when no projectId argument is supplied at all", async () => {
    assertProjectAccessMock.mockRejectedValue(new Error("Access denied"));

    await expect(handler(makeEvent(undefined))).rejects.toBeInstanceOf(
      CrossOrgDesignProgressSubscriptionError,
    );
  });

  it("allows when assertProjectAccess resolves (owner, org member, or admin)", async () => {
    assertProjectAccessMock.mockResolvedValue(undefined);

    await expect(handler(makeEvent("my-proj"))).resolves.toBeNull();
    expect(assertProjectAccessMock).toHaveBeenCalledWith(
      "my-proj",
      "user-123",
      expect.anything(),
    );
  });
});
