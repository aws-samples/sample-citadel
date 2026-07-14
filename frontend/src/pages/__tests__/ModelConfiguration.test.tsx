/**
 * ModelConfiguration page tests.
 *
 * Mirrors the AgentCatalog RTL idiom: shadcn primitives are mocked with @/
 * alias paths (Select rendered as a native <select> so onValueChange can be
 * fired via fireEvent.change), and the service / OrganizationContext / sonner
 * are mocked. Model ids are generic placeholders.
 *
 * Cases:
 *  (a) admin renders catalog rows after load
 *  (b) changing the global-default select calls updateModelConfig
 *  (c) changing a catalog row status select calls setModelCatalogEntryStatus
 *  (d) non-admin shows the access-required message and never lists the catalog
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

// Render shadcn Select primitives as native <select>/<option> so jest can fire
// onValueChange via fireEvent.change(...). Each <select> is tagged with a
// data-testid derived from its SelectTrigger id so individual controls can be
// targeted.
jest.mock('@/components/ui/select', () => {
  const R = require('react');
  const SelectTrigger = Object.assign(
    ({ children, id, className, ...rest }: any) =>
      R.createElement(
        'div',
        { id, className, 'data-testid': 'select-trigger', ...rest },
        children,
      ),
    { _triggerMarker: true },
  );
  const SelectItem = Object.assign(
    ({ children }: any) => R.createElement('span', null, children),
    { _optionMarker: true },
  );
  const Select = ({ value, onValueChange, children }: any) => {
    const options: Array<{ value: any; label: any }> = [];
    let triggerId: string | undefined;
    const collect = (node: any) => {
      if (!node) return;
      if (Array.isArray(node)) {
        node.forEach(collect);
        return;
      }
      if (node?.type?._optionMarker === true && node?.props?.value !== undefined) {
        options.push({ value: node.props.value, label: node.props.children });
      }
      if (node?.type?._triggerMarker === true && node?.props?.id) {
        triggerId = node.props.id;
      }
      if (node?.props?.children) collect(node.props.children);
    };
    collect(children);
    return R.createElement(
      'select',
      {
        value: value ?? '',
        onChange: (e: any) => onValueChange && onValueChange(e.target.value),
        'data-testid': triggerId ? `select-${triggerId}` : 'select-mock',
        'data-current-value': value,
      },
      options.map((o) =>
        R.createElement('option', { key: String(o.value), value: o.value }, o.label),
      ),
    );
  };
  return {
    Select,
    SelectTrigger,
    SelectValue: () => null,
    SelectContent: ({ children }: any) => R.createElement('div', null, children),
    SelectItem,
  };
});

jest.mock('@/components/ui/table', () => ({
  Table: ({ children }: any) => React.createElement('table', null, children),
  TableHeader: ({ children }: any) => React.createElement('thead', null, children),
  TableBody: ({ children }: any) => React.createElement('tbody', null, children),
  TableRow: ({ children, ...rest }: any) =>
    React.createElement('tr', rest, children),
  TableHead: ({ children }: any) => React.createElement('th', null, children),
  TableCell: ({ children }: any) => React.createElement('td', null, children),
}));

jest.mock('@/components/ui/card', () => ({
  Card: ({ children }: any) => React.createElement('div', null, children),
  CardHeader: ({ children }: any) => React.createElement('div', null, children),
  CardTitle: ({ children }: any) => React.createElement('div', null, children),
  CardDescription: ({ children }: any) => React.createElement('div', null, children),
  CardContent: ({ children }: any) => React.createElement('div', null, children),
}));

jest.mock('@/components/ui/badge', () => ({
  Badge: ({ children }: any) =>
    React.createElement('span', { 'data-testid': 'badge' }, children),
}));

jest.mock('@/components/ui/label', () => ({
  Label: ({ children, htmlFor }: any) =>
    React.createElement('label', { htmlFor }, children),
}));

jest.mock('@/components/ui/button', () => ({
  Button: ({ children, onClick, ...rest }: any) =>
    React.createElement('button', { onClick, ...rest }, children),
}));

jest.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: any) => React.createElement('div', null, children),
  TooltipTrigger: ({ children }: any) => React.createElement('div', null, children),
  TooltipContent: ({ children }: any) => React.createElement('div', null, children),
}));

jest.mock('@/components/PageContainer', () => ({
  PageContainer: ({ children }: any) => React.createElement('div', null, children),
}));

jest.mock('@/components/ErrorBoundary', () => ({
  ErrorBoundary: ({ children }: any) => React.createElement('div', null, children),
}));

jest.mock('sonner', () => ({
  __esModule: true,
  toast: { success: jest.fn(), error: jest.fn() },
}));

jest.mock('@/services/modelConfigService', () => ({
  modelConfigService: {
    listModelCatalog: jest.fn(),
    getModelConfig: jest.fn(),
    updateModelConfig: jest.fn(),
    setModelCatalogEntryStatus: jest.fn(),
    syncModelCatalog: jest
      .fn()
      .mockResolvedValue({ triggered: true, message: 'Model sync started' }),
  },
}));

jest.mock('@/contexts/OrganizationContext', () => ({
  useOrganization: jest.fn(),
}));

import { ModelConfiguration } from '../ModelConfiguration';
import { modelConfigService } from '../../services/modelConfigService';
import { useOrganization } from '../../contexts/OrganizationContext';

const CATALOG = [
  {
    modelKey: 'provider-a.model-x',
    provider: 'provider-a',
    baseModelId: 'model-x-base',
    status: 'enabled',
    modality: 'text',
    invocationMode: 'on_demand',
    supportsTools: true,
    supportsSystemPrompt: true,
    supportsStreaming: true,
    regionProfiles: { 'us-east-1': 'model-x-base' },
  },
  {
    modelKey: 'provider-b.model-y',
    provider: 'provider-b',
    baseModelId: 'model-y-base',
    status: 'enabled',
    modality: 'multimodal',
    invocationMode: 'provisioned',
    supportsTools: false,
    supportsSystemPrompt: true,
    supportsStreaming: false,
    regionProfiles: {},
  },
];

const CONFIG = {
  scope: 'platform',
  globalDefaultKey: 'provider-a.model-x',
  slotDefaults: {},
  orgDefaults: {},
  agentOverrides: {},
  localityMode: 'off',
};

function mockAdmin(isAdmin: boolean) {
  (useOrganization as jest.Mock).mockReturnValue({ isAdmin });
}

describe('ModelConfiguration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (modelConfigService.listModelCatalog as jest.Mock).mockResolvedValue(CATALOG);
    (modelConfigService.getModelConfig as jest.Mock).mockResolvedValue(CONFIG);
    (modelConfigService.updateModelConfig as jest.Mock).mockResolvedValue(CONFIG);
    (modelConfigService.setModelCatalogEntryStatus as jest.Mock).mockResolvedValue(
      CATALOG[0],
    );
  });

  it('(a) renders catalog rows for an admin after load', async () => {
    mockAdmin(true);
    render(<ModelConfiguration />);

    await waitFor(() =>
      expect(modelConfigService.listModelCatalog).toHaveBeenCalled(),
    );

    expect(
      await screen.findByTestId('model-row-provider-a.model-x'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('model-row-provider-b.model-y')).toBeInTheDocument();
  });

  it('(b) changing the global-default select calls updateModelConfig', async () => {
    mockAdmin(true);
    render(<ModelConfiguration />);

    await waitFor(() =>
      expect(modelConfigService.listModelCatalog).toHaveBeenCalled(),
    );

    const globalSelect = await screen.findByTestId('select-model-global-default');
    fireEvent.change(globalSelect, {
      target: { value: 'provider-b.model-y' },
    });

    await waitFor(() =>
      expect(modelConfigService.updateModelConfig).toHaveBeenCalledWith({
        globalDefaultKey: 'provider-b.model-y',
      }),
    );
  });

  it('(c) changing a catalog row status select calls setModelCatalogEntryStatus', async () => {
    mockAdmin(true);
    render(<ModelConfiguration />);

    await waitFor(() =>
      expect(modelConfigService.listModelCatalog).toHaveBeenCalled(),
    );

    const statusSelect = await screen.findByTestId(
      'select-model-status-provider-a.model-x',
    );
    fireEvent.change(statusSelect, { target: { value: 'disabled' } });

    await waitFor(() =>
      expect(modelConfigService.setModelCatalogEntryStatus).toHaveBeenCalledWith(
        'provider-a.model-x',
        'disabled',
      ),
    );
  });

  it('(d) shows the access-required message for non-admins and never lists the catalog', async () => {
    mockAdmin(false);
    render(<ModelConfiguration />);

    expect(screen.getByTestId('model-config-admin-only')).toBeInTheDocument();
    expect(
      screen.getByText(/Administrator access required/i),
    ).toBeInTheDocument();
    expect(modelConfigService.listModelCatalog).not.toHaveBeenCalled();
  });

  it('(e) renders the Model Sync button and triggers a catalog sync on click', async () => {
    mockAdmin(true);
    render(<ModelConfiguration />);

    await waitFor(() =>
      expect(modelConfigService.listModelCatalog).toHaveBeenCalled(),
    );

    const syncButton = await screen.findByRole('button', {
      name: /sync model catalog from bedrock/i,
    });
    fireEvent.click(syncButton);

    await waitFor(() =>
      expect(modelConfigService.syncModelCatalog).toHaveBeenCalled(),
    );
  });
});
