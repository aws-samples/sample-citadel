/**
 * GovernanceModeProvider tests
 *
 * Verifies:
 *  - one fetch per interval regardless of how many consumers are mounted
 *  - polling pauses when the document becomes hidden
 *  - immediate refetch when the tab becomes visible again
 */

import { render, act, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('../../services/governanceService', () => ({
  governanceService: {
    getGovernanceMode: jest.fn(),
  },
}));

import { governanceService } from '../../services/governanceService';
import { GovernanceModeProvider } from '../../contexts/GovernanceModeContext';
import { useGovernanceMode } from '../../hooks/useGovernanceMode';

const getGovernanceModeMock = governanceService.getGovernanceMode as jest.Mock;

/** Two independent consumers reading the same context. */
function ConsumerA() {
  const { mode, loading } = useGovernanceMode();
  return (
    <div data-testid="consumer-a">
      {loading ? 'loading' : mode?.enforce ?? 'null'}
    </div>
  );
}
function ConsumerB() {
  const { mode, loading } = useGovernanceMode();
  return (
    <div data-testid="consumer-b">
      {loading ? 'loading' : mode?.enforce ?? 'null'}
    </div>
  );
}

function renderWithProvider() {
  return render(
    <GovernanceModeProvider>
      <ConsumerA />
      <ConsumerB />
    </GovernanceModeProvider>,
  );
}

describe('GovernanceModeProvider', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    getGovernanceModeMock.mockResolvedValue({
      enforce: 'shadow',
      effectiveAt: '2026-01-01T00:00:00Z',
      env: 'dev',
    });

    // Reset visibility to visible.
    Object.defineProperty(document, 'hidden', {
      writable: true,
      value: false,
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('makes exactly one fetch on mount regardless of consumer count', async () => {
    await act(async () => {
      renderWithProvider();
    });

    // Only one call despite two consumers.
    expect(getGovernanceModeMock).toHaveBeenCalledTimes(1);

    // Both consumers see the same data.
    expect(screen.getByTestId('consumer-a')).toHaveTextContent('shadow');
    expect(screen.getByTestId('consumer-b')).toHaveTextContent('shadow');
  });

  it('makes exactly one fetch per 60 s interval tick', async () => {
    await act(async () => {
      renderWithProvider();
    });

    expect(getGovernanceModeMock).toHaveBeenCalledTimes(1);

    // Advance one interval.
    await act(async () => {
      jest.advanceTimersByTime(60_000);
    });

    // Still only two total: mount + one tick.
    expect(getGovernanceModeMock).toHaveBeenCalledTimes(2);

    // Advance another interval.
    await act(async () => {
      jest.advanceTimersByTime(60_000);
    });

    expect(getGovernanceModeMock).toHaveBeenCalledTimes(3);
  });

  it('pauses polling when the document becomes hidden', async () => {
    await act(async () => {
      renderWithProvider();
    });

    expect(getGovernanceModeMock).toHaveBeenCalledTimes(1);

    // Hide the tab.
    await act(async () => {
      Object.defineProperty(document, 'hidden', { writable: true, value: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });

    // Advance well past one interval — no new calls.
    await act(async () => {
      jest.advanceTimersByTime(120_000);
    });

    expect(getGovernanceModeMock).toHaveBeenCalledTimes(1);
  });

  it('refetches immediately when the tab becomes visible again', async () => {
    await act(async () => {
      renderWithProvider();
    });

    expect(getGovernanceModeMock).toHaveBeenCalledTimes(1);

    // Hide.
    await act(async () => {
      Object.defineProperty(document, 'hidden', { writable: true, value: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });

    // Unhide.
    await act(async () => {
      Object.defineProperty(document, 'hidden', { writable: true, value: false });
      document.dispatchEvent(new Event('visibilitychange'));
    });

    // Mount + refetch on visibility.
    expect(getGovernanceModeMock).toHaveBeenCalledTimes(2);
  });

  it('resumes polling after the tab becomes visible again', async () => {
    await act(async () => {
      renderWithProvider();
    });

    // Hide → unhide.
    await act(async () => {
      Object.defineProperty(document, 'hidden', { writable: true, value: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await act(async () => {
      Object.defineProperty(document, 'hidden', { writable: true, value: false });
      document.dispatchEvent(new Event('visibilitychange'));
    });

    const callsAfterUnhide = getGovernanceModeMock.mock.calls.length;

    // Advance one interval — should tick again.
    await act(async () => {
      jest.advanceTimersByTime(60_000);
    });

    expect(getGovernanceModeMock).toHaveBeenCalledTimes(callsAfterUnhide + 1);
  });
});
