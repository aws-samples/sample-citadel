/**
 * Observability page tests — route renders from deep-link params, and the
 * admin-only raw-trace-id input is hidden for non-admin users (design §1:
 * /traces/{traceId} has no org entry key, so it must never be exposed to
 * non-admins even as a UI affordance).
 */
import '@testing-library/jest-dom';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { Observability } from '../Observability';
import { traceService } from '../../services/traceService';
import { useOrganization } from '../../contexts/OrganizationContext';

jest.mock('../../services/traceService', () => ({
  traceService: {
    isAvailable: jest.fn(),
    getByExecution: jest.fn(),
    getByConversation: jest.fn(),
    getByTraceId: jest.fn(),
  },
}));

jest.mock('../../contexts/OrganizationContext', () => ({
  useOrganization: jest.fn(),
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
