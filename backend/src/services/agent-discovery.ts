/**
 * Agent-import discovery sources (US-IMP-002, discovery LOGIC increment).
 *
 * Three entry points used by the import pipeline to turn a pasted reference, an
 * account tag-scan, or a pasted manifest into normalized {@link AgentCandidate}
 * shapes:
 *
 *   - resolveSourceRef(ref)        parse an ARN / URL -> { protocol, substrate, target }
 *   - tagScanDiscover(scope, deps) Resource Groups Tagging API GetResources scan
 *   - candidateFromManifest(json)  validate a pasted manifest -> candidate + descriptor
 *
 * This is the discovery LOGIC only: it produces candidates but never describe()s
 * or invoke()s a target — those flow through the per-protocol adapters in
 * ../adapters/agent-source. The injected CommandSender mirrors the adapter
 * testability boundary (see lambda-invoke-adapter.ts) so tests run with zero
 * live AWS calls.
 *
 * TODO(agent-import): wire discoverAgents/describeAgentCandidate queries at the
 * next wiring increment.
 */
import {
  ResourceGroupsTaggingAPIClient,
  GetResourcesCommand,
} from '@aws-sdk/client-resource-groups-tagging-api';
import type { GetResourcesCommandOutput } from '@aws-sdk/client-resource-groups-tagging-api';
import type { STSClient } from '@aws-sdk/client-sts';
import type { CommandSender } from '../adapters/agent-source/invoke-support';
import type {
  AgentCandidate,
  AgentInvocationProtocol,
  AgentOrigin,
  AgentSourceAdapter,
} from '../adapters/agent-source/base';
import { EcsSourceAdapter } from '../adapters/agent-source/ecs-source-adapter';
import type { AdapterCredentialProvider } from '../adapters/agent-source/invoke-support';
import { validateImportDescriptor } from '../lambda/agent-config-resolver';
import { assumeRoleCredentials, type AssumedRoleCredentials } from '../utils/trust-path';

const DEFAULT_REGION = process.env.AWS_REGION || 'ap-southeast-2';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown when a source ref resolves to a real AWS substrate that the phase-1
 * import pipeline does not yet support (ECS/EKS/EC2/Step Functions/SageMaker
 * and any other non-phase-1 service). Carries the offending `substrate` so
 * callers — notably {@link tagScanDiscover} — can skip-and-continue rather than
 * abort on the first unsupported resource.
 */
export class UnsupportedSourceError extends Error {
  public readonly substrate: string;

  constructor(substrate: string) {
    super(`${substrate} not supported in phase 1`);
    this.name = 'UnsupportedSourceError';
    this.substrate = substrate;
    // Preserve the prototype chain so `instanceof` holds after transpilation.
    Object.setPrototypeOf(this, UnsupportedSourceError.prototype);
  }
}

/**
 * Thrown when a source ref cannot be parsed at all (not a well-formed ARN, not
 * an http/https/mcp URL), or when a pasted manifest is not valid JSON / fails
 * descriptor validation.
 */
export class InvalidSourceRefError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidSourceRefError';
    Object.setPrototypeOf(this, InvalidSourceRefError.prototype);
  }
}

// ---------------------------------------------------------------------------
// resolveSourceRef
// ---------------------------------------------------------------------------

/** Resolution of a pasted source ref to a phase-1 invocation protocol. */
export interface ResolvedSourceRef {
  protocol: AgentInvocationProtocol;
  substrate: string;
  target: string;
}

/**
 * Parse a pasted ARN or URL and map it to a phase-1 source descriptor.
 *
 * | Input                                         | protocol          | substrate         |
 * |-----------------------------------------------|-------------------|-------------------|
 * | arn:aws:bedrock-agentcore:*:*:runtime/*       | AGENTCORE_RUNTIME | agentcore_runtime |
 * | arn:aws:lambda:*:*:function:*                 | LAMBDA_INVOKE     | lambda            |
 * | arn:aws:bedrock:*:*:agent-alias/* | agent/*   | BEDROCK_AGENT     | bedrock_agent     |
 * | arn:aws:ecs:*:*:service/*                     | HTTP_ENDPOINT     | ecs               |
 * | mcp://… | mcp+http(s)://…                       | MCP               | mcp               |
 * | http(s)://…                                   | HTTP_ENDPOINT     | http              |
 *
 * ECS is a DISCOVERY SUBSTRATE: a service ARN invokes over HTTP_ENDPOINT, but
 * discover/describe are substrate-specific (resolve the service's endpoint).
 *
 * @throws {UnsupportedSourceError} a well-formed ARN whose service is not a
 *   phase-1 substrate (EKS/EC2/Step Functions/SageMaker, a non-service ECS ARN,
 *   or any other).
 * @throws {InvalidSourceRefError} a ref that is neither a well-formed ARN nor a
 *   supported URL scheme.
 */
export function resolveSourceRef(ref: string): ResolvedSourceRef {
  const trimmed = typeof ref === 'string' ? ref.trim() : '';
  if (trimmed.length === 0) {
    throw new InvalidSourceRefError('source ref is empty');
  }

  if (trimmed.startsWith('arn:')) {
    return resolveArn(trimmed);
  }

  const scheme = schemeOf(trimmed);
  if (scheme === 'mcp') {
    return { protocol: 'MCP', substrate: 'mcp', target: trimmed };
  }
  if (scheme === 'mcp+https' || scheme === 'mcp+http') {
    // Explicit MCP flag over an http(s) endpoint: strip the `mcp+` flag so the
    // target is a plain URL the MCP adapter can dial.
    return { protocol: 'MCP', substrate: 'mcp', target: trimmed.slice('mcp+'.length) };
  }
  if (scheme === 'https' || scheme === 'http') {
    return { protocol: 'HTTP_ENDPOINT', substrate: 'http', target: trimmed };
  }

  throw new InvalidSourceRefError(`unrecognised source ref: ${ref}`);
}

/** Lower-cased URI scheme (text before `://`), or '' when there is none. */
function schemeOf(ref: string): string {
  const idx = ref.indexOf('://');
  return idx > 0 ? ref.slice(0, idx).toLowerCase() : '';
}

/**
 * Map an `arn:` reference to a phase-1 protocol/substrate. The ARN layout is
 * `arn:partition:service:region:account:resource…`; the resource segment may
 * itself contain ':' (e.g. lambda `function:name`) so it is re-joined.
 */
function resolveArn(arn: string): ResolvedSourceRef {
  const parts = arn.split(':');
  // arn : partition : service : region : account : resource(+)
  if (parts.length < 6 || parts[0] !== 'arn') {
    throw new InvalidSourceRefError(`malformed ARN: ${arn}`);
  }
  const service = parts[2];
  const resource = parts.slice(5).join(':');

  if (service === 'bedrock-agentcore' && resource.startsWith('runtime/')) {
    return { protocol: 'AGENTCORE_RUNTIME', substrate: 'agentcore_runtime', target: arn };
  }
  if (service === 'lambda' && resource.startsWith('function:')) {
    return { protocol: 'LAMBDA_INVOKE', substrate: 'lambda', target: arn };
  }
  if (
    service === 'bedrock' &&
    (resource.startsWith('agent-alias/') || resource.startsWith('agent/'))
  ) {
    return { protocol: 'BEDROCK_AGENT', substrate: 'bedrock_agent', target: arn };
  }

  // Recognised phase-1 service but the wrong resource shape (e.g. a lambda
  // layer, a bedrock foundation-model) is a genuine paste error, not an
  // unsupported substrate.
  if (service === 'lambda' || service === 'bedrock' || service === 'bedrock-agentcore') {
    throw new InvalidSourceRefError(`unsupported ${service} resource: ${resource}`);
  }

  // ECS is a DISCOVERY SUBSTRATE (US-IMP-018): a SERVICE ARN resolves to an
  // HTTP_ENDPOINT invocation — the service is reached over HTTP, while
  // discover/describe are substrate-specific (they resolve the service's
  // endpoint via the load balancer / `citadel:endpoint` tag). Non-service ECS
  // ARNs (task, task-definition, cluster) stay unsupported below.
  if (service === 'ecs' && resource.startsWith('service/')) {
    return { protocol: 'HTTP_ENDPOINT', substrate: 'ecs', target: arn };
  }

  // Any other AWS service (EKS/EC2/Step Functions/SageMaker, SQS, non-service
  // ECS, …) is a well-formed but unsupported substrate — typed so tag-scans
  // skip-and-continue.
  throw new UnsupportedSourceError(service);
}

// ---------------------------------------------------------------------------
// tagScanDiscover
// ---------------------------------------------------------------------------

/** Account-scan scope for {@link tagScanDiscover}. */
export interface TagScanScope {
  region?: string;
  tagKey?: string;
  tagValue?: string;
  /**
   * Operator-supplied READ-ONLY discovery role in the TARGET account. When set,
   * {@link tagScanDiscover} assumes it (externalId-gated) and runs the
   * GetResources scan in THAT account. Absent ⇒ same-account scan under the
   * caller's identity (byte-identical to the pre-Phase-2 behaviour). The role
   * must trust Citadel and the external id.
   */
  discoveryRoleArn?: string;
  /** STS ExternalId forwarded when assuming {@link discoveryRoleArn}. */
  discoveryExternalId?: string;
}

/** Injectable dependencies (mirrors the adapter testability boundary). */
export interface TagScanDeps {
  /** Tagging-API sender; tests inject a fake, production builds a client. */
  sender?: CommandSender;
  /**
   * Factory building a tagging-API sender, receiving the assumed credentials on
   * the cross-account path (and `undefined` on the same-account path). Used to
   * wire a cross-account `ResourceGroupsTaggingAPIClient`; defaults to building
   * a real client. Takes precedence over `sender` when provided — tests inject
   * it to observe the credentials handed to the client.
   */
  senderFactory?: (
    region: string,
    credentials?: AssumedRoleCredentials,
  ) => CommandSender;
  /** STS client for the cross-account assume; tests inject a fake. */
  stsClient?: STSClient;
  /** Clock for `discoveredAt`; defaults to `() => new Date()`. */
  now?: () => Date;
  /** Logger for skipped (unsupported) resources; defaults to `console`. */
  logger?: Pick<Console, 'warn'>;
}

/**
 * Enumerate importable agent candidates by scanning an account via the
 * Resource Groups Tagging API `GetResources`, filtered to a single tag
 * (default `citadel:agent=true`). Each returned `ResourceARN` is mapped through
 * {@link resolveSourceRef}; resources on a substrate unsupported in phase 1 are
 * logged and skipped (never fatal). Pagination follows `PaginationToken` (the
 * API returns an empty-string token on the final page).
 *
 * CROSS-ACCOUNT (Phase-2): when `scope.discoveryRoleArn` is set, an
 * operator-supplied READ-ONLY discovery role in the TARGET account is assumed
 * (externalId-gated via {@link assumeRoleCredentials}) and the tagging-API
 * client is built WITH those temporary credentials, so the scan runs in the
 * target account. When absent the behaviour is EXACTLY as before: the default
 * client under the caller's (Lambda) identity. A failed assume yields an empty
 * result with a credential-free warning rather than crashing the caller; the
 * assumed credentials are never logged.
 */
export async function tagScanDiscover(
  scope: TagScanScope,
  deps: TagScanDeps = {},
): Promise<AgentCandidate[]> {
  const region = scope.region ?? DEFAULT_REGION;
  const now = deps.now ?? ((): Date => new Date());
  const logger = deps.logger ?? console;

  // Cross-account: assume the operator-supplied READ-ONLY discovery role in the
  // TARGET account (externalId-gated) so the scan runs THERE. Absent ⇒ same
  // account: no assume, no credentials — byte-identical to the prior behaviour.
  let credentials: AssumedRoleCredentials | undefined;
  if (scope.discoveryRoleArn) {
    try {
      credentials = await assumeRoleCredentials(
        scope.discoveryRoleArn,
        scope.discoveryExternalId,
        { stsClient: deps.stsClient, sessionNamePrefix: 'import-tagscan' },
      );
    } catch (err) {
      // A failed cross-account assume yields an EMPTY scan rather than crashing
      // the resolver. The warning names the role (NEVER the credentials) so the
      // misconfiguration is diagnosable.
      logger.warn(
        `agent-discovery: cross-account discovery-role assume failed for ${scope.discoveryRoleArn}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return [];
    }
  }

  const sender: CommandSender = deps.senderFactory
    ? deps.senderFactory(region, credentials)
    : deps.sender ?? buildTaggingSender(region, credentials);

  const tagKey = scope.tagKey ?? 'citadel:agent';
  const values = scope.tagValue ? [scope.tagValue] : ['true'];
  const tagFilters = [{ Key: tagKey, Values: values }];

  const candidates: AgentCandidate[] = [];
  let paginationToken: string | undefined;

  do {
    const out = (await sender.send(
      new GetResourcesCommand({
        TagFilters: tagFilters,
        PaginationToken: paginationToken,
      }),
    )) as GetResourcesCommandOutput;

    for (const mapping of out.ResourceTagMappingList ?? []) {
      const arn = mapping.ResourceARN;
      if (!arn) continue;
      try {
        const { substrate } = resolveSourceRef(arn);
        const { region: arnRegion, account } = parseArnFields(arn);
        candidates.push({
          origin: {
            sourceArn: arn,
            substrate,
            region: arnRegion ?? region,
            account,
            discoveredAt: now().toISOString(),
            ownership: 'external',
          },
          displayName: deriveDisplayName(arn),
          reference: arn,
        });
      } catch (err) {
        if (err instanceof UnsupportedSourceError) {
          logger.warn(
            `agent-discovery: skipping unsupported source ${arn} (${err.message})`,
          );
          continue;
        }
        throw err;
      }
    }

    // The tagging API signals "no more pages" with an empty-string token.
    paginationToken =
      out.PaginationToken && out.PaginationToken.length > 0
        ? out.PaginationToken
        : undefined;
  } while (paginationToken);

  return candidates;
}

// ---------------------------------------------------------------------------
// candidateFromManifest
// ---------------------------------------------------------------------------

/** Output of {@link candidateFromManifest}: a candidate plus the validated descriptor. */
export interface ManifestCandidate {
  candidate: AgentCandidate;
  descriptor: unknown;
}

/** Protocol -> substrate fallback used when a manifest omits origin.substrate. */
const PROTOCOL_SUBSTRATE: Record<AgentInvocationProtocol, string> = {
  AGENTCORE_RUNTIME: 'agentcore_runtime',
  BEDROCK_AGENT: 'bedrock_agent',
  LAMBDA_INVOKE: 'lambda',
  HTTP_ENDPOINT: 'http',
  MCP: 'mcp',
  A2A: 'a2a',
  STEP_FUNCTIONS: 'step_functions',
  SAGEMAKER_ENDPOINT: 'sagemaker_endpoint',
  SQS_ASYNC: 'sqs_async',
};

/**
 * Turn a pasted manifest (JSON string or already-parsed object) into an
 * {@link AgentCandidate} plus the validated descriptor. The manifest is
 * validated with {@link validateImportDescriptor} (reused from the resolver, the
 * single source of truth for import-descriptor rules); `ownership` is forced to
 * 'external' on the produced candidate — Citadel never owns an imported agent.
 *
 * @throws {InvalidSourceRefError} on malformed JSON, or on a manifest that fails
 *   descriptor validation (the message lists the offending fields).
 */
export function candidateFromManifest(manifestJson: string | object): ManifestCandidate {
  let parsed: unknown;
  if (typeof manifestJson === 'string') {
    try {
      parsed = JSON.parse(manifestJson);
    } catch (err) {
      throw new InvalidSourceRefError(
        `manifest is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } else {
    parsed = manifestJson;
  }

  const validation = validateImportDescriptor(parsed);
  if (!validation.valid) {
    throw new InvalidSourceRefError(
      `invalid import manifest: ${validation.errors.join('; ')}`,
    );
  }

  // Validation guarantees invocation.protocol (one of the nine protocols),
  // invocation.target (non-empty), and origin.ownership === 'external'.
  const root = parsed as Record<string, unknown>;
  const invocation = root.invocation as { protocol: AgentInvocationProtocol; target: string };
  const originBlock = isPlainObject(root.origin) ? root.origin : {};

  const substrate =
    asString(originBlock.substrate) ?? PROTOCOL_SUBSTRATE[invocation.protocol];

  const origin: AgentOrigin = {
    sourceArn: asString(originBlock.sourceArn),
    account: asString(originBlock.account),
    region: asString(originBlock.region),
    substrate,
    discoveredAt: asString(originBlock.discoveredAt) ?? new Date().toISOString(),
    ownership: 'external', // forced — invariant 1
  };

  const reference = origin.sourceArn ?? invocation.target;
  const displayName =
    asString(root.displayName) ?? asString(root.name) ?? deriveDisplayName(reference);

  return {
    candidate: { origin, displayName, reference },
    descriptor: parsed,
  };
}

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

/**
 * Build the ResourceGroupsTaggingAPI sender. On the same-account path
 * (`credentials` undefined) the client config is exactly `{ region }` —
 * byte-identical to the pre-Phase-2 client. On the cross-account path the
 * assumed temporary credentials are wired in so `GetResources` runs in the
 * target account. The credentials are passed straight to the SDK client config
 * and are never logged.
 */
function buildTaggingSender(
  region: string,
  credentials?: AssumedRoleCredentials,
): CommandSender {
  const client = credentials
    ? new ResourceGroupsTaggingAPIClient({
        region,
        credentials: {
          accessKeyId: credentials.accessKeyId,
          secretAccessKey: credentials.secretAccessKey,
          sessionToken: credentials.sessionToken,
        },
      })
    : new ResourceGroupsTaggingAPIClient({ region });
  return client as unknown as CommandSender;
}

/** Standard ARN field extraction: `arn:partition:service:region:account:…`. */
function parseArnFields(arn: string): { region?: string; account?: string } {
  const parts = arn.split(':');
  if (parts[0] !== 'arn' || parts.length < 6) return {};
  return { region: parts[3] || undefined, account: parts[4] || undefined };
}

/**
 * Human-readable display name derived from a ref: the trailing segment of an
 * ARN resource (e.g. `function:my-agent` -> `my-agent`, `runtime/abc` -> `abc`)
 * or the last URL path segment, falling back to the ref itself.
 */
function deriveDisplayName(ref: string): string {
  if (ref.startsWith('arn:')) {
    const parts = ref.split(':');
    const resource = parts.length >= 6 ? parts.slice(5).join(':') : ref;
    const tail = resource.split(/[/:]/).filter((s) => s.length > 0).pop();
    return tail ?? ref;
  }
  try {
    const url = new URL(ref);
    const seg = url.pathname.split('/').filter((s) => s.length > 0).pop();
    return seg ?? url.host ?? ref;
  } catch {
    return ref;
  }
}

/** Narrowing guard: true when `value` is a non-null, non-array object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Returns `value` when it is a non-empty string, else `undefined`. */
function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

// ---------------------------------------------------------------------------
// Discovery-substrate dispatch (US-IMP-018)
// ---------------------------------------------------------------------------

/** Optional dependencies threaded into a substrate discovery adapter. */
export interface DiscoveryAdapterDeps {
  /**
   * Cross-account assumed credentials (READ-ONLY discovery role). Threaded into
   * the substrate adapter's AWS SDK clients so describe/healthCheck run in the
   * TARGET account. Absent ⇒ the default provider chain (same-account).
   */
  credentialProvider?: AdapterCredentialProvider;
}

/**
 * Resolve the DISCOVERY adapter for a substrate, or `undefined` when the
 * substrate has no substrate-specific discovery adapter (it is described
 * through the protocol-keyed registry instead).
 *
 * A DISCOVERY SUBSTRATE is one whose discover/describe/healthCheck are
 * substrate-specific — e.g. ECS resolves the service's HTTP endpoint from its
 * load balancer / `citadel:endpoint` tag — even though the produced candidate
 * INVOKES through a standard protocol (HTTP_ENDPOINT for ECS). This is the
 * single substrate→adapter dispatch point so `describeAgentCandidate` can route
 * by substrate; it mirrors the protocol-keyed
 * {@link AgentSourceAdapterRegistry}. Future substrates (EKS/EC2) add a case
 * here.
 */
export function getDiscoveryAdapterForSubstrate(
  substrate: string,
  deps: DiscoveryAdapterDeps = {},
): AgentSourceAdapter | undefined {
  switch (substrate) {
    case 'ecs':
      return new EcsSourceAdapter({ credentialProvider: deps.credentialProvider });
    default:
      return undefined;
  }
}
