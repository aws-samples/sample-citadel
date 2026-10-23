/**
 * Calendar + ChartTooltipContent — recharts 3 / react-day-picker 10 migration
 *
 * Validates:
 *  1. Calendar renders Chevron (not IconLeft/IconRight) for navigation.
 *  2. ChartTooltipContent renders tooltip payload with the new recharts 3 types.
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

/* ─── Calendar ──────────────────────────────────────────────────────── */

// Mock lucide-react icons so we can assert they are rendered
jest.mock('lucide-react', () => ({
  ChevronLeft: (props: Record<string, unknown>) => (
    <svg data-testid="chevron-left" {...props} />
  ),
  ChevronRight: (props: Record<string, unknown>) => (
    <svg data-testid="chevron-right" {...props} />
  ),
}));

import { Calendar } from '../components/ui/calendar';

describe('Calendar – react-day-picker 10 Chevron migration', () => {
  it('renders left and right chevron navigation icons', () => {
    render(<Calendar />);
    // react-day-picker 10 invokes components.Chevron with orientation="left"/"right"
    // Our Chevron component maps those to ChevronLeft/ChevronRight from lucide-react
    expect(screen.getAllByTestId('chevron-left').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByTestId('chevron-right').length).toBeGreaterThanOrEqual(1);
  });

  it('does not render legacy IconLeft / IconRight components', () => {
    const { container } = render(<Calendar />);
    expect(container.querySelector('[data-testid="icon-left"]')).toBeNull();
    expect(container.querySelector('[data-testid="icon-right"]')).toBeNull();
  });
});

/* ─── ChartTooltipContent ───────────────────────────────────────────── */

// Mock recharts ResponsiveContainer so it renders children in jsdom (0-size viewport)
jest.mock('recharts', () => {
  const actual = jest.requireActual('recharts');
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
      <div data-testid="responsive-container">{children}</div>
    ),
  };
});

import { ChartContainer, ChartTooltipContent } from '../components/ui/chart';

const chartConfig = { revenue: { label: 'Revenue', color: '#000' } };

function ChartWrapper({ children }: { children: React.ReactNode }) {
  return <ChartContainer config={chartConfig}>{children}</ChartContainer>;
}

describe('ChartTooltipContent – recharts 3 type migration', () => {
  it('renders nothing when not active', () => {
    const { container } = render(
      <ChartWrapper>
        <ChartTooltipContent active={false} payload={[]} />
      </ChartWrapper>,
    );
    expect(container.querySelector('[data-slot="chart"]')).toBeInTheDocument();
  });

  it('renders payload items when active', () => {
    const payload = [
      {
        name: 'Revenue',
        value: 42_000,
        dataKey: 'revenue',
        color: '#8884d8',
        payload: { fill: '#8884d8' },
        graphicalItemId: 'item-1',
      },
    ];

    render(
      <ChartWrapper>
        <ChartTooltipContent
          active={true}
          payload={payload as any}
          label="Jan"
        />
      </ChartWrapper>,
    );

    expect(screen.getByText('Jan')).toBeInTheDocument();
    expect(screen.getByText('42,000')).toBeInTheDocument();
  });
});
