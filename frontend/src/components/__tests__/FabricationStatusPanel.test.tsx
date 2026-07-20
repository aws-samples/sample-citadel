/**
 * FabricationStatusPanel tests
 * TDD — renders rows with status badges, updates a row on a live fabrication
 * event, unsubscribes on unmount, and shows loading/empty states.
 *
 * The fabricator queue service is fully mocked; no network is hit.
 *
 * NOTE: requires the jsdom test environment. If `jest-environment-jsdom` is
 * not installed locally these component tests cannot execute — see the task
 * report. They are written correctly against the public component API.
 */

import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

jest.mock('../../services/fabricatorQueueService', () => ({
  __esModule: true,
  getFabricatorQueue: jest.fn(),
  subscribeToFabricationEvents: jest.fn(),
}));

jest.mock('../../services/agentConfigService', () => ({
  __esModule: true,
  agentConfigService: {
    activateProjectAgents: jest.fn(),
  },
}));

jest.mock('sonner', () => ({
  __esModule: true,
  toast: {
    success: jest.fn(),
    warning: jest.fn(),
    error: jest.fn(),
  },
}));

import {
  getFabricatorQueue,
  subscribeToFabricationEvents,
  type FabricationQueueItem,
  type FabricationEvent,
} from '../../services/fabricatorQueueService';
import { agentConfigService } from '../../services/agentConfigService';
import { toast } from 'sonner';
import { FabricationStatusPanel } from '../FabricationStatusPanel';

const mockGetQueue = getFabricatorQueue as jest.MockedFunction<typeof getFabricatorQueue>;
const mockSubscribe = subscribeToFabricationEvents as jest.MockedFunction<typeof subscribeToFabricationEvents>;
const mockActivate = agentConfigService.activateProjectAgents as jest.MockedFunction<
  typeof agentConfigService.activateProjectAgents
>;

const COMPLETED_ITEMS: FabricationQueueItem[] = [
  {
    requestId: 'r1',
    agentName: 'agent_alpha',
    taskDescription: 'build alpha',
    status: 'COMPLETED',
    submittedAt: '2026-01-01T00:00:00Z',
  },
  {
    requestId: 'r2',
    agentName: 'agent_beta',
    taskDescription: 'build beta',
    status: 'COMPLETED',
    submittedAt: '2026-01-01T00:01:00Z',
  },
];

const ITEMS: FabricationQueueItem[] = [
  {
    requestId: 'r1',
    agentName: 'agent_alpha',
    taskDescription: 'build alpha',
    status: 'PENDING',
    submittedAt: '2026-01-01T00:00:00Z',
  },
  {
    requestId: 'r2',
    agentName: 'agent_beta',
    taskDescription: 'build beta',
    status: 'PROCESSING',
    submittedAt: '2026-01-01T00:01:00Z',
  },
];

describe('FabricationStatusPanel', () => {
  beforeEach(() => {
    mockGetQueue.mockReset();
    mockSubscribe.mockReset();
    mockActivate.mockReset();
    (toast.success as jest.Mock).mockReset();
    (toast.warning as jest.Mock).mockReset();
    (toast.error as jest.Mock).mockReset();
    // Default: a no-op unsubscribe.
    mockSubscribe.mockReturnValue(() => {});
  });

  it('passes the projectId to getFabricatorQueue', async () => {
    mockGetQueue.mockResolvedValue([]);
    render(<FabricationStatusPanel projectId="proj-1" phaseActive />);
    await waitFor(() => expect(mockGetQueue).toHaveBeenCalledWith('proj-1'));
  });

  it('renders a row per agent with the correct status badge', async () => {
    mockGetQueue.mockResolvedValue(ITEMS);
    render(<FabricationStatusPanel projectId="proj-1" phaseActive />);

    expect(await screen.findByText('agent_alpha')).toBeInTheDocument();
    expect(screen.getByText('agent_beta')).toBeInTheDocument();
    // Status conveyed by text (not color-only).
    expect(screen.getByText('Queued')).toBeInTheDocument();
    expect(screen.getByText('Building')).toBeInTheDocument();
  });

  it('exposes an accessible status label per row (not color-only)', async () => {
    mockGetQueue.mockResolvedValue(ITEMS);
    render(<FabricationStatusPanel projectId="proj-1" phaseActive />);

    expect(await screen.findByLabelText('agent_alpha: Queued')).toBeInTheDocument();
    expect(screen.getByLabelText('agent_beta: Building')).toBeInTheDocument();
  });

  it('updates the matching row when an onFabricationEvent fires', async () => {
    mockGetQueue.mockResolvedValue(ITEMS);
    let emit: (event: FabricationEvent) => void = () => {};
    mockSubscribe.mockImplementation((onEvent: (event: FabricationEvent) => void) => {
      emit = onEvent;
      return () => {};
    });

    render(<FabricationStatusPanel projectId="proj-1" phaseActive />);
    await screen.findByText('agent_alpha');
    expect(screen.getByText('Queued')).toBeInTheDocument();

    act(() => {
      emit({
        type: 'FAILED',
        requestId: 'r1',
        errorMessage: 'fabrication exploded',
        timestamp: '2026-01-01T00:05:00Z',
      });
    });

    await waitFor(() => expect(screen.getByText('Failed')).toBeInTheDocument());
    // Old status for that row is gone.
    expect(screen.queryByText('Queued')).not.toBeInTheDocument();
    // Error message is accessible via the row label.
    expect(
      screen.getByLabelText('agent_alpha: Failed — fabrication exploded'),
    ).toBeInTheDocument();
  });

  it('unsubscribes on unmount', async () => {
    mockGetQueue.mockResolvedValue(ITEMS);
    const unsubscribe = jest.fn();
    mockSubscribe.mockReturnValue(unsubscribe);

    const { unmount } = render(<FabricationStatusPanel projectId="proj-1" phaseActive />);
    await screen.findByText('agent_alpha');

    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('shows a loading state while the queue is loading', async () => {
    let resolve: (items: FabricationQueueItem[]) => void = () => {};
    mockGetQueue.mockReturnValue(new Promise((r) => { resolve = r; }));

    render(<FabricationStatusPanel projectId="proj-1" phaseActive />);
    expect(screen.getByText('Loading fabrication status...')).toBeInTheDocument();

    await act(async () => { resolve([]); });
    await waitFor(() =>
      expect(screen.queryByText('Loading fabrication status...')).not.toBeInTheDocument(),
    );
  });

  it('shows an empty state when the build phase is active but there are no jobs', async () => {
    mockGetQueue.mockResolvedValue([]);
    render(<FabricationStatusPanel projectId="proj-1" phaseActive />);
    expect(await screen.findByText('No agents are being fabricated yet.')).toBeInTheDocument();
  });

  it('renders nothing when the build phase is inactive and there are no jobs', async () => {
    mockGetQueue.mockResolvedValue([]);
    const { container } = render(<FabricationStatusPanel projectId="proj-1" />);
    await waitFor(() => expect(mockGetQueue).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('renders jobs even when the build phase is inactive (jobs > 0)', async () => {
    mockGetQueue.mockResolvedValue(ITEMS);
    render(<FabricationStatusPanel projectId="proj-1" />);
    expect(await screen.findByText('agent_alpha')).toBeInTheDocument();
  });

  describe('Activate all agents', () => {
    it('does not render the button until every job is COMPLETED', async () => {
      mockGetQueue.mockResolvedValue(ITEMS); // PENDING + PROCESSING
      render(<FabricationStatusPanel projectId="proj-1" phaseActive />);
      await screen.findByText('agent_alpha');
      expect(screen.queryByLabelText('Activate all agents')).not.toBeInTheDocument();
    });

    it('renders the button when all jobs are COMPLETED', async () => {
      mockGetQueue.mockResolvedValue(COMPLETED_ITEMS);
      render(<FabricationStatusPanel projectId="proj-1" phaseActive />);
      expect(await screen.findByLabelText('Activate all agents')).toBeInTheDocument();
    });

    it('calls activateProjectAgents and shows a success toast', async () => {
      mockGetQueue.mockResolvedValue(COMPLETED_ITEMS);
      mockActivate.mockResolvedValue({ activated: ['agent_alpha', 'agent_beta'], failed: [], alreadyActive: [] });

      render(<FabricationStatusPanel projectId="proj-1" phaseActive />);
      const btn = await screen.findByLabelText('Activate all agents');

      await act(async () => {
        fireEvent.click(btn);
      });

      expect(mockActivate).toHaveBeenCalledWith('proj-1');
      await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Activated 2 agents'));
    });

    it('shows a warning toast when some agents fail', async () => {
      mockGetQueue.mockResolvedValue(COMPLETED_ITEMS);
      mockActivate.mockResolvedValue({ activated: ['agent_alpha'], failed: ['agent_beta'], alreadyActive: [] });

      render(<FabricationStatusPanel projectId="proj-1" phaseActive />);
      const btn = await screen.findByLabelText('Activate all agents');

      await act(async () => {
        fireEvent.click(btn);
      });

      await waitFor(() => expect(toast.warning).toHaveBeenCalled());
    });

    it('shows an error toast when the mutation throws', async () => {
      mockGetQueue.mockResolvedValue(COMPLETED_ITEMS);
      mockActivate.mockRejectedValue(new Error('network down'));

      render(<FabricationStatusPanel projectId="proj-1" phaseActive />);
      const btn = await screen.findByLabelText('Activate all agents');

      await act(async () => {
        fireEvent.click(btn);
      });

      await waitFor(() => expect(toast.error).toHaveBeenCalled());
    });
  });

  describe('collapsible agent list', () => {
    function getTrigger(): HTMLElement {
      return screen.getByRole('button', { name: /agent fabrication/i });
    }

    it('auto-collapses the agent list when fabrication completion flips true', async () => {
      // Verified: FabricationQueueItem carries NO activation signal and the
      // local `activated` flag only reflects this panel's own button (agents
      // are usually activated conversationally) — so allBuilt is the
      // strongest authoritative completion signal available to the panel.
      mockGetQueue.mockResolvedValue(ITEMS); // PENDING + PROCESSING
      let emit: (event: FabricationEvent) => void = () => {};
      mockSubscribe.mockImplementation((onEvent: (event: FabricationEvent) => void) => {
        emit = onEvent;
        return () => {};
      });

      render(<FabricationStatusPanel projectId="proj-1" phaseActive />);
      await screen.findByText('agent_alpha');
      expect(getTrigger()).toHaveAttribute('aria-expanded', 'true');

      act(() => {
        emit({ type: 'COMPLETED', requestId: 'r1', timestamp: '2026-01-01T00:05:00Z' });
        emit({ type: 'COMPLETED', requestId: 'r2', timestamp: '2026-01-01T00:06:00Z' });
      });

      await waitFor(() => expect(getTrigger()).toHaveAttribute('aria-expanded', 'false'));
      // The list body is collapsed away.
      expect(screen.queryByText('agent_alpha')).not.toBeInTheDocument();
    });

    it('does NOT auto-collapse when the user has toggled manually', async () => {
      mockGetQueue.mockResolvedValue(ITEMS);
      let emit: (event: FabricationEvent) => void = () => {};
      mockSubscribe.mockImplementation((onEvent: (event: FabricationEvent) => void) => {
        emit = onEvent;
        return () => {};
      });

      render(<FabricationStatusPanel projectId="proj-1" phaseActive />);
      await screen.findByText('agent_alpha');

      // Manual collapse then expand — the user's choice wins forever after.
      fireEvent.click(getTrigger());
      await waitFor(() => expect(getTrigger()).toHaveAttribute('aria-expanded', 'false'));
      fireEvent.click(getTrigger());
      await waitFor(() => expect(getTrigger()).toHaveAttribute('aria-expanded', 'true'));

      act(() => {
        emit({ type: 'COMPLETED', requestId: 'r1', timestamp: '2026-01-01T00:05:00Z' });
        emit({ type: 'COMPLETED', requestId: 'r2', timestamp: '2026-01-01T00:06:00Z' });
      });

      // Completion flipped true, but the panel stays expanded.
      expect(await screen.findByText('agent_alpha')).toBeInTheDocument();
      expect(getTrigger()).toHaveAttribute('aria-expanded', 'true');
    });

    it('trigger is keyboard-operable with correct aria-expanded wiring', async () => {
      const user = userEvent.setup();
      mockGetQueue.mockResolvedValue(ITEMS);
      render(<FabricationStatusPanel projectId="proj-1" phaseActive />);
      await screen.findByText('agent_alpha');

      const trigger = getTrigger();
      expect(trigger).toHaveAttribute('aria-expanded', 'true');
      expect(trigger).toHaveAttribute('aria-controls');

      trigger.focus();
      await user.keyboard('{Enter}');
      await waitFor(() => expect(trigger).toHaveAttribute('aria-expanded', 'false'));

      await user.keyboard(' ');
      await waitFor(() => expect(trigger).toHaveAttribute('aria-expanded', 'true'));
    });

    it('shows a status count badge with a polite live region when collapsed', async () => {
      // All jobs already COMPLETED on first load — the panel auto-collapses
      // and the header keeps an at-a-glance status count.
      mockGetQueue.mockResolvedValue(COMPLETED_ITEMS);
      render(<FabricationStatusPanel projectId="proj-1" phaseActive />);

      await waitFor(() => expect(getTrigger()).toHaveAttribute('aria-expanded', 'false'));
      const badgeText = screen.getByText('2 agents built');
      expect(badgeText).toBeInTheDocument();
      expect(badgeText).toHaveAttribute('aria-live', 'polite');
    });

    it('keeps Activate all agents and Refresh outside the trigger', async () => {
      mockGetQueue.mockResolvedValue(COMPLETED_ITEMS);
      render(<FabricationStatusPanel projectId="proj-1" phaseActive />);

      const activate = await screen.findByLabelText('Activate all agents');
      const refresh = screen.getByLabelText('Refresh fabrication status');
      const trigger = getTrigger();
      expect(trigger).not.toContainElement(activate);
      expect(trigger).not.toContainElement(refresh);
    });

    it('activation still works from the header while collapsed', async () => {
      mockGetQueue.mockResolvedValue(COMPLETED_ITEMS);
      mockActivate.mockResolvedValue({
        activated: ['agent_alpha', 'agent_beta'],
        failed: [],
        alreadyActive: [],
      });
      render(<FabricationStatusPanel projectId="proj-1" phaseActive />);
      await waitFor(() => expect(getTrigger()).toHaveAttribute('aria-expanded', 'false'));

      await act(async () => {
        fireEvent.click(screen.getByLabelText('Activate all agents'));
      });

      expect(mockActivate).toHaveBeenCalledWith('proj-1');
      await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Activated 2 agents'));
    });
  });
});
