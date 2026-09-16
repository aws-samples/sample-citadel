/**
 * Tests for chatter-subscription-authorizer (wave-2a tenancy fix, finding
 * 87a171ad section A).
 *
 * The `onChatter`/`onFabricationEvent` subscription fields gain an
 * `orgId: ID!` argument used by AppSync's implicit subscription filter,
 * but the filter alone is not isolation — a client could subscribe with
 * an arbitrary (victim) orgId and the filter would happily match once a
 * message with that orgId is published. This resolver is the connect-time
 * authorization gate: it must reject when the requested orgId does not
 * match the caller's own organization (unless the caller is an admin).
 */
import { AppSyncResolverEvent } from "aws-lambda";
import {
  handler,
  CrossOrgSubscriptionError,
} from "../chatter-subscription-authorizer";

jest.mock("../../utils/auth-event", () => ({
  extractOrgFromEvent: jest.fn(),
  isAdminFromEvent: jest.fn(),
}));

import { extractOrgFromEvent, isAdminFromEvent } from "../../utils/auth-event";

const mockExtractOrg = extractOrgFromEvent as jest.Mock;
const mockIsAdmin = isAdminFromEvent as jest.Mock;

function makeEvent(
  requestedOrgId: string | undefined,
  fieldName: string = "onChatter",
): AppSyncResolverEvent<{ orgId: string }> {
  return {
    arguments: { orgId: requestedOrgId as string },
    info: {
      fieldName,
      parentTypeName: "Subscription",
      variables: {},
      selectionSetList: [],
      selectionSetGraphQL: "",
    },
    identity: {},
    source: null,
    request: { headers: {}, domainName: null },
    prev: null,
    stash: {},
  } as unknown as AppSyncResolverEvent<{ orgId: string }>;
}

beforeEach(() => {
  jest.resetAllMocks();
});

describe("chatter-subscription-authorizer", () => {
  describe("cross-org reject", () => {
    it("rejects onChatter when requested orgId does not match caller's org", async () => {
      mockIsAdmin.mockReturnValue(false);
      mockExtractOrg.mockResolvedValue("org-mine");

      await expect(
        handler(makeEvent("org-victim", "onChatter")),
      ).rejects.toBeInstanceOf(CrossOrgSubscriptionError);
    });

    it("rejects onFabricationEvent when requested orgId does not match caller's org", async () => {
      mockIsAdmin.mockReturnValue(false);
      mockExtractOrg.mockResolvedValue("org-mine");

      await expect(
        handler(makeEvent("org-victim", "onFabricationEvent")),
      ).rejects.toBeInstanceOf(CrossOrgSubscriptionError);
    });

    it("rejects when the caller has no resolvable org at all (fail closed)", async () => {
      mockIsAdmin.mockReturnValue(false);
      mockExtractOrg.mockResolvedValue(null);

      await expect(handler(makeEvent("org-victim"))).rejects.toBeInstanceOf(
        CrossOrgSubscriptionError,
      );
    });

    it("rejects when no orgId argument is supplied at all", async () => {
      mockIsAdmin.mockReturnValue(false);
      mockExtractOrg.mockResolvedValue("org-mine");

      await expect(handler(makeEvent(undefined))).rejects.toBeInstanceOf(
        CrossOrgSubscriptionError,
      );
    });
  });

  describe("same-org allow", () => {
    it("allows onChatter when requested orgId matches caller's org", async () => {
      mockIsAdmin.mockReturnValue(false);
      mockExtractOrg.mockResolvedValue("org-mine");

      await expect(
        handler(makeEvent("org-mine", "onChatter")),
      ).resolves.toBeNull();
    });

    it("allows onFabricationEvent when requested orgId matches caller's org", async () => {
      mockIsAdmin.mockReturnValue(false);
      mockExtractOrg.mockResolvedValue("org-mine");

      await expect(
        handler(makeEvent("org-mine", "onFabricationEvent")),
      ).resolves.toBeNull();
    });
  });

  describe("admin bypass", () => {
    it("allows an admin caller to subscribe to any orgId", async () => {
      mockIsAdmin.mockReturnValue(true);
      mockExtractOrg.mockResolvedValue(null);

      await expect(handler(makeEvent("org-any-tenant"))).resolves.toBeNull();

      expect(mockExtractOrg).not.toHaveBeenCalled();
    });
  });
});
