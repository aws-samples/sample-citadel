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
    testImportedAgent: jest.fn(),
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

import { ImportAgentWizard, substrateToProtocol } from '../ImportAgentWizard';
import { agentImportService } from '../../services/agentImportService';
import type {
  AgentCandidate,
  AgentCapabilityDescriptor,
  ImportAgentResult,
  ImportTestResult,
} from '../../types/agentImport';

const svc = agentImportService as unknown as {
  discoverAgents: jest.Mock;
  describeAgentCandidate: jest.Mock;
  importAgent: jest.Mock;
  attestAgentImport: jest.Mock;
  testImportedAgent: jest.Mock;
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

const testOk: ImportTestResult = {
  ok: true,
  output: 'pong: {"status":"ok"}',
  error: null,
  latencyMs: 142,
};

const testFail: ImportTestResult = {
  ok: false,
  output: null,
  error: 'Endpoint returned 403 Forbidden',
  latencyMs: 88,
};

// Multi-candidate SCAN fixtures for batch draft-import. Substrate values match
// what the discovery adapters actually emit (agentcore_runtime / lambda / http).
const batchA: AgentCandidate = {
  displayName: 'Orders Agent',
  reference: 'ref-a',
  substrate: 'agentcore_runtime',
  sourceArn: 'arn:aws:bedrock-agentcore:us-east-1:111122223333:runtime/orders',
  region: 'us-east-1',
  account: '111122223333',
  ownership: 'external',
  discoveredAt: '2026-06-28T00:00:00Z',
};

const batchB: AgentCandidate = {
  displayName: 'Billing Agent',
  reference: 'ref-b',
  substrate: 'lambda',
  sourceArn: 'arn:aws:lambda:us-east-1:111122223333:function:billing',
  region: 'us-east-1',
  account: '111122223333',
  ownership: 'external',
  discoveredAt: '2026-06-28T00:00:00Z',
};

const batchC: AgentCandidate = {
  displayName: 'Search Agent',
  reference: 'ref-c',
  substrate: 'http',
  region: 'us-east-1',
  account: '111122223333',
  ownership: 'external',
  discoveredAt: '2026-06-28T00:00:00Z',
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
  svc.testImportedAgent.mockResolvedValue(testOk);
  await user.click(screen.getByRole('button', { name: /test connection/i }));
  await screen.findByText(/connection verified/i);
  await user.click(nextBtn());
  await screen.findByRole('button', { name: /register agent/i });
}

// The shadcn Select is flattened to a native <select> (role "combobox") whose
// label association is lost through the mock, so locate the auth-mode select
// structurally: it is the one carrying a "BEARER" option.
function authModeSelect(): HTMLSelectElement {
  const selects = screen.getAllByRole('combobox') as HTMLSelectElement[];
  const found = selects.find((s) =>
    Array.from(s.options).some((o) => o.value === 'BEARER'),
  );
  if (!found) throw new Error('auth-mode <select> not found');
  return found;
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

  it('runs a real test-invoke: ok:true calls testImportedAgent with the assembled input, shows the output preview + latency, and enables Next', async () => {
    const user = userEvent.setup();
    renderWizard();
    await gotoConfigure(user);

    // API_KEY auth → secret field + optional header-name input present
    expect(screen.getByLabelText(/invocation secret/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/header name/i)).toBeInTheDocument();

    // cannot advance until a successful test
    expect(nextBtn()).toBeDisabled();

    svc.testImportedAgent.mockResolvedValue(testOk);
    await user.click(screen.getByRole('button', { name: /test connection/i }));

    await waitFor(() => expect(svc.testImportedAgent).toHaveBeenCalledTimes(1));
    const input = svc.testImportedAgent.mock.calls[0][0];
    expect(input).toEqual(
      expect.objectContaining({
        invocationProtocol: 'HTTP_ENDPOINT',
        invocationTarget: 'https://api.example.com/agent',
        invocationAuthMode: 'API_KEY',
        invocationMode: 'sync',
        prompt: expect.any(String),
      }),
    );
    // a non-empty test prompt is sent
    expect(input.prompt.length).toBeGreaterThan(0);

    // success state: verified + latency + a short output preview
    expect(await screen.findByText(/connection verified/i)).toBeInTheDocument();
    expect(screen.getByText(/142 ms/)).toBeInTheDocument();
    expect(screen.getByText(/pong/i)).toBeInTheDocument();
    expect(nextBtn()).not.toBeDisabled();
  });

  it('ok:false surfaces the returned error and keeps Next disabled', async () => {
    const user = userEvent.setup();
    renderWizard();
    await gotoConfigure(user);

    svc.testImportedAgent.mockResolvedValue(testFail);
    await user.click(screen.getByRole('button', { name: /test connection/i }));

    expect(await screen.findByText(/403 forbidden/i)).toBeInTheDocument();
    expect(screen.queryByText(/connection verified/i)).not.toBeInTheDocument();
    expect(nextBtn()).toBeDisabled();
  });

  it('surfaces a thrown transport error and keeps Next disabled', async () => {
    const user = userEvent.setup();
    renderWizard();
    await gotoConfigure(user);

    svc.testImportedAgent.mockRejectedValue(new Error('network down'));
    await user.click(screen.getByRole('button', { name: /test connection/i }));

    expect(await screen.findByText(/network down/i)).toBeInTheDocument();
    expect(nextBtn()).toBeDisabled();
  });

  it('BEARER auth uses a secret value (no header-name input) and sends invocationAuthMode BEARER', async () => {
    const user = userEvent.setup();
    renderWizard();
    await gotoConfigure(user);

    await user.selectOptions(authModeSelect(), 'BEARER');

    // BEARER → secret value field, but no API-key header-name input
    expect(screen.getByLabelText(/invocation secret/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/header name/i)).not.toBeInTheDocument();

    svc.testImportedAgent.mockResolvedValue(testOk);
    await user.click(screen.getByRole('button', { name: /test connection/i }));

    await waitFor(() => expect(svc.testImportedAgent).toHaveBeenCalledTimes(1));
    expect(svc.testImportedAgent.mock.calls[0][0]).toEqual(
      expect.objectContaining({ invocationAuthMode: 'BEARER' }),
    );
  });

  it('API_KEY with a custom header name sends invocationAuthHeader in the test input', async () => {
    const user = userEvent.setup();
    renderWizard();
    await gotoConfigure(user);

    await user.type(screen.getByLabelText(/header name/i), 'x-api-key');

    svc.testImportedAgent.mockResolvedValue(testOk);
    await user.click(screen.getByRole('button', { name: /test connection/i }));

    await waitFor(() => expect(svc.testImportedAgent).toHaveBeenCalledTimes(1));
    expect(svc.testImportedAgent.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        invocationAuthMode: 'API_KEY',
        invocationAuthHeader: 'x-api-key',
      }),
    );
  });

  it('invalidates a prior passing test when an input changes, re-disabling Next', async () => {
    const user = userEvent.setup();
    renderWizard();
    await gotoConfigure(user);

    svc.testImportedAgent.mockResolvedValue(testOk);
    await user.click(screen.getByRole('button', { name: /test connection/i }));
    await screen.findByText(/connection verified/i);
    expect(nextBtn()).not.toBeDisabled();

    // editing the target invalidates the prior result
    await user.type(screen.getByLabelText(/invocation target/i), '/v2');
    expect(screen.queryByText(/connection verified/i)).not.toBeInTheDocument();
    expect(nextBtn()).toBeDisabled();
  });
});

describe('ImportAgentWizard — step 5 (Governance & register)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('forwards a custom API_KEY header (invocationAuthHeader) into the importAgent input', async () => {
    const user = userEvent.setup();
    renderWizard();
    await gotoConfigure(user);

    await user.type(screen.getByLabelText(/header name/i), 'x-api-key');
    svc.testImportedAgent.mockResolvedValue(testOk);
    await user.click(screen.getByRole('button', { name: /test connection/i }));
    await screen.findByText(/connection verified/i);
    await user.click(nextBtn());
    await screen.findByRole('button', { name: /register agent/i });

    svc.importAgent.mockResolvedValue(successResult);
    await user.click(screen.getByRole('button', { name: /register agent/i }));

    await waitFor(() => expect(svc.importAgent).toHaveBeenCalledTimes(1));
    expect(svc.importAgent.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        invocationAuthMode: 'API_KEY',
        invocationAuthHeader: 'x-api-key',
      }),
    );
  });

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

describe('substrateToProtocol (substrate → invocation protocol map)', () => {
  it('maps each known discovery substrate to its invocation protocol', () => {
    expect(substrateToProtocol('agentcore_runtime')).toBe('AGENTCORE_RUNTIME');
    expect(substrateToProtocol('lambda')).toBe('LAMBDA_INVOKE');
    expect(substrateToProtocol('bedrock_agent')).toBe('BEDROCK_AGENT');
    expect(substrateToProtocol('http')).toBe('HTTP_ENDPOINT');
    expect(substrateToProtocol('mcp')).toBe('MCP');
  });

  it('falls back to HTTP_ENDPOINT for an unrecognized substrate', () => {
    expect(substrateToProtocol('something-else')).toBe('HTTP_ENDPOINT');
  });
});

describe('ImportAgentWizard — batch draft-import (Step 2)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('imports each selected candidate as a draft with the substrate-mapped protocol, renders per-candidate results, then completes', async () => {
    const user = userEvent.setup();
    svc.discoverAgents.mockResolvedValue([batchA, batchB, batchC]);
    const { onComplete } = renderWizard();

    await gotoCandidates(user);
    await screen.findByText('Orders Agent');

    // select all three discovered candidates
    await user.click(screen.getByRole('button', { name: /orders agent/i }));
    await user.click(screen.getByRole('button', { name: /billing agent/i }));
    await user.click(screen.getByRole('button', { name: /search agent/i }));

    // one success, one conflict, one error — exercised in selection order
    svc.importAgent
      .mockResolvedValueOnce(successResult)
      .mockResolvedValueOnce(conflictResult)
      .mockRejectedValueOnce(new Error('boom'));

    await user.click(screen.getByRole('button', { name: /import 3 as drafts/i }));

    await waitFor(() => expect(svc.importAgent).toHaveBeenCalledTimes(3));

    // each call carries the candidate-derived input + substrate-mapped protocol
    expect(svc.importAgent.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        name: 'Orders Agent',
        invocationTarget: 'ref-a',
        substrate: 'agentcore_runtime',
        invocationProtocol: 'AGENTCORE_RUNTIME',
        invocationMode: 'sync',
        invocationAuthMode: 'NONE',
        region: 'us-east-1',
        account: '111122223333',
        sourceArn: 'arn:aws:bedrock-agentcore:us-east-1:111122223333:runtime/orders',
      }),
    );
    expect(svc.importAgent.mock.calls[1][0]).toEqual(
      expect.objectContaining({
        substrate: 'lambda',
        invocationProtocol: 'LAMBDA_INVOKE',
        invocationTarget: 'ref-b',
      }),
    );
    expect(svc.importAgent.mock.calls[2][0]).toEqual(
      expect.objectContaining({
        substrate: 'http',
        invocationProtocol: 'HTTP_ENDPOINT',
        invocationTarget: 'ref-c',
      }),
    );

    // per-candidate results: success + conflict (with existing id) + error
    expect(await screen.findByText('Orders Agent')).toBeInTheDocument();
    expect(screen.getByText('Billing Agent')).toBeInTheDocument();
    expect(screen.getByText('Search Agent')).toBeInTheDocument();
    expect(screen.getByText(/draft created/i)).toBeInTheDocument();
    expect(screen.getByText(/conflict/i)).toBeInTheDocument();
    expect(screen.getByText(/agent-existing-9/)).toBeInTheDocument();
    expect(screen.getByText(/failed/i)).toBeInTheDocument();
    expect(screen.getByText(/boom/i)).toBeInTheDocument();

    // the DRAFT / skip-per-candidate-test note is surfaced
    expect(screen.getByText(/attested before activation/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^done$/i }));
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('does not offer the batch action for a single selection and keeps the review path intact', async () => {
    const user = userEvent.setup();
    svc.discoverAgents.mockResolvedValue([batchA, batchB]);
    svc.describeAgentCandidate.mockResolvedValue(descriptor);
    renderWizard();

    await gotoCandidates(user);
    await screen.findByText('Orders Agent');

    await user.click(screen.getByRole('button', { name: /orders agent/i }));

    // exactly one selected → no batch affordance, and importAgent is untouched
    expect(
      screen.queryByRole('button', { name: /import .* as drafts/i }),
    ).not.toBeInTheDocument();
    expect(svc.importAgent).not.toHaveBeenCalled();

    // the single-candidate path still advances into the review step
    await user.click(nextBtn());
    expect(await screen.findByLabelText(/agent name/i)).toBeInTheDocument();
  });
});

describe('ImportAgentWizard — manifest file upload (Step 1)', () => {
  beforeEach(() => jest.clearAllMocks());

  async function gotoManifestSource(user: User): Promise<void> {
    renderWizard();
    await user.click(screen.getByRole('button', { name: /provide a manifest/i }));
    await screen.findByLabelText(/agent manifest/i);
  }

  it('reads a chosen .json file into the manifest field and enables Next', async () => {
    const user = userEvent.setup();
    await gotoManifestSource(user);

    const file = new File(['{"agents":[{"name":"x"}]}'], 'manifest.json', {
      type: 'application/json',
    });
    await user.upload(screen.getByLabelText(/upload manifest file/i), file);

    await waitFor(() =>
      expect(screen.getByLabelText(/agent manifest/i)).toHaveValue(
        '{"agents":[{"name":"x"}]}',
      ),
    );
    expect(nextBtn()).not.toBeDisabled();
  });

  it('shows a parse error when the chosen file is not valid JSON', async () => {
    const user = userEvent.setup();
    await gotoManifestSource(user);

    const file = new File(['{ oops'], 'bad.json', {
      type: 'application/json',
    });
    await user.upload(screen.getByLabelText(/upload manifest file/i), file);

    await waitFor(() =>
      expect(screen.getByLabelText(/agent manifest/i)).toHaveValue('{ oops'),
    );
    expect(screen.getByRole('alert')).toHaveTextContent(/manifest is not valid json/i);
    expect(nextBtn()).toBeDisabled();
  });

  it('still accepts a pasted manifest (paste path unchanged)', async () => {
    const user = userEvent.setup();
    await gotoManifestSource(user);

    const textarea = screen.getByLabelText(/agent manifest/i);
    await user.click(textarea);
    await user.paste('{"agents":[]}');

    expect(textarea).toHaveValue('{"agents":[]}');
    expect(nextBtn()).not.toBeDisabled();
  });
});

describe('ImportAgentWizard — Step 4 analysis role ARN (cross-account trust-path)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('renders an optional "Analysis role ARN" input in Step 4 that does not block Next when left empty', async () => {
    const user = userEvent.setup();
    renderWizard();
    await gotoConfigure(user);

    // the optional analysis-role input is present in the invocation config
    expect(screen.getByLabelText(/analysis role arn/i)).toBeInTheDocument();

    // leaving it blank does not gate Step 4: a passing reachability test alone
    // enables Next (the field is optional — Next is never blocked on it)
    svc.testImportedAgent.mockResolvedValue(testOk);
    await user.click(screen.getByRole('button', { name: /test connection/i }));
    await screen.findByText(/connection verified/i);
    expect(nextBtn()).not.toBeDisabled();
  });

  it('threads a filled analysis role ARN into the importAgent input as invocationAnalysisRoleArn', async () => {
    const user = userEvent.setup();
    renderWizard();
    await gotoConfigure(user);

    const analysisArn = 'arn:aws:iam::444455556666:role/citadel-analysis-readonly';
    await user.type(screen.getByLabelText(/analysis role arn/i), analysisArn);

    // filling the analysis role must not disturb the reachability test (it is
    // consumed only by the activation trust-path, not the test-invoke)
    svc.testImportedAgent.mockResolvedValue(testOk);
    await user.click(screen.getByRole('button', { name: /test connection/i }));
    await screen.findByText(/connection verified/i);
    await user.click(nextBtn());
    await screen.findByRole('button', { name: /register agent/i });

    svc.importAgent.mockResolvedValue(successResult);
    await user.click(screen.getByRole('button', { name: /register agent/i }));

    await waitFor(() => expect(svc.importAgent).toHaveBeenCalledTimes(1));
    expect(svc.importAgent.mock.calls[0][0]).toEqual(
      expect.objectContaining({ invocationAnalysisRoleArn: analysisArn }),
    );
  });

  it('omits invocationAnalysisRoleArn (undefined) when the analysis role input is left blank', async () => {
    const user = userEvent.setup();
    renderWizard();
    await gotoRegister(user);

    svc.importAgent.mockResolvedValue(successResult);
    await user.click(screen.getByRole('button', { name: /register agent/i }));

    await waitFor(() => expect(svc.importAgent).toHaveBeenCalledTimes(1));
    expect(
      svc.importAgent.mock.calls[0][0].invocationAnalysisRoleArn,
    ).toBeUndefined();
  });
});

describe('ImportAgentWizard — Step 4 cross-account invoke role (ARN + external ID)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('renders optional "Invoke role ARN (cross-account)" and "External ID" inputs that do not block Next when left blank', async () => {
    const user = userEvent.setup();
    renderWizard();
    await gotoConfigure(user);

    // both optional cross-account fields are present in the invocation config
    expect(screen.getByLabelText(/invoke role arn/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/external id/i)).toBeInTheDocument();

    // leaving them blank does not gate Step 4: a passing reachability test
    // alone enables Next (the fields are optional — Next never blocks on them)
    svc.testImportedAgent.mockResolvedValue(testOk);
    await user.click(screen.getByRole('button', { name: /test connection/i }));
    await screen.findByText(/connection verified/i);
    expect(nextBtn()).not.toBeDisabled();
  });

  it('threads a filled invoke role ARN + external ID into BOTH the Step-4 test-invoke and the importAgent input', async () => {
    const user = userEvent.setup();
    renderWizard();
    await gotoConfigure(user);

    const invokeArn = 'arn:aws:iam::444455556666:role/citadel-invoke';
    const externalId = 'citadel-ext-12345';
    await user.type(screen.getByLabelText(/invoke role arn/i), invokeArn);
    await user.type(screen.getByLabelText(/external id/i), externalId);

    // the Step-4 Test connection must carry them so a cross-account target is
    // reachable before activation
    svc.testImportedAgent.mockResolvedValue(testOk);
    await user.click(screen.getByRole('button', { name: /test connection/i }));
    await waitFor(() => expect(svc.testImportedAgent).toHaveBeenCalledTimes(1));
    expect(svc.testImportedAgent.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        invocationRoleArn: invokeArn,
        invocationExternalId: externalId,
      }),
    );

    // …and the eventual import must carry them too
    await screen.findByText(/connection verified/i);
    await user.click(nextBtn());
    await screen.findByRole('button', { name: /register agent/i });

    svc.importAgent.mockResolvedValue(successResult);
    await user.click(screen.getByRole('button', { name: /register agent/i }));
    await waitFor(() => expect(svc.importAgent).toHaveBeenCalledTimes(1));
    expect(svc.importAgent.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        invocationRoleArn: invokeArn,
        invocationExternalId: externalId,
      }),
    );
  });

  it('omits invocationRoleArn + invocationExternalId (undefined) in BOTH inputs when left blank', async () => {
    const user = userEvent.setup();
    renderWizard();
    await gotoConfigure(user);

    svc.testImportedAgent.mockResolvedValue(testOk);
    await user.click(screen.getByRole('button', { name: /test connection/i }));
    await waitFor(() => expect(svc.testImportedAgent).toHaveBeenCalledTimes(1));
    expect(
      svc.testImportedAgent.mock.calls[0][0].invocationRoleArn,
    ).toBeUndefined();
    expect(
      svc.testImportedAgent.mock.calls[0][0].invocationExternalId,
    ).toBeUndefined();

    await screen.findByText(/connection verified/i);
    await user.click(nextBtn());
    await screen.findByRole('button', { name: /register agent/i });

    svc.importAgent.mockResolvedValue(successResult);
    await user.click(screen.getByRole('button', { name: /register agent/i }));
    await waitFor(() => expect(svc.importAgent).toHaveBeenCalledTimes(1));
    expect(svc.importAgent.mock.calls[0][0].invocationRoleArn).toBeUndefined();
    expect(
      svc.importAgent.mock.calls[0][0].invocationExternalId,
    ).toBeUndefined();
  });
});
