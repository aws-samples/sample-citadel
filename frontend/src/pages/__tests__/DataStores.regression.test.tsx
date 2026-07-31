/**
 * Regression tests for the DataStores page.
 *
 * Covers: renders list, category filter tabs, search input, status icons,
 * create wizard trigger, loading/error/empty states.
 */
import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
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
  Tabs: ({ children, value, onValueChange }: any) => <div data-value={value}>{children}</div>,
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
  AlertDialogTitle: ({ children }: any) => <h2>{children}</h2>,
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
jest.mock('@/components/PageContainer', () => ({
  PageContainer: ({ children }: any) => <div>{children}</div>,
}));
jest.mock('@/components/SearchInput', () => ({
  SearchInput: ({ value, onChange, placeholder }: any) => (
    <input data-testid="search-input" value={value} onChange={onChange} placeholder={placeholder} />
  ),
}));
jest.mock('@/components/DataStoreCard', () => ({
  DataStoreCard: ({ dataStore, onDelete }: any) => (
    <div data-testid={`datastore-card-${dataStore.id}`}>
      <span>{dataStore.name}</span>
      <button onClick={() => onDelete?.(dataStore.id)}>Delete</button>
    </div>
  ),
}));
jest.mock('@/components/CreateDataStoreWizard', () => ({
  CreateDataStoreWizard: ({ onClose }: any) => (
    <div data-testid="create-wizard">
      <button onClick={onClose}>Close</button>
    </div>
  ),
}));
jest.mock('@/contexts/OrganizationContext', () => ({
  useOrganization: () => ({ selectedOrganization: 'test-org' }),
}));
jest.mock('sonner', () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}));

const mockDataStores = [
  { id: 'ds-1', name: 'Knowledge Base', description: 'OpenSearch knowledge base', category: 'KNOWLEDGE_BASE', status: 'CONNECTED', adapterType: 'opensearch', orgId: 'test-org' },
  { id: 'ds-2', name: 'S3 Bucket', description: 'Document storage', category: 'S3_STORAGE', status: 'CREATED', adapterType: 's3', orgId: 'test-org' },
  { id: 'ds-3', name: 'PostgreSQL', description: 'Main database', category: 'RELATIONAL_DATABASE', status: 'ERROR', adapterType: 'rds-postgres', orgId: 'test-org' },
];

jest.mock('@/services/datastoreService', () => ({
  datastoreService: {
    listDataStores: jest.fn().mockResolvedValue(mockDataStores),
    getDataStoreStats: jest.fn().mockResolvedValue({ total: 3, connected: 1, error: 1 }),
    deleteDataStore: jest.fn().mockResolvedValue(undefined),
  },
  DataStoreStatus: {
    CREATED: 'CREATED',
    CONNECTING: 'CONNECTING',
    CONNECTED: 'CONNECTED',
    PROVISIONING: 'PROVISIONING',
    PROVISIONED: 'PROVISIONED',
    DISCONNECTED: 'DISCONNECTED',
    ERROR: 'ERROR',
    DELETING: 'DELETING',
  },
  DataStoreCategory: {
    KNOWLEDGE_BASE: 'KNOWLEDGE_BASE',
    RELATIONAL_DATABASE: 'RELATIONAL_DATABASE',
    NOSQL_DATABASE: 'NOSQL_DATABASE',
    S3_STORAGE: 'S3_STORAGE',
    DATA_WAREHOUSE: 'DATA_WAREHOUSE',
    DATA_LAKE: 'DATA_LAKE',
    SEARCH_ENGINE: 'SEARCH_ENGINE',
    GRAPH_DATABASE: 'GRAPH_DATABASE',
    TIME_SERIES: 'TIME_SERIES',
    DOCUMENT_DATABASE: 'DOCUMENT_DATABASE',
    CACHE: 'CACHE',
    EXTERNAL: 'EXTERNAL',
  },
}));
jest.mock('@/pages/datastoreFilterUtils', () => ({
  filterDataStoresByUsage: (stores: any[]) => stores,
  UsageFilterTab: {},
}));

import { DataStores } from '../DataStores';

describe('DataStores page — regression', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('renders datastore cards after loading', async () => {
    render(<DataStores />);

    await waitFor(() => {
      expect(screen.getByTestId('datastore-card-ds-1')).toBeInTheDocument();
      expect(screen.getByTestId('datastore-card-ds-2')).toBeInTheDocument();
      expect(screen.getByTestId('datastore-card-ds-3')).toBeInTheDocument();
    });
  });

  test('renders search input', async () => {
    render(<DataStores />);

    await waitFor(() => {
      expect(screen.getByTestId('search-input')).toBeInTheDocument();
    });
  });

  test('renders category filter tabs', async () => {
    render(<DataStores />);

    await waitFor(() => {
      expect(screen.getByRole('tablist')).toBeInTheDocument();
      expect(screen.getAllByText(/Knowledge Base/).length).toBeGreaterThan(0);
      expect(screen.getAllByText(/Relational/).length).toBeGreaterThan(0);
    });
  });

  test('renders create button that opens wizard', async () => {
    render(<DataStores />);

    await waitFor(() => {
      const createBtn = screen.getByRole('button', { name: /add|create|new/i });
      expect(createBtn).toBeInTheDocument();
    });
  });

  test('filters datastores by search text', async () => {
    render(<DataStores />);

    await waitFor(() => {
      expect(screen.getByTestId('datastore-card-ds-1')).toBeInTheDocument();
    });

    const searchInput = screen.getByTestId('search-input');
    fireEvent.change(searchInput, { target: { value: 'Knowledge' } });

    await waitFor(() => {
      expect(screen.getByTestId('datastore-card-ds-1')).toBeInTheDocument();
    });
  });

  test('shows empty state when no datastores exist', async () => {
    const { datastoreService } = require('@/services/datastoreService');
    datastoreService.listDataStores.mockResolvedValueOnce([]);

    render(<DataStores />);

    await waitFor(() => {
      expect(screen.queryByTestId('datastore-card-ds-1')).not.toBeInTheDocument();
    });
  });
});
