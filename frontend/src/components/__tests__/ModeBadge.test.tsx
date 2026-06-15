/**
 * ModeBadge tests
 *
 * Mocks useGovernanceMode to drive the four render states (loading, known
 * modes, error/unknown) and verifies click navigation.
 */

import { render, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';

const mockNavigate = jest.fn();

jest.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
}));

jest.mock('../../hooks/useGovernanceMode', () => ({
  useGovernanceMode: jest.fn(),
}));

import { useGovernanceMode } from '../../hooks/useGovernanceMode';
import { ModeBadge } from '../ModeBadge';

const useGovernanceModeMock = useGovernanceMode as jest.Mock;

function setMode(value: {
  mode: any;
  loading?: boolean;
  error?: string | null;
}) {
  useGovernanceModeMock.mockReturnValue({
    mode: value.mode,
    loading: value.loading ?? false,
    error: value.error ?? null,
    refresh: jest.fn(),
  });
}

// The pill is a <button> with no explicit role; locate it via the
// aria-label prefix that the component always sets.
function findPill(container: HTMLElement): HTMLButtonElement {
  const el = container.querySelector(
    'button[aria-label^="Governance mode:"]',
  ) as HTMLButtonElement | null;
  if (!el) throw new Error('ModeBadge pill button not found');
  return el;
}

describe('ModeBadge', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders a Skeleton placeholder while loading', () => {
    setMode({ mode: null, loading: true });
    const { getByTestId, container } = render(<ModeBadge />);
    expect(getByTestId('mode-badge-skeleton')).toBeInTheDocument();
    // Pill button must not be rendered while loading.
    expect(
      container.querySelector('button[aria-label^="Governance mode:"]'),
    ).toBeNull();
  });

  it('renders the permissive label and its tokens', () => {
    setMode({
      mode: { enforce: 'permissive', effectiveAt: null, env: 'dev' },
    });
    const { container } = render(<ModeBadge />);
    const pill = findPill(container);
    expect(pill).toHaveTextContent('permissive');
    expect(pill).toHaveAttribute('data-mode', 'permissive');
    expect(pill).toHaveAttribute('aria-label', 'Governance mode: permissive');
    expect(pill.className).toContain('bg-muted');
  });

  it('renders the shadow label with chart-4 styling', () => {
    setMode({
      mode: { enforce: 'shadow', effectiveAt: '2026-01-01T00:00:00Z', env: 'staging' },
    });
    const { container } = render(<ModeBadge />);
    const pill = findPill(container);
    expect(pill).toHaveTextContent('shadow');
    expect(pill).toHaveAttribute('data-mode', 'shadow');
    expect(pill.className).toContain('chart-4');
    expect(pill.className).toContain('animate-pulse');
  });

  it('renders the strict label with chart-2 styling and ring', () => {
    setMode({
      mode: { enforce: 'strict', effectiveAt: '2026-02-01T00:00:00Z', env: 'prod' },
    });
    const { container } = render(<ModeBadge />);
    const pill = findPill(container);
    expect(pill).toHaveTextContent('strict');
    expect(pill).toHaveAttribute('data-mode', 'strict');
    expect(pill.className).toContain('chart-2');
    expect(pill.className).toContain('ring-1');
  });

  it('renders "mode unknown" pill on error', () => {
    setMode({ mode: null, error: 'oops' });
    const { container } = render(<ModeBadge />);
    const pill = findPill(container);
    expect(pill).toHaveTextContent('mode unknown');
    expect(pill).toHaveAttribute('data-mode', 'unknown');
    expect(pill).toHaveAttribute('aria-label', 'Governance mode: mode unknown');
    expect(pill.className).toContain('bg-muted');
  });

  it('renders "mode unknown" pill when enforce is an unrecognised value', () => {
    setMode({
      mode: { enforce: 'banana', effectiveAt: null, env: 'dev' },
    });
    const { container } = render(<ModeBadge />);
    const pill = findPill(container);
    expect(pill).toHaveTextContent('mode unknown');
    expect(pill).toHaveAttribute('data-mode', 'unknown');
  });

  it('aria-label includes the current mode label', () => {
    setMode({
      mode: { enforce: 'shadow', effectiveAt: null, env: 'dev' },
    });
    const { container } = render(<ModeBadge />);
    const pill = findPill(container);
    expect(pill).toHaveAttribute('aria-label', 'Governance mode: shadow');
  });

  it('navigates to /governance on click', () => {
    setMode({
      mode: { enforce: 'permissive', effectiveAt: null, env: 'dev' },
    });
    const { container } = render(<ModeBadge />);
    fireEvent.click(findPill(container));
    expect(mockNavigate).toHaveBeenCalledWith('/governance');
  });
});
