/**
 * CostOverTimeChart tests
 *
 * Covers: loading skeleton, empty state (no points), data rendering with
 * EstimateBadge, and UnpricedChip showing the unpriced count.
 */
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { CostOverTimeChart } from '../CostOverTimeChart';
import type { CostSeriesResponse } from '../../../services/costService';

function makeSeries(overrides: Partial<CostSeriesResponse> = {}): CostSeriesResponse {
  return {
    dimension: 'org',
    bucket: 'day',
    from: '2026-06-25T00:00:00.000Z',
    to: '2026-07-25T00:00:00.000Z',
    currency: 'USD',
    estimate: true,
    truncated: false,
    unpricedCount: 0,
    points: [],
    ...overrides,
  };
}

describe('CostOverTimeChart', () => {
  it('renders a loading skeleton when loading is true', () => {
    render(<CostOverTimeChart data={null} loading={true} />);
    expect(screen.getByTestId('cost-over-time-chart')).toBeInTheDocument();
    expect(screen.queryByText(/No cost data available/i)).not.toBeInTheDocument();
  });

  it('renders an empty state when there are no points', () => {
    render(<CostOverTimeChart data={makeSeries({ points: [] })} loading={false} />);
    expect(screen.getByText(/No cost data available for this period/i)).toBeInTheDocument();
  });

  it('renders the EstimateBadge and no UnpricedChip when data has points and no unpriced rows', () => {
    render(
      <CostOverTimeChart
        data={makeSeries({
          points: [{ t: '2026-07-20', costMicros: 5_000_000, totalTokens: 100, rows: 2, unpricedRows: 0 }],
          unpricedCount: 0,
        })}
        loading={false}
      />,
    );
    expect(screen.getByText('Estimate')).toBeInTheDocument();
    expect(screen.queryByText(/unpriced/)).not.toBeInTheDocument();
  });

  it('renders the UnpricedChip with the unpriced count when unpricedCount > 0', () => {
    render(
      <CostOverTimeChart
        data={makeSeries({
          points: [{ t: '2026-07-20', costMicros: 5_000_000, totalTokens: 100, rows: 3, unpricedRows: 1 }],
          unpricedCount: 3,
        })}
        loading={false}
      />,
    );
    expect(screen.getByText('3 unpriced')).toBeInTheDocument();
  });
});
