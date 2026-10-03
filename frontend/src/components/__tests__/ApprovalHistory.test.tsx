import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { ApprovalHistory } from '../ApprovalHistory';
import type { AgentConfig } from '../../services/agentConfigService';

function makeAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    agentId: 'agent-1',
    name: 'Test Agent',
    config: { name: 'Test Agent' },
    state: 'active',
    categories: [],
    registryStatus: 'APPROVED',
    ...overrides,
  };
}

describe('ApprovalHistory', () => {
  it('shows approved badge and decided-by/decided-at for an approved agent', () => {
    const agent = makeAgent({
      registryStatus: 'APPROVED',
      decidedBy: 'admin-user-42',
      decidedAt: '2026-09-30T10:00:00Z',
      statusReason: 'Meets all criteria',
    });

    render(<ApprovalHistory agent={agent} />);

    expect(screen.getByText('Approved')).toBeInTheDocument();
    expect(screen.getByTestId('decided-by')).toHaveTextContent('admin-user-42');
    expect(screen.getByTestId('decided-at')).toBeInTheDocument();
    expect(screen.getByTestId('decided-at')).toHaveAttribute('title', '2026-09-30T10:00:00Z');
    expect(screen.getByTestId('status-reason')).toHaveTextContent('Meets all criteria');
  });

  it('shows rejected badge and guidance text for a rejected agent', () => {
    const agent = makeAgent({
      registryStatus: 'REJECTED',
      decidedBy: 'admin-1',
      decidedAt: '2026-10-01T12:00:00Z',
      statusReason: 'Missing docs',
    });

    render(<ApprovalHistory agent={agent} />);

    expect(screen.getByText('Rejected')).toBeInTheDocument();
    expect(
      screen.getByText('Rejected records cannot be resubmitted; create a new record'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('status-reason')).toHaveTextContent('Missing docs');
  });

  it('shows awaiting administrator review for a pending agent', () => {
    const agent = makeAgent({ registryStatus: 'PENDING_APPROVAL' });

    render(<ApprovalHistory agent={agent} />);

    expect(screen.getByText('Pending approval')).toBeInTheDocument();
    expect(screen.getByText('Awaiting administrator review')).toBeInTheDocument();
  });

  it('renders nothing for a legacy agent without registryStatus', () => {
    const agent = makeAgent({ registryStatus: undefined });

    const { container } = render(<ApprovalHistory agent={agent} />);

    expect(container.innerHTML).toBe('');
    expect(screen.queryByTestId('approval-history')).not.toBeInTheDocument();
  });
});
