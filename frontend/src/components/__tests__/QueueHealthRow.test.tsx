/**
 * QueueHealthRow tests.
 *
 * Admin-only row inside the System Health card. Shows only non-OK queue
 * alarm state. Covers every state usePlatformAlarms can report plus the
 * non-admin hidden case, summary text/ordering/truncation, and the tooltip.
 */
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('../../hooks/usePlatformAlarms', () => ({
  usePlatformAlarms: jest.fn(),
}));
jest.mock('../../contexts/OrganizationContext', () => ({
  useOrganization: jest.fn(),
}));
jest.mock('../../services/server', () => ({
  __esModule: true,
  default: { getConfig: () => ({ appsyncRegion: 'us-east-1' }) },
}));

import { usePlatformAlarms } from '../../hooks/usePlatformAlarms';
import { useOrganization } from '../../contexts/OrganizationContext';
import type { PlatformAlarm } from '../../services/platformAlarmsService';
import { QueueHealthRow } from '../QueueHealthRow';
import { humaniseAlarmName, summariseAttentionAlarms } from '../../utils/queueHealth';

const usePlatformAlarmsMock = usePlatformAlarms as jest.Mock;
const useOrganizationMock = useOrganization as jest.Mock;

const refresh = jest.fn();

const makeAlarm = (overrides: Partial<PlatformAlarm> & { alarmName: string }): PlatformAlarm => ({
  state: 'ALARM',
  reason: null,
  queueDepth: null,
  ...overrides,
});

const registryDlq = makeAlarm({
  alarmName: 'citadel-registry-sync-dlq-dev',
  state: 'ALARM',
  queueDepth: 109,
  reason: 'Threshold Crossed: 1 datapoint [109.0] was greater than the threshold (0.0).',
});
const workerDlq = makeAlarm({
  alarmName: 'citadel-worker-dlq-dev',
  state: 'ALARM',
  queueDepth: 3,
  reason: 'Threshold Crossed: 1 datapoint [3.0] was greater than the threshold (0.0).',
});
const okAlarm = makeAlarm({ alarmName: 'citadel-intake-dlq-dev', state: 'OK', queueDepth: 0 });

describe('QueueHealthRow', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useOrganizationMock.mockReturnValue({ isAdmin: true });
  });

  test('renders nothing for a non-admin caller and does not enable the query', () => {
    useOrganizationMock.mockReturnValue({ isAdmin: false });
    usePlatformAlarmsMock.mockReturnValue({ status: 'loading', alarms: [], refresh });

    render(<QueueHealthRow />);

    expect(screen.queryByTestId('queue-health-row')).not.toBeInTheDocument();
    expect(usePlatformAlarmsMock).toHaveBeenCalledWith({ enabled: false });
  });

  describe('loading', () => {
    test('shows the Queues label with a skeleton line and no status text', () => {
      usePlatformAlarmsMock.mockReturnValue({ status: 'loading', alarms: [], refresh });

      render(<QueueHealthRow />);

      expect(screen.getByText('Queues')).toBeInTheDocument();
      expect(screen.getByTestId('queue-health-loading')).toBeInTheDocument();
      expect(screen.queryByText('All clear')).not.toBeInTheDocument();
      expect(screen.queryByText('Unavailable')).not.toBeInTheDocument();
    });
  });

  describe('all clear', () => {
    test('shows a muted "All clear" with a check icon when every alarm is OK', () => {
      usePlatformAlarmsMock.mockReturnValue({ status: 'all-ok', alarms: [okAlarm], refresh });

      render(<QueueHealthRow />);

      const summary = screen.getByTestId('queue-health-summary');
      expect(summary).toHaveTextContent(/^All clear$/);
      expect(screen.getByText('All clear')).toHaveClass('text-muted-foreground');
      expect(screen.getByTestId('queue-health-icon')).toHaveAttribute('data-severity', 'ok');
    });

    test('shows "All clear" when no alarms are configured', () => {
      usePlatformAlarmsMock.mockReturnValue({ status: 'not-configured', alarms: [], refresh });

      render(<QueueHealthRow />);

      expect(screen.getByTestId('queue-health-summary')).toHaveTextContent(/^All clear$/);
    });

    test('does not list healthy queues or counts', () => {
      usePlatformAlarmsMock.mockReturnValue({ status: 'all-ok', alarms: [okAlarm], refresh });

      render(<QueueHealthRow />);

      expect(screen.queryByText(/intake/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/healthy/i)).not.toBeInTheDocument();
    });
  });

  describe('attention', () => {
    test('summarises two alarms with humanised names and queue depth', () => {
      usePlatformAlarmsMock.mockReturnValue({
        status: 'alarm',
        alarms: [registryDlq, workerDlq],
        refresh,
      });

      render(<QueueHealthRow />);

      expect(screen.getByTestId('queue-health-summary')).toHaveTextContent(
        '2 queues need attention: Registry Sync DLQ (109), Worker DLQ (3)',
      );
    });

    test('uses singular wording for one queue and omits depth when unknown', () => {
      usePlatformAlarmsMock.mockReturnValue({
        status: 'alarm',
        alarms: [makeAlarm({ alarmName: 'citadel-worker-dlq-dev', queueDepth: null }), okAlarm],
        refresh,
      });

      render(<QueueHealthRow />);

      expect(screen.getByTestId('queue-health-summary')).toHaveTextContent(
        /^1 queue needs attention: Worker DLQ$/,
      );
    });

    test('omits OK alarms from the summary', () => {
      usePlatformAlarmsMock.mockReturnValue({
        status: 'alarm',
        alarms: [okAlarm, registryDlq],
        refresh,
      });

      render(<QueueHealthRow />);

      const summary = screen.getByTestId('queue-health-summary');
      expect(summary).toHaveTextContent('1 queue needs attention: Registry Sync DLQ (109)');
      expect(summary).not.toHaveTextContent(/intake/i);
    });

    test('lists ALARM before INSUFFICIENT_DATA regardless of input order', () => {
      const insufficient = makeAlarm({
        alarmName: 'citadel-intake-dlq-dev',
        state: 'INSUFFICIENT_DATA',
        queueDepth: 7,
      });
      usePlatformAlarmsMock.mockReturnValue({
        status: 'alarm',
        alarms: [insufficient, workerDlq],
        refresh,
      });

      render(<QueueHealthRow />);

      expect(screen.getByTestId('queue-health-summary')).toHaveTextContent(
        '2 queues need attention: Worker DLQ (3), Intake DLQ (7)',
      );
    });

    test('shows exactly three alarms without a "+N more" suffix', () => {
      const third = makeAlarm({ alarmName: 'citadel-intake-dlq-dev', queueDepth: 1 });
      usePlatformAlarmsMock.mockReturnValue({
        status: 'alarm',
        alarms: [registryDlq, workerDlq, third],
        refresh,
      });

      render(<QueueHealthRow />);

      const summary = screen.getByTestId('queue-health-summary');
      expect(summary).toHaveTextContent(
        '3 queues need attention: Registry Sync DLQ (109), Worker DLQ (3), Intake DLQ (1)',
      );
      expect(summary).not.toHaveTextContent('more');
    });

    test('truncates after three alarms with "+N more"', () => {
      const alarms = [
        registryDlq,
        workerDlq,
        makeAlarm({ alarmName: 'citadel-intake-dlq-dev', queueDepth: 1 }),
        makeAlarm({ alarmName: 'citadel-fourth-dlq-dev', queueDepth: 2 }),
        makeAlarm({ alarmName: 'citadel-fifth-dlq-dev', state: 'INSUFFICIENT_DATA' }),
      ];
      usePlatformAlarmsMock.mockReturnValue({ status: 'alarm', alarms, refresh });

      render(<QueueHealthRow />);

      const summary = screen.getByTestId('queue-health-summary');
      expect(summary).toHaveTextContent(
        '5 queues need attention: Registry Sync DLQ (109), Worker DLQ (3), Intake DLQ (1), +2 more',
      );
      expect(summary).not.toHaveTextContent('Fourth');
      expect(summary).not.toHaveTextContent('Fifth');
    });

    test('uses a red icon when any alarm is firing', () => {
      usePlatformAlarmsMock.mockReturnValue({ status: 'alarm', alarms: [workerDlq], refresh });

      render(<QueueHealthRow />);

      const icon = screen.getByTestId('queue-health-icon');
      expect(icon).toHaveAttribute('data-severity', 'alarm');
      expect(icon).toHaveClass('text-destructive');
    });

    test('uses an amber icon when only INSUFFICIENT_DATA alarms remain', () => {
      usePlatformAlarmsMock.mockReturnValue({
        status: 'all-ok',
        alarms: [makeAlarm({ alarmName: 'citadel-intake-dlq-dev', state: 'INSUFFICIENT_DATA' })],
        refresh,
      });

      render(<QueueHealthRow />);

      const icon = screen.getByTestId('queue-health-icon');
      expect(icon).toHaveAttribute('data-severity', 'insufficient-data');
      expect(icon).toHaveClass('text-chart-3');
      expect(screen.getByTestId('queue-health-summary')).toHaveTextContent(
        '1 queue needs attention: Intake DLQ',
      );
    });

    test('keeps the summary in a polite live region', () => {
      usePlatformAlarmsMock.mockReturnValue({ status: 'alarm', alarms: [workerDlq], refresh });

      render(<QueueHealthRow />);

      expect(screen.getByTestId('queue-health-summary')).toHaveAttribute('aria-live', 'polite');
    });
  });

  describe('tooltip', () => {
    test('lists raw alarm names, states and reasons for every non-OK alarm, untruncated', () => {
      const alarms = [
        registryDlq,
        workerDlq,
        makeAlarm({ alarmName: 'citadel-intake-dlq-dev', queueDepth: 1, reason: 'intake reason' }),
        makeAlarm({
          alarmName: 'citadel-fourth-dlq-dev',
          state: 'INSUFFICIENT_DATA',
          reason: 'Unchecked: Initial alarm creation',
        }),
        okAlarm,
      ];
      usePlatformAlarmsMock.mockReturnValue({ status: 'alarm', alarms, refresh });

      render(<QueueHealthRow />);
      fireEvent.focus(screen.getByTestId('queue-health-row'));

      const tooltip = screen.getByRole('tooltip');
      expect(tooltip).toHaveTextContent('citadel-registry-sync-dlq-dev (ALARM)');
      expect(tooltip).toHaveTextContent('Threshold Crossed: 1 datapoint [109.0]');
      expect(tooltip).toHaveTextContent('citadel-worker-dlq-dev (ALARM)');
      expect(tooltip).toHaveTextContent('intake reason');
      expect(tooltip).toHaveTextContent('citadel-fourth-dlq-dev (INSUFFICIENT_DATA)');
      expect(tooltip).toHaveTextContent('Unchecked: Initial alarm creation');
      expect(tooltip).not.toHaveTextContent('citadel-intake-dlq-dev (OK)');
    });

    test('makes the row keyboard-focusable only when there is something to show', () => {
      usePlatformAlarmsMock.mockReturnValue({ status: 'alarm', alarms: [workerDlq], refresh });
      const { unmount } = render(<QueueHealthRow />);
      expect(screen.getByTestId('queue-health-row')).toHaveAttribute('tabindex', '0');
      unmount();

      usePlatformAlarmsMock.mockReturnValue({ status: 'all-ok', alarms: [okAlarm], refresh });
      render(<QueueHealthRow />);
      expect(screen.getByTestId('queue-health-row')).not.toHaveAttribute('tabindex');
    });

    test('shows no tooltip when all clear', () => {
      usePlatformAlarmsMock.mockReturnValue({ status: 'all-ok', alarms: [okAlarm], refresh });

      render(<QueueHealthRow />);
      fireEvent.focus(screen.getByTestId('queue-health-row'));

      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    });
  });

  describe('error', () => {
    test('shows "Unavailable" with a Retry button that refreshes the query', () => {
      usePlatformAlarmsMock.mockReturnValue({ status: 'unauthorised', alarms: [], refresh });

      render(<QueueHealthRow />);

      expect(screen.getByTestId('queue-health-summary')).toHaveTextContent(/^Unavailable$/);
      fireEvent.click(screen.getByRole('button', { name: /retry loading queue health/i }));
      expect(refresh).toHaveBeenCalledTimes(1);
    });

    test('does not show a Retry button in non-error states', () => {
      usePlatformAlarmsMock.mockReturnValue({ status: 'alarm', alarms: [workerDlq], refresh });

      render(<QueueHealthRow />);

      expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
    });
  });
});

describe('humaniseAlarmName', () => {
  test.each([
    ['citadel-registry-sync-dlq-dev', 'Registry Sync DLQ'],
    ['citadel-worker-dlq-prod', 'Worker DLQ'],
    ['plain-name', 'Plain Name'],
  ])('%s -> %s', (raw, expected) => {
    expect(humaniseAlarmName(raw)).toBe(expected);
  });
});

describe('summariseAttentionAlarms', () => {
  test('does not collapse four alarms into "+0 more" and collapses to +1 more', () => {
    const four = ['a', 'b', 'c', 'd'].map((n) => makeAlarm({ alarmName: `citadel-${n}-dlq-dev` }));
    expect(summariseAttentionAlarms(four)).toBe('4 queues need attention: A DLQ, B DLQ, C DLQ, +1 more');
  });
});
