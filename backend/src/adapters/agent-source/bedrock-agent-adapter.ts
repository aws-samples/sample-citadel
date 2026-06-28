/**
 * BEDROCK_AGENT adapter.
 *
 * invoke() reaches an Agents-for-Bedrock agent via InvokeAgentCommand
 * (@aws-sdk/client-bedrock-agent-runtime). `descriptor.invocation.target` is
 * "<agentId>/<agentAliasId>".
 *
 * discover/describe/healthCheck (US-IMP-009) use the CONTROL plane
 * (@aws-sdk/client-bedrock-agent — a backend dependency) to enumerate agents
 * and aliases and read their self-described capabilities. The control client
 * is injected as a CommandSender in tests (deps.controlSender) and built lazily
 * in production, mirroring the AgentCore/Lambda adapters.
 *
 * NOTE: @aws-sdk/client-bedrock-agent-runtime (the DATA plane used by invoke())
 * is NOT a backend dependency. To avoid breaking `tsc`/bundling for every other
 * path, that SDK is loaded through an indirected require reached only when a
 * BEDROCK_AGENT agent is actually invoked. The control plane package IS a
 * dependency and is imported statically.
 */
import {
  BedrockAgentClient,
  ListAgentsCommand,
  ListAgentAliasesCommand,
  GetAgentCommand,
  GetAgentAliasCommand,
  ListAgentActionGroupsCommand,
  GetAgentActionGroupCommand,
  ListAgentKnowledgeBasesCommand,
} from '@aws-sdk/client-bedrock-agent';
import type {
  ListAgentsCommandOutput,
  ListAgentAliasesCommandOutput,
  GetAgentCommandOutput,
  GetAgentAliasCommandOutput,
  ListAgentActionGroupsCommandOutput,
  GetAgentActionGroupCommandOutput,
  ListAgentKnowledgeBasesCommandOutput,
} from '@aws-sdk/client-bedrock-agent';
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
import { NotImplementedError } from './not-implemented';
import type { CommandSender } from './invoke-support';
import { NO_RESPONSE_TEXT, bytesToString, collectOpenApi, isAsyncIterable } from './invoke-support';

const DEFAULT_REGION = process.env.AWS_REGION || 'ap-southeast-2';
const MODULE_NAME = '@aws-sdk/client-bedrock-agent-runtime';

/** Structural sender for the lazily-loaded bedrock-agent-runtime client. */
interface AgentRuntimeSender {
  send(command: unknown): Promise<unknown>;
}

/** Minimal shape of the parts of the SDK module this adapter needs. */
interface BedrockAgentRuntimeModule {
  BedrockAgentRuntimeClient: new (config: { region?: string }) => AgentRuntimeSender;
  InvokeAgentCommand: new (input: Record<string, unknown>) => unknown;
}

export interface BedrockAgentAdapterDeps {
  // --- data plane (invoke) ---
  client?: AgentRuntimeSender;
  createCommand?: (input: Record<string, unknown>) => unknown;
  loadModule?: () => BedrockAgentRuntimeModule;
  // --- control plane (discover/describe/healthCheck, US-IMP-009) ---
  /** Control-plane sender; tests inject a fake, production builds a client. */
  controlSender?: CommandSender;
  defaultRegion?: string;
  defaultAccount?: string;
}

/** Optional discovery scope for {@link BedrockAgentAdapter.discover}. */
interface BedrockDiscoverScope {
  region?: string;
  account?: string;
}

/** Loose structural view of the parts of an action group describe() reads. */
interface ActionGroupDetail {
  actionGroupName?: string;
  apiSchema?: { payload?: string };
  functionSchema?: {
    functions?: Array<{
      name?: string;
      description?: string;
      parameters?: Record<string, { type?: string; description?: string; required?: boolean }>;
    }>;
  };
}

export class BedrockAgentAdapter implements AgentSourceAdapter {
  public readonly protocol: AgentInvocationProtocol = 'BEDROCK_AGENT';

  constructor(private readonly deps: BedrockAgentAdapterDeps = {}) {}

  async invoke(
    req: InvokeRequest,
    descriptor: AgentCapabilityDescriptor,
  ): Promise<InvokeResponse> {
    const { target, region } = descriptor.invocation;
    const slash = target.indexOf('/');
    const agentId = slash >= 0 ? target.slice(0, slash) : target;
    const agentAliasId = slash >= 0 ? target.slice(slash + 1) : 'TSTALIASID';

    const input: Record<string, unknown> = {
      agentId,
      agentAliasId,
      sessionId: req.sessionId,
      inputText: req.prompt,
    };

    let client = this.deps.client;
    let createCommand = this.deps.createCommand;
    if (!client || !createCommand) {
      const mod = (this.deps.loadModule ?? loadBedrockAgentRuntime)();
      client = client ?? new mod.BedrockAgentRuntimeClient({ region: region || DEFAULT_REGION });
      createCommand = createCommand ?? ((i) => new mod.InvokeAgentCommand(i));
    }

    const response = await client.send(createCommand(input));
    return { output: await parseAgentResponse(response), raw: response };
  }

  /**
   * Enumerate importable candidates: ListAgents, then ListAgentAliases per
   * agent, returning one AgentCandidate PER ALIAS. Aliases (not the bare agent
   * draft) are the importable, versioned targets, so no candidate is emitted
   * for an agent itself. `reference` is the stable "agentId/aliasId" handle
   * invoke()/describe() consume; `sourceArn` is the alias ARN (constructed from
   * the scope region/account, since list responses omit alias ARNs).
   */
  async discover(scope: unknown): Promise<AgentCandidate[]> {
    const s = readScope(scope);
    const region = s.region ?? this.deps.defaultRegion ?? DEFAULT_REGION;
    const account = s.account ?? this.deps.defaultAccount;
    const sender = this.controlClient(region);
    const discoveredAt = new Date().toISOString();

    const candidates: AgentCandidate[] = [];
    let agentToken: string | undefined;
    do {
      const agentsOut = (await sender.send(
        new ListAgentsCommand({ nextToken: agentToken }),
      )) as ListAgentsCommandOutput;
      for (const agent of agentsOut.agentSummaries ?? []) {
        const agentId = agent.agentId;
        if (!agentId) continue;

        let aliasToken: string | undefined;
        do {
          const aliasesOut = (await sender.send(
            new ListAgentAliasesCommand({ agentId, nextToken: aliasToken }),
          )) as ListAgentAliasesCommandOutput;
          for (const alias of aliasesOut.agentAliasSummaries ?? []) {
            const aliasId = alias.agentAliasId;
            if (!aliasId) continue;
            candidates.push({
              origin: {
                sourceArn: buildAliasArn(region, account, agentId, aliasId),
                substrate: 'bedrock_agent',
                region,
                account,
                discoveredAt,
                ownership: 'external',
              },
              displayName: displayName(agent.agentName, alias.agentAliasName, `${agentId}/${aliasId}`),
              reference: `${agentId}/${aliasId}`,
            });
          }
          aliasToken = aliasesOut.nextToken;
        } while (aliasToken);
      }
      agentToken = agentsOut.nextToken;
    } while (agentToken);

    return candidates;
  }

  /**
   * Tier-0 capability descriptor for an "agentId/aliasId" handle. Reads GetAgent
   * (name/description/instruction) and GetAgentAlias (real alias ARN + served
   * version), then enumerates the served version's action groups (OpenAPI /
   * function schemas -> input/outputSchema) and knowledge bases (-> categories).
   * All fields are self-described, so fieldConfidence is 'high'. The invocation
   * target is "agentId/aliasId" — identical to what invoke() parses.
   */
  async describe(ref: AgentRef): Promise<AgentCapabilityDescriptor> {
    const { agentId, aliasId } = parseHandle(refToString(ref));
    const region = originRegionOf(ref) ?? this.deps.defaultRegion ?? DEFAULT_REGION;
    const account = originAccountOf(ref) ?? this.deps.defaultAccount;
    const sender = this.controlClient(region);

    const agentOut = (await sender.send(
      new GetAgentCommand({ agentId }),
    )) as GetAgentCommandOutput;
    const agent = agentOut.agent;

    const aliasOut = (await sender.send(
      new GetAgentAliasCommand({ agentId, agentAliasId: aliasId }),
    )) as GetAgentAliasCommandOutput;
    const alias = aliasOut.agentAlias;
    const servedVersion =
      alias?.routingConfiguration?.find((r) => typeof r.agentVersion === 'string')?.agentVersion;
    const version = servedVersion ?? agent?.agentVersion ?? 'DRAFT';

    // Action groups (served version) -> skills + input/output schemas.
    const skills: string[] = [];
    const inputProps: Record<string, JsonSchema> = {};
    const outputProps: Record<string, JsonSchema> = {};
    let agToken: string | undefined;
    do {
      const agOut = (await sender.send(
        new ListAgentActionGroupsCommand({ agentId, agentVersion: version, nextToken: agToken }),
      )) as ListAgentActionGroupsCommandOutput;
      for (const summary of agOut.actionGroupSummaries ?? []) {
        const actionGroupId = summary.actionGroupId;
        if (!actionGroupId) continue;
        const detailOut = (await sender.send(
          new GetAgentActionGroupCommand({ agentId, agentVersion: version, actionGroupId }),
        )) as GetAgentActionGroupCommandOutput;
        const ag = detailOut.agentActionGroup as unknown as ActionGroupDetail | undefined;
        if (!ag) continue;
        if (ag.actionGroupName) skills.push(ag.actionGroupName);
        const payload = ag.apiSchema?.payload;
        if (typeof payload === 'string') {
          const { inputs, outputs } = collectOpenApi(tryParseJson(payload));
          Object.assign(inputProps, inputs);
          Object.assign(outputProps, outputs);
        } else if (ag.functionSchema?.functions) {
          for (const fn of ag.functionSchema.functions) {
            if (fn?.name) inputProps[fn.name] = functionParamsSchema(fn);
          }
        }
      }
      agToken = agOut.nextToken;
    } while (agToken);

    // Knowledge bases (served version) -> categories.
    const categories: string[] = [];
    let kbToken: string | undefined;
    do {
      const kbOut = (await sender.send(
        new ListAgentKnowledgeBasesCommand({ agentId, agentVersion: version, nextToken: kbToken }),
      )) as ListAgentKnowledgeBasesCommandOutput;
      for (const kb of kbOut.agentKnowledgeBaseSummaries ?? []) {
        if (kb.knowledgeBaseId) categories.push(kb.knowledgeBaseId);
      }
      kbToken = kbOut.nextToken;
    } while (kbToken);

    const inputSchema: JsonSchema =
      Object.keys(inputProps).length > 0 ? { type: 'object', properties: inputProps } : {};
    const outputSchema: JsonSchema =
      Object.keys(outputProps).length > 0 ? { type: 'object', properties: outputProps } : {};

    const origin: AgentOrigin = {
      sourceArn: alias?.agentAliasArn ?? buildAliasArn(region, account, agentId, aliasId),
      substrate: 'bedrock_agent',
      region,
      account,
      discoveredAt: new Date().toISOString(),
      ownership: 'external',
    };
    const invocation: AgentInvocationBlock = {
      protocol: 'BEDROCK_AGENT',
      target: `${agentId}/${aliasId}`,
      auth: { mode: 'SIGV4' },
      mode: 'sync',
      region,
      account,
    };
    // Self-described control-plane facts: high confidence across the board.
    const fieldConfidence: Record<string, Confidence> = {
      name: 'high',
      description: 'high',
      version: 'high',
      skills: 'high',
      categories: 'high',
      inputSchema: 'high',
      outputSchema: 'high',
    };

    return {
      name: agent?.agentName ?? displayNameOf(ref) ?? agentId,
      description: agent?.description || agent?.instruction || '',
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
   * Reachability probe via GetAgentAlias (verifies the importable alias).
   * ResourceNotFoundException -> { reachable: false } WITHOUT throwing; other
   * errors propagate (a 403 is a configuration problem, not "unreachable").
   */
  async healthCheck(ref: AgentRef): Promise<HealthCheckResult> {
    const { agentId, aliasId } = parseHandle(refToString(ref));
    const region = originRegionOf(ref) ?? this.deps.defaultRegion ?? DEFAULT_REGION;
    const sender = this.controlClient(region);
    try {
      await sender.send(new GetAgentAliasCommand({ agentId, agentAliasId: aliasId }));
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
    // The concrete BedrockAgentClient's overloaded send() is structurally a
    // CommandSender (command in -> Promise out); the double assertion bridges
    // the overload set to the loose injection type used on the test path.
    return new BedrockAgentClient({ region }) as unknown as CommandSender;
  }
}

/**
 * Load @aws-sdk/client-bedrock-agent-runtime through an indirected require so
 * a static import does not fail `tsc`/bundling when the package is absent.
 * Throws a clear error at invoke time if the dependency is missing.
 */
function loadBedrockAgentRuntime(): BedrockAgentRuntimeModule {
  const nodeRequire: (id: string) => unknown = require;
  return nodeRequire(MODULE_NAME) as BedrockAgentRuntimeModule;
}

/** Concatenate the InvokeAgent completion event-stream into a single string. */
async function parseAgentResponse(response: unknown): Promise<string> {
  if (!response || typeof response !== 'object') return NO_RESPONSE_TEXT;
  const r = response as { completion?: unknown; output?: unknown };

  if (isAsyncIterable(r.completion)) {
    const chunks: string[] = [];
    for await (const event of r.completion) {
      const e = event as { chunk?: { bytes?: unknown } };
      if (e.chunk?.bytes != null) chunks.push(bytesToString(e.chunk.bytes));
    }
    if (chunks.length > 0) return chunks.join('');
  }
  if (typeof r.output === 'string') return r.output;
  return NO_RESPONSE_TEXT;
}

// --- control-plane helpers (scope / handles / ARNs / schemas / errors) -----

function readScope(scope: unknown): BedrockDiscoverScope {
  if (!isObject(scope)) return {};
  return {
    region: typeof scope.region === 'string' ? scope.region : undefined,
    account: typeof scope.account === 'string' ? scope.account : undefined,
  };
}

/** Parse the "agentId/aliasId" handle exactly as invoke() does. */
function parseHandle(handle: string): { agentId: string; aliasId: string } {
  const slash = handle.indexOf('/');
  if (slash < 0) return { agentId: handle, aliasId: 'TSTALIASID' };
  return { agentId: handle.slice(0, slash), aliasId: handle.slice(slash + 1) };
}

function refToString(ref: AgentRef): string {
  return typeof ref === 'string' ? ref : ref.reference;
}

function originRegionOf(ref: AgentRef): string | undefined {
  return typeof ref === 'string' ? undefined : ref.origin.region;
}

function originAccountOf(ref: AgentRef): string | undefined {
  return typeof ref === 'string' ? undefined : ref.origin.account;
}

function displayNameOf(ref: AgentRef): string | undefined {
  return typeof ref === 'string' ? undefined : ref.displayName;
}

function displayName(
  agentName: string | undefined,
  aliasName: string | undefined,
  fallback: string,
): string {
  if (agentName && aliasName) return `${agentName} (${aliasName})`;
  return aliasName ?? agentName ?? fallback;
}

/**
 * Build the standard Bedrock agent-alias ARN. Returns undefined when the
 * account is unknown (list responses omit ARNs, so describe() prefers the real
 * ARN from GetAgentAlias).
 */
function buildAliasArn(
  region: string,
  account: string | undefined,
  agentId: string,
  aliasId: string,
): string | undefined {
  if (!account) return undefined;
  return `arn:aws:bedrock:${region}:${account}:agent-alias/${agentId}/${aliasId}`;
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function functionParamsSchema(fn: {
  parameters?: Record<string, { type?: string; description?: string; required?: boolean }>;
}): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const [pname, detail] of Object.entries(fn.parameters ?? {})) {
    const prop: JsonSchema = { type: detail?.type ?? 'string' };
    if (detail?.description) prop.description = detail.description;
    properties[pname] = prop;
    if (detail?.required) required.push(pname);
  }
  const schema: JsonSchema = { type: 'object', properties };
  if (required.length > 0) schema.required = required;
  return schema;
}

function isResourceNotFound(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  return e.name === 'ResourceNotFoundException' || e.$metadata?.httpStatusCode === 404;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
