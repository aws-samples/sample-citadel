/**
 * DlqAlarmsWidget tests.
 *
 * Admin-only widget surfacing DLQ/SLO CloudWatch alarm state on the
 * dashboard. Covers every state usePlatformAlarms can report, plus the
 * non-admin hidden-widget case. The GraphQL query, hook, and data flow are
 * unchanged by the restyle — these tests assert on the new presentation.
 */
import { render, screen, fireEvent, within } from '@testing-library/react';
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
import { DlqAlarmsWidget } from '../DlqAlarmsWidget';

const usePlatformAlarmsMock = usePlatformAlarms as jest.Mock;
const useOrganizationMock = useOrganization as jest.Mock;

const refresh = jest.fn();

describe('DlqAlarmsWidget', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useOrganizationMock.mockReturnValue({ isAdmin: true });
  });

  test('renders nothing for a non-admin caller', () => {
    useOrganizationMock.mockReturnValue({ isAdmin: false });
    usePlatformAlarmsMock.mockReturnValue({ status: 'all-ok', alarms: [], refresh });

    render(<DlqAlarmsWidget />);

    expect(screen.queryByTestId('dlq-alarms-widget')).not.toBeInTheDocument();
  });

  test('renders nothing when the hook reports unauthorised', () => {
    usePlatformAlarmsMock.mockReturnValue({ status: 'unauthorised', alarms: [], refresh });

    render(<DlqAlarmsWidget />);

    expect(screen.queryByTestId('dlq-alarms-widget')).not.toBeInTheDocument();
  });

  describe('loading', () => {
    test('renders skeleton rows while the first fetch is pending', () => {
      usePlatformAlarmsMock.mockReturnValue({ status: 'loading', alarms: [], refresh });

      render(<DlqAlarmsWidget />);

      expect(screen.getByTestId('dlq-alarms-widget')).toBeInTheDocument();
      expect(screen.getByTestId('dlq-alarms-loading')).toBeInTheDocument();
      expect(screen.getByText('Queue health')).toBeInTheDocument();
    });
  });

  describe('not-configured (empty) state', () => {
    test('shows empty-state copy when no alarms are configured', () => {
      usePlatformAlarmsMock.mockReturnValue({ status: 'not-configured', alarms: [], refresh });

      render(<DlqAlarmsWidget />);

      expect(screen.getByText(/dlq monitoring not configured/i)).toBeInTheDocument();
    });
  });

  describe('all-clear state', () => {
    test('shows the overall status chip, a compact summary line, and expands the healthy list', () => {
      usePlatformAlarmsMock.mockReturnValue({
        status: 'all-ok',
        alarms: [
          {
            alarmName: 'citadel-dlq-not-empty-dev',
            state: 'OK',
            reason: 'Threshold not breached',
            stateUpdatedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
            category: 'dlq',
          },
        ],
        refresh,
      });

      render(<DlqAlarmsWidget />);

      expect(screen.getByText('All clear')).toBeInTheDocument();
      const summary = screen.getByTestId('dlq-alarms-summary');
      expect(summary).toHaveAttribute('aria-live', 'polite');
      expect(summary).toHaveTextContent(/1 queue healthy/i);
      expect(summary).toHaveTextContent(/checked/i);

      expect(screen.queryByText('citadel-dlq-not-empty-dev')).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: /show details/i }));
      expect(screen.getByText('DLQ Not Empty')).toBeInTheDocument();
    });

    test('pluralises the summary line for more than one healthy queue', () => {
      usePlatformAlarmsMock.mockReturnValue({
        status: 'all-ok',
        alarms: [
          { alarmName: 'citadel-dlq-a-dev', state: 'OK', stateUpdatedAt: new Date().toISOString() },
          { alarmName: 'citadel-dlq-b-dev', state: 'OK', stateUpdatedAt: new Date().toISOString() },
        ],
        refresh,
      });

      render(<DlqAlarmsWidget />);

      expect(screen.getByTestId('dlq-alarms-summary')).toHaveTextContent(/2 queues healthy/i);
    });
  });

  describe('alarm state', () => {
    const baseAlarms = [
      {
        alarmName: 'citadel-dlq-not-empty-prod',
        state: 'OK' as const,
        reason: 'ok',
        stateUpdatedAt: new Date(Date.now() - 2 * 60_000).toISOString(),
        category: 'dlq',
      },
      {
        alarmName: 'citadel-queue-backlog-dev',
        state: 'INSUFFICIENT_DATA' as const,
        reason: 'no datapoints',
        stateUpdatedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
        category: 'dlq',
      },
      {
        alarmName: 'citadel-dlq-message-count-dev',
        state: 'ALARM' as const,
        reason: 'Threshold Crossed: 1 datapoint [4.0] was greater than the threshold (0.0).',
        stateUpdatedAt: new Date(Date.now() - 60_000).toISOString(),
        category: 'dlq',
        queueDepth: 4,
      },
    ];

    test('shows the status chip with a firing count and a pulsing indicator', () => {
      usePlatformAlarmsMock.mockReturnValue({ status: 'alarm', alarms: baseAlarms, refresh });

      render(<DlqAlarmsWidget />);

      const chip = screen.getByTestId('dlq-alarms-status-chip');
      expect(chip).toHaveTextContent('1 alarm');
      expect(within(chip).getByTestId('dlq-alarms-pulse')).toBeInTheDocument();
    });

    test('lists alarms sorted ALARM first, with humanised names and state badges', () => {
      usePlatformAlarmsMock.mockReturnValue({ status: 'alarm', alarms: baseAlarms, refresh });

      render(<DlqAlarmsWidget />);

      const rows = screen.getAllByTestId('dlq-alarm-row');
      expect(rows).toHaveLength(3);
      expect(within(rows[0]).getByText('ALARM')).toBeInTheDocument();
      expect(within(rows[0]).getByText(/dlq message count/i)).toBeInTheDocument();
      expect(within(rows[0]).getByText(/4 messages?/i)).toBeInTheDocument();

      expect(within(rows[1]).getByText('INSUFFICIENT_DATA')).toBeInTheDocument();
      expect(within(rows[2]).getByText('OK')).toBeInTheDocument();
      expect(within(rows[2]).getByText(/dlq not empty/i)).toBeInTheDocument();
    });

    test('shows the raw StateReason in a tooltip on each row', () => {
      usePlatformAlarmsMock.mockReturnValue({ status: 'alarm', alarms: baseAlarms, refresh });

      render(<DlqAlarmsWidget />);

      const rows = screen.getAllByTestId('dlq-alarm-row');
      const trigger = within(rows[0]).getByTestId('dlq-alarm-reason-trigger');
      expect(trigger).toHaveAttribute(
        'title',
        'Threshold Crossed: 1 datapoint [4.0] was greater than the threshold (0.0).',
      );
    });
  });
});
