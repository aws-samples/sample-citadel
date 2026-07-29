/**
 * ProjectWorkspace — "View trace" deep-link test.
 *
 * Design task 60ba09e4 (pass 2) explicitly calls for extending
 * ExecutionDetailSheet/ProjectWorkspace tests to assert the "View trace"
 * button navigates with the right path. This covers the ProjectWorkspace
 * half: clicking the header's trace icon button navigates to
 * /observability/trace/conversation/<projectId>.
 *
 * All service/child-component dependencies are mocked so this test is
 * scoped strictly to the navigation wiring, not the full chat/document
 * workspace behavior (which has no dedicated coverage prior to this file).
 */
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';

const mockNavigate = jest.fn();

jest.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
}));

jest.mock('../../services/projectService', () => ({
  projectService: {
    getProject: jest.fn().mockResolvedValue({ id: 'proj-1', progress: null }),
  },
}));

jest.mock('../../services/conversationService', () => ({
  sendMessageToAgent: jest.fn(),
  getConversationHistoryForProject: jest.fn().mockResolvedValue({ items: [], nextToken: null }),
  subscribeToConversation: jest.fn(() => () => {}),
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

// react-resizable-panels' imperative Panel ref/collapse API isn't needed for
// this test; stub the whole module to plain divs so the DOM renders without
// ref plumbing or layout measurement (which jsdom can't do anyway).
jest.mock('react-resizable-panels', () => {
  const React = require('react');
  return {
    PanelGroup: (props: any) => React.createElement('div', null, props.children),
    Panel: React.forwardRef((props: any, ref: any) => {
      React.useImperativeHandle(ref, () => ({ collapse: jest.fn(), expand: jest.fn() }));
      return React.createElement('div', null, props.children);
    }),
    PanelResizeHandle: (props: any) => React.createElement('div', null, props.children),
  };
});

import { ProjectWorkspace } from '../ProjectWorkspace';

// jsdom does not implement scrollIntoView; ProjectWorkspace calls it on
// every messages update.
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

describe('ProjectWorkspace — View trace deep-link', () => {
  beforeEach(() => {
    mockNavigate.mockClear();
  });

  it('navigates to /observability/trace/conversation/<projectId> when "View trace" is clicked', () => {
    render(<ProjectWorkspace project={baseProject} onBack={jest.fn()} />);

    fireEvent.click(screen.getByTitle('View trace'));

    expect(mockNavigate).toHaveBeenCalledWith('/observability/trace/conversation/proj-42');
  });

  it('URL-encodes a project id containing special characters', () => {
    render(
      <ProjectWorkspace project={{ ...baseProject, id: 'proj/42 x' }} onBack={jest.fn()} />,
    );

    fireEvent.click(screen.getByTitle('View trace'));

    expect(mockNavigate).toHaveBeenCalledWith(
      `/observability/trace/conversation/${encodeURIComponent('proj/42 x')}`,
    );
  });
});
