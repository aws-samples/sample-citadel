/**
 * PublishConfirmationScreen unit tests
 * Tests: rendering endpoint URL, API key, warning message, app name/status badge,
 * copy-to-clipboard calls, silent clipboard failure, back navigation
 * Validates: Requirements 1.3, 2.1, 2.2, 2.3, 2.4, 3.1, 3.2, 3.3, 3.4
 */
import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import '@testing-library/jest-dom';

// Mock clipboard API
const mockWriteText = jest.fn().mockResolvedValue(undefined);
Object.assign(navigator, { clipboard: { writeText: mockWriteText } });

// Mock UI components following existing test patterns
jest.mock('@/components/ui/badge', () => ({
  Badge: ({ children, className }: any) =>
    React.createElement('span', { className, 'data-testid': 'badge' }, children),
}));

jest.mock('@/components/ui/button', () => ({
  Button: ({ children, onClick, disabled, className, variant, size, ...props }: any) =>
    React.createElement('button', { onClick, disabled, className, ...props }, children),
}));

import { PublishConfirmationScreen } from '../PublishConfirmationScreen';

const defaultProps = {
  appId: 'app-123',
  appName: 'Test App',
  endpointUrl: 'https://abc123.execute-api.us-east-1.amazonaws.com',
  apiKey: 'dGVzdC1hcGkta2V5LXZhbHVl',
  onBack: jest.fn(),
  onNavigate: jest.fn(),
};

describe('PublishConfirmationScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    mockWriteText.mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // Req 2.4: Displays the app name
  it('renders the app name', () => {
    render(React.createElement(PublishConfirmationScreen, defaultProps));
    expect(screen.getByText('Test App')).toBeInTheDocument();
  });

  // Req 2.4: Displays the PUBLISHED status badge
  it('renders the PUBLISHED status badge', () => {
    render(React.createElement(PublishConfirmationScreen, defaultProps));
    const badges = screen.getAllByTestId('badge');
    const publishedBadge = badges.find((b) => b.textContent === 'PUBLISHED');
    expect(publishedBadge).toBeTruthy();
  });

  // Req 2.1: Displays the endpoint URL
  it('renders the endpoint URL text', () => {
    render(React.createElement(PublishConfirmationScreen, defaultProps));
    expect(
      screen.getByText('https://abc123.execute-api.us-east-1.amazonaws.com')
    ).toBeInTheDocument();
  });

  // Req 2.2: Displays the API key
  it('renders the API key text', () => {
    render(React.createElement(PublishConfirmationScreen, defaultProps));
    expect(screen.getByText('dGVzdC1hcGkta2V5LXZhbHVl')).toBeInTheDocument();
  });

  // Req 2.3: Displays the one-time warning message
  it('renders the warning message about one-time API key', () => {
    render(React.createElement(PublishConfirmationScreen, defaultProps));
    expect(
      screen.getByText(
        'This API key is shown only once and cannot be retrieved later. Copy it now.'
      )
    ).toBeInTheDocument();
  });

  // Req 3.1: Copy endpoint URL button calls clipboard.writeText
  it('copies endpoint URL to clipboard when copy button is clicked', async () => {
    render(React.createElement(PublishConfirmationScreen, defaultProps));

    const copyEndpointBtn = screen.getByLabelText('Copy endpoint URL');
    await act(async () => {
      fireEvent.click(copyEndpointBtn);
    });

    expect(mockWriteText).toHaveBeenCalledWith(
      'https://abc123.execute-api.us-east-1.amazonaws.com'
    );
  });

  // Req 3.2: Copy API key button calls clipboard.writeText
  it('copies API key to clipboard when copy button is clicked', async () => {
    render(React.createElement(PublishConfirmationScreen, defaultProps));

    const copyApiKeyBtn = screen.getByLabelText('Copy API key');
    await act(async () => {
      fireEvent.click(copyApiKeyBtn);
    });

    expect(mockWriteText).toHaveBeenCalledWith('dGVzdC1hcGkta2V5LXZhbHVl');
  });

  // Req 3.3: Shows "Copied" feedback after successful copy
  it('shows "Copied" feedback after successful copy', async () => {
    render(React.createElement(PublishConfirmationScreen, defaultProps));

    const copyEndpointBtn = screen.getByLabelText('Copy endpoint URL');
    await act(async () => {
      fireEvent.click(copyEndpointBtn);
    });

    expect(screen.getByText('Copied')).toBeInTheDocument();
  });

  // Req 3.4: Silent clipboard failure — no error thrown/shown
  it('fails silently when clipboard writeText rejects', async () => {
    mockWriteText.mockRejectedValueOnce(new Error('Clipboard unavailable'));

    render(React.createElement(PublishConfirmationScreen, defaultProps));

    const copyEndpointBtn = screen.getByLabelText('Copy endpoint URL');

    // Should not throw
    await act(async () => {
      fireEvent.click(copyEndpointBtn);
    });

    // No "Copied" feedback should appear since it failed
    expect(screen.queryByText('Copied')).not.toBeInTheDocument();
  });

  // Req 1.3: Back navigation — clicking "Back to App" calls onBack
  it('calls onBack when "Back to App" button is clicked', () => {
    render(React.createElement(PublishConfirmationScreen, defaultProps));

    const backButton = screen.getByText('Back to App');
    fireEvent.click(backButton);

    expect(defaultProps.onBack).toHaveBeenCalled();
  });

  // Navigation: "Go to API Dashboard" calls onNavigate with correct path
  it('calls onNavigate with correct path when "Go to API Dashboard" is clicked', () => {
    render(React.createElement(PublishConfirmationScreen, defaultProps));

    const dashboardButton = screen.getByText('Go to API Dashboard');
    fireEvent.click(dashboardButton);

    expect(defaultProps.onNavigate).toHaveBeenCalledWith('app-api-dashboard:app-123');
  });
});
