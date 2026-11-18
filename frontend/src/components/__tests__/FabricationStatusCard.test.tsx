/**
 * FabricationStatusCard — in-chat fabrication progress card.
 *
 * Renders inside the chat stream after the last message while the project
 * has fabrication jobs. Shows per-agent status, 'All N agents built' when
 * complete, and a truthful Activate button with honest result reporting:
 *
 *  - submitted > 0  → 'Submitted N for approval' + link to /approvals
 *  - all active      → 'Agents active' disabled
 *  - all-empty / err → 'No agents found for this project yet'
 *  - mixed results   → counts for activated / submitted / failed
 */

import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';

// Must mock react-router-dom for the Link to /approvals
jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  Link: ({ to, children, ...props }: { to: string; children: React.ReactNode; [k: string]: unknown }) => <a href={to} {...props}>{children}</a>,
}));

jest.mock('../../services/agentConfigService', () => ({
  __esModule: true,
  agentConfigService: {
    activateProjectAgents: jest.fn(),
  },
}));

jest.mock('sonner', () => ({
  __esModule: true,
  toast: { success: jest.fn(), warning: jest.fn(), error: jest.fn() },
}));

import { agentConfigService } from '../../services/agentConfigService';
import type { FabricationQueueItem } from '../../services/fabricatorQueueService';
import { FabricationStatusCard } from '../FabricationStatusCard';

const mockActivate = agentConfigService.activateProjectAgents as jest.MockedFunction<
  typeof agentConfigService.activateProjectAgents
>;

const ALL_BUILT: FabricationQueueItem[] = [
  { requestId: 'r1', agentName: 'alpha', taskDescription: '', status: 'COMPLETED', submittedAt: '' },
  { requestId: 'r2', agentName: 'beta', taskDescription: '', status: 'COMPLETED', submittedAt: '' },
];

const IN_PROGRESS: FabricationQueueItem[] = [
  { requestId: 'r1', agentName: 'alpha', taskDescription: '', status: 'PROCESSING', submittedAt: '' },
  { requestId: 'r2', agentName: 'beta', taskDescription: '', status: 'COMPLETED', submittedAt: '' },
];

describe('FabricationStatusCard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders per-agent status rows', () => {
    render(<FabricationStatusCard items={IN_PROGRESS} projectId="p1" allBuilt={false} allTerminal={false} />);
    expect(screen.getByText('alpha')).toBeInTheDocument();
    expect(screen.getByText('beta')).toBeInTheDocument();
  });

  it('shows "All N agents built" when allBuilt is true', () => {
    render(<FabricationStatusCard items={ALL_BUILT} projectId="p1" allBuilt allTerminal />);
    expect(screen.getByText(/All 2 agents built/)).toBeInTheDocument();
  });

  it('shows building progress when not all built', () => {
    render(<FabricationStatusCard items={IN_PROGRESS} projectId="p1" allBuilt={false} allTerminal={false} />);
    expect(screen.getByText(/1 of 2/)).toBeInTheDocument();
  });

  describe('Activate button', () => {
    it('is only visible when allBuilt is true', () => {
      const { rerender } = render(
        <FabricationStatusCard items={IN_PROGRESS} projectId="p1" allBuilt={false} allTerminal={false} />,
      );
      expect(screen.queryByRole('button', { name: /activate/i })).not.toBeInTheDocument();

      rerender(<FabricationStatusCard items={ALL_BUILT} projectId="p1" allBuilt allTerminal />);
      expect(screen.getByRole('button', { name: /activate/i })).toBeInTheDocument();
    });

    it('shows truthful "Submitted N for approval" when submitted > 0', async () => {
      mockActivate.mockResolvedValue({
        activated: ['alpha'],
        submitted: ['beta'],
        failed: [],
        alreadyActive: [],
      });

      render(<FabricationStatusCard items={ALL_BUILT} projectId="p1" allBuilt allTerminal />);
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: /activate/i })); });

      await waitFor(() => {
        expect(screen.getByText(/Submitted 1 for approval/)).toBeInTheDocument();
      });
      // Link to Approvals page
      expect(screen.getByRole('link', { name: /approv/i })).toHaveAttribute('href', '/approvals');
    });

    it('shows "Agents active" disabled when all are active', async () => {
      mockActivate.mockResolvedValue({
        activated: ['alpha', 'beta'],
        failed: [],
        alreadyActive: [],
      });

      render(<FabricationStatusCard items={ALL_BUILT} projectId="p1" allBuilt allTerminal />);
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: /activate/i })); });

      await waitFor(() => {
        const btn = screen.getByRole('button', { name: /agents active/i });
        expect(btn).toBeDisabled();
      });
    });

    it('shows error state with "No agents found" on all-empty result', async () => {
      mockActivate.mockRejectedValue(new Error('ValidationError: No agents found for project p1'));

      render(<FabricationStatusCard items={ALL_BUILT} projectId="p1" allBuilt allTerminal />);
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: /activate/i })); });

      await waitFor(() => {
        expect(screen.getByText(/No agents found for this project yet/)).toBeInTheDocument();
      });
    });

    it('shows "Activate approved agents" when submitted > 0 (button stays available)', async () => {
      mockActivate.mockResolvedValue({
        activated: [],
        submitted: ['alpha', 'beta'],
        failed: [],
        alreadyActive: [],
      });

      render(<FabricationStatusCard items={ALL_BUILT} projectId="p1" allBuilt allTerminal />);
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: /activate/i })); });

      await waitFor(() => {
        const btn = screen.getByRole('button', { name: /activate approved/i });
        expect(btn).not.toBeDisabled();
      });
    });

    it('shows mixed counts for activated/submitted/failed', async () => {
      mockActivate.mockResolvedValue({
        activated: ['alpha'],
        submitted: ['beta'],
        failed: ['gamma'],
        alreadyActive: [],
      });

      render(
        <FabricationStatusCard
          items={[...ALL_BUILT, { requestId: 'r3', agentName: 'gamma', taskDescription: '', status: 'COMPLETED', submittedAt: '' }]}
          projectId="p1"
          allBuilt
          allTerminal
        />,
      );
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: /activate/i })); });

      await waitFor(() => {
        expect(screen.getByText(/1 activated/i)).toBeInTheDocument();
        expect(screen.getByText(/Submitted 1 for approval/i)).toBeInTheDocument();
        expect(screen.getByText(/1 failed/i)).toBeInTheDocument();
      });
    });

    it('never shows "Agents activated" for an all-empty response (the old lie)', async () => {
      mockActivate.mockResolvedValue({
        activated: [],
        failed: [],
        alreadyActive: [],
      });

      render(<FabricationStatusCard items={ALL_BUILT} projectId="p1" allBuilt allTerminal />);
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: /activate/i })); });

      await waitFor(() => {
        expect(screen.queryByText(/Agents activated/)).not.toBeInTheDocument();
      });
    });
  });

  it('renders nothing when items is empty', () => {
    const { container } = render(
      <FabricationStatusCard items={[]} projectId="p1" allBuilt={false} allTerminal={false} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
