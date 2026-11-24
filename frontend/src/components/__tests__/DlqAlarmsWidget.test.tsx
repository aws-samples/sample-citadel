/**
 * DlqAlarmsWidget tests.
 *
 * Admin-only widget surfacing DLQ/SLO CloudWatch alarm state on the
 * dashboard. Covers every state usePlatformAlarms can report, plus the
 * non-admin hidden-widget case.
 */
import { render, screen } from '@testing-library/react';
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

describe('DlqAlarmsWidget', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useOrganizationMock.mockReturnValue({ isAdmin: true });
  });

  test('renders nothing for a non-admin caller', () => {
    useOrganizationMock.mockReturnValue({ isAdmin: false });
    usePlatformAlarmsMock.mockReturnValue({ status: 'all-ok', alarms: [] });

    render(<DlqAlarmsWidget />);

    expect(screen.queryByTestId('dlq-alarms-widget')).not.toBeInTheDocument();
  });

  test('renders a loading skeleton while the first fetch is pending', () => {
    usePlatformAlarmsMock.mockReturnValue({ status: 'loading', alarms: [] });

    render(<DlqAlarmsWidget />);

    expect(screen.getByTestId('dlq-alarms-widget')).toBeInTheDocument();
    expect(screen.getByTestId('dlq-alarms-loading')).toBeInTheDocument();
  });

  test('renders an all-healthy message when configured with no alarms firing', () => {
    usePlatformAlarmsMock.mockReturnValue({ status: 'all-ok', alarms: [] });

    render(<DlqAlarmsWidget />);

    expect(screen.getByText(/all queues healthy/i)).toBeInTheDocument();
  });

  test('renders alarm details with redrive hint and a CloudWatch deep link', () => {
    usePlatformAlarmsMock.mockReturnValue({
      status: 'alarm',
      alarms: [
        {
          alarmName: 'citadel-dlq-not-empty-dev',
          state: 'ALARM',
          queueName: 'citadel-dlq-dev',
          queueDepth: 4,
          redriveHint: 'Redrive the DLQ once the root cause is fixed.',
        },
      ],
    });

    render(<DlqAlarmsWidget />);

    expect(screen.getByText('citadel-dlq-dev')).toBeInTheDocument();
    expect(screen.getByText(/4/)).toBeInTheDocument();
    expect(
      screen.getByText(/redrive the dlq once the root cause is fixed/i),
    ).toBeInTheDocument();

    const link = screen.getByRole('link', { name: /citadel-dlq-not-empty-dev/i });
    expect(link).toHaveAttribute(
      'href',
      'https://us-east-1.console.aws.amazon.com/cloudwatch/home?region=us-east-1#alarmsV2:alarm/citadel-dlq-not-empty-dev',
    );
  });

  test('renders nothing when the hook reports unauthorised', () => {
    usePlatformAlarmsMock.mockReturnValue({ status: 'unauthorised', alarms: [] });

    render(<DlqAlarmsWidget />);

    expect(screen.queryByTestId('dlq-alarms-widget')).not.toBeInTheDocument();
  });

  test('renders a muted not-configured message when the platform signal is unavailable', () => {
    usePlatformAlarmsMock.mockReturnValue({ status: 'not-configured', alarms: [] });

    render(<DlqAlarmsWidget />);

    expect(screen.getByText(/dlq monitoring not configured/i)).toBeInTheDocument();
  });
});
