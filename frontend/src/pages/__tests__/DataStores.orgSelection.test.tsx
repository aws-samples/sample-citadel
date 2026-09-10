/**
 * TDD (red-first) for the DataStores "Add Data Store" org-selection UX
 * defect exposed by decision b5d463f2 (createDataStore now rejects a
 * cross-org / placeholder orgId for everyone, including admins).
 *
 * Before the fix: DataStores.tsx:100 did
 *   `const orgId = selectedOrganization || "default";`
 * and passed that straight into CreateDataStoreWizard as the creation
 * target — so an admin viewing "All Organizations" (selectedOrganization
 * === 'All Organizations') or a user with no organization at all
 * (selectedOrganization === null) would submit the literal string
 * "default" as input.orgId, which can never match a real org claim and
 * always gets rejected server-side with no clear explanation.
 *
 * This test asserts:
 *  1. The "Add Data Store" action is disabled, with an actionable message,
 *     when the caller has no organisation OR the selector is on
 *     "All Organizations"/null.
 *  2. When enabled, the wizard is opened with the CALLER'S OWN organisation
 *     (currentUser.organization), never the selector value, and never the
 *     literal placeholder "default".
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

jest.mock('@/components/ui/card', () => ({
  Card: ({ children, className }: any) => <div className={className}>{children}</div>,
}));
jest.mock('@/components/ui/button', () => ({
  Button: ({ children, onClick, disabled, ...rest }: any) => (
    <button onClick={onClick} disabled={disabled} {...rest}>{children}</button>
  ),
}));
jest.mock('@/components/ui/tabs', () => ({
  Tabs: ({ children, value }: any) => <div data-value={value}>{children}</div>,
  TabsContent: ({ children, value }: any) => <div data-tabcontent={value}>{children}</div>,
  TabsList: ({ children }: any) => <div role="tablist">{children}</div>,
  TabsTrigger: ({ children, value, onClick }: any) => (
    <button role="tab" data-value={value} onClick={onClick}>{children}</button>
  ),
}));
jest.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children, open }: any) => open ? <div data-testid="dialog">{children}</div> : null,
  DialogContent: ({ children }: any) => <div>{children}</div>,
  DialogDescription: ({ children }: any) => <p>{children}</p>,
  DialogHeader: ({ children }: any) => <div>{children}</div>,
  DialogTitle: ({ children }: any) => <h2>{children}</h2>,
}));
jest.mock('@/components/ui/alert-dialog', () => ({
  AlertDialog: ({ children, open }: any) => open ? <div data-testid="alert-dialog">{children}</div> : null,
  AlertDialogAction: ({ children, onClick }: any) => <button onClick={onClick}>{children}</button>,
  AlertDialogCancel: ({ children, onClick }: any) => <button onClick={onClick}>{children}</button>,
  AlertDialogContent: ({ children }: any) => <div>{children}</div>,
  AlertDialogDescription: ({ children }: any) => <p>{children}</p>,
  AlertDialogFooter: ({ children }: any) => <div>{children}</div>,
  AlertDialogHeader: ({ children }: any) => <div>{children}</div>,
}));
jest.mock('@/components/ui/input', () => ({
  Input: (props: any) => <input {...props} />,
}));
jest.mock('@/components/ui/textarea', () => ({
  Textarea: (props: any) => <textarea {...props} />,
}));
jest.mock('@/components/ui/label', () => ({
  Label: ({ children, ...props }: any) => <label {...props}>{children}</label>,
}));
jest.mock('@/components/ui/utils', () => ({
  cn: (...args: any[]) => args.filter(Boolean).join(' '),
}));
jest.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: any) => <>{children}</>,
  TooltipContent: ({ children }: any) => <div role="tooltip">{children}</div>,
  TooltipProvider: ({ children }: any) => <>{children}</>,
  TooltipTrigger: ({ children }: any) => <>{children}</>,
}));
jest.mock('@/components/PageContainer', () => ({
  PageContainer: ({ children }: any) => <div>{children}</div>,
}));
jest.mock('@/components/SearchInput', () => ({
  SearchInput: ({ value, onChange, placeholder }: any) => (
    <input data-testid="search-input" value={value} onChange={onChange} placeholder={placeholder} />
  ),
}));
jest.mock('@/components/DataStoreCard', () => ({
  DataStoreCard: ({ dataStore }: any) => (
    <div data-testid={`datastore-card-${dataStore.id}`}>{dataStore.name}</div>
  ),
}));

let capturedWizardProps: any = null;
jest.mock('@/components/CreateDataStoreWizard', () => ({
  CreateDataStoreWizard: (props: any) => {
    capturedWizardProps = props;
    return props.open ? <div data-testid="create-wizard" /> : null;
  },
}));

let mockOrgContext: any = {};
jest.mock('@/contexts/OrganizationContext', () => ({
  useOrganization: () => mockOrgContext,
}));

jest.mock('sonner', () => ({
  toast: { success: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

jest.mock('@/services/datastoreService', () => ({
  datastoreService: {
    listDataStores: jest.fn().mockResolvedValue([]),
    getDataStoreStats: jest.fn().mockResolvedValue({ total: 0, connected: 0, error: 0 }),
    deleteDataStore: jest.fn().mockResolvedValue(undefined),
  },
  DataStoreStatus: {
    CREATED: 'CREATED', CONNECTING: 'CONNECTING', CONNECTED: 'CONNECTED',
    PROVISIONING: 'PROVISIONING', PROVISIONED: 'PROVISIONED',
    DISCONNECTED: 'DISCONNECTED', ERROR: 'ERROR', DELETING: 'DELETING',
  },
  DataStoreCategory: {
    KNOWLEDGE_BASE: 'KNOWLEDGE_BASE', RELATIONAL_DATABASE: 'RELATIONAL_DATABASE',
    NOSQL_DATABASE: 'NOSQL_DATABASE', S3_STORAGE: 'S3_STORAGE',
    DATA_WAREHOUSE: 'DATA_WAREHOUSE', DATA_LAKE: 'DATA_LAKE',
    SEARCH_ENGINE: 'SEARCH_ENGINE', GRAPH_DATABASE: 'GRAPH_DATABASE',
    TIME_SERIES: 'TIME_SERIES', DOCUMENT_DATABASE: 'DOCUMENT_DATABASE',
    CACHE: 'CACHE', EXTERNAL: 'EXTERNAL',
  },
}));
jest.mock('@/pages/datastoreFilterUtils', () => ({
  filterDataStoresByUsage: (stores: any[]) => stores,
  UsageFilterTab: {},
}));

import { DataStores } from '../DataStores';

describe('DataStores — Add Data Store org-selection guard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    capturedWizardProps = null;
  });

  test('disables Add Data Store with an actionable message when caller has no organisation', async () => {
    mockOrgContext = {
      selectedOrganization: null,
      currentUser: { organization: undefined, role: 'user' },
      isAdmin: false,
      loading: false,
    };

    render(<DataStores />);

    await waitFor(() => {
      const addBtn = screen.getByRole('button', { name: /add data store/i });
      expect(addBtn).toBeDisabled();
    });
    expect(
      screen.getAllByText(/no organization.*contact an administrator/i).length,
    ).toBeGreaterThan(0);
  });

  test('disables Add Data Store with an actionable message when an admin has no organisation of their own, even while viewing All Organizations', async () => {
    mockOrgContext = {
      selectedOrganization: 'All Organizations',
      currentUser: { organization: undefined, role: 'admin' },
      isAdmin: true,
      loading: false,
    };

    render(<DataStores />);

    await waitFor(() => {
      const addBtn = screen.getByRole('button', { name: /add data store/i });
      expect(addBtn).toBeDisabled();
    });
    expect(
      screen.getAllByText(/no organization.*contact an administrator/i).length,
    ).toBeGreaterThan(0);
  });

  test('enables Add Data Store and opens wizard with the caller\'s own organisation, never the selector value or a placeholder', async () => {
    mockOrgContext = {
      selectedOrganization: 'All Organizations',
      currentUser: { organization: 'org-real', role: 'user' },
      isAdmin: false,
      loading: false,
    };

    render(<DataStores />);

    const user = userEvent.setup();
    const addBtn = await screen.findByRole('button', { name: /add data store/i });
    expect(addBtn).not.toBeDisabled();

    await user.click(addBtn);

    await waitFor(() => {
      expect(screen.getByTestId('create-wizard')).toBeInTheDocument();
    });

    expect(capturedWizardProps.orgId).toBe('org-real');
    expect(capturedWizardProps.orgId).not.toBe('default');
    expect(capturedWizardProps.orgId).not.toBe('All Organizations');
  });
});
