/**
 * Discovery / describe / healthCheck tests for the ECS source adapter
 * (US-IMP-018). ECS is a DISCOVERY SUBSTRATE: discover/describe/healthCheck are
 * ECS-specific (they resolve the service's HTTP endpoint), but the resulting
 * candidate's INVOCATION protocol is HTTP_ENDPOINT — invoke/test flow through
 * the existing HTTP adapter, so this adapter's invoke()/vendCredentials() are
 * NotImplemented stubs. The ECS + ELBv2 clients and global fetch are injected as
 * fakes — there are NO live AWS calls and NO live network.
 */
import { EcsSourceAdapter } from '../ecs-source-adapter';
import { NotImplementedError } from '../not-implemented';
import type { AgentInvocationBlock } from '../base';

interface SentCommand {
  constructor: { name: string };
  input: Record<string, unknown>;
}

/** AWS SDK client send() double that dispatches on the command class name. */
function senderDouble(
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

const asFetch = (fn: jest.Mock): typeof fetch => fn as unknown as typeof fetch;

const CLUSTER_ARN = 'arn:aws:ecs:us-east-1:123456789012:cluster/my-cluster';
const SERVICE_ARN = 'arn:aws:ecs:us-east-1:123456789012:service/my-cluster/my-agent-svc';
const TASKDEF_ARN = 'arn:aws:ecs:us-east-1:123456789012:task-definition/my-agent:7';
const TG_ARN = 'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/my-tg/abc123';
const LB_ARN = 'arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/my-alb/def456';
const LB_DNS = 'my-alb-123456.us-east-1.elb.amazonaws.com';

// ---------------------------------------------------------------------------
// discover
// ---------------------------------------------------------------------------

describe('EcsSourceAdapter.discover (US-IMP-018)', () => {
  it('lists clusters -> services -> describeServices and maps each service to an ecs candidate', async () => {
    const ecsSender = senderDouble({
      ListClustersCommand: () => ({ clusterArns: [CLUSTER_ARN] }),
      ListServicesCommand: () => ({ serviceArns: [SERVICE_ARN] }),
      DescribeServicesCommand: () => ({
        services: [{ serviceArn: SERVICE_ARN, serviceName: 'my-agent-svc' }],
      }),
    });
    const adapter = new EcsSourceAdapter({ ecsSender });

    const candidates = await adapter.discover({ region: 'us-east-1' });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      displayName: 'my-agent-svc',
      reference: SERVICE_ARN,
      origin: {
        sourceArn: SERVICE_ARN,
        substrate: 'ecs',
        region: 'us-east-1',
        account: '123456789012',
        ownership: 'external',
      },
    });
    expect(typeof candidates[0].origin.discoveredAt).toBe('string');
  });

  it('paginates clusters (nextToken) and services across pages', async () => {
    const clusterPages: Record<string, unknown>[] = [
      { clusterArns: [CLUSTER_ARN], nextToken: 'c2' },
      { clusterArns: ['arn:aws:ecs:us-east-1:123456789012:cluster/other'] },
    ];
    const servicePages: Record<string, unknown>[] = [
      { serviceArns: [SERVICE_ARN], nextToken: 's2' },
      { serviceArns: ['arn:aws:ecs:us-east-1:123456789012:service/my-cluster/svc-2'] },
    ];
    let clusterCall = 0;
    let serviceCall = 0;
    const ecsSender = senderDouble({
      ListClustersCommand: () => clusterPages[clusterCall++],
      // Only the first cluster has (paginated) services; the second has none.
      ListServicesCommand: (input) =>
        input.cluster === CLUSTER_ARN
          ? servicePages[serviceCall++]
          : { serviceArns: [] },
      DescribeServicesCommand: (input) => ({
        services: (input.services as string[]).map((arn) => ({
          serviceArn: arn,
          serviceName: String(arn).split('/').pop(),
        })),
      }),
    });
    const adapter = new EcsSourceAdapter({ ecsSender });

    const candidates = await adapter.discover({ region: 'us-east-1' });

    expect(candidates.map((c) => c.reference)).toEqual([
      SERVICE_ARN,
      'arn:aws:ecs:us-east-1:123456789012:service/my-cluster/svc-2',
    ]);
    expect(candidates.every((c) => c.origin.substrate === 'ecs')).toBe(true);
  });

  it('filters by scope.tagKey/tagValue using the service TAGS', async () => {
    const ecsSender = senderDouble({
      ListClustersCommand: () => ({ clusterArns: [CLUSTER_ARN] }),
      ListServicesCommand: () => ({
        serviceArns: [
          SERVICE_ARN,
          'arn:aws:ecs:us-east-1:123456789012:service/my-cluster/drop-svc',
        ],
      }),
      DescribeServicesCommand: (input) => ({
        services: (input.services as string[]).map((arn) => ({
          serviceArn: arn,
          serviceName: String(arn).split('/').pop(),
          tags: String(arn).endsWith('my-agent-svc')
            ? [{ key: 'citadel:agent', value: 'true' }]
            : [{ key: 'team', value: 'other' }],
        })),
      }),
    });
    const adapter = new EcsSourceAdapter({ ecsSender });

    const candidates = await adapter.discover({
      region: 'us-east-1',
      tagKey: 'citadel:agent',
      tagValue: 'true',
    });

    expect(candidates.map((c) => c.displayName)).toEqual(['my-agent-svc']);
  });

  it('returns [] when there are no clusters', async () => {
    const ecsSender = senderDouble({ ListClustersCommand: () => ({ clusterArns: [] }) });
    const adapter = new EcsSourceAdapter({ ecsSender });
    await expect(adapter.discover({ region: 'us-east-1' })).resolves.toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// describe
// ---------------------------------------------------------------------------

describe('EcsSourceAdapter.describe (US-IMP-018)', () => {
  const taskDef = {
    taskDefinition: {
      family: 'my-agent',
      revision: 7,
      containerDefinitions: [
        {
          name: 'web',
          image: '123.dkr.ecr.us-east-1.amazonaws.com/my-agent:1.2',
          portMappings: [{ containerPort: 8080, protocol: 'tcp' }],
          environment: [{ name: 'STAGE', value: 'prod' }],
        },
      ],
    },
  };

  it('builds a low-confidence Tier-1 descriptor and resolves the endpoint from the load balancer', async () => {
    const ecsSender = senderDouble({
      DescribeServicesCommand: () => ({
        services: [
          {
            serviceArn: SERVICE_ARN,
            serviceName: 'my-agent-svc',
            taskDefinition: TASKDEF_ARN,
            loadBalancers: [{ targetGroupArn: TG_ARN, containerName: 'web', containerPort: 8080 }],
            tags: [],
          },
        ],
      }),
      DescribeTaskDefinitionCommand: () => taskDef,
    });
    const elbSender = senderDouble({
      DescribeTargetGroupsCommand: () => ({
        TargetGroups: [{ LoadBalancerArns: [LB_ARN], Port: 443, Protocol: 'HTTPS' }],
      }),
      DescribeLoadBalancersCommand: () => ({
        LoadBalancers: [{ DNSName: LB_DNS, Scheme: 'internet-facing' }],
      }),
    });
    const adapter = new EcsSourceAdapter({ ecsSender, elbSender });

    const d = await adapter.describe(SERVICE_ARN);

    expect(d.name).toBe('my-agent-svc');
    expect(d.invocation).toMatchObject({
      protocol: 'HTTP_ENDPOINT',
      target: `https://${LB_DNS}`,
      auth: { mode: 'NONE' },
      mode: 'sync',
      region: 'us-east-1',
      account: '123456789012',
    });
    expect(d.origin).toMatchObject({ substrate: 'ecs', sourceArn: SERVICE_ARN });
    // Tier-1 facts inferred from the task definition appear in the description.
    expect(d.description).toContain('my-agent:1.2');
    expect(d.description).toContain('8080');
    // Inferred fields are low confidence.
    expect(d.fieldConfidence?.name).toBe('low');
    expect(d.version).toBe('7');
  });

  it('builds http://<dns>:<port> when the target group is HTTP on a non-default port', async () => {
    const ecsSender = senderDouble({
      DescribeServicesCommand: () => ({
        services: [
          {
            serviceArn: SERVICE_ARN,
            serviceName: 'my-agent-svc',
            taskDefinition: TASKDEF_ARN,
            loadBalancers: [{ targetGroupArn: TG_ARN }],
            tags: [],
          },
        ],
      }),
      DescribeTaskDefinitionCommand: () => taskDef,
    });
    const elbSender = senderDouble({
      DescribeTargetGroupsCommand: () => ({
        TargetGroups: [{ LoadBalancerArns: [LB_ARN], Port: 8080, Protocol: 'HTTP' }],
      }),
      DescribeLoadBalancersCommand: () => ({ LoadBalancers: [{ DNSName: LB_DNS }] }),
    });
    const adapter = new EcsSourceAdapter({ ecsSender, elbSender });

    const d = await adapter.describe(SERVICE_ARN);

    expect(d.invocation.target).toBe(`http://${LB_DNS}:8080`);
  });

  it('falls back to the citadel:endpoint tag when the service has no load balancer', async () => {
    const ecsSender = senderDouble({
      DescribeServicesCommand: () => ({
        services: [
          {
            serviceArn: SERVICE_ARN,
            serviceName: 'my-agent-svc',
            taskDefinition: TASKDEF_ARN,
            loadBalancers: [],
            tags: [{ key: 'citadel:endpoint', value: 'https://agent.example.com/run' }],
          },
        ],
      }),
      DescribeTaskDefinitionCommand: () => taskDef,
    });
    // No ELB calls expected — an elbSender that throws proves it isn't reached.
    const elbSender = senderDouble({});
    const adapter = new EcsSourceAdapter({ ecsSender, elbSender });

    const d = await adapter.describe(SERVICE_ARN);

    expect(d.invocation.target).toBe('https://agent.example.com/run');
    expect(d.invocation.protocol).toBe('HTTP_ENDPOINT');
  });

  it('leaves the endpoint empty and adds an operator note when nothing resolves', async () => {
    const ecsSender = senderDouble({
      DescribeServicesCommand: () => ({
        services: [
          {
            serviceArn: SERVICE_ARN,
            serviceName: 'my-agent-svc',
            taskDefinition: TASKDEF_ARN,
            loadBalancers: [],
            tags: [],
          },
        ],
      }),
      DescribeTaskDefinitionCommand: () => taskDef,
    });
    const adapter = new EcsSourceAdapter({ ecsSender });

    const d = await adapter.describe(SERVICE_ARN);

    expect(d.invocation.target).toBe('');
    expect(d.invocation.protocol).toBe('HTTP_ENDPOINT');
    expect(d.description.toLowerCase()).toContain('endpoint');
  });
});

// ---------------------------------------------------------------------------
// healthCheck
// ---------------------------------------------------------------------------

describe('EcsSourceAdapter.healthCheck (US-IMP-018)', () => {
  function lbEcsSender(): { send: jest.Mock } {
    return senderDouble({
      DescribeServicesCommand: () => ({
        services: [
          {
            serviceArn: SERVICE_ARN,
            serviceName: 'my-agent-svc',
            loadBalancers: [{ targetGroupArn: TG_ARN }],
            tags: [],
          },
        ],
      }),
    });
  }
  function lbElbSender(): { send: jest.Mock } {
    return senderDouble({
      DescribeTargetGroupsCommand: () => ({
        TargetGroups: [{ LoadBalancerArns: [LB_ARN], Port: 443, Protocol: 'HTTPS' }],
      }),
      DescribeLoadBalancersCommand: () => ({ LoadBalancers: [{ DNSName: LB_DNS }] }),
    });
  }

  it('probes the resolved endpoint and returns reachable:true on a 2xx', async () => {
    const fetchFn = jest.fn(async () => ({ ok: true, status: 200 }));
    const adapter = new EcsSourceAdapter({
      ecsSender: lbEcsSender(),
      elbSender: lbElbSender(),
      fetchFn: asFetch(fetchFn),
    });
    await expect(adapter.healthCheck(SERVICE_ARN)).resolves.toEqual({ reachable: true });
    expect(String(fetchFn.mock.calls[0][0])).toBe(`https://${LB_DNS}`);
  });

  it('returns reachable:false (with detail) on a non-2xx WITHOUT throwing', async () => {
    const fetchFn = jest.fn(async () => ({ ok: false, status: 503 }));
    const adapter = new EcsSourceAdapter({
      ecsSender: lbEcsSender(),
      elbSender: lbElbSender(),
      fetchFn: asFetch(fetchFn),
    });
    const res = await adapter.healthCheck(SERVICE_ARN);
    expect(res.reachable).toBe(false);
    expect(res.detail).toContain('503');
  });

  it('returns reachable:false with a clear detail when no endpoint resolves', async () => {
    const ecsSender = senderDouble({
      DescribeServicesCommand: () => ({
        services: [{ serviceArn: SERVICE_ARN, serviceName: 'my-agent-svc', loadBalancers: [], tags: [] }],
      }),
    });
    const fetchFn = jest.fn();
    const adapter = new EcsSourceAdapter({ ecsSender, fetchFn: asFetch(fetchFn) });

    await expect(adapter.healthCheck(SERVICE_ARN)).resolves.toEqual({
      reachable: false,
      detail: 'no endpoint resolved',
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// invoke / vendCredentials — NotImplemented (ECS invokes via HTTP_ENDPOINT)
// ---------------------------------------------------------------------------

describe('EcsSourceAdapter invoke/vendCredentials are NotImplemented stubs', () => {
  const invocation: AgentInvocationBlock = {
    protocol: 'HTTP_ENDPOINT',
    target: 'https://agent.example.com',
    auth: { mode: 'NONE' },
    mode: 'sync',
  };

  it('vendCredentials throws NotImplementedError (no AWS invoke role for ECS)', async () => {
    const adapter = new EcsSourceAdapter({});
    await expect(adapter.vendCredentials(invocation)).rejects.toBeInstanceOf(NotImplementedError);
  });

  it('invoke throws NotImplementedError (invoke flows through the HTTP adapter)', async () => {
    const adapter = new EcsSourceAdapter({});
    await expect(
      adapter.invoke(
        { prompt: 'ping' },
        {
          name: 'x',
          description: '',
          version: '1',
          skills: [],
          categories: [],
          inputSchema: {},
          outputSchema: {},
          invocation,
          origin: { substrate: 'ecs', discoveredAt: 'now', ownership: 'external' },
        },
      ),
    ).rejects.toBeInstanceOf(NotImplementedError);
  });

  it("declares protocol HTTP_ENDPOINT (the candidate's invocation protocol)", () => {
    expect(new EcsSourceAdapter({}).protocol).toBe('HTTP_ENDPOINT');
  });
});
