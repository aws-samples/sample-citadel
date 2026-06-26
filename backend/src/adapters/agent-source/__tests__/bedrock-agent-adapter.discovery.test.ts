/**
 * Discovery / describe / healthCheck tests for the Bedrock Agent adapter
 * (US-IMP-009). The control-plane @aws-sdk/client-bedrock-agent client is
 * injected as a fake — these tests never reach AWS.
 */
import { BedrockAgentAdapter } from '../bedrock-agent-adapter';
import { NotImplementedError } from '../not-implemented';

interface SentCommand {
  constructor: { name: string };
  input: Record<string, unknown>;
}

/** bedrock-agent control sender double dispatching on command class name. */
function bedrockSenderDouble(
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

function commandsOfKind(send: jest.Mock, kind: string): SentCommand[] {
  return send.mock.calls
    .map((c) => c[0] as SentCommand)
    .filter((c) => c.constructor.name === kind);
}

describe('BedrockAgentAdapter.discover (US-IMP-009)', () => {
  it('returns one candidate PER ALIAS (substrate bedrock_agent) and paginates agents + aliases', async () => {
    let agentsCall = 0;
    const agentPages: Record<string, unknown>[] = [
      { agentSummaries: [{ agentId: 'AG1', agentName: 'Bot1' }], nextToken: 'ag-p2' },
      { agentSummaries: [{ agentId: 'AG2', agentName: 'Bot2' }] },
    ];
    const aliasPages: Record<string, Record<string, unknown>[]> = {
      AG1: [
        { agentAliasSummaries: [{ agentAliasId: 'AL1', agentAliasName: 'prod' }], nextToken: 'al-p2' },
        { agentAliasSummaries: [{ agentAliasId: 'AL1b', agentAliasName: 'canary' }] },
      ],
      AG2: [{ agentAliasSummaries: [{ agentAliasId: 'AL2', agentAliasName: 'staging' }] }],
    };
    const aliasCall: Record<string, number> = { AG1: 0, AG2: 0 };
    const sender = bedrockSenderDouble({
      ListAgentsCommand: () => agentPages[agentsCall++],
      ListAgentAliasesCommand: (input) => {
        const id = String(input.agentId);
        return aliasPages[id][aliasCall[id]++];
      },
    });
    const adapter = new BedrockAgentAdapter({
      controlSender: sender,
      defaultRegion: 'us-east-1',
      defaultAccount: '123456789012',
    });

    const candidates = await adapter.discover({ region: 'us-east-1', account: '123456789012' });

    // One candidate per alias across both agents (drafts/bare agents are NOT emitted).
    expect(candidates.map((c) => c.reference)).toEqual(['AG1/AL1', 'AG1/AL1b', 'AG2/AL2']);
    expect(candidates[0].origin).toMatchObject({
      substrate: 'bedrock_agent',
      sourceArn: 'arn:aws:bedrock:us-east-1:123456789012:agent-alias/AG1/AL1',
      region: 'us-east-1',
      account: '123456789012',
      ownership: 'external',
    });
    expect(typeof candidates[0].origin.discoveredAt).toBe('string');
    // agents paginated once (2 pages); AG1 aliases paginated once (2 pages).
    expect(commandsOfKind(sender.send, 'ListAgentsCommand')).toHaveLength(2);
    expect(commandsOfKind(sender.send, 'ListAgentAliasesCommand')).toHaveLength(3);
  });

  it('tolerates an empty agent list', async () => {
    const sender = bedrockSenderDouble({ ListAgentsCommand: () => ({}) });
    const adapter = new BedrockAgentAdapter({ controlSender: sender });
    await expect(adapter.discover(undefined)).resolves.toEqual([]);
  });
});

describe('BedrockAgentAdapter.describe (US-IMP-009)', () => {
  const ALIAS_ARN = 'arn:aws:bedrock:us-east-1:123456789012:agent-alias/AGENT123/ALIAS1';
  const reqSchema = { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] };
  const resSchema = { type: 'object', properties: { tempC: { type: 'number' } } };
  const openApiDoc = {
    openapi: '3.0.0',
    info: { title: 'Weather', version: '1.0.0' },
    paths: {
      '/forecast': {
        post: {
          operationId: 'getForecast',
          requestBody: { content: { 'application/json': { schema: reqSchema } } },
          responses: { '200': { content: { 'application/json': { schema: resSchema } } } },
        },
      },
    },
  };

  function describeSender(
    overrides: Record<string, (i: Record<string, unknown>) => unknown> = {},
  ): { send: jest.Mock } {
    return bedrockSenderDouble({
      GetAgentCommand: () => ({
        agent: {
          agentId: 'AGENT123',
          agentName: 'WeatherBot',
          description: 'Forecasts weather',
          instruction: 'You forecast weather',
          agentVersion: 'DRAFT',
        },
      }),
      GetAgentAliasCommand: () => ({
        agentAlias: {
          agentAliasArn: ALIAS_ARN,
          agentAliasId: 'ALIAS1',
          routingConfiguration: [{ agentVersion: '3' }],
        },
      }),
      ListAgentActionGroupsCommand: () => ({
        actionGroupSummaries: [{ actionGroupId: 'AGRP1', actionGroupName: 'WeatherActions' }],
      }),
      GetAgentActionGroupCommand: () => ({
        agentActionGroup: {
          actionGroupName: 'WeatherActions',
          apiSchema: { payload: JSON.stringify(openApiDoc) },
        },
      }),
      ListAgentKnowledgeBasesCommand: () => ({
        agentKnowledgeBaseSummaries: [{ knowledgeBaseId: 'KB1', description: 'docs' }],
      }),
      ...overrides,
    });
  }

  it('builds a Tier-0 descriptor; action-group OpenAPI fills input/outputSchema at high confidence', async () => {
    const sender = describeSender();
    const adapter = new BedrockAgentAdapter({
      controlSender: sender,
      defaultRegion: 'us-east-1',
      defaultAccount: '123456789012',
    });

    const d = await adapter.describe('AGENT123/ALIAS1');

    expect(d.name).toBe('WeatherBot');
    expect(d.description).toBe('Forecasts weather');
    expect(d.version).toBe('3'); // served version from the alias routing config
    expect(d.skills).toContain('WeatherActions');
    expect(d.categories).toContain('KB1');
    expect(d.inputSchema).toEqual({ type: 'object', properties: { getForecast: reqSchema } });
    expect(d.outputSchema).toEqual({ type: 'object', properties: { getForecast: resSchema } });
    expect(d.fieldConfidence?.inputSchema).toBe('high');
    expect(d.fieldConfidence?.outputSchema).toBe('high');
    expect(d.fieldConfidence?.name).toBe('high');
    expect(d.origin).toMatchObject({ substrate: 'bedrock_agent', sourceArn: ALIAS_ARN, ownership: 'external' });

    // action-group enumeration used the alias-served version.
    expect(commandsOfKind(sender.send, 'ListAgentActionGroupsCommand')[0].input.agentVersion).toBe('3');
  });

  it('emits invocation.target as agentId/aliasId — consistent with invoke()\'s parsing', async () => {
    const adapter = new BedrockAgentAdapter({
      controlSender: describeSender(),
      defaultRegion: 'us-east-1',
      defaultAccount: '123456789012',
    });

    const d = await adapter.describe('AGENT123/ALIAS1');

    expect(d.invocation).toMatchObject({
      protocol: 'BEDROCK_AGENT',
      target: 'AGENT123/ALIAS1',
      auth: { mode: 'SIGV4' },
      mode: 'sync',
      region: 'us-east-1',
      account: '123456789012',
    });
    // Re-run the exact parse invoke() performs on the target.
    const target = d.invocation.target;
    const slash = target.indexOf('/');
    expect(target.slice(0, slash)).toBe('AGENT123');
    expect(target.slice(slash + 1)).toBe('ALIAS1');
  });

  it('maps action-group functionSchema parameters into inputSchema', async () => {
    const sender = describeSender({
      GetAgentActionGroupCommand: () => ({
        agentActionGroup: {
          actionGroupName: 'MathActions',
          functionSchema: {
            functions: [
              {
                name: 'add',
                description: 'adds two numbers',
                parameters: {
                  a: { type: 'number', required: true, description: 'first' },
                  b: { type: 'number' },
                },
              },
            ],
          },
        },
      }),
    });
    const adapter = new BedrockAgentAdapter({ controlSender: sender, defaultRegion: 'us-east-1' });

    const d = await adapter.describe('AGENT123/ALIAS1');

    expect(d.skills).toContain('MathActions');
    expect(d.inputSchema).toEqual({
      type: 'object',
      properties: {
        add: {
          type: 'object',
          properties: { a: { type: 'number', description: 'first' }, b: { type: 'number' } },
          required: ['a'],
        },
      },
    });
    expect(d.outputSchema).toEqual({});
  });
});

describe('BedrockAgentAdapter.healthCheck (US-IMP-009)', () => {
  const REF = 'AGENT123/ALIAS1';

  it('returns reachable:true when GetAgentAlias succeeds', async () => {
    const sender = bedrockSenderDouble({
      GetAgentAliasCommand: () => ({ agentAlias: { agentAliasId: 'ALIAS1' } }),
    });
    const adapter = new BedrockAgentAdapter({ controlSender: sender });
    await expect(adapter.healthCheck(REF)).resolves.toEqual({ reachable: true });
  });

  it('returns reachable:false on ResourceNotFoundException WITHOUT throwing', async () => {
    const sender = { send: jest.fn(() => Promise.reject(rnf('Alias not found'))) };
    const adapter = new BedrockAgentAdapter({ controlSender: sender });
    const res = await adapter.healthCheck(REF);
    expect(res.reachable).toBe(false);
    expect(res.detail).toContain('not found');
  });

  it('rethrows non-ResourceNotFound errors', async () => {
    const denied = new Error('denied');
    denied.name = 'AccessDeniedException';
    const sender = { send: jest.fn(() => Promise.reject(denied)) };
    const adapter = new BedrockAgentAdapter({ controlSender: sender });
    await expect(adapter.healthCheck(REF)).rejects.toThrow('denied');
  });
});

describe('BedrockAgentAdapter.vendCredentials (still a stub)', () => {
  it('throws NotImplementedError', async () => {
    const adapter = new BedrockAgentAdapter();
    await expect(adapter.vendCredentials('AGENT123/ALIAS1')).rejects.toBeInstanceOf(
      NotImplementedError,
    );
  });
});
