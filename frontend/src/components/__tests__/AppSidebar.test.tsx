import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter } from 'react-router-dom';
import { AppSidebar } from '../AppSidebar';
import { SidebarProvider } from '../ui/sidebar';

// matchMedia stub (jsdom lacks it)
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: jest.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: jest.fn(),
    removeListener: jest.fn(),
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    dispatchEvent: jest.fn(),
  })),
});

// ---------- approvals service mock ----------
const mockListPendingApprovals = jest.fn();
jest.mock('../../services/approvalsService', () => ({
  approvalsService: { listPendingApprovals: (...args: any[]) => mockListPendingApprovals(...args) },
}));

// ---------- org context ----------
let mockIsAdmin = true;
let mockLoading = false;
jest.mock('../../contexts/OrganizationContext', () => ({
  useOrganization: () => ({
    selectedOrganization: 'TestOrg',
    setSelectedOrganization: jest.fn(),
    organizations: ['TestOrg'],
    currentUser: mockLoading
      ? null
      : { userId: 'u1', role: mockIsAdmin ? 'admin' : 'dev', organization: 'TestOrg' },
    isAdmin: mockIsAdmin,
    loading: mockLoading,
  }),
}));

function renderSidebar() {
  return render(
    <MemoryRouter>
      <SidebarProvider defaultOpen={true}>
        <AppSidebar />
      </SidebarProvider>
    </MemoryRouter>,
  );
}

describe('AppSidebar — Approvals entry', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLoading = false;
    mockListPendingApprovals.mockResolvedValue({ items: [], nextToken: null });
  });

  it('shows the Approvals entry with badge for admins', async () => {
    mockIsAdmin = true;
    mockListPendingApprovals.mockResolvedValue({
      items: [
        { recordId: 'r1', recordType: 'agent', name: 'A', displayName: 'A', orgId: 'o', submittedAt: '', createdBy: 'u', status: 'PENDING_APPROVAL' },
        { recordId: 'r2', recordType: 'agent', name: 'B', displayName: 'B', orgId: 'o', submittedAt: '', createdBy: 'u', status: 'PENDING_APPROVAL' },
      ],
      nextToken: null,
    });

    renderSidebar();

    expect(screen.getByText('Approvals')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText('2')).toBeInTheDocument();
    });
  });

  it('hides badge when pending count is 0', async () => {
    mockIsAdmin = true;
    mockListPendingApprovals.mockResolvedValue({ items: [], nextToken: null });

    renderSidebar();

    expect(screen.getByText('Approvals')).toBeInTheDocument();
    // No badge element with a number
    await waitFor(() => {
      expect(screen.queryByText('0')).not.toBeInTheDocument();
    });
  });

  it('does not show the Approvals entry for non-admins', () => {
    mockIsAdmin = false;

    renderSidebar();

    expect(screen.queryByText('Approvals')).not.toBeInTheDocument();
    expect(mockListPendingApprovals).not.toHaveBeenCalled();
  });

  it('keeps Approvals visible while loading and does not fetch pending count', () => {
    mockIsAdmin = false;
    mockLoading = true;

    renderSidebar();

    // Approvals entry is shown during loading (not hidden prematurely)
    expect(screen.getByText('Approvals')).toBeInTheDocument();
    // Pending-count fetch should not fire while still loading
    expect(mockListPendingApprovals).not.toHaveBeenCalled();
  });
});
