/**
 * ImportAgentWizard — 5-step import flow (US-IMP UI).
 *
 * Mirrors CreateAgentWizard conventions (step state, onBack/onComplete props,
 * components/ui primitives). Consumes the mocked `agentImportService`
 * (discoverAgents / describeAgentCandidate / importAgent).
 *
 * shadcn Select (Radix portal) is flattened to a native <select> and Checkbox
 * to a native checkbox so the wizard is queryable in jsdom — same approach as
 * DynamicConnectorForm.test / RuleEditorDialog.test.
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

// --- Mock the import service (the only data dependency) ---
jest.mock('../../services/agentImportService', () => ({
  agentImportService: {
    discoverAgents: jest.fn(),
    describeAgentCandidate: jest.fn(),
    importAgent: jest.fn(),
    attestAgentImport: jest.fn(),
  },
}));

// --- Flatten shadcn Select to a native <select> ---
jest.mock('../ui/select', () => {
  const ReactLib = require('react');
  return {
    Select: ({ value, onValueChange, children, disabled, ...rest }: any) =>
      ReactLib.createElement(
        'select',
        {
          value: value ?? '',
          disabled,
          onChange: (e: any) => onValueChange?.(e.target.value),
          ...rest,
        },
        children,
      ),
    SelectTrigger: ({ children }: any) =>
      ReactLib.createElement(ReactLib.Fragment, null, children),
    SelectValue: () => null,
    SelectContent: ({ children }: any) =>
      ReactLib.createElement(ReactLib.Fragment, null, children),
    SelectItem: ({ children, value, ...rest }: any) =>
      ReactLib.createElement('option', { value, ...rest }, children),
  };
});

// --- Flatten shadcn Checkbox to a native checkbox input ---
jest.mock('../ui/checkbox', () => ({
  Checkbox: ({ checked, onCheckedChange, ...rest }: any) =>
    React.createElement('input', {
      type: 'checkbox',
      checked: !!checked,
      onChange: (e: any) => onCheckedChange?.(e.target.checked),
      ...rest,
    }),
}));

import { ImportAgentWizard } from '../ImportAgentWizard';
import { agentImportService } from '../../services/agentImportService';
import type {
  AgentCandidate,
  AgentCapabilityDescriptor,
  ImportAgentResult,
} from '../../types/agentImport';

const svc = agentImportService as unknown as {
  discoverAgents: jest.Mock;
  describeAgentCandidate: jest.Mock;
  importAgent: jest.Mock;
  attestAgentImport: jest.Mock;
};

const candidate: AgentCandidate = {
  displayName: 'Orders Agent',
  reference: 'ref-orders-1',
  substrate: 'AGENTCORE',
  sourceArn: 'arn:aws:bedrock-agentcore:us-east-1:111122223333:runtime/orders',
  region: 'us-east-1',
  account: '111122223333',
  ownership: 'external',
  discoveredAt: '2026-06-28T00:00:00Z',
};

const descriptor: AgentCapabilityDescriptor = {
  name: 'Orders Agent',
  description: 'Handles the order lifecycle',
  version: '1.2.0',
  skills: ['create_order', 'cancel_order'],
  categories: ['commerce'],
  inputSchema: {},
  outputSchema: {},
  invocation: {
    protocol: 'HTTP_ENDPOINT',
    target: 'https://api.example.com/agent',
    auth: { mode: 'API_KEY' },
    mode: 'sync',
  },
  origin: {
    sourceArn: 'arn:aws:bedrock-agentcore:us-east-1:111122223333:runtime/orders',
    account: '111122223333',
    region: 'us-east-1',
    substrate: 'AGENTCORE',
    discoveredAt: '2026-06-28T00:00:00Z',
    ownership: 'external',
  },
  // 'description' is low-confidence → must be explicitly confirmed in step 3.
  fieldConfidence: { name: 'high', description: 'low', invocation: 'medium' },
};

const successResult: ImportAgentResult = {
  agent: {
    agentId: 'agent-new-1',
    name: 'Orders Agent',
    config: { name: 'Orders Agent' },
    state: 'inactive',
    categories: ['commerce'],
  },
  conflict: false,
};

const conflictResult: ImportAgentResult = {
  agent: null,
  conflict: true,
  existingId: 'agent-existing-9',
  reason: 'An agent with the same source ARN already exists',
  options: ['LINK', 'REPLACE', 'COPY'],
};

type User = ReturnType<typeof userEvent.setup>;

function renderWizard() {
  const onBack = jest.fn();
  const onComplete = jest.fn();
  render(<ImportAgentWizard onBack={onBack} onComplete={onComplete} />);
  return { onBack, onComplete };
}

const nextBtn = () => screen.getByRole('button', { name: /^next$/i });

async function gotoCandidates(user: User): Promise<void> {
  await user.type(screen.getByLabelText(/aws region/i), 'us-east-1');
  await user.click(nextBtn());
}

async function gotoReview(user: User): Promise<void> {
  svc.discoverAgents.mockResolvedValue([candidate]);
  svc.describeAgentCandidate.mockResolvedValue(descriptor);
  await gotoCandidates(user);
  await screen.findByText('Orders Agent');
  await user.click(screen.getByRole('button', { name: /orders agent/i }));
  await user.click(nextBtn());
  await screen.findByLabelText(/agent name/i);
}

async function gotoConfigure(user: User): Promise<void> {
  await gotoReview(user);
  await user.click(
    screen.getByLabelText(/confirm low-confidence field: description/i),
  );
  await user.click(nextBtn());
  await screen.findByRole('button', { name: /test connection/i });
}

async function gotoRegister(user: User): Promise<void> {
  await gotoConfigure(user);
  await user.click(screen.getByRole('button', { name: /test connection/i }));
  await screen.findByText(/connection verified/i);
  await user.click(nextBtn());
  await screen.findByRole('button', { name: /register agent/i });
}

describe('ImportAgentWizard — step 1 (Source)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('renders the wizard header and a labeled AWS Region input for the default SCAN source', () => {
    renderWizard();
    expect(screen.getByText('Import Agent')).toBeInTheDocument();
    // input has an associated label (accessibility)
    expect(screen.getByLabelText(/aws region/i)).toBeInTheDocument();
  });

  it('disables Next until the SCAN region is provided', async () => {
    const user = userEvent.setup();
    renderWizard();
    expect(nextBtn()).toBeDisabled();
    await user.type(screen.getByLabelText(/aws region/i), 'us-east-1');
    expect(nextBtn()).not.toBeDisabled();
  });
});

describe('ImportAgentWizard — step 2 (Candidates)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('advancing SCAN calls discoverAgents with source SCAN and renders selectable candidates', async () => {
    const user = userEvent.setup();
    svc.discoverAgents.mockResolvedValue([candidate]);
    renderWizard();

    await gotoCandidates(user);

    expect(svc.discoverAgents).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'SCAN', region: 'us-east-1' }),
    );

    await screen.findByText('Orders Agent');
    // substrate badge present
    expect(screen.getAllByText('AGENTCORE').length).toBeGreaterThan(0);

    // no selection yet → Next disabled
    expect(nextBtn()).toBeDisabled();
    await user.click(screen.getByRole('button', { name: /orders agent/i }));
    expect(nextBtn()).not.toBeDisabled();
  });

  it('renders a loading state while discovery is in flight', async () => {
    const user = userEvent.setup();
    svc.discoverAgents.mockReturnValue(new Promise(() => {}));
    renderWizard();
    await gotoCandidates(user);
    expect(await screen.findByText(/discovering agents/i)).toBeInTheDocument();
  });

  it('renders an empty state when discovery returns no candidates', async () => {
    const user = userEvent.setup();
    svc.discoverAgents.mockResolvedValue([]);
    renderWizard();
    await gotoCandidates(user);
    expect(
      await screen.findByText(/no importable agents/i),
    ).toBeInTheDocument();
  });

  it('renders an error state when discovery fails', async () => {
    const user = userEvent.setup();
    svc.discoverAgents.mockRejectedValue(new Error('scan blew up'));
    renderWizard();
    await gotoCandidates(user);
    expect(await screen.findByText(/scan blew up/i)).toBeInTheDocument();
  });
});

describe('ImportAgentWizard — step 3 (Review descriptor)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('calls describeAgentCandidate, renders confidence badges, and gates on low-confidence confirmation', async () => {
    const user = userEvent.setup();
    renderWizard();
    await gotoReview(user);

    expect(svc.describeAgentCandidate).toHaveBeenCalledWith('ref-orders-1');

    // descriptor fields rendered
    expect(screen.getByText(/1\.2\.0/)).toBeInTheDocument();
    expect(screen.getByText('create_order')).toBeInTheDocument();

    // per-field confidence badges
    expect(screen.getByTestId('confidence-description')).toHaveTextContent(
      /low/i,
    );
    expect(screen.getByTestId('confidence-name')).toHaveTextContent(/high/i);

    // low-confidence field must be confirmed before proceeding
    expect(nextBtn()).toBeDisabled();
    await user.click(
      screen.getByLabelText(/confirm low-confidence field: description/i),
    );
    expect(nextBtn()).not.toBeDisabled();
  });
});

describe('ImportAgentWizard — step 4 (Configure + Test)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('shows a secret field for API_KEY auth and gates advancing on a successful Test connection', async () => {
    const user = userEvent.setup();
    renderWizard();
    await gotoConfigure(user);

    // API_KEY auth → secret field is present and labeled
    expect(screen.getByLabelText(/invocation secret/i)).toBeInTheDocument();

    // cannot advance until tested
    expect(nextBtn()).toBeDisabled();

    svc.describeAgentCandidate.mockClear();
    await user.click(screen.getByRole('button', { name: /test connection/i }));

    await waitFor(() =>
      expect(svc.describeAgentCandidate).toHaveBeenCalledWith('ref-orders-1'),
    );
    expect(await screen.findByText(/connection verified/i)).toBeInTheDocument();
    expect(nextBtn()).not.toBeDisabled();
  });
});

describe('ImportAgentWizard — step 5 (Governance & register)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('imports with the assembled input, surfaces the DRAFT/attestation notice, then calls onComplete', async () => {
    const user = userEvent.setup();
    const { onComplete } = renderWizard();
    // wire the happy-path mocks then drive to the register step
    svc.discoverAgents.mockResolvedValue([candidate]);
    svc.describeAgentCandidate.mockResolvedValue(descriptor);
    await gotoRegister(user);

    svc.importAgent.mockResolvedValue(successResult);
    await user.click(screen.getByRole('button', { name: /register agent/i }));

    await waitFor(() => expect(svc.importAgent).toHaveBeenCalledTimes(1));
    const input = svc.importAgent.mock.calls[0][0];
    expect(input).toEqual(
      expect.objectContaining({
        name: 'Orders Agent',
        substrate: 'AGENTCORE',
        invocationProtocol: 'HTTP_ENDPOINT',
        invocationTarget: 'https://api.example.com/agent',
        invocationAuthMode: 'API_KEY',
      }),
    );

    // DRAFT pending governance attestation surfaced
    expect(await screen.findByText(/draft/i)).toBeInTheDocument();
    expect(screen.getByText(/attestation/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^done$/i }));
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('on conflict, shows link/replace/copy options and resubmits with onConflict', async () => {
    const user = userEvent.setup();
    const { onComplete } = renderWizard();
    svc.discoverAgents.mockResolvedValue([candidate]);
    svc.describeAgentCandidate.mockResolvedValue(descriptor);
    await gotoRegister(user);

    svc.importAgent
      .mockResolvedValueOnce(conflictResult)
      .mockResolvedValueOnce(successResult);

    await user.click(screen.getByRole('button', { name: /register agent/i }));

    // conflict surfaced with existing id + the three resolution options
    expect(await screen.findByText(/already exists/i)).toBeInTheDocument();
    expect(screen.getByText(/agent-existing-9/)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /link to existing/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /import as a new copy/i }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /replace existing/i }));
    await user.click(screen.getByRole('button', { name: /resubmit import/i }));

    await waitFor(() => expect(svc.importAgent).toHaveBeenCalledTimes(2));
    expect(svc.importAgent.mock.calls[1][0]).toEqual(
      expect.objectContaining({ onConflict: 'REPLACE' }),
    );

    expect(await screen.findByText(/draft/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^done$/i }));
    expect(onComplete).toHaveBeenCalledTimes(1);
  });
});

describe('ImportAgentWizard — accessibility', () => {
  beforeEach(() => jest.clearAllMocks());

  it('renders selectable candidate cards as buttons carrying cursor-pointer', async () => {
    const user = userEvent.setup();
    svc.discoverAgents.mockResolvedValue([candidate]);
    renderWizard();
    await gotoCandidates(user);

    const card = await screen.findByRole('button', { name: /orders agent/i });
    expect(card.className).toMatch(/cursor-pointer/);
  });
});
