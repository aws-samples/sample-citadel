/**
 * ModelOverrideSelect unit tests.
 *
 * The shadcn/Radix Select is mocked as a native <select> so that option
 * rendering and selection are assertable in jsdom (onValueChange is mapped to
 * the native onChange). The model catalog service is mocked so enabled/disabled
 * filtering and legacy-value preservation can be driven with generic
 * placeholder data.
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('@/components/ui/select', () => ({
  Select: ({ value, onValueChange, disabled, children }: any) =>
    React.createElement(
      'select',
      {
        'data-testid': 'model-select',
        value,
        disabled,
        onChange: (e: any) => onValueChange(e.target.value),
      },
      children,
    ),
  SelectTrigger: ({ children }: any) => React.createElement(React.Fragment, null, children),
  SelectValue: () => null,
  SelectContent: ({ children }: any) => React.createElement(React.Fragment, null, children),
  SelectItem: ({ value, children }: any) => React.createElement('option', { value }, children),
}));

jest.mock('@/services/modelConfigService', () => ({
  modelConfigService: { listModelCatalog: jest.fn() },
}));

import { ModelOverrideSelect } from '../ModelOverrideSelect';
import { modelConfigService } from '@/services/modelConfigService';

const listModelCatalog = modelConfigService.listModelCatalog as jest.Mock;

// Generic placeholder catalog data — two enabled entries and one disabled.
const CATALOG = [
  {
    modelKey: 'prov-model-x',
    provider: 'provider.model-x',
    baseModelId: 'model-x',
    status: 'enabled',
    supportsTools: true,
  },
  {
    modelKey: 'prov-model-y',
    provider: 'provider.model-y',
    baseModelId: 'model-y',
    status: 'enabled',
    supportsTools: false,
  },
  {
    modelKey: 'prov-model-z',
    provider: 'provider.model-z',
    baseModelId: 'model-z',
    status: 'disabled',
    supportsTools: false,
  },
];

beforeEach(() => {
  listModelCatalog.mockReset();
  listModelCatalog.mockResolvedValue(CATALOG);
});

describe('ModelOverrideSelect', () => {
  it('renders the platform-default option plus one option per enabled catalog entry', async () => {
    render(<ModelOverrideSelect value="" onChange={jest.fn()} />);

    expect(
      await screen.findByRole('option', { name: 'Use platform default' }),
    ).toBeInTheDocument();
    // supportsTools appends the ' · tools' suffix; both enabled entries render.
    expect(
      screen.getByRole('option', { name: 'provider.model-x · model-x · tools' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('option', { name: 'provider.model-y · model-y' }),
    ).toBeInTheDocument();
    // The disabled catalog entry is excluded.
    expect(screen.queryByRole('option', { name: /model-z/ })).not.toBeInTheDocument();
  });

  it('calls onChange with the modelKey when an enabled option is selected', async () => {
    const onChange = jest.fn();
    render(<ModelOverrideSelect value="" onChange={onChange} />);
    await screen.findByRole('option', { name: 'provider.model-x · model-x · tools' });

    fireEvent.change(screen.getByTestId('model-select'), {
      target: { value: 'prov-model-x' },
    });

    expect(onChange).toHaveBeenCalledWith('prov-model-x');
  });

  it('calls onChange with an empty string when the platform-default option is selected', async () => {
    const onChange = jest.fn();
    render(<ModelOverrideSelect value="prov-model-x" onChange={onChange} />);
    await screen.findByRole('option', { name: 'Use platform default' });

    fireEvent.change(screen.getByTestId('model-select'), {
      target: { value: '__default__' },
    });

    expect(onChange).toHaveBeenCalledWith('');
  });

  it('preserves a legacy value that is not in the catalog as a "Current" option', async () => {
    render(<ModelOverrideSelect value="legacy-model-key" onChange={jest.fn()} />);

    expect(
      await screen.findByRole('option', { name: 'Current: legacy-model-key' }),
    ).toBeInTheDocument();
  });
});
