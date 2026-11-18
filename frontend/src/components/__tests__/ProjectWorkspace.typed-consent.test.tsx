/**
 * ProjectWorkspace — typed-consent tests.
 *
 * Validates:
 * - Typing 'confirm' (case-insensitive) with a pending consent id records
 *   consent for that id before sending the user message.
 * - 'confirm later', 'yes but', 'no' do NOT record consent.
 * - Without a pending consent id, affirmative text is sent as a plain message.
 * - Consent is recorded only once (cleared after use).
 */
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import '@testing-library/jest-dom';

const mockNavigate = jest.fn();
jest.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
}));

const mockGetProject = jest.fn().mockResolvedValue({ id: 'proj-1', progress: null });
jest.mock('../../services/projectService', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  projectService: { getProject: (...args: any[]) => mockGetProject(...args) },
}));

const mockSendMessage = jest.fn().mockResolvedValue(undefined);
const mockGetHistory = jest.fn().mockResolvedValue({ items: [], nextToken: null });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockSubscribe = jest.fn<any, any[]>((_id: string, _cb: any) => () => {});
jest.mock('../../services/conversationService', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sendMessageToAgent: (...args: any[]) => mockSendMessage(...args),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getConversationHistoryForProject: (...args: any[]) => mockGetHistory(...args),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  subscribeToConversation: (...args: any[]) => mockSubscribe(...args),
}));

jest.mock('../../services/documentService', () => ({
  uploadDocument: jest.fn(),
  getProjectDocument: jest.fn().mockResolvedValue(null),
  listDocumentVersions: jest.fn().mockResolvedValue([]),
  getDocumentVersion: jest.fn(),
  generateDocumentPdf: jest.fn(),
  waitForDocumentIndexed: jest.fn(),
  deleteDocument: jest.fn(),
  listProjectDocuments: jest.fn().mockResolvedValue([]),
}));

jest.mock('../FabricationStatusPanel', () => ({
  FabricationStatusPanel: () => null,
}));

jest.mock('sonner', () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}));

const mockRecordIntakeConsent = jest.fn().mockResolvedValue({ ok: true, action: 'plan_fabrication', expiresAt: '' });
jest.mock('../../services/intakeConsentService', () => {
  const actual = jest.requireActual('../../services/intakeConsentService');
  return {
    ...actual,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    recordIntakeConsent: (...args: any[]) => mockRecordIntakeConsent(...args),
  };
});

jest.mock('react-resizable-panels', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react');
  return {
    Group: (props: Record<string, unknown>) => React.createElement('div', null, props.children),
    Panel: ({ children, panelRef }: Record<string, unknown>) => {
      React.useImperativeHandle(panelRef, () => ({ collapse: jest.fn(), expand: jest.fn() }));
      return React.createElement('div', null, children);
    },
    Separator: (props: Record<string, unknown>) => React.createElement('div', null, props.children),
  };
});

import { ProjectWorkspace } from '../ProjectWorkspace';

beforeAll(() => {
  window.HTMLElement.prototype.scrollIntoView = jest.fn();
});

const baseProject = {
  id: 'proj-42',
  name: 'Test Project',
  description: '',
  status: 'IN_PROGRESS' as const,
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
};

/**
 * Helper: render the workspace, then simulate an assistant message arriving
 * with a consent action so pendingConsentId gets set.
 */
function renderWithConsentAction(consentId = 'plan_fabrication') {
  // Return a subscription callback we can invoke
  let subscriptionCb: ((msg: Record<string, unknown>) => void) | null = null;
  mockSubscribe.mockImplementation((_id: string, cb: (msg: Record<string, unknown>) => void) => {
    subscriptionCb = cb;
    return () => {};
  });

  const result = render(<ProjectWorkspace project={baseProject} onBack={jest.fn()} />);

  // Simulate an assistant message with a consent action
  act(() => {
    subscriptionCb?.({
      id: 'msg-1',
      messageType: 'AGENT_RESPONSE',
      message: `Here is my plan.\n\n\`\`\`actions\n[{"consent":"${consentId}"}]\n\`\`\``,
      timestamp: new Date().toISOString(),
    });
  });

  return result;
}

describe('ProjectWorkspace — typed consent via affirmative text', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetHistory.mockResolvedValue({ items: [], nextToken: null });
    mockGetProject.mockResolvedValue({ id: 'proj-42', progress: null });
    mockSendMessage.mockResolvedValue(undefined);
    mockRecordIntakeConsent.mockResolvedValue({ ok: true, action: 'plan_fabrication', expiresAt: '' });
  });

  it.each([
    'confirm', 'Confirm', 'CONFIRM',
    'yes', 'Yes', 'YES',
    'proceed', 'Proceed',
    'go ahead', 'Go Ahead', 'GO AHEAD',
    'approve', 'Approve',
    'ok', 'Ok', 'OK',
    'okay', 'Okay', 'OKAY',
    'do it', 'Do it', 'DO IT',
  ])('typing "%s" with a pending consent id records consent then sends the message', async (text) => {
    renderWithConsentAction('plan_fabrication');

    const input = screen.getByPlaceholderText('Message the agent...');
    fireEvent.change(input, { target: { value: text } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(mockRecordIntakeConsent).toHaveBeenCalledWith('proj-42', 'plan_fabrication');
    });
    expect(mockSendMessage).toHaveBeenCalledWith('proj-42', 'agent_intake_single', text.trim());
    // Consent recorded BEFORE message sent
    const consentOrder = mockRecordIntakeConsent.mock.invocationCallOrder[0];
    const sendOrder = mockSendMessage.mock.invocationCallOrder[0];
    expect(consentOrder).toBeLessThan(sendOrder);
  });

  it.each([
    'confirm later',
    'yes but',
    'no',
    'not now',
    'cancel',
    'maybe',
    'sure thing',
    'absolutely',
  ])('typing "%s" does NOT record consent', async (text) => {
    renderWithConsentAction('plan_fabrication');

    const input = screen.getByPlaceholderText('Message the agent...');
    fireEvent.change(input, { target: { value: text } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(mockSendMessage).toHaveBeenCalled();
    });
    expect(mockRecordIntakeConsent).not.toHaveBeenCalled();
  });

  it('without a pending consent id, affirmative text is sent as plain message', async () => {
    // No consent action in the history
    mockSubscribe.mockImplementation((_id: string, _cb: unknown) => () => {});
    render(<ProjectWorkspace project={baseProject} onBack={jest.fn()} />);

    const input = screen.getByPlaceholderText('Message the agent...');
    fireEvent.change(input, { target: { value: 'confirm' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(mockSendMessage).toHaveBeenCalledWith('proj-42', 'agent_intake_single', 'confirm');
    });
    expect(mockRecordIntakeConsent).not.toHaveBeenCalled();
  });

  it('consent is only recorded once — second "confirm" does not record again', async () => {
    renderWithConsentAction('plan_fabrication');

    const input = screen.getByPlaceholderText('Message the agent...');

    // First confirm
    fireEvent.change(input, { target: { value: 'confirm' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(mockRecordIntakeConsent).toHaveBeenCalledTimes(1);
    });

    // Reset sending state for second message
    // Simulate agent response so sending resets
    act(() => {
      // We need the subscription callback; grab from mock
      const cb = mockSubscribe.mock.calls[0]?.[1] as ((msg: Record<string, unknown>) => void) | undefined;
      cb?.({
        id: 'msg-2',
        messageType: 'AGENT_RESPONSE',
        message: 'Done.',
        timestamp: new Date().toISOString(),
      });
    });

    // Second confirm — no pending consent (cleared + newer assistant msg has no actions)
    fireEvent.change(input, { target: { value: 'confirm' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(mockSendMessage).toHaveBeenCalledTimes(2);
    });
    // Still only 1 consent call total
    expect(mockRecordIntakeConsent).toHaveBeenCalledTimes(1);
  });
});
