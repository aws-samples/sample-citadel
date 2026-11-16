/**
 * react-resizable-panels v2→v4 migration contract tests.
 *
 * Part 1: Resizable wrapper (src/components/ui/resizable.tsx)
 *   - Group renders with data-group attribute (v4)
 *   - Separator renders with data-separator and role="separator" (v4)
 *   - Vertical orientation applies flex-col via prop-based class (not data attr selector)
 *
 * Part 2: ProjectWorkspace collapse/expand behaviour
 *   - docPanelRef.collapse() called on mount when assessment incomplete
 *   - Toggle button calls collapse/expand alternately
 *   - onResize callback tracks collapsed state
 */
import { render, screen, fireEvent, act } from '@testing-library/react';
import '@testing-library/jest-dom';

// ── Mocks ────────────────────────────────────────────────────────────────────

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

// ── Stub react-resizable-panels with v4-shaped API ──────────────────────────
// The mock exposes Group/Panel/Separator (v4 names) and renders data
// attributes matching the v4 rendered contract.
const collapseMock = jest.fn();
const expandMock = jest.fn();

jest.mock('react-resizable-panels', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react');
  return {
    __esModule: true,
    // v4 Group: renders data-group, receives orientation prop
    Group: ({ children, orientation, className, ...rest }: Record<string, unknown>) =>
      React.createElement(
        'div',
        { 'data-group': '', 'data-orientation': orientation, className, ...rest },
        children,
      ),
    // v4 Panel: renders data-panel, imperative via panelRef prop
    Panel: ({ children, panelRef, ...rest }: Record<string, unknown>) => {
      React.useImperativeHandle(panelRef, () => ({
        collapse: collapseMock,
        expand: expandMock,
        isCollapsed: jest.fn(() => false),
        getSize: jest.fn(() => ({ asPercentage: 50, inPixels: 500 })),
      }));
      return React.createElement('div', { 'data-panel': '', ...rest }, children);
    },
    // v4 Separator: renders data-separator + role="separator"
    Separator: ({ children, className, ...rest }: Record<string, unknown>) =>
      React.createElement(
        'div',
        { 'data-separator': '', role: 'separator', className, ...rest },
        children,
      ),
  };
});

import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from '../ui/resizable';

// ── Part 1: Resizable wrapper v4 contract ────────────────────────────────────

describe('Resizable wrapper v4 contract', () => {
  it('ResizablePanelGroup renders with data-group attribute', () => {
    const { container } = render(
      <ResizablePanelGroup orientation="horizontal">
        <div>child</div>
      </ResizablePanelGroup>,
    );
    const group = container.querySelector('[data-group]');
    expect(group).toBeInTheDocument();
  });

  it('ResizablePanelGroup passes orientation prop to Group', () => {
    const { container } = render(
      <ResizablePanelGroup orientation="vertical">
        <div>child</div>
      </ResizablePanelGroup>,
    );
    const group = container.querySelector('[data-group]');
    expect(group).toHaveAttribute('data-orientation', 'vertical');
  });

  it('ResizablePanelGroup applies flex-col class for vertical orientation', () => {
    const { container } = render(
      <ResizablePanelGroup orientation="vertical">
        <div>child</div>
      </ResizablePanelGroup>,
    );
    const group = container.querySelector('[data-group]');
    expect(group?.className).toContain('flex-col');
  });

  it('ResizablePanelGroup does NOT apply flex-col for horizontal orientation', () => {
    const { container } = render(
      <ResizablePanelGroup orientation="horizontal">
        <div>child</div>
      </ResizablePanelGroup>,
    );
    const group = container.querySelector('[data-group]');
    expect(group?.className).not.toContain('flex-col');
  });

  it('ResizableHandle renders with data-separator and role="separator"', () => {
    const { container } = render(
      <ResizablePanelGroup orientation="horizontal">
        <ResizablePanel><div>A</div></ResizablePanel>
        <ResizableHandle />
        <ResizablePanel><div>B</div></ResizablePanel>
      </ResizablePanelGroup>,
    );
    const separator = container.querySelector('[data-separator]');
    expect(separator).toBeInTheDocument();
    expect(separator).toHaveAttribute('role', 'separator');
  });

  it('ResizableHandle renders grip icon when withHandle is true', () => {
    const { container } = render(
      <ResizablePanelGroup orientation="horizontal">
        <ResizablePanel><div>A</div></ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel><div>B</div></ResizablePanel>
      </ResizablePanelGroup>,
    );
    const separator = container.querySelector('[data-separator]');
    expect(separator).toBeInTheDocument();
    // Grip icon wrapper div should be inside the separator
    const gripDiv = separator?.querySelector('div');
    expect(gripDiv).toBeInTheDocument();
  });
});

// ── Part 2: ProjectWorkspace collapse/expand ─────────────────────────────────

import { ProjectWorkspace } from '../ProjectWorkspace';
import { projectService } from '../../services/projectService';
import type { ProjectProgress } from '../../services/projectService';

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

describe('ProjectWorkspace — doc panel collapse/expand', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (projectService.getProject as jest.Mock).mockResolvedValue({
      id: 'proj-42',
      progress: null,
    });
  });

  it('calls collapse on doc panel ref when assessment is not complete on mount', async () => {
    render(<ProjectWorkspace project={baseProject} onBack={jest.fn()} />);

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    // The useEffect should have called docPanelRef.current?.collapse()
    expect(collapseMock).toHaveBeenCalled();
  });

  it('renders a toggle button for show/hide documents', async () => {
    render(<ProjectWorkspace project={baseProject} onBack={jest.fn()} />);

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    const toggleBtn = screen.getByTitle(/documents/i);
    expect(toggleBtn).toBeInTheDocument();
  });

  it('toggle button calls expand or collapse on doc panel ref', async () => {
    render(<ProjectWorkspace project={baseProject} onBack={jest.fn()} />);

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    // The button toggles between show/hide. Since mock collapse doesn't
    // fire onResize, docPanelCollapsed stays false, so button says "Hide documents".
    const toggleBtn = screen.getByTitle('Hide documents');
    fireEvent.click(toggleBtn);

    // Click on "Hide" triggers collapse
    expect(collapseMock).toHaveBeenCalledTimes(2); // once on mount + once on click
  });

  it('calls expand on doc panel ref when assessment reaches 100% during polling', async () => {
    jest.useFakeTimers();

    // First poll (on mount) returns 50%, interval poll returns 100%
    (projectService.getProject as jest.Mock)
      .mockResolvedValueOnce({
        id: 'proj-42',
        progress: { assessment: 50, design: 0, planning: 0, implementation: 0, currentPhase: 'ASSESSMENT_IN_PROGRESS' },
      })
      .mockResolvedValue({
        id: 'proj-42',
        progress: { assessment: 100, design: 0, planning: 0, implementation: 0, currentPhase: 'DESIGN_IN_PROGRESS' },
      });

    render(
      <ProjectWorkspace
        project={{ ...baseProject, progress: { assessment: 50, design: 0, planning: 0, implementation: 0, currentPhase: 'ASSESSMENT_IN_PROGRESS' } as unknown as ProjectProgress }}
        onBack={jest.fn()}
      />,
    );

    // Let the mount effect fire (first poll)
    await act(async () => {
      await jest.advanceTimersByTimeAsync(100);
    });
    expect(collapseMock).toHaveBeenCalled();
    expandMock.mockClear();

    // Advance past the 10s polling interval
    await act(async () => {
      await jest.advanceTimersByTimeAsync(11_000);
    });

    // expand should have been called: prev.assessment=50 < 100, new.assessment=100
    expect(expandMock).toHaveBeenCalled();

    jest.useRealTimers();
  });
});
