/**
 * useChatterSubscription Hook Tests
 * TDD — the hook must subscribe using the caller's own organisation (from
 * OrganizationContext), never a hardcoded value, and must not subscribe at
 * all when no organisation is available for the caller.
 */

jest.mock("../../services/chatterService", () => ({
  __esModule: true,
  subscribeToChatter: jest.fn(),
}));

const mockUseOrganization = jest.fn();
jest.mock("../../contexts/OrganizationContext", () => ({
  __esModule: true,
  useOrganization: () => mockUseOrganization(),
}));

import { renderHook } from "@testing-library/react";
import { useChatterSubscription } from "../useChatterSubscription";
import { subscribeToChatter } from "../../services/chatterService";

const mockSubscribeToChatter = subscribeToChatter as jest.MockedFunction<typeof subscribeToChatter>;

const CALLER_ORG_ID = "org-caller-1";

function withCallerOrg(organization: string | null = CALLER_ORG_ID) {
  mockUseOrganization.mockReturnValue({
    currentUser: organization ? { organization } : null,
    selectedOrganization: null,
    setSelectedOrganization: jest.fn(),
    organizations: [],
    isAdmin: false,
    loading: false,
  });
}

describe("useChatterSubscription", () => {
  let mockUnsubscribe: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockUnsubscribe = jest.fn();
    mockSubscribeToChatter.mockReturnValue(mockUnsubscribe);
    withCallerOrg();
  });

  it("subscribes with the caller's own organisation", () => {
    renderHook(() => useChatterSubscription(jest.fn(), true));

    expect(mockSubscribeToChatter).toHaveBeenCalledWith(expect.any(Function), CALLER_ORG_ID);
  });

  it("does not subscribe when no organisation is available", () => {
    withCallerOrg(null);

    renderHook(() => useChatterSubscription(jest.fn(), true));

    expect(mockSubscribeToChatter).not.toHaveBeenCalled();
  });

  it("does not subscribe when disabled, even with an organisation", () => {
    renderHook(() => useChatterSubscription(jest.fn(), false));

    expect(mockSubscribeToChatter).not.toHaveBeenCalled();
  });

  it("never uses the selected/filter organisation as the subscription identity", () => {
    // A non-admin's selectedOrganization must never leak into the subscribe
    // call — only currentUser.organization (the caller's own claim) may.
    mockUseOrganization.mockReturnValue({
      currentUser: { organization: CALLER_ORG_ID },
      selectedOrganization: "some-other-org-selector-value",
      setSelectedOrganization: jest.fn(),
      organizations: [],
      isAdmin: false,
      loading: false,
    });

    renderHook(() => useChatterSubscription(jest.fn(), true));

    expect(mockSubscribeToChatter).toHaveBeenCalledWith(expect.any(Function), CALLER_ORG_ID);
    expect(mockSubscribeToChatter).not.toHaveBeenCalledWith(
      expect.any(Function),
      "some-other-org-selector-value",
    );
  });

  it("unsubscribes on unmount", () => {
    const { unmount } = renderHook(() => useChatterSubscription(jest.fn(), true));

    unmount();

    expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
  });

  it("tears down an active subscription when the organisation becomes unavailable", () => {
    const { rerender } = renderHook(
      ({ enabled }) => useChatterSubscription(jest.fn(), enabled),
      { initialProps: { enabled: true } },
    );

    expect(mockSubscribeToChatter).toHaveBeenCalledTimes(1);

    withCallerOrg(null);
    rerender({ enabled: true });

    expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
  });
});
