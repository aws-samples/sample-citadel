/**
 * Discovery / describe / healthCheck tests for the AgentCore Runtime adapter
 * (US-IMP-008). The control-plane client and RegistryService are injected as
 * fakes — these tests never reach AWS.
 */
import { AgentCoreRuntimeAdapter } from '../agentcore-runtime-adapter';
import { NotImplementedError } from '../not-implemented';

interface SentCommand {
  constructor: { name: string };
  input: Record<string, unknown>;
}

/** Control-plane sender double whose send() dispatches on command class name. */
function controlSenderDouble(
  handlers: Record<string, (input: Record<string, unknown>) => unknown>,
): { send: jest.Mock } {
  const send = jest.fn((command: unknown) => {
    const c = command as SentCommand;
    const kind = c.constructor.name;
    const handler = handlers[kind];
    if (!handler) return Promise.reject(new Error(`unexpected command: ${kind}`));
    return Promise.resolve(handler(c.input));
  });
  return { send };
}

function rnf(message: string): Error {
  const e = new Error(message);
  e.name = 'ResourceNotFoundException';
  return e;
}

const RUNTIME_ARN =
  'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/agent-abc123';

describe('AgentCoreRuntimeAdapter.discover (US-IMP-008)', () => {
  it('maps each runtime ARN to a candidate with substrate agentcore_runtime and paginates', async () => {
    const pages: Record<string, unknown>[] = [
      {
        agentRuntimes: [
          {
            agentRuntimeArn: RUNTIME_ARN,
            agentRuntimeId: 'agent-abc123',
            agentRuntimeName: 'support-bot',
          },
        ],
        nextToken: 'page-2',
      },
      {
        agentRuntimes: [
          {
            agentRuntimeArn:
              'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/agent-def456',
            agentRuntimeId: 'agent-def456',
            agentRuntimeName: 'triage-bot',
          },
        ],
      },
    ];
    let call = 0;
    const sender = controlSenderDouble({
      ListAgentRuntimesCommand: () => pages[call++],
    });
    const adapter = new AgentCoreRuntimeAdapter(undefined, { controlSender: sender });

    const candidates = await adapter.discover({ region: 'us-east-1' });

    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toMatchObject({
      displayName: 'support-bot',
      reference: RUNTIME_ARN,
      origin: {
        sourceArn: RUNTIME_ARN,
        substrate: 'agentcore_runtime',
        region: 'us-east-1',
        account: '123456789012',
        ownership: 'external',
      },
    });
    expect(typeof candidates[0].origin.discoveredAt).toBe('string');
    expect(candidates[1].reference).toContain('agent-def456');
    // paginated -> two ListAgentRuntimes calls (followed nextToken once).
    expect(sender.send).toHaveBeenCalledTimes(2);
  });

  it('tolerates an empty runtime list', async () => {
    const sender = controlSenderDouble({ ListAgentRuntimesCommand: () => ({}) });
    const adapter = new AgentCoreRuntimeAdapter(undefined, { controlSender: sender });
    await expect(adapter.discover(undefined)).resolves.toEqual([]);
  });
});

describe('AgentCoreRuntimeAdapter.describe (US-IMP-008)', () => {
  it('builds a descriptor with self-described fields at high confidence and a SIGV4 sync invocation', async () => {
    const sender = controlSenderDouble({
      GetAgentRuntimeCommand: () => ({
        agentRuntimeArn: RUNTIME_ARN,
        agentRuntimeName: 'support-bot',
        agentRuntimeId: 'agent-abc123',
        agentRuntimeVersion: '3',
        description: 'Customer support runtime',
        status: 'READY',
      }),
    });
    const adapter = new AgentCoreRuntimeAdapter(undefined, { controlSender: sender });

    const d = await adapter.describe(RUNTIME_ARN);

    // The runtime id was parsed from the ARN for the Get call.
    const getCall = sender.send.mock.calls[0][0] as SentCommand;
    expect(getCall.input.agentRuntimeId).toBe('agent-abc123');

    expect(d.name).toBe('support-bot');
    expect(d.description).toBe('Customer support runtime');
    expect(d.version).toBe('3');
    expect(d.invocation).toEqual({
      protocol: 'AGENTCORE_RUNTIME',
      target: RUNTIME_ARN,
      auth: { mode: 'SIGV4' },
      mode: 'sync',
      region: 'us-east-1',
      account: '123456789012',
    });
    expect(d.origin.substrate).toBe('agentcore_runtime');
    expect(d.origin.ownership).toBe('external');
    expect(d.inputSchema).toEqual({});
    expect(d.outputSchema).toEqual({});
    expect(d.fieldConfidence?.name).toBe('high');
    expect(d.fieldConfidence?.description).toBe('high');
    expect(d.fieldConfidence?.version).toBe('high');
  });

  it('enriches skills/categories/schemas from the Registry manifest when the runtime is registered', async () => {
    const sender = controlSenderDouble({
      GetAgentRuntimeCommand: () => ({
        agentRuntimeArn: RUNTIME_ARN,
        agentRuntimeName: 'support-bot',
        agentRuntimeId: 'agent-abc123',
        agentRuntimeVersion: '1',
      }),
    });
    const registry = {
      listResources: jest.fn(async () => [
        {
          recordId: 'rec1',
          name: 'support-bot',
          status: 'APPROVED',
          customDescriptorContent: JSON.stringify({
            manifest: {
              description: 'From manifest',
              version: '9.9.9',
              skills: ['answer', 'escalate'],
              categories: ['support'],
              inputSchema: { type: 'object' },
            },
          }),
        },
      ]),
      deserializeCustomMetadata: (
        json: string | null | undefined,
        defaults: Record<string, unknown>,
      ) => (json ? { ...defaults, ...JSON.parse(json) } : defaults),
    };
    const adapter = new AgentCoreRuntimeAdapter(undefined, {
      controlSender: sender,
      registry,
    });

    const d = await adapter.describe(RUNTIME_ARN);

    expect(registry.listResources).toHaveBeenCalledWith('agent');
    expect(d.description).toBe('From manifest');
    expect(d.version).toBe('9.9.9');
    expect(d.skills).toEqual(['answer', 'escalate']);
    expect(d.categories).toEqual(['support']);
    expect(d.inputSchema).toEqual({ type: 'object' });
  });

  it('does not fail describe when the registry lookup throws', async () => {
    const sender = controlSenderDouble({
      GetAgentRuntimeCommand: () => ({
        agentRuntimeArn: RUNTIME_ARN,
        agentRuntimeName: 'support-bot',
      }),
    });
    const registry = {
      listResources: jest.fn(async () => {
        throw new Error('registry down');
      }),
      deserializeCustomMetadata: (_j: string | null | undefined, d: unknown) => d,
    };
    const adapter = new AgentCoreRuntimeAdapter(undefined, {
      controlSender: sender,
      registry,
    });

    const d = await adapter.describe(RUNTIME_ARN);
    expect(d.name).toBe('support-bot');
    expect(d.skills).toEqual([]);
  });
});

describe('AgentCoreRuntimeAdapter.healthCheck (US-IMP-008)', () => {
  it('returns reachable:true when GetAgentRuntime succeeds', async () => {
    const sender = controlSenderDouble({
      GetAgentRuntimeCommand: () => ({ agentRuntimeArn: RUNTIME_ARN, status: 'READY' }),
    });
    const adapter = new AgentCoreRuntimeAdapter(undefined, { controlSender: sender });
    await expect(adapter.healthCheck(RUNTIME_ARN)).resolves.toEqual({ reachable: true });
  });

  it('returns reachable:false on ResourceNotFoundException WITHOUT throwing', async () => {
    const sender = { send: jest.fn(() => Promise.reject(rnf('Runtime not found'))) };
    const adapter = new AgentCoreRuntimeAdapter(undefined, { controlSender: sender });

    const res = await adapter.healthCheck(RUNTIME_ARN);
    expect(res.reachable).toBe(false);
    expect(res.detail).toContain('not found');
  });

  it('rethrows non-ResourceNotFound errors', async () => {
    const denied = new Error('denied');
    denied.name = 'AccessDeniedException';
    const sender = { send: jest.fn(() => Promise.reject(denied)) };
    const adapter = new AgentCoreRuntimeAdapter(undefined, { controlSender: sender });
    await expect(adapter.healthCheck(RUNTIME_ARN)).rejects.toThrow('denied');
  });
});

describe('AgentCoreRuntimeAdapter.vendCredentials (still a stub)', () => {
  it('throws NotImplementedError', async () => {
    const adapter = new AgentCoreRuntimeAdapter(undefined, {
      controlSender: { send: jest.fn() },
    });
    await expect(adapter.vendCredentials(RUNTIME_ARN)).rejects.toBeInstanceOf(
      NotImplementedError,
    );
  });
});
