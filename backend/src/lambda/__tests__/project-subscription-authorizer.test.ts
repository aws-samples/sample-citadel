/**
 * Tests for project-subscription-authorizer — shared connect-time gate for
 * onAgentStatusUpdate, onConversationMessage, onProjectProgress,
 * onAssessmentCompleted (all projectId-keyed).
 */
import { AppSyncResolverEvent } from "aws-lambda";
import {
  handler,
  CrossProjectSubscriptionError,
} from "../project-subscription-authorizer";

const assertProjectAccessMock = jest.fn();
jest.mock("../../utils/project-access", () => ({
  assertProjectAccess: (...args: unknown[]) => assertProjectAccessMock(...args),
}));

jest.mock("../../utils/appsync", () => ({
  getUserId: jest.fn().mockReturnValue("user-123"),
}));

function makeEvent(
  requestedProjectId: string | undefined,
  fieldName: string = "onAgentStatusUpdate",
): AppSyncResolverEvent<{ projectId: string }> {
  return {
    arguments: { projectId: requestedProjectId as string },
    info: {
      fieldName,
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

describe("project-subscription-authorizer", () => {
  describe("owner/member positive — returns null", () => {
    it.each([
      "onAgentStatusUpdate",
      "onConversationMessage",
      "onProjectProgress",
      "onAssessmentCompleted",
    ])("%s allows when assertProjectAccess resolves", async (fieldName) => {
      assertProjectAccessMock.mockResolvedValue(undefined);

      await expect(
        handler(makeEvent("my-proj", fieldName)),
      ).resolves.toBeNull();
      expect(assertProjectAccessMock).toHaveBeenCalledWith(
        "my-proj",
        "user-123",
        expect.anything(),
      );
    });
  });

  describe("foreign/non-member — refused with identical error", () => {
    it.each([
      "onAgentStatusUpdate",
      "onConversationMessage",
      "onProjectProgress",
      "onAssessmentCompleted",
    ])(
      "%s rejects when assertProjectAccess denies (cross-project caller)",
      async (fieldName) => {
        assertProjectAccessMock.mockRejectedValue(new Error("Access denied"));

        await expect(
          handler(makeEvent("victim-proj", fieldName)),
        ).rejects.toBeInstanceOf(CrossProjectSubscriptionError);
      },
    );
  });

  describe("random id — refused (non-existent row same as foreign)", () => {
    it("rejects with a non-existent projectId", async () => {
      assertProjectAccessMock.mockRejectedValue(new Error("Access denied"));

      await expect(
        handler(makeEvent("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")),
      ).rejects.toBeInstanceOf(CrossProjectSubscriptionError);
    });
  });

  describe("empty arg — refused", () => {
    it("rejects when no projectId argument is supplied", async () => {
      await expect(handler(makeEvent(undefined))).rejects.toBeInstanceOf(
        CrossProjectSubscriptionError,
      );
      expect(assertProjectAccessMock).not.toHaveBeenCalled();
    });

    it("rejects when projectId is empty string", async () => {
      await expect(handler(makeEvent(""))).rejects.toBeInstanceOf(
        CrossProjectSubscriptionError,
      );
      expect(assertProjectAccessMock).not.toHaveBeenCalled();
    });
  });

  describe("unknown field — refused (fail closed)", () => {
    it("rejects when fieldName is not in the allowed set", async () => {
      assertProjectAccessMock.mockResolvedValue(undefined);

      await expect(
        handler(makeEvent("my-proj", "onSomethingElse")),
      ).rejects.toBeInstanceOf(CrossProjectSubscriptionError);
      expect(assertProjectAccessMock).not.toHaveBeenCalled();
    });

    it("rejects when fieldName is undefined", async () => {
      const event = makeEvent("my-proj");
      (event as unknown as { info: { fieldName: undefined } }).info.fieldName =
        undefined as unknown as string;

      await expect(handler(event)).rejects.toBeInstanceOf(
        CrossProjectSubscriptionError,
      );
    });
  });
});
