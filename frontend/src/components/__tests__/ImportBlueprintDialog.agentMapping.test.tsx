/**
 * ImportBlueprintDialog — agent-slot remap tests.
 *
 * Verifies that importing a blueprint forces every placeholder agent slot to be
 * mapped to a real agent before the import can proceed, and that the resulting
 * agentMapping ({ [slotAgentId]: realAgentId }) is passed to importBlueprint.
 *
 * The shadcn/Radix Select is mocked as a native <select> (see
 * ModelOverrideSelect.test.tsx for the established pattern) so option rendering
 * and selection are assertable in jsdom. The `aria-label` passed to the Select
 * root is surfaced on the native element so each slot's selector is queryable.
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('../ui/select', () => ({
  Select: ({ value, onValueChange, disabled, children, ['aria-label']: ariaLabel }: any) =>
    React.createElement(
      'select',
      {
        'aria-label': ariaLabel,
        value: value ?? '',
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

jest.mock('../../services/workflowApiService', () => ({
  workflowApiService: { importBlueprint: jest.fn() },
}));

jest.mock('../../services/appApiService', () => ({
  appApiService: { listApps: jest.fn(), createApp: jest.fn() },
}));

jest.mock('../../services/agentConfigService', () => ({
  agentConfigService: { listAgentConfigs: jest.fn() },
}));

import { ImportBlueprintDialog } from '../ImportBlueprintDialog';
import type { BlueprintData } from '../BlueprintCard';
import { workflowApiService } from '../../services/workflowApiService';
import { appApiService } from '../../services/appApiService';
import { agentConfigService } from '../../services/agentConfigService';

const AGENTS = [
  { agentId: 'agent-real-1', name: 'Research Agent', config: {}, state: 'active' as const },
  { agentId: 'agent-real-2', name: 'Coder Agent', config: {}, state: 'active' as const },
];

function makeBlueprint(nodes: Array<{ id: string; agentId: string }>): BlueprintData {
  return {
    workflowId: 'bp-1',
    name: 'Sequential Pipeline',
    description: '[Template] remap before publishing',
    definition: JSON.stringify({
      nodes: nodes.map((n, i) => ({ ...n, position: { x: i * 200, y: 0 }, configuration: {} })),
      edges: [],
    }),
    metadata: JSON.stringify({ category: 'pipeline', isSystem: true }),
    status: 'PUBLISHED',
    version: 1,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    isBlueprint: true,
  };
}

const twoPlaceholderBlueprint = makeBlueprint([
  { id: 'n1', agentId: 'placeholder-agent-1' },
  { id: 'n2', agentId: 'placeholder-agent-2' },
  { id: 'n3', agentId: 'placeholder-agent-1' }, // duplicate slot — must be de-duplicated
]);

beforeEach(() => {
  jest.clearAllMocks();
  (appApiService.listApps as jest.Mock).mockResolvedValue({ items: [], nextToken: null });
  (appApiService.createApp as jest.Mock).mockResolvedValue({ appId: 'app-new' });
  (agentConfigService.listAgentConfigs as jest.Mock).mockResolvedValue(AGENTS);
  (workflowApiService.importBlueprint as jest.Mock).mockResolvedValue({ workflowId: 'wf-new', status: 'DRAFT' });
});

describe('ImportBlueprintDialog — agent slot remap', () => {
  it('renders one selector per DISTINCT blueprint agent slot, listing real agents as options', async () => {
    render(<ImportBlueprintDialog blueprint={twoPlaceholderBlueprint} open onClose={() => {}} />);

    const slotSelects = await screen.findAllByLabelText(/map agent slot/i);
    expect(slotSelects).toHaveLength(2);
    expect(screen.getByLabelText(/map agent slot placeholder-agent-1/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/map agent slot placeholder-agent-2/i)).toBeInTheDocument();

    // Each slot selector offers the real agents from the catalog.
    expect(screen.getAllByRole('option', { name: 'Research Agent' }).length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByRole('option', { name: 'Coder Agent' }).length).toBeGreaterThanOrEqual(2);
  });

  it('keeps import disabled with a visible message until every placeholder slot is mapped', async () => {
    render(<ImportBlueprintDialog blueprint={twoPlaceholderBlueprint} open onClose={() => {}} />);
    await screen.findAllByLabelText(/map agent slot/i);

    const importBtn = screen.getByRole('button', { name: /^import$/i });
    expect(importBtn).toBeDisabled();
    expect(screen.getByText(/all agent slots must be mapped to a real agent/i)).toBeInTheDocument();

    // Map only the first slot — still blocked.
    fireEvent.change(screen.getByLabelText(/map agent slot placeholder-agent-1/i), {
      target: { value: 'agent-real-1' },
    });
    expect(importBtn).toBeDisabled();

    // Map the second slot — now unblocked and message gone.
    fireEvent.change(screen.getByLabelText(/map agent slot placeholder-agent-2/i), {
      target: { value: 'agent-real-2' },
    });
    expect(importBtn).toBeEnabled();
    expect(screen.queryByText(/all agent slots must be mapped to a real agent/i)).not.toBeInTheDocument();
  });

  it('passes agentMapping { slot: realAgentId } to importBlueprint on confirm', async () => {
    render(<ImportBlueprintDialog blueprint={twoPlaceholderBlueprint} open onClose={() => {}} onImported={() => {}} />);
    await screen.findAllByLabelText(/map agent slot/i);

    // Use the "New App" flow (Input, not a Select) to satisfy the app gate.
    fireEvent.click(screen.getByRole('button', { name: /new app/i }));
    fireEvent.change(screen.getByLabelText(/new app name/i), { target: { value: 'My New App' } });

    fireEvent.change(screen.getByLabelText(/map agent slot placeholder-agent-1/i), {
      target: { value: 'agent-real-1' },
    });
    fireEvent.change(screen.getByLabelText(/map agent slot placeholder-agent-2/i), {
      target: { value: 'agent-real-2' },
    });

    fireEvent.click(screen.getByRole('button', { name: /^import$/i }));

    await waitFor(() => {
      expect(workflowApiService.importBlueprint).toHaveBeenCalledWith(
        'bp-1',
        'app-new',
        undefined,
        { 'placeholder-agent-1': 'agent-real-1', 'placeholder-agent-2': 'agent-real-2' },
      );
    });
  });

  it('preserves a non-placeholder slot\'s current value as an option and does not gate on it', async () => {
    const mixed = makeBlueprint([
      { id: 'n1', agentId: 'placeholder-agent-1' },
      { id: 'n2', agentId: 'legacy-agent-x' }, // real (non-placeholder), not in catalog
    ]);
    render(<ImportBlueprintDialog blueprint={mixed} open onClose={() => {}} />);
    await screen.findAllByLabelText(/map agent slot/i);

    // Current value preserved as a selectable option for the legacy slot.
    expect(screen.getByRole('option', { name: /legacy-agent-x/i })).toBeInTheDocument();

    // Only the placeholder slot gates the import.
    const importBtn = screen.getByRole('button', { name: /^import$/i });
    expect(importBtn).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/map agent slot placeholder-agent-1/i), {
      target: { value: 'agent-real-1' },
    });
    expect(importBtn).toBeEnabled();

    // Confirm carries both slots; the legacy slot keeps its current value.
    fireEvent.click(screen.getByRole('button', { name: /new app/i }));
    fireEvent.change(screen.getByLabelText(/new app name/i), { target: { value: 'App2' } });
    fireEvent.click(importBtn);

    await waitFor(() => {
      expect(workflowApiService.importBlueprint).toHaveBeenCalledWith(
        'bp-1',
        'app-new',
        undefined,
        { 'placeholder-agent-1': 'agent-real-1', 'legacy-agent-x': 'legacy-agent-x' },
      );
    });
  });
});
