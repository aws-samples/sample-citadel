/**
 * Discovery / describe / healthCheck tests for the Lambda adapter
 * (US-IMP-010). The LambdaClient is injected as a fake — no AWS calls.
 */
import { LambdaInvokeAdapter } from '../lambda-invoke-adapter';
import { NotImplementedError } from '../not-implemented';

interface SentCommand {
  constructor: { name: string };
  input: Record<string, unknown>;
}

/** LambdaClient send() double that dispatches on command class name. */
function lambdaSenderDouble(
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

const FN_ARN = 'arn:aws:lambda:us-east-1:123456789012:function:my-agent';

describe('LambdaInvokeAdapter.discover (US-IMP-010)', () => {
  it('maps each function ARN to a candidate with substrate lambda and paginates', async () => {
    const pages: Record<string, unknown>[] = [
      { Functions: [{ FunctionName: 'my-agent', FunctionArn: FN_ARN }], NextMarker: 'm2' },
      {
        Functions: [
          {
            FunctionName: 'other',
            FunctionArn: 'arn:aws:lambda:us-east-1:123456789012:function:other',
          },
        ],
      },
    ];
    let call = 0;
    const sender = lambdaSenderDouble({ ListFunctionsCommand: () => pages[call++] });
    const adapter = new LambdaInvokeAdapter(undefined, { controlSender: sender });

    const candidates = await adapter.discover({ region: 'us-east-1' });

    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toMatchObject({
      displayName: 'my-agent',
      reference: FN_ARN,
      origin: {
        sourceArn: FN_ARN,
        substrate: 'lambda',
        region: 'us-east-1',
        account: '123456789012',
        ownership: 'external',
      },
    });
    expect(sender.send).toHaveBeenCalledTimes(2);
  });

  it('filters by tag when scope.tagKey/tagValue are provided', async () => {
    const sender = lambdaSenderDouble({
      ListFunctionsCommand: () => ({
        Functions: [
          {
            FunctionName: 'keep',
            FunctionArn: 'arn:aws:lambda:us-east-1:123456789012:function:keep',
          },
          {
            FunctionName: 'drop',
            FunctionArn: 'arn:aws:lambda:us-east-1:123456789012:function:drop',
          },
        ],
      }),
      ListTagsCommand: (input) => ({
        Tags: String(input.Resource).endsWith('keep')
          ? { team: 'agents' }
          : { team: 'other' },
      }),
    });
    const adapter = new LambdaInvokeAdapter(undefined, { controlSender: sender });

    const candidates = await adapter.discover({ tagKey: 'team', tagValue: 'agents' });

    expect(candidates.map((c) => c.displayName)).toEqual(['keep']);
  });
});

describe('LambdaInvokeAdapter.describe (US-IMP-010)', () => {
  function describeSender(
    overrides: Record<string, (i: Record<string, unknown>) => unknown> = {},
  ): { send: jest.Mock } {
    return lambdaSenderDouble({
      GetFunctionConfigurationCommand: () => ({
        FunctionName: 'my-agent',
        FunctionArn: FN_ARN,
        Description: 'An agent fn',
        Timeout: 15,
        Version: '$LATEST',
      }),
      ListTagsCommand: () => ({ Tags: {} }),
      GetPolicyCommand: () => {
        throw rnf('no resource policy');
      },
      ListFunctionUrlConfigsCommand: () => ({ FunctionUrlConfigs: [] }),
      ListEventSourceMappingsCommand: () => ({ EventSourceMappings: [] }),
      ...overrides,
    });
  }

  it('defaults mode to sync, builds a SIGV4 invocation, and pulls config+tags+policy+urlconfigs', async () => {
    const sender = describeSender();
    const adapter = new LambdaInvokeAdapter(undefined, { controlSender: sender });

    const d = await adapter.describe(FN_ARN);

    expect(d.invocation).toMatchObject({
      protocol: 'LAMBDA_INVOKE',
      target: FN_ARN,
      auth: { mode: 'SIGV4' },
      mode: 'sync',
      region: 'us-east-1',
      account: '123456789012',
    });
    expect(d.origin.substrate).toBe('lambda');
    expect(d.inputSchema).toEqual({});
    expect(d.fieldConfidence?.name).toBe('medium');

    const kinds = sender.send.mock.calls.map(
      (c) => (c[0] as SentCommand).constructor.name,
    );
    expect(kinds).toEqual(
      expect.arrayContaining([
        'GetFunctionConfigurationCommand',
        'ListTagsCommand',
        'GetPolicyCommand',
        'ListFunctionUrlConfigsCommand',
      ]),
    );
  });

  it('infers async_callback when Timeout >= 60s', async () => {
    const sender = describeSender({
      GetFunctionConfigurationCommand: () => ({
        FunctionName: 'my-agent',
        FunctionArn: FN_ARN,
        Timeout: 120,
      }),
    });
    const adapter = new LambdaInvokeAdapter(undefined, { controlSender: sender });
    const d = await adapter.describe(FN_ARN);
    expect(d.invocation.mode).toBe('async_callback');
  });

  it('infers async_callback when an event-source mapping (async trigger) exists', async () => {
    const sender = describeSender({
      ListEventSourceMappingsCommand: () => ({ EventSourceMappings: [{ UUID: 'esm-1' }] }),
    });
    const adapter = new LambdaInvokeAdapter(undefined, { controlSender: sender });
    const d = await adapter.describe(FN_ARN);
    expect(d.invocation.mode).toBe('async_callback');
  });

  it('prefers tag-derived name/description (low confidence) over config', async () => {
    const sender = describeSender({
      ListTagsCommand: () => ({
        Tags: { Name: 'Tagged Agent', Description: 'Tagged desc', Category: 'a,b' },
      }),
    });
    const adapter = new LambdaInvokeAdapter(undefined, { controlSender: sender });
    const d = await adapter.describe(FN_ARN);
    expect(d.name).toBe('Tagged Agent');
    expect(d.description).toBe('Tagged desc');
    expect(d.categories).toEqual(['a', 'b']);
    expect(d.fieldConfidence?.name).toBe('low');
  });
});

describe('LambdaInvokeAdapter.healthCheck (US-IMP-010)', () => {
  it('returns reachable:true when GetFunctionConfiguration succeeds', async () => {
    const sender = lambdaSenderDouble({
      GetFunctionConfigurationCommand: () => ({ FunctionArn: FN_ARN }),
    });
    const adapter = new LambdaInvokeAdapter(undefined, { controlSender: sender });
    await expect(adapter.healthCheck(FN_ARN)).resolves.toEqual({ reachable: true });
  });

  it('returns reachable:false on ResourceNotFoundException WITHOUT throwing', async () => {
    const sender = { send: jest.fn(() => Promise.reject(rnf('Function not found'))) };
    const adapter = new LambdaInvokeAdapter(undefined, { controlSender: sender });

    await expect(adapter.healthCheck(FN_ARN)).resolves.toEqual({
      reachable: false,
      detail: 'Function not found',
    });
  });
});

describe('LambdaInvokeAdapter.vendCredentials (still a stub)', () => {
  it('throws NotImplementedError', async () => {
    const adapter = new LambdaInvokeAdapter(undefined, {
      controlSender: { send: jest.fn() },
    });
    await expect(adapter.vendCredentials(FN_ARN)).rejects.toBeInstanceOf(
      NotImplementedError,
    );
  });
});
