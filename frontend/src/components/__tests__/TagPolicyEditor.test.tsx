/**
 * TagPolicyEditor unit tests — load+render, add rule + save payload,
 * duplicate key blocked, non-admin does not see the editor.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

// ── UI mocks (match Team.test.tsx pattern) ─────────────────────────
jest.mock('@/components/ui/button', () => ({
  Button: ({ children, onClick, disabled, ...rest }: any) => (
    <button onClick={onClick} disabled={disabled} {...rest}>{children}</button>
  ),
}));
jest.mock('@/components/ui/input', () => ({
  Input: (props: any) => <input {...props} />,
}));
jest.mock('@/components/ui/label', () => ({
  Label: ({ children, ...props }: any) => <label {...props}>{children}</label>,
}));
jest.mock('@/components/ui/badge', () => ({
  Badge: ({ children, className }: any) => <span data-testid="badge" className={className}>{children}</span>,
}));
jest.mock('lucide-react', () => ({
  Plus: () => <span data-testid="icon-plus" />,
  Trash2: () => <span data-testid="icon-trash" />,
}));

// ── Service mock ───────────────────────────────────────────────────
const mockGetTagPolicy = jest.fn();
const mockUpdateTagPolicy = jest.fn();

jest.mock('@/services/tagPolicyService', () => ({
  tagPolicyService: {
    getTagPolicy: (...args: unknown[]) => mockGetTagPolicy(...args),
    updateTagPolicy: (...args: unknown[]) => mockUpdateTagPolicy(...args),
  },
}));

import { TagPolicyEditor } from '../TagPolicyEditor';

describe('TagPolicyEditor', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ── Load + render ──────────────────────────────────────────────────

  it('renders empty-state message when getTagPolicy returns null', async () => {
    mockGetTagPolicy.mockResolvedValue(null);

    render(<TagPolicyEditor orgId="org-1" isAdmin={true} />);

    await waitFor(() => {
      expect(screen.getByTestId('empty-policy-msg')).toHaveTextContent(
        'No tag policy. Records in this organisation need no tags.',
      );
    });
    expect(mockGetTagPolicy).toHaveBeenCalledWith('org-1');
  });

  it('renders existing policy rules and metadata after load', async () => {
    mockGetTagPolicy.mockResolvedValue({
      requiredKeys: [
        { key: 'env', allowedValues: ['dev', 'prod'] },
        { key: 'team', allowedValues: null },
      ],
      version: 3,
      updatedBy: 'alice',
      updatedAt: '2026-09-01T12:00:00Z',
    });

    render(<TagPolicyEditor orgId="org-1" isAdmin={true} />);

    await waitFor(() => {
      expect(screen.getByTestId('rule-row-0')).toBeInTheDocument();
    });
    // Key inputs
    const keyInputs = screen.getAllByPlaceholderText('Key');
    expect(keyInputs[0]).toHaveValue('env');
    expect(keyInputs[1]).toHaveValue('team');

    // Values input
    const valueInputs = screen.getAllByPlaceholderText('Allowed values (comma-separated)');
    expect(valueInputs[0]).toHaveValue('dev, prod');
    expect(valueInputs[1]).toHaveValue('');

    // Metadata
    expect(screen.getByTestId('policy-meta')).toHaveTextContent('v3');
    expect(screen.getByTestId('policy-meta')).toHaveTextContent('alice');
  });

  // ── Add rule + save ────────────────────────────────────────────────

  it('adds a rule, fills it in, and sends correct payload on save', async () => {
    mockGetTagPolicy.mockResolvedValue(null);
    mockUpdateTagPolicy.mockResolvedValue({
      requiredKeys: [{ key: 'env', allowedValues: ['dev', 'prod'] }],
      version: 1,
      updatedBy: 'admin',
      updatedAt: '2026-10-04T20:00:00Z',
    });

    render(<TagPolicyEditor orgId="org-1" isAdmin={true} />);

    await waitFor(() => {
      expect(screen.getByTestId('empty-policy-msg')).toBeInTheDocument();
    });

    // Add a rule
    fireEvent.click(screen.getByTestId('add-rule-btn'));
    expect(screen.getByTestId('rule-row-0')).toBeInTheDocument();

    // Fill key
    const keyInput = screen.getByPlaceholderText('Key');
    fireEvent.change(keyInput, { target: { value: 'env' } });

    // Fill values
    const valuesInput = screen.getByPlaceholderText('Allowed values (comma-separated)');
    fireEvent.change(valuesInput, { target: { value: 'dev, prod' } });

    // Save
    fireEvent.click(screen.getByTestId('save-policy-btn'));

    await waitFor(() => {
      expect(mockUpdateTagPolicy).toHaveBeenCalledWith({
        orgId: 'org-1',
        requiredKeys: [{ key: 'env', allowedValues: ['dev', 'prod'] }],
        expectedVersion: undefined,
      });
    });

    // After save, metadata is displayed
    await waitFor(() => {
      expect(screen.getByTestId('policy-meta')).toHaveTextContent('v1');
    });
  });

  // ── Duplicate key blocked ──────────────────────────────────────────

  it('blocks save and shows error when duplicate keys exist', async () => {
    mockGetTagPolicy.mockResolvedValue(null);

    render(<TagPolicyEditor orgId="org-1" isAdmin={true} />);

    await waitFor(() => {
      expect(screen.getByTestId('empty-policy-msg')).toBeInTheDocument();
    });

    // Add two rules with the same key
    fireEvent.click(screen.getByTestId('add-rule-btn'));
    fireEvent.click(screen.getByTestId('add-rule-btn'));

    const keyInputs = screen.getAllByPlaceholderText('Key');
    fireEvent.change(keyInputs[0], { target: { value: 'env' } });
    fireEvent.change(keyInputs[1], { target: { value: 'env' } });

    fireEvent.click(screen.getByTestId('save-policy-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('policy-error')).toHaveTextContent('Duplicate key: "env"');
    });
    expect(mockUpdateTagPolicy).not.toHaveBeenCalled();
  });

  // ── Non-admin ──────────────────────────────────────────────────────

  it('does not render the editor when isAdmin is false', () => {
    mockGetTagPolicy.mockResolvedValue(null);

    const { container } = render(<TagPolicyEditor orgId="org-1" isAdmin={false} />);

    expect(container.innerHTML).toBe('');
    expect(mockGetTagPolicy).not.toHaveBeenCalled();
  });
});
