/**
 * CostByDimensionChart tests
 *
 * Covers: loading skeleton, empty state (no buckets), data rendering with
 * EstimateBadge, UnpricedChip, and the currency-mixed warning banner.
 */
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { CostByDimensionChart } from '../CostByDimensionChart';
import type { CostSummaryResponse } from '../../../services/costService';

function makeSummary(overrides: Partial<CostSummaryResponse> = {}): CostSummaryResponse {
  return {
    groupBy: 'app',
    from: '2026-06-25T00:00:00.000Z',
    to: '2026-07-25T00:00:00.000Z',
    currency: 'USD',
    currencyMixed: false,
    totalCostMicros: 0,
    pricedRows: 0,
    unpricedRows: 0,
    estimate: true,
    truncated: false,
    buckets: [],
    ...overrides,
  };
}

describe('CostByDimensionChart', () => {
  it('renders a loading skeleton when loading is true', () => {
    render(<CostByDimensionChart data={null} loading={true} />);
    expect(screen.getByTestId('cost-by-dimension-chart')).toBeInTheDocument();
  });

  it('renders an empty state when there are no buckets', () => {
    render(<CostByDimensionChart data={makeSummary({ buckets: [] })} loading={false} />);
    expect(screen.getByText(/No cost data available for this period/i)).toBeInTheDocument();
  });

  it('renders the EstimateBadge when buckets are present', () => {
    render(
      <CostByDimensionChart
        data={makeSummary({
          buckets: [{ key: 'app-1', label: 'app-1', costMicros: 2_000_000, tokenCost: 2, totalTokens: 500, rows: 4, unpricedRows: 0 }],
        })}
        loading={false}
      />,
    );
    expect(screen.getByText('Estimate')).toBeInTheDocument();
  });

  it('renders the UnpricedChip when unpricedRows > 0', () => {
    render(
      <CostByDimensionChart
        data={makeSummary({
          buckets: [{ key: 'app-1', label: 'app-1', costMicros: 2_000_000, tokenCost: 2, totalTokens: 500, rows: 4, unpricedRows: 2 }],
          unpricedRows: 2,
        })}
        loading={false}
      />,
    );
    expect(screen.getByText('2 unpriced')).toBeInTheDocument();
  });

  it('shows a currency-mixed warning when currencyMixed is true', () => {
    render(
      <CostByDimensionChart
        data={makeSummary({
          currencyMixed: true,
          currency: null,
          buckets: [{ key: 'app-1', label: 'app-1', costMicros: 1_000_000, tokenCost: 1, totalTokens: 100, rows: 1, unpricedRows: 0 }],
        })}
        loading={false}
      />,
    );
    expect(screen.getByText(/multiple currencies/i)).toBeInTheDocument();
  });
});
