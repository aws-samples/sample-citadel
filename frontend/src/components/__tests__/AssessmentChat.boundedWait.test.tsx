/**
 * Tests for AssessmentChat bounded-wait integration.
 *
 * Exercises the full component: turn state machine driving UI banners,
 * Retry reusing clientMessageId, and mutation error surfacing.
 */
import { render, screen, fireEvent, act } from '@testing-library/react';
import '@testing-library/jest-dom';
import { AssessmentChat } from '../../components/AssessmentChat';

// ── Mocks ──────────────────────────────────────────────────────────────
// jsdom doesn't have scrollIntoView.
Element.prototype.scrollIntoView = jest.fn();

// Track sendMessageToAgent calls.
const sendSpy = jest.fn().mockResolvedValue({
  id: 'srv-1', projectId: 'proj-1', agentId: 'agent1',
  message: 'hello', messageType: 'USER_INPUT',
  timestamp: new Date().toISOString(),
});

// Capture the subscription callback so we can push messages into it.
let capturedOnMessage: ((msg: Record<string, unknown>) => void) | null = null;

jest.mock('../../services/conversationService', () => ({
  sendMessageToAgent: (...args: unknown[]) => sendSpy(...args),
  getConversationHistoryForProject: jest.fn().mockResolvedValue({
    items: [
      { id: 'init-1', projectId: 'proj-1', agentId: 'agent1',
        message: 'Welcome', messageType: 'AGENT_RESPONSE',
        timestamp: '2026-01-01T00:00:00Z' },
    ],
    nextToken: null,
  }),
  subscribeToConversation: jest.fn((_pid: string, cb: (msg: Record<string, unknown>) => void) => {
    capturedOnMessage = cb;
    return () => { capturedOnMessage = null; };
  }),
}));

jest.mock('../../services/documentService', () => ({
  uploadDocument: jest.fn(),
}));

jest.mock('../../services/projectService', () => ({
  projectService: {
    isDesignComplete: jest.fn().mockReturnValue(false),
    getAssessmentProgress: jest.fn().mockResolvedValue([]),
    getProject: jest.fn().mockResolvedValue({ progress: { design: 0 } }),
    subscribeToProjectProgress: jest.fn(() => () => {}),
    subscribeToAssessmentCompletion: jest.fn(() => () => {}),
    subscribeToDesignProgress: jest.fn(() => () => {}),
  },
}));

jest.mock('../../services/subscriptionManager', () => ({
  subscriptionManager: {
    initializeSubscription: jest.fn(),
    addLocalSubscriber: jest.fn(),
    removeLocalSubscriber: jest.fn(),
    cleanupSubscription: jest.fn(),
  },
}));

jest.mock('sonner', () => ({ toast: { error: jest.fn(), success: jest.fn() } }));

// Minimal project fixture (with existing history so no initial greeting fires).
const project = {
  id: 'proj-1',
  name: 'Test',
  status: 'ACTIVE',
  progress: { assessment: 20, currentPhase: 'Assessment' },
} as unknown as Parameters<typeof AssessmentChat>[0]['project'];

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  capturedOnMessage = null;
  sendSpy.mockResolvedValue({
    id: 'srv-1', projectId: 'proj-1', agentId: 'agent1',
    message: 'hello', messageType: 'USER_INPUT',
    timestamp: new Date().toISOString(),
  });
});
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

// Helper: wait for loading to finish and the component to settle.
async function renderAndSettle() {
  render(<AssessmentChat project={project} onBack={jest.fn()} onComplete={jest.fn()} />);
  // Flush all micro-tasks (history fetch) and timers.
  await act(async () => { jest.advanceTimersByTime(100); });
}

// Helper: type text and click send.
async function typeAndSend(text: string) {
  const input = screen.getByPlaceholderText('Type your response...') as HTMLInputElement;
  // Ensure input is enabled.
  expect(input.disabled).toBe(false);
  await act(async () => { fireEvent.change(input, { target: { value: text } }); });
  // Press Enter to send (simpler than button-hunting).
  await act(async () => {
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
  });
  // Flush the async mutation.
  await act(async () => { jest.advanceTimersByTime(0); });
}

function pushSubscriptionMsg(overrides: Record<string, unknown>) {
  expect(capturedOnMessage).not.toBeNull();
  act(() => {
    capturedOnMessage!({
      id: Math.random().toString(36),
      projectId: 'proj-1',
      agentId: 'agent1',
      message: '',
      messageType: 'AGENT_RESPONSE',
      timestamp: new Date().toISOString(),
      ...overrides,
    });
  });
}

describe('AssessmentChat bounded-wait integration', () => {
  it('shows thinking indicator on send, clears on reply', async () => {
    await renderAndSettle();
    await typeAndSend('Hello agent');

    // Should show thinking indicator (phase = awaitingAck).
    expect(screen.queryByTestId('thinking-indicator')).toBeInTheDocument();

    // ACK.
    pushSubscriptionMsg({ id: 'ack-1', message: '', messageType: 'TURN_ACCEPTED' });
    // Still thinking (awaitingReply).
    expect(screen.queryByTestId('thinking-indicator')).toBeInTheDocument();

    // Agent response.
    pushSubscriptionMsg({ id: 'resp-1', message: 'I am the agent', messageType: 'AGENT_RESPONSE' });
    expect(screen.queryByTestId('thinking-indicator')).not.toBeInTheDocument();
  });

  it('shows ack-timeout banner when T1 fires without ACK', async () => {
    await renderAndSettle();
    await typeAndSend('test');

    // Advance past T1 (8 s).
    act(() => { jest.advanceTimersByTime(8_000); });

    expect(screen.queryByTestId('ack-timeout-banner')).toBeInTheDocument();
    expect(screen.getByText(/still waiting/i)).toBeInTheDocument();
  });

  it('ACK cancels T1 and arms T2; T2 fires replyTimeout', async () => {
    await renderAndSettle();
    await typeAndSend('test');

    // ACK at 3 s.
    act(() => { jest.advanceTimersByTime(3_000); });
    pushSubscriptionMsg({ id: 'ack-1', message: '', messageType: 'TURN_ACCEPTED' });

    // No ack-timeout at T1.
    act(() => { jest.advanceTimersByTime(5_000); });
    expect(screen.queryByTestId('ack-timeout-banner')).not.toBeInTheDocument();

    // T2 fires at 90 s after ACK (we've advanced 5 s since ACK, need 85 more).
    act(() => { jest.advanceTimersByTime(85_000); });
    expect(screen.queryByTestId('reply-timeout-banner')).toBeInTheDocument();
    expect(screen.getByText(/no response/i)).toBeInTheDocument();
  });

  it('PROGRESS_UPDATE resets T2 soft timer', async () => {
    await renderAndSettle();
    await typeAndSend('test');
    pushSubscriptionMsg({ id: 'ack-1', message: '', messageType: 'TURN_ACCEPTED' });

    // Advance 80 s, then send progress.
    act(() => { jest.advanceTimersByTime(80_000); });
    pushSubscriptionMsg({ id: 'prog-1', message: 'processing...', messageType: 'PROGRESS_UPDATE' });

    // 80 s more → still under the reset T2 (only 80 s since last progress).
    act(() => { jest.advanceTimersByTime(80_000); });
    expect(screen.queryByTestId('reply-timeout-banner')).not.toBeInTheDocument();

    // 10 s more → 90 s since progress → T2 fires.
    act(() => { jest.advanceTimersByTime(10_000); });
    expect(screen.queryByTestId('reply-timeout-banner')).toBeInTheDocument();
  });

  it('Retry reuses the same clientMessageId', async () => {
    await renderAndSettle();
    await typeAndSend('my question');

    // Capture the clientMessageId from the first send.
    const firstCallArgs = sendSpy.mock.calls.find((c: unknown[]) => c[2] === 'my question');
    expect(firstCallArgs).toBeTruthy();
    const firstClientId = firstCallArgs![4]; // 5th arg = clientMessageId
    expect(typeof firstClientId).toBe('string');
    expect(firstClientId.length).toBeGreaterThan(0);

    // T1 + T2 timeout.
    act(() => { jest.advanceTimersByTime(8_000 + 90_000); });
    expect(screen.queryByTestId('reply-timeout-banner')).toBeInTheDocument();

    // Click Retry.
    sendSpy.mockClear();
    const retryBtn = screen.getByText('Retry');
    await act(async () => { fireEvent.click(retryBtn); });
    await act(async () => { jest.advanceTimersByTime(0); });

    expect(sendSpy).toHaveBeenCalledTimes(1);
    const retryClientId = sendSpy.mock.calls[0][4];
    expect(retryClientId).toBe(firstClientId);
  });

  it('mutation error shows inline error banner (not silent spinner)', async () => {
    await renderAndSettle();

    sendSpy.mockRejectedValueOnce(new Error('GraphQL timeout'));
    await typeAndSend('hello');

    expect(screen.queryByTestId('send-error-banner')).toBeInTheDocument();
    expect(screen.getByText(/GraphQL timeout/)).toBeInTheDocument();
  });
});
