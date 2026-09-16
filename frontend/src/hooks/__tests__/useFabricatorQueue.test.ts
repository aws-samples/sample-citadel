/**
 * useFabricatorQueue Hook Tests
 * TDD — the hook must subscribe to fabrication events using the caller's
 * own organisation (from OrganizationContext), never a hardcoded value,
 * and must not subscribe at all when no organisation is available.
 */

jest.mock("sonner", () => ({
  __esModule: true,
  toast: {
    success: jest.fn(),
    error: jest.fn(),
  },
}));

jest.mock("../../services/fabricatorQueueService", () => ({
  __esModule: true,
  fabricatorQueueService: {
    getFabricatorQueue: jest.fn(),
    subscribeToFabricationEvents: jest.fn(),
  },
}));

const mockUseOrganization = jest.fn();
jest.mock("../../contexts/OrganizationContext", () => ({
  __esModule: true,
  useOrganization: () => mockUseOrganization(),
}));

import { renderHook, waitFor } from "@testing-library/react";
import { useFabricatorQueue } from "../useFabricatorQueue";
import { fabricatorQueueService } from "../../services/fabricatorQueueService";

const mockGetQueue = fabricatorQueueService.getFabricatorQueue as jest.MockedFunction<
  typeof fabricatorQueueService.getFabricatorQueue
>;
const mockSubscribe = fabricatorQueueService.subscribeToFabricationEvents as jest.MockedFunction<
  typeof fabricatorQueueService.subscribeToFabricationEvents
>;

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

describe("useFabricatorQueue", () => {
  let mockUnsubscribe: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockUnsubscribe = jest.fn();
    mockGetQueue.mockResolvedValue([]);
    mockSubscribe.mockReturnValue(mockUnsubscribe);
    withCallerOrg();
  });

  it("subscribes with the caller's own organisation", async () => {
    renderHook(() => useFabricatorQueue());

    await waitFor(() =>
      expect(mockSubscribe).toHaveBeenCalledWith(
        expect.any(Function),
        CALLER_ORG_ID,
        expect.any(Function),
      ),
    );
  });

  it("does not subscribe when no organisation is available", async () => {
    withCallerOrg(null);

    renderHook(() => useFabricatorQueue());

    await waitFor(() => expect(mockGetQueue).toHaveBeenCalled());
    expect(mockSubscribe).not.toHaveBeenCalled();
  });

  it("still loads the queue even when no organisation is available", async () => {
    withCallerOrg(null);

    renderHook(() => useFabricatorQueue());

    await waitFor(() => expect(mockGetQueue).toHaveBeenCalled());
  });

  it("unsubscribes on unmount", async () => {
    const { unmount } = renderHook(() => useFabricatorQueue());

    await waitFor(() => expect(mockSubscribe).toHaveBeenCalled());

    unmount();

    expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
  });
});
