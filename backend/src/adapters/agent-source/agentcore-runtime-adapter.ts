/**
 * AGENTCORE_RUNTIME adapter.
 *
 * Invokes a Bedrock AgentCore runtime via InvokeAgentRuntimeCommand against
 * `descriptor.invocation.target` — the same client pattern the legacy
 * agent-message-handler uses. Only invoke() is implemented for now.
 */
import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import {
  BedrockAgentCoreControlClient,
  ListAgentRuntimesCommand,
  GetAgentRuntimeCommand,
} from '@aws-sdk/client-bedrock-agentcore-control';
import type {
  ListAgentRuntimesCommandOutput,
  GetAgentRuntimeCommandOutput,
} from '@aws-sdk/client-bedrock-agentcore-control';
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
  JsonSchema,
  VendedCredentials,
} from './base';
import type { RegistryService } from '../../services/registry-service';
import { NotImplementedError } from './not-implemented';
import type { CommandSender } from './invoke-support';
import { NO_RESPONSE_TEXT, extractTextOutput, isAsyncIterable } from './invoke-support';

const DEFAULT_REGION = process.env.AWS_REGION || 'ap-southeast-2';

/** Optional discovery scope for {@link AgentCoreRuntimeAdapter.discover}. */
interface AgentCoreDiscoverScope {
  region?: string;
  account?: string;
}

/**
 * Injectable dependencies for the control-plane path
 * (discover/describe/healthCheck). All optional so the legacy single-arg
 * construction used by the dispatcher (invoke-only) keeps working.
 */
export interface AgentCoreRuntimeAdapterDeps {
  /** Control-plane sender; tests inject a fake, production builds a client. */
  controlSender?: CommandSender;
  /** Optional registry reader used to enrich describe() from a manifest. */
  registry?: Pick<RegistryService, 'listResources' | 'deserializeCustomMetadata'>;
  defaultRegion?: string;
  defaultAccount?: string;
}

export class AgentCoreRuntimeAdapter implements AgentSourceAdapter {
  public readonly protocol: AgentInvocationProtocol = 'AGENTCORE_RUNTIME';

  /**
   * @param sender Optional data-plane sender for invoke() (tests inject a fake).
   * @param deps   Optional control-plane deps for discover/describe/healthCheck.
   */
  constructor(
    private readonly sender?: CommandSender,
    private readonly deps: AgentCoreRuntimeAdapterDeps = {},
  ) {}

  async invoke(
    req: InvokeRequest,
    descriptor: AgentCapabilityDescriptor,
  ): Promise<InvokeResponse> {
    const { target, region } = descriptor.invocation;

    const payload = JSON.stringify({
      prompt: req.prompt,
      session_id: req.sessionId,
      ...(req.attributes && Object.keys(req.attributes).length > 0
        ? { sessionAttributes: req.attributes }
        : {}),
    });

    const command = new InvokeAgentRuntimeCommand({
      agentRuntimeArn: target,
      runtimeSessionId: req.sessionId,
      payload,
      qualifier: 'DEFAULT',
    });

    const response = this.sender
      ? await this.sender.send(command)
      : await new BedrockAgentCoreClient({ region: region || DEFAULT_REGION }).send(command);

    return { output: await parseRuntimeResponse(response), raw: response };
  }

  /**
   * Enumerate importable AgentCore runtimes within an optional region/account
   * scope by paginating ListAgentRuntimes. Each runtime maps to one candidate
   * whose `reference` is the runtime ARN (later resolved by describe()/invoke()).
   *
   * ListAgentRuntimeEndpoints is intentionally NOT called here: the
   * substrate-agnostic AgentCandidate carries no endpoint field, the invoke
   * target is the runtime ARN (not an endpoint ARN), and a per-runtime endpoint
   * call would be an N+1 with no effect on the candidate shape.
   */
  async discover(scope: unknown): Promise<AgentCandidate[]> {
    const s = readScope(scope);
    const region = s.region ?? this.deps.defaultRegion ?? DEFAULT_REGION;
    const sender = this.controlClient(region);
    const discoveredAt = new Date().toISOString();

    const candidates: AgentCandidate[] = [];
    let nextToken: string | undefined;
    do {
      const out = (await sender.send(
        new ListAgentRuntimesCommand({ nextToken }),
      )) as ListAgentRuntimesCommandOutput;
      for (const rt of out.agentRuntimes ?? []) {
        const arn = rt.agentRuntimeArn;
        if (!arn) continue;
        const parsed = parseArn(arn);
        candidates.push({
          origin: {
            sourceArn: arn,
            substrate: 'agentcore_runtime',
            region: parsed.region ?? region,
            account: s.account ?? parsed.account,
            discoveredAt,
            ownership: 'external',
          },
          displayName: rt.agentRuntimeName ?? arn,
          reference: arn,
        });
      }
      nextToken = out.nextToken;
    } while (nextToken);
    return candidates;
  }

  /**
   * Resolve a runtime ARN/candidate to a normalized capability descriptor.
   * Self-described fields (the runtime's own detail and, when it is registered
   * in the AgentCore Registry, its manifest) carry fieldConfidence 'high'.
   * inputSchema/outputSchema are {} unless a manifest declares them.
   */
  async describe(ref: AgentRef): Promise<AgentCapabilityDescriptor> {
    const arn = refToString(ref);
    const parsed = parseArn(arn);
    const region = parsed.region ?? this.deps.defaultRegion ?? DEFAULT_REGION;
    const account = parsed.account ?? this.deps.defaultAccount;
    const sender = this.controlClient(region);

    const detail = (await sender.send(
      new GetAgentRuntimeCommand({ agentRuntimeId: runtimeIdFromArn(arn) }),
    )) as GetAgentRuntimeCommandOutput;

    const runtimeArn = detail.agentRuntimeArn ?? arn;
    const name = detail.agentRuntimeName ?? displayNameOf(ref) ?? runtimeArn;
    let description = detail.description ?? '';
    let version = detail.agentRuntimeVersion ?? '1.0.0';
    let skills: string[] = [];
    let categories: string[] = [];
    let inputSchema: JsonSchema = {};
    let outputSchema: JsonSchema = {};

    // Manifest enrichment when the runtime is registered in the AgentCore
    // Registry. The manifest is the agent's OWN description, so its fields are
    // self-described (high confidence) and override the bare runtime detail.
    const manifest = await this.lookupManifest(name);
    if (manifest) {
      if (typeof manifest.description === 'string') description = manifest.description;
      if (typeof manifest.version === 'string') version = manifest.version;
      if (Array.isArray(manifest.skills)) {
        skills = manifest.skills.filter((v): v is string => typeof v === 'string');
      }
      if (Array.isArray(manifest.categories)) {
        categories = manifest.categories.filter((v): v is string => typeof v === 'string');
      }
      if (isObject(manifest.inputSchema)) inputSchema = manifest.inputSchema;
      if (isObject(manifest.outputSchema)) outputSchema = manifest.outputSchema;
    }

    const origin: AgentOrigin = {
      sourceArn: runtimeArn,
      substrate: 'agentcore_runtime',
      region,
      account,
      discoveredAt: new Date().toISOString(),
      ownership: 'external',
    };
    const invocation: AgentInvocationBlock = {
      protocol: 'AGENTCORE_RUNTIME',
      target: runtimeArn,
      auth: { mode: 'SIGV4' },
      mode: 'sync',
      region,
      account,
    };
    const fieldConfidence: Record<string, Confidence> = {
      name: 'high',
      description: 'high',
      version: 'high',
      skills: 'high',
      categories: 'high',
    };

    return {
      name,
      description,
      version,
      skills,
      categories,
      inputSchema,
      outputSchema,
      invocation,
      origin,
      fieldConfidence,
    };
  }

  /**
   * Reachability probe via GetAgentRuntime. Returns { reachable: false } on
   * ResourceNotFoundException WITHOUT throwing; other errors propagate (a 403
   * is a configuration problem, not "unreachable").
   */
  async healthCheck(ref: AgentRef): Promise<HealthCheckResult> {
    const arn = refToString(ref);
    const region = parseArn(arn).region ?? this.deps.defaultRegion ?? DEFAULT_REGION;
    const sender = this.controlClient(region);
    try {
      await sender.send(new GetAgentRuntimeCommand({ agentRuntimeId: runtimeIdFromArn(arn) }));
      return { reachable: true };
    } catch (err) {
      if (isResourceNotFound(err)) {
        return { reachable: false, detail: errMessage(err) };
      }
      throw err;
    }
  }

  async vendCredentials(_ref: AgentRef): Promise<VendedCredentials> {
    throw new NotImplementedError();
  }

  /** Resolve the control-plane sender, building a real client when none injected. */
  private controlClient(region: string): CommandSender {
    if (this.deps.controlSender) return this.deps.controlSender;
    // The concrete SDK client's overloaded send() is structurally a
    // CommandSender (command in -> Promise out). The double assertion bridges
    // the overload set to the loose injection type used on the test path;
    // production calls flow straight through the real control-plane client.
    return new BedrockAgentCoreControlClient({ region }) as unknown as CommandSender;
  }

  /** Best-effort manifest lookup for a runtime registered in the Registry. */
  private async lookupManifest(
    name: string,
  ): Promise<Record<string, unknown> | undefined> {
    const registry = this.deps.registry;
    if (!registry) return undefined;
    try {
      const records = await registry.listResources('agent');
      const match = records.find((r) => r.name === name);
      if (!match) return undefined;
      const meta = registry.deserializeCustomMetadata<{
        manifest?: Record<string, unknown>;
      }>(match.customDescriptorContent ?? null, {});
      return meta.manifest;
    } catch (err) {
      console.error('agentcore describe: registry manifest lookup failed', err);
      return undefined;
    }
  }
}

// --- control-plane helpers (ARN parsing / scope / errors) ------------------

function readScope(scope: unknown): AgentCoreDiscoverScope {
  if (typeof scope !== 'object' || scope === null) return {};
  const o = scope as Record<string, unknown>;
  return {
    region: typeof o.region === 'string' ? o.region : undefined,
    account: typeof o.account === 'string' ? o.account : undefined,
  };
}

function refToString(ref: AgentRef): string {
  return typeof ref === 'string' ? ref : ref.reference;
}

function displayNameOf(ref: AgentRef): string | undefined {
  return typeof ref === 'string' ? undefined : ref.displayName;
}

/** Parse the standard ARN layout `arn:partition:service:region:account:resource`. */
function parseArn(arn: string): {
  region?: string;
  account?: string;
  resource?: string;
} {
  const parts = arn.split(':');
  if (parts[0] !== 'arn' || parts.length < 6) return {};
  return {
    region: parts[3] || undefined,
    account: parts[4] || undefined,
    resource: parts.slice(5).join(':') || undefined,
  };
}

/** Extract the runtime id (segment after `runtime/`) from a runtime ARN. */
function runtimeIdFromArn(arn: string): string {
  const { resource } = parseArn(arn);
  if (!resource) return arn; // ref may already be a bare runtime id
  const slash = resource.indexOf('/');
  return slash >= 0 ? resource.slice(slash + 1) : resource;
}

function isResourceNotFound(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  return e.name === 'ResourceNotFoundException' || e.$metadata?.httpStatusCode === 404;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Parse a streaming or buffered AgentCore runtime response into text. */
async function parseRuntimeResponse(response: unknown): Promise<string> {
  if (!response || typeof response !== 'object') return NO_RESPONSE_TEXT;
  const r = response as { contentType?: string; response?: unknown };
  if (r.response == null) return NO_RESPONSE_TEXT;

  const contentType = r.contentType ?? '';
  if (contentType.includes('text/event-stream') && isAsyncIterable(r.response)) {
    const chunks: string[] = [];
    for await (const chunk of r.response) {
      if (chunk != null) chunks.push(Buffer.from(chunk as Uint8Array).toString('utf-8'));
    }
    return parseEventStream(chunks.join('')) || NO_RESPONSE_TEXT;
  }

  const body = r.response as { transformToByteArray?: () => Promise<Uint8Array> };
  if (typeof body.transformToByteArray === 'function') {
    const bytes = await body.transformToByteArray();
    return extractTextOutput(Buffer.from(bytes).toString('utf-8')) || NO_RESPONSE_TEXT;
  }

  return NO_RESPONSE_TEXT;
}

/** Collapse an SSE ("data: ...") event stream body into a single string. */
function parseEventStream(full: string): string {
  const out: string[] = [];
  for (const line of full.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const data = line.substring(6);
    try {
      const parsed: unknown = JSON.parse(data);
      if (typeof parsed === 'string') {
        out.push(parsed);
      } else if (
        parsed &&
        typeof parsed === 'object' &&
        typeof (parsed as Record<string, unknown>).text === 'string'
      ) {
        out.push((parsed as Record<string, string>).text);
      } else {
        out.push(JSON.stringify(parsed));
      }
    } catch {
      out.push(data);
    }
  }
  return out.join('');
}
