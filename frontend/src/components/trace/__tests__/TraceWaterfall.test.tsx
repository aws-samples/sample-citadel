/**
 * TraceWaterfall + TraceSpanRow + TraceDurationRuler + TraceStates tests.
 *
 * Covers: nested span tree render, fault>error>throttle badge precedence,
 * span collapse toggle, duration ruler tick scaling, and each honest state
 * (loading/indexing/empty/unauthorized/unavailable) — design pass-2 test list.
 */
import '@testing-library/jest-dom';
import { render, screen, fireEvent } from '@testing-library/react';
import { TraceWaterfall } from '../TraceWaterfall';
import { TraceDurationRuler } from '../TraceDurationRuler';
import {
  TraceLoadingState,
  TraceIndexingState,
  TraceEmptyState,
  TraceUnauthorizedState,
  TraceUnavailableState,
} from '../TraceStates';
import type { TraceSpan, TraceSummary } from '../../../services/traceService';

function makeSpan(overrides: Partial<TraceSpan> = {}): TraceSpan {
  return {
    id: 'span-1',
    parentId: null,
    name: 'root-span',
    startTime: 0,
    startOffsetMs: 0,
    durationMs: 100,
    status: 'ok',
    children: [],
    ...overrides,
  };
}

function makeTrace(overrides: Partial<TraceSummary> = {}): TraceSummary {
  return {
    traceId: '1-abc-def',
    rootName: 'citadel-stepRunner-prod',
    startTime: 100,
    endTime: 102,
    durationMs: 2000,
    hasError: false,
    hasFault: false,
    hasThrottle: false,
    annotations: { correlation_id: 'exec-1' },
    spans: [makeSpan()],
    ...overrides,
  };
}

describe('TraceWaterfall', () => {
  it('renders a nested span tree with parent and child rows', () => {
    const child = makeSpan({ id: 'span-2', parentId: 'span-1', name: 'child-span', startOffsetMs: 10, durationMs: 20 });
    const root = makeSpan({ children: [child] });
    render(<TraceWaterfall traces={[makeTrace({ spans: [root] })]} />);

    const rows = screen.getAllByTestId('trace-span-row');
    expect(rows).toHaveLength(2);
    expect(screen.getByText('root-span')).toBeInTheDocument();
    expect(screen.getByText('child-span')).toBeInTheDocument();
  });

  it('shows a fault badge taking precedence over error/throttle on the trace header', () => {
    const trace = makeTrace({ hasFault: true, hasError: true, hasThrottle: true });
    render(<TraceWaterfall traces={[trace]} />);
    expect(screen.getByText('fault')).toBeInTheDocument();
    expect(screen.queryByText('error')).not.toBeInTheDocument();
  });

  it('shows an error badge on a span (fault > error > throttle precedence)', () => {
    const errored = makeSpan({ status: 'error', error: { type: 'Timeout', message: 'boom' } });
    render(<TraceWaterfall traces={[makeTrace({ spans: [errored] })]} />);
    expect(screen.getByText('error')).toBeInTheDocument();
    expect(screen.getByText(/boom/)).toBeInTheDocument();
  });

  it('shows a throttle badge on a span when status is throttle', () => {
    const throttled = makeSpan({ status: 'throttle' });
    render(<TraceWaterfall traces={[makeTrace({ spans: [throttled] })]} />);
    expect(screen.getByText('throttle')).toBeInTheDocument();
  });

  it('sorts multiple traces by startTime ascending', () => {
    const later = makeTrace({ traceId: '1-later', startTime: 200, rootName: 'later-trace' });
    const earlier = makeTrace({ traceId: '1-earlier', startTime: 50, rootName: 'earlier-trace' });
    render(<TraceWaterfall traces={[later, earlier]} />);
    const blocks = screen.getAllByTestId('trace-block');
    expect(blocks[0]).toHaveTextContent('earlier-trace');
    expect(blocks[1]).toHaveTextContent('later-trace');
  });

  it('collapses and expands a span with children via the chevron toggle', () => {
    const child = makeSpan({ id: 'span-2', parentId: 'span-1', name: 'child-span' });
    const root = makeSpan({ children: [child] });
    render(<TraceWaterfall traces={[makeTrace({ spans: [root] })]} />);

    expect(screen.getByText('child-span')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Collapse span'));
    expect(screen.queryByText('child-span')).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Expand span'));
    expect(screen.getByText('child-span')).toBeInTheDocument();
  });

  it('renders "No spans recorded" when a trace has zero spans', () => {
    render(<TraceWaterfall traces={[makeTrace({ spans: [] })]} />);
    expect(screen.getByText(/No spans recorded/)).toBeInTheDocument();
  });

  it('positions the duration bar with left%/width% computed from startOffsetMs/durationMs', () => {
    // startOffsetMs 500 of a 2000ms trace duration → left: 25%
    // durationMs 300 of a 2000ms trace duration → width: 15%
    const span = makeSpan({ startOffsetMs: 500, durationMs: 300 });
    render(<TraceWaterfall traces={[makeTrace({ durationMs: 2000, spans: [span] })]} />);

    const bar = screen.getByTitle(/root-span · 300ms/);
    expect(bar).toHaveStyle({ left: '25%', width: '15%' });
  });
});

describe('TraceDurationRuler', () => {
  it('renders tick labels scaled to the total duration', () => {
    render(<TraceDurationRuler totalDurationMs={5000} tickCount={3} />);
    expect(screen.getByText('0ms')).toBeInTheDocument();
    expect(screen.getByText('2.5s')).toBeInTheDocument();
    expect(screen.getByText('5.0s')).toBeInTheDocument();
  });

  it('handles a sub-second total duration in ms', () => {
    render(<TraceDurationRuler totalDurationMs={400} tickCount={2} />);
    expect(screen.getByText('0ms')).toBeInTheDocument();
    expect(screen.getByText('400ms')).toBeInTheDocument();
  });
});

describe('TraceStates — honest states', () => {
  it('renders the loading state', () => {
    render(<TraceLoadingState />);
    expect(screen.getByRole('status', { name: /loading trace/i })).toBeInTheDocument();
  });

  it('renders the indexing state with a retry action', () => {
    const onRetry = jest.fn();
    render(<TraceIndexingState onRetry={onRetry} />);
    expect(screen.getByText(/still indexing/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('renders the empty state', () => {
    render(<TraceEmptyState />);
    expect(screen.getByText(/no trace recorded/i)).toBeInTheDocument();
  });

  it('renders the unauthorized state with the server-supplied reason', () => {
    render(<TraceUnauthorizedState reason="Forbidden" />);
    expect(screen.getByText(/not authorized/i)).toBeInTheDocument();
    expect(screen.getByText('Forbidden')).toBeInTheDocument();
  });

  it('renders the unavailable state', () => {
    render(<TraceUnavailableState />);
    expect(screen.getByText(/trace viewer unavailable/i)).toBeInTheDocument();
  });
});
