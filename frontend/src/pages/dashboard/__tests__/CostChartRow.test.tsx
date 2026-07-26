/**
 * CostChartRow tests
 *
 * Covers: renders nothing when the cost API is unconfigured (no fetch
 * attempts at all), and renders the cost panels once data resolves when
 * configured.
 */
import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('recharts', () => {
  const Original = jest.requireActual('recharts');
  const MockResponsiveContainer = ({ children }: { children: React.ReactNode }) => (
    <div data-testid="responsive-container">{children}</div>
  );
  return { ...Original, ResponsiveContainer: MockResponsiveContainer };
});

jest.mock('../../../services/costService', () => ({
  costService: {
    isAvailable: jest.fn(),
    getSummary: jest.fn(),
    getSeries: jest.fn(),
    listBudgets: jest.fn(),
    putBudget: jest.fn(),
  },
}));

import { costService } from '../../../services/costService';
import CostChartRow from '../CostChartRow';

describe('CostChartRow', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders nothing and makes no fetch calls when the cost API is unconfigured', async () => {
    (costService.isAvailable as jest.Mock).mockReturnValue(false);

    const { container } = render(<CostChartRow />);

    await waitFor(() => expect(container.firstChild).toBeNull());
    expect(costService.getSummary).not.toHaveBeenCalled();
    expect(costService.getSeries).not.toHaveBeenCalled();
  });

  it('renders the cost panels once data resolves when the cost API is configured', async () => {
    (costService.isAvailable as jest.Mock).mockReturnValue(true);
    (costService.getSeries as jest.Mock).mockResolvedValue({
      available: true,
      data: {
        dimension: 'org', bucket: 'day', from: '', to: '', currency: 'USD',
        estimate: true, truncated: false, unpricedCount: 0,
        points: [{ t: '2026-07-20', costMicros: 1_000_000, totalTokens: 10, rows: 1, unpricedRows: 0 }],
      },
    });
    (costService.getSummary as jest.Mock).mockResolvedValue({
      available: true,
      data: {
        groupBy: 'app', from: '', to: '', currency: 'USD', currencyMixed: false,
        totalCostMicros: 1_000_000, pricedRows: 1, unpricedRows: 0, estimate: true,
        truncated: false, buckets: [{ key: 'app-1', label: 'app-1', costMicros: 1_000_000, tokenCost: 1, totalTokens: 10, rows: 1, unpricedRows: 0 }],
      },
    });

    render(<CostChartRow />);

    await waitFor(() => expect(screen.getByTestId('cost-chart-row')).toBeInTheDocument());
    expect(screen.getByText('Cost by App')).toBeInTheDocument();
    expect(screen.getByText('Cost by Model')).toBeInTheDocument();
    expect(screen.getByText('Cost by Agent')).toBeInTheDocument();
  });
});
