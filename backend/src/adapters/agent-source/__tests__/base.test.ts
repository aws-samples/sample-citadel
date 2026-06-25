/**
 * Tests for the AgentSourceAdapter interface + protocol registry (US-IMP-002).
 *
 * Uses a FakeAdapter test double to exercise the registry's register/resolve/
 * has contract and the typed UnknownProtocolError. Mirrors the unified
 * connector-registry test style.
 */
import {
  AgentSourceAdapterRegistry,
  UnknownProtocolError,
  type AgentSourceAdapter,
  type AgentCandidate,
  type AgentCapabilityDescriptor,
  type HealthCheckResult,
  type VendedCredentials,
  type InvokeRequest,
  type InvokeResponse,
  type AgentInvocationProtocol,
} from '../base';

/**
 * Minimal in-memory adapter double. Builds its capability descriptor from its
 * own protocol so describe() output can be asserted against the registration.
 */
class FakeAdapter implements AgentSourceAdapter {
  public readonly protocol: AgentInvocationProtocol;
  public discoverCalls = 0;

  constructor(protocol: AgentInvocationProtocol) {
    this.protocol = protocol;
  }

  async discover(_scope: unknown): Promise<AgentCandidate[]> {
    this.discoverCalls += 1;
    return [
      {
        origin: {
          substrate: 'fake',
          discoveredAt: '2026-06-25T00:00:00.000Z',
          ownership: 'external',
        },
        displayName: `fake-${this.protocol}`,
        reference: `ref-${this.protocol}`,
      },
    ];
  }

  async describe(_ref: AgentCandidate | string): Promise<AgentCapabilityDescriptor> {
    return {
      name: 'fake',
      description: 'fake agent',
      version: '1.0.0',
      skills: [],
      categories: [],
      inputSchema: {},
      outputSchema: {},
      invocation: {
        protocol: this.protocol,
        target: 'fake-target',
        auth: { mode: 'NONE' },
        mode: 'sync',
      },
      origin: {
        substrate: 'fake',
        discoveredAt: '2026-06-25T00:00:00.000Z',
        ownership: 'external',
      },
      fieldConfidence: { name: 'high' },
    };
  }

  async healthCheck(_ref: AgentCandidate | string): Promise<HealthCheckResult> {
    return { reachable: true };
  }

  async vendCredentials(_ref: AgentCandidate | string): Promise<VendedCredentials> {
    return { roleArn: 'arn:aws:iam::123456789012:role/fake' };
  }

  async invoke(
    req: InvokeRequest,
    _descriptor: AgentCapabilityDescriptor,
  ): Promise<InvokeResponse> {
    return { output: `echo:${req.prompt}` };
  }
}

describe('AgentSourceAdapterRegistry (US-IMP-002)', () => {
  let registry: AgentSourceAdapterRegistry;

  beforeEach(() => {
    registry = new AgentSourceAdapterRegistry();
  });

  it('resolve() returns the exact instance that was registered', () => {
    const adapter = new FakeAdapter('LAMBDA_INVOKE');
    registry.register(adapter);
    expect(registry.resolve('LAMBDA_INVOKE')).toBe(adapter);
  });

  it('has() reflects registration state', () => {
    expect(registry.has('MCP')).toBe(false);
    registry.register(new FakeAdapter('MCP'));
    expect(registry.has('MCP')).toBe(true);
  });

  it('resolve() throws a typed UnknownProtocolError for an unregistered protocol', () => {
    expect(() => registry.resolve('A2A')).toThrow(UnknownProtocolError);

    let caught: unknown;
    try {
      registry.resolve('A2A');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UnknownProtocolError);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as UnknownProtocolError).protocol).toBe('A2A');
  });

  it('UnknownProtocolError has the expected name', () => {
    const err = new UnknownProtocolError('SQS_ASYNC');
    expect(err.name).toBe('UnknownProtocolError');
    expect(err.message).toContain('SQS_ASYNC');
  });

  it('register() replaces a prior adapter for the same protocol', () => {
    const first = new FakeAdapter('HTTP_ENDPOINT');
    const second = new FakeAdapter('HTTP_ENDPOINT');
    registry.register(first);
    registry.register(second);
    expect(registry.resolve('HTTP_ENDPOINT')).toBe(second);
  });

  it('exposes the full AgentSourceAdapter surface through the registry', async () => {
    const adapter = new FakeAdapter('AGENTCORE_RUNTIME');
    registry.register(adapter);
    const resolved = registry.resolve('AGENTCORE_RUNTIME');

    const candidates = await resolved.discover(undefined);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].origin.ownership).toBe('external');

    const descriptor = await resolved.describe('ref');
    expect(descriptor.invocation.protocol).toBe('AGENTCORE_RUNTIME');

    expect(await resolved.healthCheck('ref')).toEqual({ reachable: true });
    expect((await resolved.vendCredentials('ref')).roleArn).toContain('role/fake');

    const response = await resolved.invoke({ prompt: 'hi' }, descriptor);
    expect(response.output).toBe('echo:hi');
  });
});
