/**
 * EKS source adapter (US-IMP-019).
 *
 * EKS is a DISCOVERY SUBSTRATE, not an invocation protocol. discover/describe/
 * healthCheck enumerate EKS CLUSTERS and resolve each cluster's AGENT HTTP
 * endpoint (a `citadel:endpoint` resource tag, a cluster-tagged load balancer's
 * DNS, or — failing both — left empty for the operator to supply at import).
 * The produced candidate's INVOCATION protocol is HTTP_ENDPOINT, so invoke()/
 * test flow through the existing HttpEndpointAdapter — this adapter's invoke()
 * and vendCredentials() are {@link NotImplementedError} stubs (there is no AWS
 * "invoke" action for an EKS-hosted agent; reaching it is plain HTTP).
 *
 * SCOPE: this increment discovers CLUSTERS and resolves the agent endpoint via
 * ELB/tag. In-cluster Kubernetes API enumeration (listing k8s Services /
 * Ingresses) is OUT OF SCOPE — it has a different access model (k8s RBAC).
 *
 * NOTE the cluster's own `endpoint` field is the KUBERNETES API server, NOT the
 * agent endpoint — it is NEVER used as the invocation target. Tier-1 describe
 * surfaces only safe metadata (k8s version / status / platform version); it
 * NEVER emits certificate-authority data, the OIDC identity, or any secret.
 *
 * The EKS + ELBv2 SDK clients and global fetch are injected for testability,
 * mirroring the ECS source adapter. A cross-account `credentialProvider`
 * (assumed READ-ONLY discovery role) is threaded into both SDK clients so
 * describe runs in the target account; absent ⇒ the default provider chain
 * (same-account).
 */
import { EKSClient, ListClustersCommand, DescribeClusterCommand } from '@aws-sdk/client-eks';
import type {
  ListClustersCommandOutput,
  DescribeClusterCommandOutput,
  Cluster,
} from '@aws-sdk/client-eks';
import {
  ElasticLoadBalancingV2Client,
  DescribeLoadBalancersCommand,
  DescribeTagsCommand,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import type {
  DescribeLoadBalancersCommandOutput,
  DescribeTagsCommandOutput,
  LoadBalancer,
  Tag,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import type { AgentSourceAdapter, AgentRef } from './base';
import type {
  AgentCandidate,
  AgentCapabilityDescriptor,
  AgentInvocationBlock,
  AgentInvocationProtocol,
  AgentOrigin,
  Confidence,
  HealthCheckResult,
  InvokeRequest,
  InvokeResponse,
  VendedCredentials,
} from './base';
import type { AdapterCredentialProvider, CommandSender } from './invoke-support';
import { NotImplementedError } from './not-implemented';

const DEFAULT_REGION = process.env.AWS_REGION || 'ap-southeast-2';

/** Resource tag an operator can set to declare a cluster's agent endpoint. */
const ENDPOINT_TAG = 'citadel:endpoint';

/** ELBv2 DescribeTags accepts at most 20 resource ARNs per call. */
const DESCRIBE_TAGS_BATCH = 20;

/** Optional discovery scope for {@link EksSourceAdapter.discover}. */
interface EksDiscoverScope {
  region?: string;
  account?: string;
  tagKey?: string;
  tagValue?: string;
}

/**
 * Injectable dependencies. All optional: production omits them (real clients +
 * global fetch); tests inject `{ eksSender, elbSender, fetchFn }` doubles.
 */
export interface EksSourceAdapterDeps {
  /** EKS control sender; tests inject a fake, production builds an EKSClient. */
  eksSender?: CommandSender;
  /** ELBv2 control sender; tests inject a fake, production builds the client. */
  elbSender?: CommandSender;
  /** Reachability probe; defaults to late-bound global fetch (test stub honoured). */
  fetchFn?: typeof fetch;
  defaultRegion?: string;
  defaultAccount?: string;
  /**
   * Cross-account assumed credentials (READ-ONLY discovery role). When set, the
   * EKS + ELBv2 clients are built with these so describe runs in the target
   * account. Absent ⇒ the default provider chain (same-account, unchanged).
   */
  credentialProvider?: AdapterCredentialProvider;
}

export class EksSourceAdapter implements AgentSourceAdapter {
  /**
   * The protocol the described candidate is INVOKED through. EKS is a discovery
   * substrate whose candidates invoke over HTTP, so this is HTTP_ENDPOINT — the
   * adapter is dispatched by SUBSTRATE (not via the protocol registry), and its
   * own invoke() is a NotImplemented stub.
   */
  public readonly protocol: AgentInvocationProtocol = 'HTTP_ENDPOINT';

  private readonly fetchFn: typeof fetch;

  constructor(private readonly deps: EksSourceAdapterDeps = {}) {
    // Late-bind to the current global fetch so test stubs are honoured.
    this.fetchFn = deps.fetchFn ?? ((input, init) => globalThis.fetch(input, init));
  }

  /**
   * Enumerate EKS clusters as candidates: ListClusters (NAMES, paginated) ->
   * per-cluster DescribeCluster (for the ARN + tags). Each cluster becomes a
   * candidate on substrate 'eks' with the cluster ARN as both sourceArn and
   * reference. When scope.tagKey is set, only clusters carrying a matching tag
   * are kept (any value when tagValue is omitted).
   */
  async discover(scope: unknown): Promise<AgentCandidate[]> {
    const s = readScope(scope);
    const region = s.region ?? this.deps.defaultRegion ?? DEFAULT_REGION;
    const eks = this.eksClient(region);
    const discoveredAt = new Date().toISOString();

    const candidates: AgentCandidate[] = [];
    for (const clusterName of await this.listClusters(eks)) {
      const cluster = await this.resolveCluster(eks, clusterName);
      const arn = cluster?.arn;
      if (!arn) continue;
      if (s.tagKey && !clusterTagMatches(cluster, s.tagKey, s.tagValue)) continue;
      const parsed = parseArn(arn);
      candidates.push({
        origin: {
          sourceArn: arn,
          substrate: 'eks',
          region: parsed.region ?? region,
          account: parsed.account ?? s.account ?? this.deps.defaultAccount,
          discoveredAt,
          ownership: 'external',
        },
        displayName: cluster.name ?? clusterName ?? arn,
        reference: arn,
      });
    }
    return candidates;
  }

  /**
   * Resolve a cluster ARN to a Tier-1 capability descriptor:
   *   - DescribeCluster supplies low-confidence inferred facts (k8s version /
   *     status / platform version — names/metadata only, NEVER CA data, the
   *     OIDC identity, or any secret).
   *   - The AGENT HTTP endpoint is resolved by precedence: the `citadel:endpoint`
   *     tag (operator hint) -> a cluster-tagged ELBv2 load balancer's DNS
   *     (`kubernetes.io/cluster/<name>`=owned|shared or `elbv2.k8s.aws/cluster`
   *     =<name>) -> empty.
   *
   * The invocation is ALWAYS HTTP_ENDPOINT/NONE/sync (invoke flows through the
   * HTTP adapter). The cluster's own `endpoint` field (the Kubernetes API
   * server) is NEVER used as the target. When no endpoint resolves the target
   * is '' and a note tells the operator to supply one at import. All inferred
   * fields are 'low'.
   */
  async describe(ref: AgentRef): Promise<AgentCapabilityDescriptor> {
    const clusterArn = refToString(ref);
    const parsed = parseArn(clusterArn);
    const region = parsed.region ?? this.deps.defaultRegion ?? DEFAULT_REGION;
    const account = parsed.account ?? this.deps.defaultAccount;
    const nameFromArn = clusterNameFromArn(clusterArn) ?? clusterArn;
    const eks = this.eksClient(region);

    const cluster = await this.resolveCluster(eks, nameFromArn);
    const clusterName = cluster?.name ?? nameFromArn;
    const endpoint = await this.resolveEndpoint(cluster, clusterName, region);

    const tierOne = summarizeCluster(cluster);
    const note = endpoint
      ? ''
      : 'no invocation endpoint could be resolved from the EKS cluster — the ' +
        'operator must supply the endpoint at import';
    const description = [tierOne, note].filter((part) => part.length > 0).join(' ');

    const invocation: AgentInvocationBlock = {
      protocol: 'HTTP_ENDPOINT',
      target: endpoint ?? '',
      auth: { mode: 'NONE' },
      mode: 'sync',
      region,
      account,
    };
    const origin: AgentOrigin = {
      sourceArn: clusterArn,
      substrate: 'eks',
      region,
      account,
      discoveredAt: new Date().toISOString(),
      ownership: 'external',
    };
    // Every produced field is inferred (describe/probe-derived), so 'low'.
    const low: Confidence = 'low';
    const fieldConfidence: Record<string, Confidence> = {
      name: low,
      description: low,
      version: low,
      skills: low,
      inputSchema: low,
      outputSchema: low,
    };

    return {
      name: cluster?.name ?? deriveName(clusterArn),
      // The k8s version is the most meaningful "version" Tier-1 can infer.
      version: cluster?.version ? String(cluster.version) : '1',
      description,
      skills: [],
      categories: [],
      inputSchema: {},
      outputSchema: {},
      invocation,
      origin,
      fieldConfidence,
    };
  }

  /**
   * Best-effort reachability probe. When an endpoint resolves, GET it: a 2xx ->
   * reachable; a non-2xx or network error -> { reachable: false, detail }
   * WITHOUT throwing. When NO endpoint resolves, return { reachable: false,
   * detail: 'no endpoint resolved' } without any network call.
   */
  async healthCheck(ref: AgentRef): Promise<HealthCheckResult> {
    const clusterArn = refToString(ref);
    const region = parseArn(clusterArn).region ?? this.deps.defaultRegion ?? DEFAULT_REGION;
    const nameFromArn = clusterNameFromArn(clusterArn) ?? clusterArn;
    const eks = this.eksClient(region);
    const cluster = await this.resolveCluster(eks, nameFromArn);
    const clusterName = cluster?.name ?? nameFromArn;
    const endpoint = await this.resolveEndpoint(cluster, clusterName, region);
    if (!endpoint) {
      return { reachable: false, detail: 'no endpoint resolved' };
    }
    try {
      const res = await this.fetchFn(endpoint, { method: 'GET' });
      if (res.ok) return { reachable: true };
      return { reachable: false, detail: `HTTP ${res.status}` };
    } catch (err) {
      return { reachable: false, detail: errMessage(err) };
    }
  }

  /**
   * Not applicable: EKS candidates invoke over HTTP_ENDPOINT, which needs no
   * AWS invoke role to vend.
   */
  async vendCredentials(_invocation: AgentInvocationBlock): Promise<VendedCredentials> {
    throw new NotImplementedError(
      'EksSourceAdapter.vendCredentials: EKS candidates invoke via HTTP_ENDPOINT — no AWS invoke role',
    );
  }

  /**
   * Not applicable: invoke/test for an EKS candidate flow through the existing
   * HTTP_ENDPOINT adapter (the candidate's invocation protocol), never this
   * discovery adapter.
   */
  async invoke(_req: InvokeRequest, _descriptor: AgentCapabilityDescriptor): Promise<InvokeResponse> {
    throw new NotImplementedError(
      'EksSourceAdapter.invoke: EKS candidates invoke via the HTTP_ENDPOINT adapter',
    );
  }

  // --- management-path helpers ---------------------------------------------

  /** ListClusters returns cluster NAMES (not ARNs); paginate via nextToken. */
  private async listClusters(eks: CommandSender): Promise<string[]> {
    const names: string[] = [];
    let nextToken: string | undefined;
    do {
      const out = (await eks.send(
        new ListClustersCommand({ nextToken }),
      )) as ListClustersCommandOutput;
      names.push(...(out.clusters ?? []));
      nextToken = out.nextToken;
    } while (nextToken);
    return names;
  }

  private async resolveCluster(
    eks: CommandSender,
    name: string,
  ): Promise<Cluster | undefined> {
    const out = (await eks.send(
      new DescribeClusterCommand({ name }),
    )) as DescribeClusterCommandOutput;
    return out.cluster;
  }

  /**
   * Resolve the cluster's AGENT HTTP endpoint by precedence: `citadel:endpoint`
   * tag -> cluster-tagged ELBv2 load balancer DNS -> undefined. Pure read; never
   * throws for "absent". The cluster's own `endpoint` (k8s API server) is NEVER
   * consulted here.
   */
  private async resolveEndpoint(
    cluster: Cluster | undefined,
    clusterName: string,
    region: string,
  ): Promise<string | undefined> {
    if (!cluster) return undefined;

    // (a) explicit operator hint.
    const explicit = (cluster.tags ?? {})[ENDPOINT_TAG];
    if (explicit) return explicit;

    // (b) best-effort: a load balancer tagged for this cluster.
    const lbEndpoint = await this.resolveClusterLbEndpoint(clusterName, region);
    if (lbEndpoint) return lbEndpoint;

    // (c) nothing resolved.
    return undefined;
  }

  /**
   * Best-effort: DescribeLoadBalancers -> batched DescribeTags -> pick a load
   * balancer tagged for this cluster (`kubernetes.io/cluster/<name>`=owned|shared
   * or `elbv2.k8s.aws/cluster`=<name>) -> `http://<DNSName>`.
   */
  private async resolveClusterLbEndpoint(
    clusterName: string,
    region: string,
  ): Promise<string | undefined> {
    const elb = this.elbClient(region);
    const loadBalancers = await this.describeAllLoadBalancers(elb);
    if (loadBalancers.length === 0) return undefined;

    for (let i = 0; i < loadBalancers.length; i += DESCRIBE_TAGS_BATCH) {
      const batch = loadBalancers.slice(i, i + DESCRIBE_TAGS_BATCH);
      const arns = batch
        .map((lb) => lb.LoadBalancerArn)
        .filter((a): a is string => typeof a === 'string' && a.length > 0);
      if (arns.length === 0) continue;

      const tagsOut = (await elb.send(
        new DescribeTagsCommand({ ResourceArns: arns }),
      )) as DescribeTagsCommandOutput;

      for (const desc of tagsOut.TagDescriptions ?? []) {
        if (!lbTagsMatchCluster(desc.Tags ?? [], clusterName)) continue;
        const dns = batch.find((lb) => lb.LoadBalancerArn === desc.ResourceArn)?.DNSName;
        if (dns) return buildClusterLbEndpoint(dns);
      }
    }
    return undefined;
  }

  /** Enumerate every load balancer in the region, paginating via Marker. */
  private async describeAllLoadBalancers(elb: CommandSender): Promise<LoadBalancer[]> {
    const loadBalancers: LoadBalancer[] = [];
    let marker: string | undefined;
    do {
      const out = (await elb.send(
        new DescribeLoadBalancersCommand({ Marker: marker }),
      )) as DescribeLoadBalancersCommandOutput;
      loadBalancers.push(...(out.LoadBalancers ?? []));
      marker = out.NextMarker;
    } while (marker);
    return loadBalancers;
  }

  private eksClient(region: string): CommandSender {
    if (this.deps.eksSender) return this.deps.eksSender;
    // The concrete EKSClient.send() is structurally a CommandSender; the double
    // assertion bridges the overload set to the loose injection type.
    return new EKSClient(this.clientConfig(region)) as unknown as CommandSender;
  }

  private elbClient(region: string): CommandSender {
    if (this.deps.elbSender) return this.deps.elbSender;
    return new ElasticLoadBalancingV2Client(
      this.clientConfig(region),
    ) as unknown as CommandSender;
  }

  private clientConfig(region: string): {
    region: string;
    credentials?: AdapterCredentialProvider;
  } {
    return this.deps.credentialProvider
      ? { region, credentials: this.deps.credentialProvider }
      : { region };
  }
}

// --- helpers (scope / ARN / tags / cluster summary / endpoint / errors) ----

function readScope(scope: unknown): EksDiscoverScope {
  if (typeof scope !== 'object' || scope === null) return {};
  const o = scope as Record<string, unknown>;
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
  return {
    region: str(o.region),
    account: str(o.account),
    tagKey: str(o.tagKey),
    tagValue: str(o.tagValue),
  };
}

function refToString(ref: AgentRef): string {
  return typeof ref === 'string' ? ref : ref.reference;
}

/** Parse the standard ARN layout `arn:partition:service:region:account:resource`. */
function parseArn(arn: string): { region?: string; account?: string } {
  const parts = arn.split(':');
  if (parts[0] !== 'arn' || parts.length < 6) return {};
  return { region: parts[3] || undefined, account: parts[4] || undefined };
}

/**
 * Extract the cluster name from a cluster ARN. The EKS cluster ARN form is
 * `…:cluster/<name>`; anything else (nodegroup/fargateprofile, malformed) ⇒
 * undefined.
 */
function clusterNameFromArn(arn: string): string | undefined {
  const parts = arn.split(':');
  const resource = parts.length >= 6 ? parts.slice(5).join(':') : '';
  const match = /^cluster\/(.+)$/.exec(resource);
  return match ? match[1] : undefined;
}

/**
 * True when the cluster carries `tagKey` (matching `tagValue` when supplied).
 * EKS cluster tags are a string map (not the {key,value}[] array ECS uses).
 */
function clusterTagMatches(cluster: Cluster, tagKey: string, tagValue?: string): boolean {
  const tags = cluster.tags ?? {};
  if (!Object.prototype.hasOwnProperty.call(tags, tagKey)) return false;
  return tagValue !== undefined ? tags[tagKey] === tagValue : true;
}

/**
 * True when a load balancer's ELBv2 tags associate it with this EKS cluster:
 * the standard subnet/ELB controller tags `kubernetes.io/cluster/<name>` (value
 * owned|shared) or the AWS Load Balancer Controller tag `elbv2.k8s.aws/cluster`
 * (value = the cluster name).
 */
function lbTagsMatchCluster(tags: Tag[], clusterName: string): boolean {
  const ownedKey = `kubernetes.io/cluster/${clusterName}`;
  for (const t of tags) {
    if (t.Key === ownedKey && (t.Value === 'owned' || t.Value === 'shared')) return true;
    if (t.Key === 'elbv2.k8s.aws/cluster' && t.Value === clusterName) return true;
  }
  return false;
}

/**
 * Assemble the agent endpoint from a load balancer DNS name. The LB listener
 * protocol is not enumerated in this increment (that would need
 * DescribeListeners), so the scheme defaults to http on the ELB default port;
 * an operator needing https or a path sets the `citadel:endpoint` tag
 * (precedence (a)), which wins over this fallback.
 */
function buildClusterLbEndpoint(dnsName: string): string {
  return `http://${dnsName}`;
}

/**
 * Compact, human-readable Tier-1 summary of safe cluster metadata: the
 * Kubernetes version, status, and platform version. Deliberately excludes the
 * certificate-authority data, the k8s API `endpoint`, the OIDC identity, the
 * cluster role, and any encryption/VPC config — none of which is safe to
 * surface. Returns '' when there is no cluster / no notable facts.
 */
function summarizeCluster(cluster: Cluster | undefined): string {
  if (!cluster) return '';
  const seg: string[] = [];
  if (cluster.version) seg.push(`k8sVersion=${cluster.version}`);
  if (cluster.status) seg.push(`status=${String(cluster.status)}`);
  if (cluster.platformVersion) seg.push(`platformVersion=${cluster.platformVersion}`);
  return seg.length > 0 ? `[eks ${seg.join(' ')}]` : '';
}

/** Trailing segment of an ARN resource, used as a display-name fallback. */
function deriveName(arn: string): string {
  return arn.split(/[/:]/).filter((s) => s.length > 0).pop() ?? arn;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
