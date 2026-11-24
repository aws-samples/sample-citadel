/**
 * DataStores page — list/stats org scoping (mirrors Integrations.tsx's
 * currentUser.organization sourcing, finding tracked alongside b5d463f2).
 *
 * Before the fix: DataStores.tsx:100-101 did
 *   const orgId = selectedOrganization || "default";
 *   datastoreService.listDataStores(orgId) / getDataStoreStats(orgId)
 * For an admin, OrganizationContext sets selectedOrganization to the
 * literal "All Organizations", so the backend's exact-match OrgIndex query
 * returns nothing. For a user with no selection, it sends the literal
 * "default", which never matches a real org either.
 *
 * This test asserts listDataStores/getDataStoreStats are always called
 * with the caller's own organisation (currentUser.organization), and
 * never with "All Organizations" or "default", regardless of what the
 * selector is showing. selectedOrganization remains a client-side filter
 * concern only, not a server request parameter.
 */
import React from 'react';
import { render, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

type WithChildren = React.PropsWithChildren<Record<string, unknown>>;

jest.mock('@/components/ui/card', () => ({
  Card: ({ children, className }: WithChildren) => <div className={className as string}>{children}</div>,
}));
jest.mock('@/components/ui/button', () => ({
  Button: ({ children, onClick, disabled, ...rest }: WithChildren) => (
    <button onClick={onClick as () => void} disabled={disabled as boolean} {...rest}>{children}</button>
  ),
}));
jest.mock('@/components/ui/tabs', () => ({
  Tabs: ({ children, value }: WithChildren) => <div data-value={value as string}>{children}</div>,
  TabsContent: ({ children, value }: WithChildren) => <div data-tabcontent={value as string}>{children}</div>,
  TabsList: ({ children }: WithChildren) => <div role="tablist">{children}</div>,
  TabsTrigger: ({ children, value, onClick }: WithChildren) => (
    <button role="tab" data-value={value as string} onClick={onClick as () => void}>{children}</button>
  ),
}));
jest.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children, open }: WithChildren) => open ? <div data-testid="dialog">{children}</div> : null,
  DialogContent: ({ children }: WithChildren) => <div>{children}</div>,
  DialogDescription: ({ children }: WithChildren) => <p>{children}</p>,
  DialogHeader: ({ children }: WithChildren) => <div>{children}</div>,
  DialogTitle: ({ children }: WithChildren) => <h2>{children}</h2>,
}));
jest.mock('@/components/ui/alert-dialog', () => ({
  AlertDialog: ({ children, open }: WithChildren) => open ? <div data-testid="alert-dialog">{children}</div> : null,
  AlertDialogAction: ({ children, onClick }: WithChildren) => <button onClick={onClick as () => void}>{children}</button>,
  AlertDialogCancel: ({ children, onClick }: WithChildren) => <button onClick={onClick as () => void}>{children}</button>,
  AlertDialogContent: ({ children }: WithChildren) => <div>{children}</div>,
  AlertDialogDescription: ({ children }: WithChildren) => <p>{children}</p>,
  AlertDialogFooter: ({ children }: WithChildren) => <div>{children}</div>,
  AlertDialogHeader: ({ children }: WithChildren) => <div>{children}</div>,
}));
jest.mock('@/components/ui/input', () => ({
  Input: (props: Record<string, unknown>) => <input {...props} />,
}));
jest.mock('@/components/ui/textarea', () => ({
  Textarea: (props: Record<string, unknown>) => <textarea {...props} />,
}));
jest.mock('@/components/ui/label', () => ({
  Label: ({ children, ...props }: WithChildren) => <label {...props}>{children}</label>,
}));
jest.mock('@/components/ui/utils', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}));
jest.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: WithChildren) => <>{children}</>,
  TooltipContent: ({ children }: WithChildren) => <div role="tooltip">{children}</div>,
  TooltipProvider: ({ children }: WithChildren) => <>{children}</>,
  TooltipTrigger: ({ children }: WithChildren) => <>{children}</>,
}));
jest.mock('@/components/PageContainer', () => ({
  PageContainer: ({ children }: WithChildren) => <div>{children}</div>,
}));
jest.mock('@/components/SearchInput', () => ({
  SearchInput: ({ value, onChange, placeholder }: WithChildren) => (
    <input
      data-testid="search-input"
      value={value as string}
      onChange={onChange as () => void}
      placeholder={placeholder as string}
    />
  ),
}));
jest.mock('@/components/DataStoreCard', () => ({
  DataStoreCard: ({ dataStore }: { dataStore: { id: string; name: string } }) => (
    <div data-testid={`datastore-card-${dataStore.id}`}>{dataStore.name}</div>
  ),
}));
jest.mock('@/components/CreateDataStoreWizard', () => ({
  CreateDataStoreWizard: () => null,
}));

interface MockOrgContext {
  selectedOrganization: string | null;
  currentUser: { organization: string; role: string };
  isAdmin: boolean;
  loading: boolean;
}

let mockOrgContext: MockOrgContext = {
  selectedOrganization: null,
  currentUser: { organization: '', role: 'user' },
  isAdmin: false,
  loading: false,
};
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
  filterDataStoresByUsage: (stores: unknown[]) => stores,
  UsageFilterTab: {},
}));

import { datastoreService } from '@/services/datastoreService';
import { DataStores } from '../DataStores';

const svc = datastoreService as unknown as {
  listDataStores: jest.Mock;
  getDataStoreStats: jest.Mock;
};

describe('DataStores — list/stats scoped to caller organisation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('admin viewing "All Organizations" still lists their own organisation, never the literal selector value', async () => {
    mockOrgContext = {
      selectedOrganization: 'All Organizations',
      currentUser: { organization: 'org-real', role: 'admin' },
      isAdmin: true,
      loading: false,
    };

    render(<DataStores />);

    await waitFor(() => {
      expect(svc.listDataStores).toHaveBeenCalledWith('org-real');
      expect(svc.getDataStoreStats).toHaveBeenCalledWith('org-real');
    });

    for (const call of svc.listDataStores.mock.calls) {
      expect(call[0]).not.toBe('All Organizations');
      expect(call[0]).not.toBe('default');
    }
    for (const call of svc.getDataStoreStats.mock.calls) {
      expect(call[0]).not.toBe('All Organizations');
      expect(call[0]).not.toBe('default');
    }
  });

  test('user with no selector value lists their own organisation, never the "default" placeholder', async () => {
    mockOrgContext = {
      selectedOrganization: null,
      currentUser: { organization: 'org-real', role: 'user' },
      isAdmin: false,
      loading: false,
    };

    render(<DataStores />);

    await waitFor(() => {
      expect(svc.listDataStores).toHaveBeenCalledWith('org-real');
      expect(svc.getDataStoreStats).toHaveBeenCalledWith('org-real');
    });

    for (const call of svc.listDataStores.mock.calls) {
      expect(call[0]).not.toBe('default');
    }
  });

  test('a concrete selectedOrganization matching the caller org still calls the service with that organisation', async () => {
    mockOrgContext = {
      selectedOrganization: 'org-real',
      currentUser: { organization: 'org-real', role: 'user' },
      isAdmin: false,
      loading: false,
    };

    render(<DataStores />);

    await waitFor(() => {
      expect(svc.listDataStores).toHaveBeenCalledWith('org-real');
    });
  });
});
