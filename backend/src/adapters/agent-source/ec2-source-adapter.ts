/**
 * EC2 source adapter (US-IMP-020).
 *
 * EC2 is a DISCOVERY SUBSTRATE, not an invocation protocol. discover/describe/
 * healthCheck enumerate running EC2 INSTANCES and resolve each instance's AGENT
 * HTTP endpoint (a `citadel:endpoint` instance tag, the DNS of a load balancer
 * the instance is a registered target of, or — failing both — the instance's
 * PRIVATE DNS/IP with an operator note, or empty). The produced candidate's
 * INVOCATION protocol is HTTP_ENDPOINT, so invoke()/test flow through the
 * existing HttpEndpointAdapter — this adapter's invoke() and vendCredentials()
 * are {@link NotImplementedError} stubs (there is no AWS "invoke" action for an
 * EC2-hosted agent; reaching it is plain HTTP).
 *
 * Reachability of PRIVATE endpoints (VPC-internal hosts) is a separate concern
 * (US-IMP-017) — healthCheck here only probes an ABSOLUTE http(s) URL; a bare
 * private host (no scheme/port) is treated as not-probeable.
 *
 * NOTE the differences from EKS/ECS: ec2 DescribeInstances returns RESERVATIONS
 * (each with an `OwnerId` used as the candidate account) wrapping Instances; the
 * instance ARN is CONSTRUCTED (`arn:aws:ec2:<region>:<OwnerId>:instance/<id>`);
 * EC2 instance `Tags` is a {Key,Value}[] array. Tier-1 describe surfaces only
 * safe metadata (instance type / platform / architecture / Name tag); it NEVER
 * emits user-data, the SSH key-pair name, or any secret/key material — and it
 * NEVER guesses a port for a private host.
 *
 * The EC2 + ELBv2 SDK clients and global fetch are injected for testability,
 * mirroring the ECS/EKS source adapters. A cross-account `credentialProvider`
 * (assumed READ-ONLY discovery role) is threaded into both SDK clients so
 * describe runs in the target account; absent ⇒ the default provider chain
 * (same-account).
 */
import { EC2Client, DescribeInstancesCommand } from '@aws-sdk/client-ec2';
import type {
  DescribeInstancesCommandOutput,
  Instance,
  Filter,
  Tag,
} from '@aws-sdk/client-ec2';
import {
  ElasticLoadBalancingV2Client,
  DescribeTargetGroupsCommand,
  DescribeTargetHealthCommand,
  DescribeLoadBalancersCommand,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import type {
  DescribeTargetGroupsCommandOutput,
  DescribeTargetHealthCommandOutput,
  DescribeLoadBalancersCommandOutput,
  TargetGroup,
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

/** Resource tag an operator can set to declare an instance's agent endpoint. */
const ENDPOINT_TAG = 'citadel:endpoint';

/** Note appended when no agent endpoint could be resolved at all (precedence d). */
const NO_ENDPOINT_NOTE =
  'no invocation endpoint could be resolved from the EC2 instance — the operator ' +
  'must supply the endpoint at import';

/** Optional discovery scope for {@link Ec2SourceAdapter.discover}. */
interface Ec2DiscoverScope {
  region?: string;
  account?: string;
  tagKey?: string;
  tagValue?: string;
}

/** Resolved agent endpoint plus an optional operator note for the description. */
interface ResolvedEndpoint {
  /** The invocation target: an absolute URL, a bare private host, or ''. */
  target: string;
  /** Operator-facing note (port/scheme must be supplied, or nothing resolved). */
  note?: string;
}

/**
 * Injectable dependencies. All optional: production omits them (real clients +
 * global fetch); tests inject `{ ec2Sender, elbSender, fetchFn }` doubles.
 */
export interface Ec2SourceAdapterDeps {
  /** EC2 control sender; tests inject a fake, production builds an EC2Client. */
  ec2Sender?: CommandSender;
  /** ELBv2 control sender; tests inject a fake, production builds the client. */
  elbSender?: CommandSender;
  /** Reachability probe; defaults to late-bound global fetch (test stub honoured). */
  fetchFn?: typeof fetch;
  defaultRegion?: string;
  defaultAccount?: string;
  /**
   * Cross-account assumed credentials (READ-ONLY discovery role). When set, the
   * EC2 + ELBv2 clients are built with these so describe runs in the target
   * account. Absent ⇒ the default provider chain (same-account, unchanged).
   */
  credentialProvider?: AdapterCredentialProvider;
}

export class Ec2SourceAdapter implements AgentSourceAdapter {
  /**
   * The protocol the described candidate is INVOKED through. EC2 is a discovery
   * substrate whose candidates invoke over HTTP, so this is HTTP_ENDPOINT — the
   * adapter is dispatched by SUBSTRATE (not via the protocol registry), and its
   * own invoke() is a NotImplemented stub.
   */
  public readonly protocol: AgentInvocationProtocol = 'HTTP_ENDPOINT';

  private readonly fetchFn: typeof fetch;

  constructor(private readonly deps: Ec2SourceAdapterDeps = {}) {
    // Late-bind to the current global fetch so test stubs are honoured.
    this.fetchFn = deps.fetchFn ?? ((input, init) => globalThis.fetch(input, init));
  }

  /**
   * Enumerate running EC2 instances as candidates: DescribeInstances filtered to
   * `instance-state-name=running` (plus `tag:<key>=<value>` when scope.tagKey is
   * set), paginated via NextToken. Each instance across every Reservation
   * becomes a candidate on substrate 'ec2'; the source ARN is CONSTRUCTED from
   * the region, the Reservation's OwnerId (the owning account), and the
   * InstanceId. The display name is the `Name` tag, falling back to the
   * InstanceId.
   */
  async discover(scope: unknown): Promise<AgentCandidate[]> {
    const s = readScope(scope);
    const region = s.region ?? this.deps.defaultRegion ?? DEFAULT_REGION;
    const ec2 = this.ec2Client(region);
    const discoveredAt = new Date().toISOString();
    const filters = buildInstanceFilters(s);

    const candidates: AgentCandidate[] = [];
    let nextToken: string | undefined;
    do {
      const out = (await ec2.send(
        new DescribeInstancesCommand({ Filters: filters, NextToken: nextToken }),
      )) as DescribeInstancesCommandOutput;
      for (const reservation of out.Reservations ?? []) {
        const account = reservation.OwnerId ?? s.account ?? this.deps.defaultAccount;
        for (const instance of reservation.Instances ?? []) {
          const instanceId = instance.InstanceId;
          if (!instanceId) continue;
          const arn = buildInstanceArn(region, reservation.OwnerId, instanceId);
          candidates.push({
            origin: {
              sourceArn: arn,
              substrate: 'ec2',
              region,
              account,
              discoveredAt,
              ownership: 'external',
            },
            displayName: nameTag(instance.Tags) ?? instanceId,
            reference: arn,
          });
        }
      }
      nextToken = out.NextToken;
    } while (nextToken);
    return candidates;
  }

  /**
   * Resolve an instance ARN to a Tier-1 capability descriptor:
   *   - DescribeInstances supplies low-confidence inferred facts (instance type
   *     / platform / architecture / Name tag — metadata only, NEVER user-data,
   *     the SSH key-pair name, or any secret).
   *   - The AGENT HTTP endpoint is resolved by precedence: the `citadel:endpoint`
   *     tag (operator hint) -> the DNS of a load balancer the instance is a
   *     registered target of (DescribeTargetGroups -> DescribeTargetHealth match
   *     -> DescribeLoadBalancers DNSName) -> the instance's PRIVATE DNS/IP with
   *     an operator note that the scheme/port must be supplied (no port guessed)
   *     -> empty + an operator note.
   *
   * The invocation is ALWAYS HTTP_ENDPOINT/NONE/sync (invoke flows through the
   * HTTP adapter). All inferred fields are 'low'.
   */
  async describe(ref: AgentRef): Promise<AgentCapabilityDescriptor> {
    const instanceArn = refToString(ref);
    const parsed = parseArn(instanceArn);
    const region = parsed.region ?? this.deps.defaultRegion ?? DEFAULT_REGION;
    const account = parsed.account ?? this.deps.defaultAccount;
    const instanceId = instanceIdFromArn(instanceArn) ?? instanceArn;
    const ec2 = this.ec2Client(region);

    const instance = await this.resolveInstance(ec2, instanceId);
    const endpoint = await this.resolveEndpoint(instance, instanceId, region);

    const tierOne = summarizeInstance(instance);
    const description = [tierOne, endpoint.note ?? '']
      .filter((part) => part.length > 0)
      .join(' ');

    const invocation: AgentInvocationBlock = {
      protocol: 'HTTP_ENDPOINT',
      target: endpoint.target,
      auth: { mode: 'NONE' },
      mode: 'sync',
      region,
      account,
    };
    const origin: AgentOrigin = {
      sourceArn: instanceArn,
      substrate: 'ec2',
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
      name: nameTag(instance?.Tags) ?? deriveName(instanceArn),
      version: '1',
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
   * Best-effort reachability probe. When the resolved endpoint is an ABSOLUTE
   * http(s) URL, GET it: a 2xx -> reachable; a non-2xx or network error ->
   * { reachable: false, detail } WITHOUT throwing. A bare private host (no
   * scheme/port) is not probeable -> { reachable: false } with NO network call
   * (private-endpoint reachability is US-IMP-017's job). When NO endpoint
   * resolves, return { reachable: false, detail: 'no endpoint resolved' } with
   * no network call.
   */
  async healthCheck(ref: AgentRef): Promise<HealthCheckResult> {
    const instanceArn = refToString(ref);
    const region = parseArn(instanceArn).region ?? this.deps.defaultRegion ?? DEFAULT_REGION;
    const instanceId = instanceIdFromArn(instanceArn) ?? instanceArn;
    const ec2 = this.ec2Client(region);
    const instance = await this.resolveInstance(ec2, instanceId);
    const endpoint = await this.resolveEndpoint(instance, instanceId, region);
    if (!endpoint.target) {
      return { reachable: false, detail: 'no endpoint resolved' };
    }
    if (!isAbsoluteHttpUrl(endpoint.target)) {
      // A bare private host without a scheme/port cannot be probed here.
      return {
        reachable: false,
        detail: 'endpoint is not an absolute http(s) URL — operator must supply scheme/port',
      };
    }
    try {
      const res = await this.fetchFn(endpoint.target, { method: 'GET' });
      if (res.ok) return { reachable: true };
      return { reachable: false, detail: `HTTP ${res.status}` };
    } catch (err) {
      return { reachable: false, detail: errMessage(err) };
    }
  }

  /**
   * Not applicable: EC2 candidates invoke over HTTP_ENDPOINT, which needs no
   * AWS invoke role to vend.
   */
  async vendCredentials(_invocation: AgentInvocationBlock): Promise<VendedCredentials> {
    throw new NotImplementedError(
      'Ec2SourceAdapter.vendCredentials: EC2 candidates invoke via HTTP_ENDPOINT — no AWS invoke role',
    );
  }

  /**
   * Not applicable: invoke/test for an EC2 candidate flow through the existing
   * HTTP_ENDPOINT adapter (the candidate's invocation protocol), never this
   * discovery adapter.
   */
  async invoke(_req: InvokeRequest, _descriptor: AgentCapabilityDescriptor): Promise<InvokeResponse> {
    throw new NotImplementedError(
      'Ec2SourceAdapter.invoke: EC2 candidates invoke via the HTTP_ENDPOINT adapter',
    );
  }

  // --- management-path helpers ---------------------------------------------

  /** Describe a single instance by id, flattening Reservations -> Instances. */
  private async resolveInstance(
    ec2: CommandSender,
    instanceId: string,
  ): Promise<Instance | undefined> {
    const out = (await ec2.send(
      new DescribeInstancesCommand({ InstanceIds: [instanceId] }),
    )) as DescribeInstancesCommandOutput;
    let first: Instance | undefined;
    for (const reservation of out.Reservations ?? []) {
      for (const instance of reservation.Instances ?? []) {
        if (first === undefined) first = instance;
        if (instance.InstanceId === instanceId) return instance;
      }
    }
    return first;
  }

  /**
   * Resolve the instance's AGENT HTTP endpoint by precedence:
   *   (a) `citadel:endpoint` tag (absolute URL) ->
   *   (b) the DNS of a load balancer the instance is a registered target of
   *       (`http(s)://<dns>`) ->
   *   (c) the instance PRIVATE DNS/IP (bare host, + operator note) ->
   *   (d) '' (+ operator note).
   * Pure read; never throws for "absent".
   */
  private async resolveEndpoint(
    instance: Instance | undefined,
    instanceId: string,
    region: string,
  ): Promise<ResolvedEndpoint> {
    if (!instance) return { target: '', note: NO_ENDPOINT_NOTE };

    // (a) explicit operator hint.
    const explicit = endpointTag(instance.Tags);
    if (explicit) return { target: explicit };

    // (b) best-effort: a load balancer this instance is a registered target of.
    const lbEndpoint = await this.resolveInstanceLbEndpoint(instanceId, region);
    if (lbEndpoint) return { target: lbEndpoint };

    // (c) private host only — the operator must supply the scheme and port (we
    // deliberately do NOT guess a port).
    const privateHost = instance.PrivateDnsName || instance.PrivateIpAddress;
    if (privateHost) {
      return {
        target: privateHost,
        note:
          `only a private host (${privateHost}) was resolved from the EC2 instance — ` +
          'the operator must supply the scheme and port at import',
      };
    }

    // (d) nothing resolved.
    return { target: '', note: NO_ENDPOINT_NOTE };
  }

  /**
   * Best-effort: DescribeTargetGroups (paginated) -> for each group, check via
   * DescribeTargetHealth whether this instance is a registered target -> the
   * group's first LoadBalancerArn -> DescribeLoadBalancers DNSName ->
   * `http(s)://<dns>[:port]` (scheme/port from the target group). Returns
   * undefined when the instance is not registered in any group.
   */
  private async resolveInstanceLbEndpoint(
    instanceId: string,
    region: string,
  ): Promise<string | undefined> {
    const elb = this.elbClient(region);
    const targetGroups = await this.describeAllTargetGroups(elb);
    for (const tg of targetGroups) {
      const tgArn = tg.TargetGroupArn;
      if (!tgArn) continue;
      if (!(await this.instanceRegisteredIn(elb, tgArn, instanceId))) continue;
      const lbArn = (tg.LoadBalancerArns ?? [])[0];
      if (!lbArn) continue;
      const dns = await this.loadBalancerDns(elb, lbArn);
      if (dns) return buildLbEndpoint(dns, tg.Protocol, tg.Port);
    }
    return undefined;
  }

  /** Enumerate every target group in the region, paginating via Marker. */
  private async describeAllTargetGroups(elb: CommandSender): Promise<TargetGroup[]> {
    const groups: TargetGroup[] = [];
    let marker: string | undefined;
    do {
      const out = (await elb.send(
        new DescribeTargetGroupsCommand({ Marker: marker }),
      )) as DescribeTargetGroupsCommandOutput;
      groups.push(...(out.TargetGroups ?? []));
      marker = out.NextMarker;
    } while (marker);
    return groups;
  }

  /** True when `instanceId` is a registered target of the target group. */
  private async instanceRegisteredIn(
    elb: CommandSender,
    targetGroupArn: string,
    instanceId: string,
  ): Promise<boolean> {
    const out = (await elb.send(
      new DescribeTargetHealthCommand({ TargetGroupArn: targetGroupArn }),
    )) as DescribeTargetHealthCommandOutput;
    return (out.TargetHealthDescriptions ?? []).some(
      (desc) => desc.Target?.Id === instanceId,
    );
  }

  /** Resolve a load balancer ARN to its DNSName, when present. */
  private async loadBalancerDns(
    elb: CommandSender,
    lbArn: string,
  ): Promise<string | undefined> {
    const out = (await elb.send(
      new DescribeLoadBalancersCommand({ LoadBalancerArns: [lbArn] }),
    )) as DescribeLoadBalancersCommandOutput;
    return (out.LoadBalancers ?? [])[0]?.DNSName;
  }

  private ec2Client(region: string): CommandSender {
    if (this.deps.ec2Sender) return this.deps.ec2Sender;
    // The concrete EC2Client.send() is structurally a CommandSender; the double
    // assertion bridges the overload set to the loose injection type.
    return new EC2Client(this.clientConfig(region)) as unknown as CommandSender;
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

// --- helpers (scope / ARN / tags / instance summary / endpoint / errors) ---

function readScope(scope: unknown): Ec2DiscoverScope {
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
 * Build the DescribeInstances filters: always `instance-state-name=running`,
 * plus `tag:<key>=<value>` when scope.tagKey is set (any value — EC2 wildcard
 * `*` — when tagValue is omitted).
 */
function buildInstanceFilters(s: Ec2DiscoverScope): Filter[] {
  const filters: Filter[] = [{ Name: 'instance-state-name', Values: ['running'] }];
  if (s.tagKey) {
    filters.push({
      Name: `tag:${s.tagKey}`,
      Values: s.tagValue !== undefined ? [s.tagValue] : ['*'],
    });
  }
  return filters;
}

/**
 * Construct an EC2 instance ARN from its region, owning account (the
 * Reservation's OwnerId) and InstanceId. The account segment is left empty when
 * the OwnerId is absent (rare; the candidate still references a valid resource
 * path).
 */
function buildInstanceArn(
  region: string,
  ownerId: string | undefined,
  instanceId: string,
): string {
  return `arn:aws:ec2:${region}:${ownerId ?? ''}:instance/${instanceId}`;
}

/**
 * Extract the instance id from an instance ARN. The EC2 instance ARN form is
 * `…:instance/<id>`; anything else (vpc/security-group/volume, malformed) ⇒
 * undefined.
 */
function instanceIdFromArn(arn: string): string | undefined {
  const parts = arn.split(':');
  const resource = parts.length >= 6 ? parts.slice(5).join(':') : '';
  const match = /^instance\/(.+)$/.exec(resource);
  return match ? match[1] : undefined;
}

/** Value of the `Name` tag (EC2 {Key,Value}[] array), when non-empty. */
function nameTag(tags: Tag[] | undefined): string | undefined {
  const t = (tags ?? []).find((x) => x.Key === 'Name');
  return t?.Value && t.Value.length > 0 ? t.Value : undefined;
}

/** Value of the `citadel:endpoint` tag (EC2 {Key,Value}[] array), when non-empty. */
function endpointTag(tags: Tag[] | undefined): string | undefined {
  const t = (tags ?? []).find((x) => x.Key === ENDPOINT_TAG);
  return t?.Value && t.Value.length > 0 ? t.Value : undefined;
}

/** True when `target` already carries an http/https scheme (probeable URL). */
function isAbsoluteHttpUrl(target: string): boolean {
  return /^https?:\/\//i.test(target);
}

/**
 * Assemble `http(s)://<dns>[:port]`. Scheme is https iff the target group
 * Protocol is HTTPS; the port is appended only when present and not the scheme
 * default (80 for http, 443 for https). Mirrors the ECS adapter's helper.
 */
function buildLbEndpoint(dnsName: string, protocol?: string, port?: number): string {
  const scheme = (protocol ?? '').toUpperCase() === 'HTTPS' ? 'https' : 'http';
  const defaultPort = scheme === 'https' ? 443 : 80;
  const portSuffix = typeof port === 'number' && port !== defaultPort ? `:${port}` : '';
  return `${scheme}://${dnsName}${portSuffix}`;
}

/**
 * Compact, human-readable Tier-1 summary of SAFE instance metadata: instance
 * type, platform, architecture, and the Name tag. Deliberately excludes
 * user-data, the SSH key-pair name (KeyName), IAM instance profile, security
 * groups, and every tag value other than Name — none of which is safe to
 * surface. Returns '' when there is no instance / no notable facts.
 */
function summarizeInstance(instance: Instance | undefined): string {
  if (!instance) return '';
  const seg: string[] = [];
  if (instance.InstanceType) seg.push(`instanceType=${String(instance.InstanceType)}`);
  const platform = instance.PlatformDetails ?? instance.Platform;
  if (platform) seg.push(`platform=${String(platform)}`);
  if (instance.Architecture) seg.push(`architecture=${String(instance.Architecture)}`);
  const name = nameTag(instance.Tags);
  if (name) seg.push(`name=${name}`);
  return seg.length > 0 ? `[ec2 ${seg.join(' ')}]` : '';
}

/** Trailing segment of an ARN resource, used as a display-name fallback. */
function deriveName(arn: string): string {
  return arn.split(/[/:]/).filter((s) => s.length > 0).pop() ?? arn;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
