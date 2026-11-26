/**
 * Discovery / describe / healthCheck tests for the EKS source adapter
 * (US-IMP-019). EKS is a DISCOVERY SUBSTRATE: discover/describe/healthCheck are
 * EKS-specific (they enumerate CLUSTERS and resolve the AGENT's HTTP endpoint),
 * but the resulting candidate's INVOCATION protocol is HTTP_ENDPOINT — invoke/
 * test flow through the existing HTTP adapter, so this adapter's invoke()/
 * vendCredentials() are NotImplemented stubs. In-cluster Kubernetes API
 * enumeration (k8s Services/Ingresses) is OUT OF SCOPE. The EKS + ELBv2 clients
 * and global fetch are injected as fakes — there are NO live AWS calls and NO
 * live network.
 *
 * NOTE the difference from ECS: eks ListClusters returns cluster NAMES (not
 * ARNs), DescribeCluster supplies the ARN; cluster `tags` is a string map (not
 * a {key,value}[] array); the cluster's own `endpoint` field is the KUBERNETES
 * API server and is NEVER used as the agent invocation target.
 */
import { EksSourceAdapter } from '../eks-source-adapter';
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

const CLUSTER_NAME = 'my-agent-cluster';
const CLUSTER_ARN = 'arn:aws:eks:us-east-1:123456789012:cluster/my-agent-cluster';
const LB_ARN = 'arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/my-alb/def456';
const LB_DNS = 'my-alb-123456.us-east-1.elb.amazonaws.com';
/** The cluster's own k8s API server endpoint — must NEVER be the invocation target. */
const K8S_API = 'https://ABC123DEF456.gr7.us-east-1.eks.amazonaws.com';
/** Certificate-authority data — must NEVER appear in any produced field. */
const CA_DATA = 'LS0tLS1CRUdJTi1TRUNSRVQtQ0EtREFUQQ==';

// ---------------------------------------------------------------------------
// discover
// ---------------------------------------------------------------------------

describe('EksSourceAdapter.discover (US-IMP-019)', () => {
  it('lists clusters -> describeCluster and maps each cluster to an eks candidate', async () => {
    const eksSender = senderDouble({
      ListClustersCommand: () => ({ clusters: [CLUSTER_NAME] }),
      DescribeClusterCommand: (input) => ({
        cluster: { name: input.name, arn: CLUSTER_ARN, version: '1.29', status: 'ACTIVE' },
      }),
    });
    const adapter = new EksSourceAdapter({ eksSender });

    const candidates = await adapter.discover({ region: 'us-east-1' });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      displayName: CLUSTER_NAME,
      reference: CLUSTER_ARN,
      origin: {
        sourceArn: CLUSTER_ARN,
        substrate: 'eks',
        region: 'us-east-1',
        account: '123456789012',
        ownership: 'external',
      },
    });
    expect(typeof candidates[0].origin.discoveredAt).toBe('string');
  });

  it('paginates clusters across pages (nextToken)', async () => {
    const clusterPages: Record<string, unknown>[] = [
      { clusters: [CLUSTER_NAME], nextToken: 'c2' },
      { clusters: ['other-cluster'] },
    ];
    let clusterCall = 0;
    const eksSender = senderDouble({
      ListClustersCommand: () => clusterPages[clusterCall++],
      DescribeClusterCommand: (input) => ({
        cluster: {
          name: input.name,
          arn: `arn:aws:eks:us-east-1:123456789012:cluster/${String(input.name)}`,
        },
      }),
    });
    const adapter = new EksSourceAdapter({ eksSender });

    const candidates = await adapter.discover({ region: 'us-east-1' });

    expect(candidates.map((c) => c.reference)).toEqual([
      CLUSTER_ARN,
      'arn:aws:eks:us-east-1:123456789012:cluster/other-cluster',
    ]);
    expect(candidates.every((c) => c.origin.substrate === 'eks')).toBe(true);
  });

  it('filters by scope.tagKey/tagValue using the cluster tags (string map)', async () => {
    const eksSender = senderDouble({
      ListClustersCommand: () => ({ clusters: [CLUSTER_NAME, 'drop-cluster'] }),
      DescribeClusterCommand: (input) => ({
        cluster: {
          name: input.name,
          arn: `arn:aws:eks:us-east-1:123456789012:cluster/${String(input.name)}`,
          tags:
            input.name === CLUSTER_NAME
              ? { 'citadel:agent': 'true' }
              : { team: 'other' },
        },
      }),
    });
    const adapter = new EksSourceAdapter({ eksSender });

    const candidates = await adapter.discover({
      region: 'us-east-1',
      tagKey: 'citadel:agent',
      tagValue: 'true',
    });

    expect(candidates.map((c) => c.displayName)).toEqual([CLUSTER_NAME]);
  });

  it('returns [] when there are no clusters', async () => {
    const eksSender = senderDouble({ ListClustersCommand: () => ({ clusters: [] }) });
    const adapter = new EksSourceAdapter({ eksSender });
    await expect(adapter.discover({ region: 'us-east-1' })).resolves.toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// describe
// ---------------------------------------------------------------------------

describe('EksSourceAdapter.describe (US-IMP-019)', () => {
  it('builds a low-confidence Tier-1 descriptor and resolves the endpoint from the citadel:endpoint tag (precedence a)', async () => {
    const eksSender = senderDouble({
      DescribeClusterCommand: () => ({
        cluster: {
          name: CLUSTER_NAME,
          arn: CLUSTER_ARN,
          version: '1.29',
          status: 'ACTIVE',
          platformVersion: 'eks.5',
          endpoint: K8S_API, // k8s API server — must NOT be used as the target
          certificateAuthority: { data: CA_DATA }, // must NEVER leak
          tags: { 'citadel:endpoint': 'https://agent.example.com/run' },
        },
      }),
    });
    // An elbSender that throws proves the ELBv2 path is NOT reached (tag wins).
    const elbSender = senderDouble({});
    const adapter = new EksSourceAdapter({ eksSender, elbSender });

    const d = await adapter.describe(CLUSTER_ARN);

    expect(d.name).toBe(CLUSTER_NAME);
    expect(d.invocation).toMatchObject({
      protocol: 'HTTP_ENDPOINT',
      target: 'https://agent.example.com/run',
      auth: { mode: 'NONE' },
      mode: 'sync',
      region: 'us-east-1',
      account: '123456789012',
    });
    expect(d.origin).toMatchObject({ substrate: 'eks', sourceArn: CLUSTER_ARN });
    // Tier-1 facts inferred from the cluster appear in the description.
    expect(d.description).toContain('1.29');
    // The descriptor version is the k8s version.
    expect(d.version).toBe('1.29');
    // Inferred fields are low confidence.
    expect(d.fieldConfidence?.name).toBe('low');
    // NEVER leak CA / secret data, and NEVER use the k8s API endpoint as target.
    expect(JSON.stringify(d)).not.toContain(CA_DATA);
    expect(d.invocation.target).not.toContain('eks.amazonaws.com');
  });

  it('falls back to a cluster-tagged ELBv2 load balancer DNS (kubernetes.io/cluster=owned) when no endpoint tag is set (precedence b)', async () => {
    const eksSender = senderDouble({
      DescribeClusterCommand: () => ({
        cluster: { name: CLUSTER_NAME, arn: CLUSTER_ARN, version: '1.29', tags: {} },
      }),
    });
    const elbSender = senderDouble({
      DescribeLoadBalancersCommand: () => ({
        LoadBalancers: [{ LoadBalancerArn: LB_ARN, DNSName: LB_DNS }],
      }),
      DescribeTagsCommand: () => ({
        TagDescriptions: [
          {
            ResourceArn: LB_ARN,
            Tags: [{ Key: `kubernetes.io/cluster/${CLUSTER_NAME}`, Value: 'owned' }],
          },
        ],
      }),
    });
    const adapter = new EksSourceAdapter({ eksSender, elbSender });

    const d = await adapter.describe(CLUSTER_ARN);

    expect(d.invocation.target).toBe(`http://${LB_DNS}`);
    expect(d.invocation.protocol).toBe('HTTP_ENDPOINT');
  });

  it('matches a load balancer via the elbv2.k8s.aws/cluster tag', async () => {
    const eksSender = senderDouble({
      DescribeClusterCommand: () => ({
        cluster: { name: CLUSTER_NAME, arn: CLUSTER_ARN, tags: {} },
      }),
    });
    const elbSender = senderDouble({
      DescribeLoadBalancersCommand: () => ({
        LoadBalancers: [{ LoadBalancerArn: LB_ARN, DNSName: LB_DNS }],
      }),
      DescribeTagsCommand: () => ({
        TagDescriptions: [
          { ResourceArn: LB_ARN, Tags: [{ Key: 'elbv2.k8s.aws/cluster', Value: CLUSTER_NAME }] },
        ],
      }),
    });
    const adapter = new EksSourceAdapter({ eksSender, elbSender });

    const d = await adapter.describe(CLUSTER_ARN);

    expect(d.invocation.target).toBe(`http://${LB_DNS}`);
  });

  it('ignores load balancers tagged for a DIFFERENT cluster', async () => {
    const eksSender = senderDouble({
      DescribeClusterCommand: () => ({
        cluster: { name: CLUSTER_NAME, arn: CLUSTER_ARN, tags: {} },
      }),
    });
    const elbSender = senderDouble({
      DescribeLoadBalancersCommand: () => ({
        LoadBalancers: [{ LoadBalancerArn: LB_ARN, DNSName: LB_DNS }],
      }),
      DescribeTagsCommand: () => ({
        TagDescriptions: [
          {
            ResourceArn: LB_ARN,
            Tags: [{ Key: 'kubernetes.io/cluster/some-other-cluster', Value: 'owned' }],
          },
        ],
      }),
    });
    const adapter = new EksSourceAdapter({ eksSender, elbSender });

    const d = await adapter.describe(CLUSTER_ARN);

    expect(d.invocation.target).toBe('');
    expect(d.description.toLowerCase()).toContain('endpoint');
  });

  it('leaves the endpoint empty and adds an operator note when nothing resolves (precedence c); cluster.endpoint is NOT used', async () => {
    const eksSender = senderDouble({
      DescribeClusterCommand: () => ({
        cluster: {
          name: CLUSTER_NAME,
          arn: CLUSTER_ARN,
          version: '1.29',
          endpoint: K8S_API, // present, but is the k8s API server — never the target
          tags: {},
        },
      }),
    });
    const elbSender = senderDouble({
      DescribeLoadBalancersCommand: () => ({ LoadBalancers: [] }),
    });
    const adapter = new EksSourceAdapter({ eksSender, elbSender });

    const d = await adapter.describe(CLUSTER_ARN);

    expect(d.invocation.target).toBe('');
    expect(d.invocation.protocol).toBe('HTTP_ENDPOINT');
    expect(d.invocation.target).not.toContain('eks.amazonaws.com');
    expect(d.description.toLowerCase()).toContain('endpoint');
  });
});

// ---------------------------------------------------------------------------
// healthCheck
// ---------------------------------------------------------------------------

describe('EksSourceAdapter.healthCheck (US-IMP-019)', () => {
  function endpointTagEksSender(): { send: jest.Mock } {
    return senderDouble({
      DescribeClusterCommand: () => ({
        cluster: {
          name: CLUSTER_NAME,
          arn: CLUSTER_ARN,
          tags: { 'citadel:endpoint': 'https://agent.example.com/run' },
        },
      }),
    });
  }

  it('probes the resolved endpoint and returns reachable:true on a 2xx', async () => {
    const fetchFn = jest.fn(async () => ({ ok: true, status: 200 }));
    const adapter = new EksSourceAdapter({
      eksSender: endpointTagEksSender(),
      fetchFn: asFetch(fetchFn),
    });
    await expect(adapter.healthCheck(CLUSTER_ARN)).resolves.toEqual({ reachable: true });
    expect(String(fetchFn.mock.calls[0][0])).toBe('https://agent.example.com/run');
  });

  it('returns reachable:false (with detail) on a non-2xx WITHOUT throwing', async () => {
    const fetchFn = jest.fn(async () => ({ ok: false, status: 503 }));
    const adapter = new EksSourceAdapter({
      eksSender: endpointTagEksSender(),
      fetchFn: asFetch(fetchFn),
    });
    const res = await adapter.healthCheck(CLUSTER_ARN);
    expect(res.reachable).toBe(false);
    expect(res.detail).toContain('503');
  });

  it('returns reachable:false with a clear detail when no endpoint resolves (fetch not called)', async () => {
    const eksSender = senderDouble({
      DescribeClusterCommand: () => ({ cluster: { name: CLUSTER_NAME, arn: CLUSTER_ARN, tags: {} } }),
    });
    const elbSender = senderDouble({ DescribeLoadBalancersCommand: () => ({ LoadBalancers: [] }) });
    const fetchFn = jest.fn();
    const adapter = new EksSourceAdapter({ eksSender, elbSender, fetchFn: asFetch(fetchFn) });

    await expect(adapter.healthCheck(CLUSTER_ARN)).resolves.toEqual({
      reachable: false,
      detail: 'no endpoint resolved',
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// invoke / vendCredentials — NotImplemented (EKS invokes via HTTP_ENDPOINT)
// ---------------------------------------------------------------------------

describe('EksSourceAdapter invoke/vendCredentials are NotImplemented stubs', () => {
  const invocation: AgentInvocationBlock = {
    protocol: 'HTTP_ENDPOINT',
    target: 'https://agent.example.com',
    auth: { mode: 'NONE' },
    mode: 'sync',
  };

  it('vendCredentials throws NotImplementedError (no AWS invoke role for EKS)', async () => {
    const adapter = new EksSourceAdapter({});
    await expect(adapter.vendCredentials(invocation)).rejects.toBeInstanceOf(NotImplementedError);
  });

  it('invoke throws NotImplementedError (invoke flows through the HTTP adapter)', async () => {
    const adapter = new EksSourceAdapter({});
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
          origin: { substrate: 'eks', discoveredAt: 'now', ownership: 'external' },
        },
      ),
    ).rejects.toBeInstanceOf(NotImplementedError);
  });

  it("declares protocol HTTP_ENDPOINT (the candidate's invocation protocol)", () => {
    expect(new EksSourceAdapter({}).protocol).toBe('HTTP_ENDPOINT');
  });
});
