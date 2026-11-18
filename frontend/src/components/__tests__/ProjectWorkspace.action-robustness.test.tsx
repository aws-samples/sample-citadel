/**
 * ProjectWorkspace — action rendering robustness.
 *
 * Validates:
 * - An action object without a `label` and without a known `consent` id
 *   renders a VISIBLE disabled button with text 'Unavailable action'.
 * - Unknown consent ids render with a warning style (raw id shown).
 */
import { render, screen, act } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('react-router-dom', () => ({
  useNavigate: () => jest.fn(),
}));

jest.mock('../../services/projectService', () => ({
  projectService: { getProject: jest.fn().mockResolvedValue({ id: 'proj-1', progress: null }) },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockSubscribe = jest.fn<any, any[]>((_id: string, _cb: any) => () => {});
jest.mock('../../services/conversationService', () => ({
  sendMessageToAgent: jest.fn().mockResolvedValue(undefined),
  getConversationHistoryForProject: jest.fn().mockResolvedValue({ items: [], nextToken: null }),
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

jest.mock('../../services/intakeConsentService', () => {
  const actual = jest.requireActual('../../services/intakeConsentService');
  return {
    ...actual,
    recordIntakeConsent: jest.fn().mockResolvedValue({ ok: true }),
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

describe('ProjectWorkspace — action rendering robustness', () => {
  beforeEach(() => jest.clearAllMocks());

  it('renders "Unavailable action" for an action with no label and no known consent id', async () => {
    let subscriptionCb: ((msg: Record<string, unknown>) => void) | null = null;
    mockSubscribe.mockImplementation((_id: string, cb: (msg: Record<string, unknown>) => void) => {
      subscriptionCb = cb;
      return () => {};
    });

    render(<ProjectWorkspace project={baseProject} onBack={jest.fn()} />);

    // Assistant message with a label-less, non-consent action
    act(() => {
      subscriptionCb?.({
        id: 'msg-bad',
        messageType: 'AGENT_RESPONSE',
        message: 'Here is something.\n\n```actions\n[{"value":"do_thing"}]\n```',
        timestamp: new Date().toISOString(),
      });
    });

    const btn = screen.getByText('Unavailable action');
    expect(btn).toBeInTheDocument();
    expect(btn.closest('button')).toBeDisabled();
    expect(btn.closest('button')?.getAttribute('title')).toBeTruthy();
  });

  it('renders unknown consent ids with the raw id and a warning style', async () => {
    let subscriptionCb: ((msg: Record<string, unknown>) => void) | null = null;
    mockSubscribe.mockImplementation((_id: string, cb: (msg: Record<string, unknown>) => void) => {
      subscriptionCb = cb;
      return () => {};
    });

    render(<ProjectWorkspace project={baseProject} onBack={jest.fn()} />);

    act(() => {
      subscriptionCb?.({
        id: 'msg-unk',
        messageType: 'AGENT_RESPONSE',
        message: '```actions\n[{"consent":"unknown_action_xyz"}]\n```',
        timestamp: new Date().toISOString(),
      });
    });

    const btn = screen.getByText('unknown_action_xyz');
    expect(btn).toBeInTheDocument();
    expect(btn.closest('button')).toBeDisabled();
    // Should have a warning style (we'll add border-destructive or similar)
    const buttonEl = btn.closest('button');
    expect(buttonEl?.className).toMatch(/warning|destructive|amber|yellow/);
  });
});
