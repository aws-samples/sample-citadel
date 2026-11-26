/**
 * ECS source adapter (US-IMP-018).
 *
 * ECS is a DISCOVERY SUBSTRATE, not an invocation protocol. discover/describe/
 * healthCheck enumerate ECS services and resolve each service's HTTP endpoint
 * (its load balancer's DNS, a `citadel:endpoint` resource tag, or — failing
 * both — left empty for the operator to supply at import). The produced
 * candidate's INVOCATION protocol is HTTP_ENDPOINT, so invoke()/test flow
 * through the existing HttpEndpointAdapter — this adapter's invoke() and
 * vendCredentials() are {@link NotImplementedError} stubs (there is no AWS
 * "invoke" action for an ECS service; reaching it is plain HTTP).
 *
 * Reachability of PRIVATE endpoints (VPC-internal ALBs) is a separate concern
 * (US-IMP-017) — healthCheck here only does a best-effort public HTTP probe.
 *
 * The ECS + ELBv2 SDK clients and global fetch are injected for testability,
 * mirroring LambdaInvokeAdapter (control sender) and HttpEndpointAdapter
 * (fetch). A cross-account `credentialProvider` (assumed READ-ONLY discovery
 * role) is threaded into both SDK clients so describe runs in the target
 * account; absent ⇒ the default provider chain (same-account).
 */
import {
  ECSClient,
  ListClustersCommand,
  ListServicesCommand,
  DescribeServicesCommand,
  DescribeTaskDefinitionCommand,
} from '@aws-sdk/client-ecs';
import type {
  ListClustersCommandOutput,
  ListServicesCommandOutput,
  DescribeServicesCommandOutput,
  DescribeTaskDefinitionCommandOutput,
  Service,
  TaskDefinition,
} from '@aws-sdk/client-ecs';
import {
  ElasticLoadBalancingV2Client,
  DescribeTargetGroupsCommand,
  DescribeLoadBalancersCommand,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import type {
  DescribeTargetGroupsCommandOutput,
  DescribeLoadBalancersCommandOutput,
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

/** Resource tag an operator can set to declare a service's invocation endpoint. */
const ENDPOINT_TAG = 'citadel:endpoint';

/** ECS DescribeServices accepts at most 10 services per call. */
const DESCRIBE_SERVICES_BATCH = 10;

/** Optional discovery scope for {@link EcsSourceAdapter.discover}. */
interface EcsDiscoverScope {
  region?: string;
  account?: string;
  tagKey?: string;
  tagValue?: string;
}

/**
 * Injectable dependencies. All optional: production omits them (real clients +
 * global fetch); tests inject `{ ecsSender, elbSender, fetchFn }` doubles.
 */
export interface EcsSourceAdapterDeps {
  /** ECS control sender; tests inject a fake, production builds an ECSClient. */
  ecsSender?: CommandSender;
  /** ELBv2 control sender; tests inject a fake, production builds the client. */
  elbSender?: CommandSender;
  /** Reachability probe; defaults to late-bound global fetch (test stub honoured). */
  fetchFn?: typeof fetch;
  defaultRegion?: string;
  defaultAccount?: string;
  /**
   * Cross-account assumed credentials (READ-ONLY discovery role). When set, the
   * ECS + ELBv2 clients are built with these so describe runs in the target
   * account. Absent ⇒ the default provider chain (same-account, unchanged).
   */
  credentialProvider?: AdapterCredentialProvider;
}

export class EcsSourceAdapter implements AgentSourceAdapter {
  /**
   * The protocol the described candidate is INVOKED through. ECS is a discovery
   * substrate whose candidates invoke over HTTP, so this is HTTP_ENDPOINT — the
   * adapter is dispatched by SUBSTRATE (not via the protocol registry), and its
   * own invoke() is a NotImplemented stub.
   */
  public readonly protocol: AgentInvocationProtocol = 'HTTP_ENDPOINT';

  private readonly fetchFn: typeof fetch;

  constructor(private readonly deps: EcsSourceAdapterDeps = {}) {
    // Late-bind to the current global fetch so test stubs are honoured.
    this.fetchFn = deps.fetchFn ?? ((input, init) => globalThis.fetch(input, init));
  }

  /**
   * Enumerate ECS services as candidates: ListClusters -> per-cluster
   * ListServices -> batched DescribeServices (TAGS included). Each service
   * becomes a candidate on substrate 'ecs' with the service ARN as both
   * sourceArn and reference. When scope.tagKey is set, only services carrying a
   * matching tag are kept (any value when tagValue is omitted).
   */
  async discover(scope: unknown): Promise<AgentCandidate[]> {
    const s = readScope(scope);
    const region = s.region ?? this.deps.defaultRegion ?? DEFAULT_REGION;
    const ecs = this.ecsClient(region);
    const discoveredAt = new Date().toISOString();

    const candidates: AgentCandidate[] = [];
    for (const clusterArn of await this.listClusters(ecs)) {
      const serviceArns = await this.listServices(ecs, clusterArn);
      for (let i = 0; i < serviceArns.length; i += DESCRIBE_SERVICES_BATCH) {
        const batch = serviceArns.slice(i, i + DESCRIBE_SERVICES_BATCH);
        if (batch.length === 0) continue;
        const out = (await ecs.send(
          new DescribeServicesCommand({
            cluster: clusterArn,
            services: batch,
            include: ['TAGS'],
          }),
        )) as DescribeServicesCommandOutput;
        for (const svc of out.services ?? []) {
          const arn = svc.serviceArn;
          if (!arn) continue;
          if (s.tagKey && !serviceTagMatches(svc, s.tagKey, s.tagValue)) continue;
          const parsed = parseArn(arn);
          candidates.push({
            origin: {
              sourceArn: arn,
              substrate: 'ecs',
              region: parsed.region ?? region,
              account: parsed.account ?? s.account ?? this.deps.defaultAccount,
              discoveredAt,
              ownership: 'external',
            },
            displayName: svc.serviceName ?? arn,
            reference: arn,
          });
        }
      }
    }
    return candidates;
  }

  /**
   * Resolve a service ARN to a Tier-1 capability descriptor:
   *   - DescribeServices (+ TAGS) and DescribeTaskDefinition supply low-confidence
   *     inferred facts (container image / ports / env-var NAMES — never values).
   *   - The HTTP endpoint is resolved by precedence: the service's load balancer
   *     (targetGroupArn -> ELBv2 DescribeTargetGroups -> LoadBalancerArns ->
   *     DescribeLoadBalancers -> DNSName) -> the `citadel:endpoint` tag -> empty.
   *
   * The invocation is ALWAYS HTTP_ENDPOINT/NONE/sync (invoke flows through the
   * HTTP adapter). When no endpoint resolves the target is '' and a note tells
   * the operator to supply one at import. All inferred fields are 'low'.
   */
  async describe(ref: AgentRef): Promise<AgentCapabilityDescriptor> {
    const serviceArn = refToString(ref);
    const parsed = parseArn(serviceArn);
    const region = parsed.region ?? this.deps.defaultRegion ?? DEFAULT_REGION;
    const account = parsed.account ?? this.deps.defaultAccount;
    const ecs = this.ecsClient(region);

    const service = await this.resolveService(ecs, serviceArn);
    const taskDef = await this.resolveTaskDefinition(ecs, service?.taskDefinition);
    const endpoint = await this.resolveEndpoint(service, region);

    const tierOne = summarizeTaskDefinition(taskDef);
    const note = endpoint
      ? ''
      : 'no invocation endpoint could be resolved from the ECS service — the ' +
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
      sourceArn: serviceArn,
      substrate: 'ecs',
      region,
      account,
      discoveredAt: new Date().toISOString(),
      ownership: 'external',
    };
    // Every produced field is inferred (probe/describe-derived), so 'low'.
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
      name: service?.serviceName ?? deriveName(serviceArn),
      description,
      version: taskDef?.revision != null ? String(taskDef.revision) : '1',
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
   * detail: 'no endpoint resolved' } without any network call (private-endpoint
   * reachability is US-IMP-017's job, not this increment).
   */
  async healthCheck(ref: AgentRef): Promise<HealthCheckResult> {
    const serviceArn = refToString(ref);
    const region = parseArn(serviceArn).region ?? this.deps.defaultRegion ?? DEFAULT_REGION;
    const ecs = this.ecsClient(region);
    const service = await this.resolveService(ecs, serviceArn);
    const endpoint = await this.resolveEndpoint(service, region);
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
   * Not applicable: ECS candidates invoke over HTTP_ENDPOINT, which needs no
   * AWS invoke role to vend. {@link buildImportInvokePolicy} likewise returns no
   * IAM invoke policy for HTTP_ENDPOINT/MCP.
   */
  async vendCredentials(_invocation: AgentInvocationBlock): Promise<VendedCredentials> {
    throw new NotImplementedError(
      'EcsSourceAdapter.vendCredentials: ECS candidates invoke via HTTP_ENDPOINT — no AWS invoke role',
    );
  }

  /**
   * Not applicable: invoke/test for an ECS candidate flow through the existing
   * HTTP_ENDPOINT adapter (the candidate's invocation protocol), never this
   * discovery adapter.
   */
  async invoke(_req: InvokeRequest, _descriptor: AgentCapabilityDescriptor): Promise<InvokeResponse> {
    throw new NotImplementedError(
      'EcsSourceAdapter.invoke: ECS candidates invoke via the HTTP_ENDPOINT adapter',
    );
  }

  // --- management-path helpers ---------------------------------------------

  private async listClusters(ecs: CommandSender): Promise<string[]> {
    const arns: string[] = [];
    let nextToken: string | undefined;
    do {
      const out = (await ecs.send(
        new ListClustersCommand({ nextToken }),
      )) as ListClustersCommandOutput;
      arns.push(...(out.clusterArns ?? []));
      nextToken = out.nextToken;
    } while (nextToken);
    return arns;
  }

  private async listServices(ecs: CommandSender, cluster: string): Promise<string[]> {
    const arns: string[] = [];
    let nextToken: string | undefined;
    do {
      const out = (await ecs.send(
        new ListServicesCommand({ cluster, nextToken }),
      )) as ListServicesCommandOutput;
      arns.push(...(out.serviceArns ?? []));
      nextToken = out.nextToken;
    } while (nextToken);
    return arns;
  }

  private async resolveService(
    ecs: CommandSender,
    serviceArn: string,
  ): Promise<Service | undefined> {
    const out = (await ecs.send(
      new DescribeServicesCommand({
        cluster: clusterFromServiceArn(serviceArn),
        services: [serviceArn],
        include: ['TAGS'],
      }),
    )) as DescribeServicesCommandOutput;
    return (out.services ?? [])[0];
  }

  private async resolveTaskDefinition(
    ecs: CommandSender,
    taskDefinition: string | undefined,
  ): Promise<TaskDefinition | undefined> {
    if (!taskDefinition) return undefined;
    const out = (await ecs.send(
      new DescribeTaskDefinitionCommand({ taskDefinition }),
    )) as DescribeTaskDefinitionCommandOutput;
    return out.taskDefinition;
  }

  /**
   * Resolve the service's HTTP endpoint by precedence: load balancer DNS ->
   * `citadel:endpoint` tag -> undefined. Pure read; never throws for "absent".
   */
  private async resolveEndpoint(
    service: Service | undefined,
    region: string,
  ): Promise<string | undefined> {
    if (!service) return undefined;

    const lb = (service.loadBalancers ?? []).find((l) => !!l.targetGroupArn);
    if (lb?.targetGroupArn) {
      const endpoint = await this.resolveLbEndpoint(lb.targetGroupArn, region);
      if (endpoint) return endpoint;
    }

    const tag = (service.tags ?? []).find((t) => t.key === ENDPOINT_TAG);
    if (tag?.value) return tag.value;

    return undefined;
  }

  /**
   * targetGroupArn -> DescribeTargetGroups -> first LoadBalancerArn ->
   * DescribeLoadBalancers -> DNSName, assembled into `http(s)://<dns>[:port]`
   * (scheme from the target group Protocol; non-default port appended).
   */
  private async resolveLbEndpoint(
    targetGroupArn: string,
    region: string,
  ): Promise<string | undefined> {
    const elb = this.elbClient(region);
    const tgOut = (await elb.send(
      new DescribeTargetGroupsCommand({ TargetGroupArns: [targetGroupArn] }),
    )) as DescribeTargetGroupsCommandOutput;
    const tg = (tgOut.TargetGroups ?? [])[0];
    const lbArn = (tg?.LoadBalancerArns ?? [])[0];
    if (!lbArn) return undefined;

    const lbOut = (await elb.send(
      new DescribeLoadBalancersCommand({ LoadBalancerArns: [lbArn] }),
    )) as DescribeLoadBalancersCommandOutput;
    const dns = (lbOut.LoadBalancers ?? [])[0]?.DNSName;
    if (!dns) return undefined;

    return buildLbEndpoint(dns, tg?.Protocol, tg?.Port);
  }

  private ecsClient(region: string): CommandSender {
    if (this.deps.ecsSender) return this.deps.ecsSender;
    // The concrete ECSClient.send() is structurally a CommandSender; the double
    // assertion bridges the overload set to the loose injection type.
    return new ECSClient(this.clientConfig(region)) as unknown as CommandSender;
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

// --- helpers (scope / ARN / tags / task def / endpoint / errors) -----------

function readScope(scope: unknown): EcsDiscoverScope {
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
 * Extract the cluster name from a service ARN. The long ARN form is
 * `…:service/<cluster>/<service>`; the legacy form `…:service/<service>` omits
 * the cluster (⇒ undefined, the SDK assumes the default cluster).
 */
function clusterFromServiceArn(arn: string): string | undefined {
  const parts = arn.split(':');
  const resource = parts.length >= 6 ? parts.slice(5).join(':') : '';
  const match = /^service\/(.+)$/.exec(resource);
  if (!match) return undefined;
  const segments = match[1].split('/');
  return segments.length >= 2 ? segments[0] : undefined;
}

/** True when the service carries `tagKey` (matching `tagValue` when supplied). */
function serviceTagMatches(svc: Service, tagKey: string, tagValue?: string): boolean {
  const match = (svc.tags ?? []).find((t) => t.key === tagKey);
  if (!match) return false;
  return tagValue !== undefined ? match.value === tagValue : true;
}

/**
 * Assemble `http(s)://<dns>[:port]`. Scheme is https iff the target group
 * Protocol is HTTPS; the port is appended only when present and not the scheme
 * default (80 for http, 443 for https).
 */
function buildLbEndpoint(dnsName: string, protocol?: string, port?: number): string {
  const scheme = (protocol ?? '').toUpperCase() === 'HTTPS' ? 'https' : 'http';
  const defaultPort = scheme === 'https' ? 443 : 80;
  const portSuffix = typeof port === 'number' && port !== defaultPort ? `:${port}` : '';
  return `${scheme}://${dnsName}${portSuffix}`;
}

/**
 * Compact, human-readable Tier-1 summary of the task definition's containers:
 * image, container ports, and env-var NAMES (never values — they may hold
 * secrets). Returns '' when no task definition / no notable facts.
 */
function summarizeTaskDefinition(taskDef: TaskDefinition | undefined): string {
  if (!taskDef) return '';
  const parts: string[] = [];
  for (const container of taskDef.containerDefinitions ?? []) {
    const seg: string[] = [];
    if (container.image) seg.push(`image=${container.image}`);
    const ports = (container.portMappings ?? [])
      .map((p) => p.containerPort)
      .filter((p): p is number => typeof p === 'number');
    if (ports.length > 0) seg.push(`ports=${ports.join(',')}`);
    const envNames = (container.environment ?? [])
      .map((e) => e.name)
      .filter((n): n is string => typeof n === 'string' && n.length > 0);
    if (envNames.length > 0) seg.push(`env=${envNames.join(',')}`);
    if (seg.length > 0) parts.push(`[ecs ${seg.join(' ')}]`);
  }
  return parts.join(' ');
}

/** Trailing segment of an ARN resource, used as a display-name fallback. */
function deriveName(arn: string): string {
  return arn.split(/[/:]/).filter((s) => s.length > 0).pop() ?? arn;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
