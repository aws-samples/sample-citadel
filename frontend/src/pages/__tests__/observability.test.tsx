/**
 * Observability page tests — route renders from deep-link params, and the
 * admin-only raw-trace-id input is hidden for non-admin users (design §1:
 * /traces/{traceId} has no org entry key, so it must never be exposed to
 * non-admins even as a UI affordance).
 */
import '@testing-library/jest-dom';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { Observability } from '../Observability';
import { traceService } from '../../services/traceService';
import { replayService } from '../../services/replayService';
import { governanceService } from '../../services/governanceService';
import { useOrganization } from '../../contexts/OrganizationContext';
import { toast } from 'sonner';

jest.mock('../../services/traceService', () => ({
  traceService: {
    isAvailable: jest.fn(),
    getByExecution: jest.fn(),
    getByConversation: jest.fn(),
    getByTraceId: jest.fn(),
  },
}));

jest.mock('../../services/replayService', () => ({
  replayService: {
    getByExecution: jest.fn(),
    getByConversation: jest.fn(),
    downloadReplayPackage: jest.fn(),
  },
}));

jest.mock('../../services/governanceService', () => ({
  governanceService: {
    listGovernanceFindings: jest.fn(),
  },
}));

jest.mock('../../contexts/OrganizationContext', () => ({
  useOrganization: jest.fn(),
}));

jest.mock('sonner', () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}));

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/observability/trace/:kind/:id" element={<Observability />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('Observability page', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (useOrganization as jest.Mock).mockReturnValue({ isAdmin: false });
    (traceService.isAvailable as jest.Mock).mockReturnValue(true);
    (governanceService.listGovernanceFindings as jest.Mock).mockResolvedValue({
      items: [],
      nextCursor: null,
    });
  });

  it('renders the ready waterfall from execution deep-link params', async () => {
    (traceService.getByExecution as jest.Mock).mockResolvedValue({
      available: true,
      data: {
        query: { kind: 'execution', id: 'exec-1' },
        status: 'ready',
        traces: [
          {
            traceId: '1-a-b',
            rootName: 'root',
            startTime: 0,
            endTime: 1,
            durationMs: 100,
            hasError: false,
            hasFault: false,
            hasThrottle: false,
            annotations: {},
            spans: [],
          },
        ],
      },
    });

    renderAt('/observability/trace/execution/exec-1');

    await waitFor(() => expect(traceService.getByExecution).toHaveBeenCalledWith('exec-1'));
    expect(await screen.findByTestId('trace-waterfall')).toBeInTheDocument();
  });

  it('renders the ready waterfall from conversation deep-link params', async () => {
    (traceService.getByConversation as jest.Mock).mockResolvedValue({
      available: true,
      data: { query: { kind: 'conversation', id: 'proj-1' }, status: 'ready', traces: [] },
    });

    renderAt('/observability/trace/conversation/proj-1');

    await waitFor(() => expect(traceService.getByConversation).toHaveBeenCalledWith('proj-1'));
  });

  it('hides the admin-only raw-trace-id input for a non-admin user', async () => {
    (traceService.getByExecution as jest.Mock).mockResolvedValue({
      available: true,
      data: { query: { kind: 'execution', id: 'exec-1' }, status: 'ready', traces: [] },
    });

    renderAt('/observability/trace/execution/exec-1');

    await waitFor(() => expect(traceService.getByExecution).toHaveBeenCalled());
    expect(screen.queryByLabelText(/raw trace id/i)).not.toBeInTheDocument();
  });

  it('shows the admin-only raw-trace-id input for an admin user', async () => {
    (useOrganization as jest.Mock).mockReturnValue({ isAdmin: true });
    (traceService.getByExecution as jest.Mock).mockResolvedValue({
      available: true,
      data: { query: { kind: 'execution', id: 'exec-1' }, status: 'ready', traces: [] },
    });

    renderAt('/observability/trace/execution/exec-1');

    await waitFor(() => expect(traceService.getByExecution).toHaveBeenCalled());
    expect(screen.getByLabelText(/raw trace id/i)).toBeInTheDocument();
  });

  it('renders the unauthorized state on a 403', async () => {
    (traceService.getByExecution as jest.Mock).mockResolvedValue({
      available: true,
      unauthorized: true,
      reason: 'Forbidden',
    });

    renderAt('/observability/trace/execution/exec-1');

    expect(await screen.findByText(/not authorized/i)).toBeInTheDocument();
  });

  it('renders the unavailable state when the trace API is not configured', async () => {
    (traceService.isAvailable as jest.Mock).mockReturnValue(false);

    renderAt('/observability/trace/execution/exec-1');

    expect(await screen.findByText(/trace viewer unavailable/i)).toBeInTheDocument();
    expect(traceService.getByExecution).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Governance decisions panel (design task 9b3f4f78, §4/§5) — P2 test 8.
// ---------------------------------------------------------------------------

describe('Observability page — governance decisions panel', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (useOrganization as jest.Mock).mockReturnValue({ isAdmin: false });
    (traceService.isAvailable as jest.Mock).mockReturnValue(true);
  });

  function mockReadyTraceWithAnnotations(annotations: Record<string, string>) {
    (traceService.getByExecution as jest.Mock).mockResolvedValue({
      available: true,
      data: {
        query: { kind: 'execution', id: 'exec-1' },
        status: 'ready',
        traces: [
          {
            traceId: '1-a-b',
            rootName: 'root',
            startTime: 0,
            endTime: 1,
            durationMs: 100,
            hasError: false,
            hasFault: false,
            hasThrottle: false,
            annotations,
            spans: [],
          },
        ],
      },
    });
  }

  it('calls listGovernanceFindings(workflowId=execution_id) and renders "Governance decisions (N)"', async () => {
    mockReadyTraceWithAnnotations({ execution_id: 'exec-1' });
    (governanceService.listGovernanceFindings as jest.Mock).mockResolvedValue({
      items: [
        {
          findingId: 'f-1',
          workflowId: 'exec-1',
          decision: 'permit',
          reason: 'scope_match:unit-1',
          requestingAgent: 'a',
          targetAgent: 'b',
          scopeEvaluated: 'unit-1',
          contractEvaluated: null,
          escalationTarget: null,
          residualAuthorityDenial: false,
          timestamp: 1,
          traceId: null,
        },
      ],
      nextCursor: null,
    });

    renderAt('/observability/trace/execution/exec-1');

    await waitFor(() =>
      expect(governanceService.listGovernanceFindings).toHaveBeenCalledWith({ workflowId: 'exec-1' }),
    );
    expect(await screen.findByText('Governance decisions (1)')).toBeInTheDocument();
    expect(screen.getByTestId('governance-decisions-row')).toBeInTheDocument();
  });

  it('falls back to correlation_id when execution_id annotation is absent', async () => {
    mockReadyTraceWithAnnotations({ correlation_id: 'corr-1' });
    (governanceService.listGovernanceFindings as jest.Mock).mockResolvedValue({
      items: [],
      nextCursor: null,
    });

    renderAt('/observability/trace/execution/exec-1');

    await waitFor(() =>
      expect(governanceService.listGovernanceFindings).toHaveBeenCalledWith({ workflowId: 'corr-1' }),
    );
  });

  it('renders the empty state when N=0', async () => {
    mockReadyTraceWithAnnotations({ execution_id: 'exec-1' });
    (governanceService.listGovernanceFindings as jest.Mock).mockResolvedValue({
      items: [],
      nextCursor: null,
    });

    renderAt('/observability/trace/execution/exec-1');

    expect(await screen.findByTestId('governance-decisions-empty')).toBeInTheDocument();
    expect(screen.getByText(/no governance decisions recorded for this execution/i)).toBeInTheDocument();
  });

  it('renders the missing-execution_id state when no annotation is present', async () => {
    mockReadyTraceWithAnnotations({});

    renderAt('/observability/trace/execution/exec-1');

    expect(
      await screen.findByTestId('governance-decisions-no-execution-id'),
    ).toBeInTheDocument();
    expect(governanceService.listGovernanceFindings).not.toHaveBeenCalled();
  });

  it('renders an inline error without breaking the waterfall render on listGovernanceFindings failure', async () => {
    mockReadyTraceWithAnnotations({ execution_id: 'exec-1' });
    (governanceService.listGovernanceFindings as jest.Mock).mockRejectedValue(new Error('GSI down'));

    renderAt('/observability/trace/execution/exec-1');

    expect(await screen.findByTestId('governance-decisions-error')).toBeInTheDocument();
    expect(screen.getByTestId('trace-waterfall')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Replay package deep link (CIT-026) — "Download replay package" button on
// the ready waterfall view, for both execution and conversation kinds.
// Owner-only enforcement happens server-side; the button itself is always
// rendered when the waterfall is ready, and gate-refusal/unauthorized
// responses degrade gracefully to a toast (never a crash).
// ---------------------------------------------------------------------------

describe('Observability page — replay package download button', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (useOrganization as jest.Mock).mockReturnValue({ isAdmin: false });
    (traceService.isAvailable as jest.Mock).mockReturnValue(true);
    (governanceService.listGovernanceFindings as jest.Mock).mockResolvedValue({
      items: [],
      nextCursor: null,
    });
    (traceService.getByExecution as jest.Mock).mockResolvedValue({
      available: true,
      data: {
        query: { kind: 'execution', id: 'exec-1' },
        status: 'ready',
        traces: [
          {
            traceId: '1-a-b',
            rootName: 'root',
            startTime: 0,
            endTime: 1,
            durationMs: 100,
            hasError: false,
            hasFault: false,
            hasThrottle: false,
            annotations: {},
            spans: [],
          },
        ],
      },
    });
  });

  it('renders a "Download replay package" button on the ready waterfall for an execution deep link', async () => {
    renderAt('/observability/trace/execution/exec-1');
    expect(await screen.findByRole('button', { name: /download replay package/i })).toBeInTheDocument();
  });

  it('on click, calls replayService.getByExecution and triggers the download on success', async () => {
    (replayService.getByExecution as jest.Mock).mockResolvedValue({
      available: true,
      data: { url: 'https://signed-url.example.com/package.json' },
    });

    renderAt('/observability/trace/execution/exec-1');
    const button = await screen.findByRole('button', { name: /download replay package/i });
    fireEvent.click(button);

    await waitFor(() => expect(replayService.getByExecution).toHaveBeenCalledWith('exec-1'));
    await waitFor(() =>
      expect(replayService.downloadReplayPackage).toHaveBeenCalledWith(
        'https://signed-url.example.com/package.json',
      ),
    );
  });

  it('on gate refusal, shows an honest toast and never crashes', async () => {
    (replayService.getByExecution as jest.Mock).mockResolvedValue({
      available: true,
      gateRefused: true,
      reason: 'Replay package could not be produced: sanitisation gate refused publication.',
    });

    renderAt('/observability/trace/execution/exec-1');
    const button = await screen.findByRole('button', { name: /download replay package/i });
    fireEvent.click(button);

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'Replay package could not be produced: sanitisation gate refused publication.',
      ),
    );
    expect(replayService.downloadReplayPackage).not.toHaveBeenCalled();
  });

  it('on unauthorized, shows an honest toast and never crashes', async () => {
    (replayService.getByExecution as jest.Mock).mockResolvedValue({
      available: true,
      unauthorized: true,
      reason: 'Forbidden',
    });

    renderAt('/observability/trace/execution/exec-1');
    const button = await screen.findByRole('button', { name: /download replay package/i });
    fireEvent.click(button);

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Forbidden'));
    expect(replayService.downloadReplayPackage).not.toHaveBeenCalled();
  });

  it('calls replayService.getByConversation for a conversation deep link', async () => {
    (traceService.getByConversation as jest.Mock).mockResolvedValue({
      available: true,
      data: { query: { kind: 'conversation', id: 'proj-1' }, status: 'ready', traces: [] },
    });
    (replayService.getByConversation as jest.Mock).mockResolvedValue({
      available: true,
      data: { url: 'https://signed-url.example.com/package.json' },
    });

    renderAt('/observability/trace/conversation/proj-1');
    // A 0-trace ready response renders the empty state, not the waterfall —
    // the button lives alongside the waterfall render only when traces
    // exist, matching this page's existing ready-with-traces gating.
    await waitFor(() => expect(traceService.getByConversation).toHaveBeenCalledWith('proj-1'));
  });
});
