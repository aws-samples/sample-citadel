/**
 * useFabricationQueue(projectId) – shared polling hook.
 *
 * Must: accept projectId and pass it to getFabricatorQueue; poll every 10s
 * while any item is non-terminal (PENDING | PROCESSING); stop polling when
 * all items are terminal (COMPLETED | FAILED) or the component unmounts;
 * update items IN PLACE on real-time events (not remove them); expose
 * allTerminal / allBuilt derived booleans.
 */

jest.mock('../../services/fabricatorQueueService', () => ({
  __esModule: true,
  fabricatorQueueService: {
    getFabricatorQueue: jest.fn(),
    subscribeToFabricationEvents: jest.fn(),
  },
}));

const mockUseOrganization = jest.fn();
jest.mock('../../contexts/OrganizationContext', () => ({
  __esModule: true,
  useOrganization: () => mockUseOrganization(),
}));

jest.mock('sonner', () => ({
  __esModule: true,
  toast: { success: jest.fn(), error: jest.fn() },
}));

import { renderHook, act, waitFor } from '@testing-library/react';
import { fabricatorQueueService } from '../../services/fabricatorQueueService';
import type { FabricationQueueItem, FabricationEvent } from '../../services/fabricatorQueueService';
import { useFabricationQueue } from '../useFabricationQueue';

const mockGetQueue = fabricatorQueueService.getFabricatorQueue as jest.MockedFunction<
  typeof fabricatorQueueService.getFabricatorQueue
>;
const mockSubscribe = fabricatorQueueService.subscribeToFabricationEvents as jest.MockedFunction<
  typeof fabricatorQueueService.subscribeToFabricationEvents
>;

const CALLER_ORG_ID = 'org-caller-1';
function withCallerOrg(org: string | null = CALLER_ORG_ID) {
  mockUseOrganization.mockReturnValue({
    currentUser: org ? { organization: org } : null,
    selectedOrganization: null,
    setSelectedOrganization: jest.fn(),
    organizations: [],
    isAdmin: false,
    loading: false,
  });
}

const MIXED_ITEMS: FabricationQueueItem[] = [
  { requestId: 'r1', agentName: 'alpha', taskDescription: '', status: 'PROCESSING', submittedAt: '' },
  { requestId: 'r2', agentName: 'beta', taskDescription: '', status: 'COMPLETED', submittedAt: '' },
];

const ALL_DONE: FabricationQueueItem[] = [
  { requestId: 'r1', agentName: 'alpha', taskDescription: '', status: 'COMPLETED', submittedAt: '' },
  { requestId: 'r2', agentName: 'beta', taskDescription: '', status: 'COMPLETED', submittedAt: '' },
];

describe('useFabricationQueue(projectId)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    mockSubscribe.mockReturnValue(() => {});
    mockGetQueue.mockResolvedValue([]);
    withCallerOrg();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('passes projectId to getFabricatorQueue', async () => {
    renderHook(() => useFabricationQueue('proj-42'));
    await waitFor(() => expect(mockGetQueue).toHaveBeenCalledWith('proj-42'));
  });

  it('polls every 10 s while any item is non-terminal', async () => {
    mockGetQueue.mockResolvedValue(MIXED_ITEMS);
    const { result } = renderHook(() => useFabricationQueue('proj-1'));

    // Wait for initial load and state update
    await waitFor(() => expect(result.current.items.length).toBe(2));
    expect(mockGetQueue).toHaveBeenCalledTimes(1);

    // Advance 10 s → second poll (use advanceTimersByTimeAsync so
    // setInterval callbacks and their returned promises interleave correctly)
    await act(async () => { await jest.advanceTimersByTimeAsync(10_000); });
    expect(mockGetQueue).toHaveBeenCalledTimes(2);

    // Advance another 10 s → third poll
    await act(async () => { await jest.advanceTimersByTimeAsync(10_000); });
    expect(mockGetQueue).toHaveBeenCalledTimes(3);
  });

  it('stops polling when all items become terminal', async () => {
    mockGetQueue.mockResolvedValue(ALL_DONE);
    renderHook(() => useFabricationQueue('proj-1'));

    await waitFor(() => expect(mockGetQueue).toHaveBeenCalledTimes(1));

    // Advance well past the interval — should NOT poll again
    await act(async () => { jest.advanceTimersByTime(30_000); });
    expect(mockGetQueue).toHaveBeenCalledTimes(1);
  });

  it('stops polling on unmount', async () => {
    mockGetQueue.mockResolvedValue(MIXED_ITEMS);
    const { unmount } = renderHook(() => useFabricationQueue('proj-1'));

    await waitFor(() => expect(mockGetQueue).toHaveBeenCalledTimes(1));
    unmount();

    await act(async () => { jest.advanceTimersByTime(20_000); });
    // Only the initial call, no polls after unmount.
    expect(mockGetQueue).toHaveBeenCalledTimes(1);
  });

  it('updates an item in place on a real-time event (does not remove it)', async () => {
    mockGetQueue.mockResolvedValue(MIXED_ITEMS);
    let emit: (e: FabricationEvent) => void = () => {};
    mockSubscribe.mockImplementation((onEvent) => { emit = onEvent; return () => {}; });

    const { result } = renderHook(() => useFabricationQueue('proj-1'));
    await waitFor(() => expect(result.current.items.length).toBe(2));

    act(() => {
      emit({ type: 'COMPLETED', requestId: 'r1', timestamp: '' });
    });

    // The item stays in the array but its status is now COMPLETED.
    expect(result.current.items.find((i) => i.requestId === 'r1')?.status).toBe('COMPLETED');
    expect(result.current.items).toHaveLength(2);
  });

  it('exposes allTerminal=true when every item is COMPLETED or FAILED', async () => {
    mockGetQueue.mockResolvedValue(ALL_DONE);
    const { result } = renderHook(() => useFabricationQueue('proj-1'));
    await waitFor(() => expect(result.current.allTerminal).toBe(true));
  });

  it('exposes allBuilt=true when every item is COMPLETED', async () => {
    mockGetQueue.mockResolvedValue(ALL_DONE);
    const { result } = renderHook(() => useFabricationQueue('proj-1'));
    await waitFor(() => expect(result.current.allBuilt).toBe(true));
  });

  it('allBuilt=false when some are FAILED', async () => {
    mockGetQueue.mockResolvedValue([
      { requestId: 'r1', agentName: 'a', taskDescription: '', status: 'COMPLETED', submittedAt: '' },
      { requestId: 'r2', agentName: 'b', taskDescription: '', status: 'FAILED', submittedAt: '' },
    ]);
    const { result } = renderHook(() => useFabricationQueue('proj-1'));
    await waitFor(() => expect(result.current.items.length).toBe(2));
    expect(result.current.allBuilt).toBe(false);
    expect(result.current.allTerminal).toBe(true);
  });
});
