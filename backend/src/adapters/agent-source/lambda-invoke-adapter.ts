/**
 * LAMBDA_INVOKE adapter.
 *
 * Invokes a Lambda function (`descriptor.invocation.target`) via InvokeCommand.
 * InvocationType is 'RequestResponse' for sync mode and 'Event' for
 * async_callback mode. Only invoke() is implemented for now.
 */
import {
  LambdaClient,
  InvokeCommand,
  ListFunctionsCommand,
  GetFunctionConfigurationCommand,
  ListTagsCommand,
  GetPolicyCommand,
  ListFunctionUrlConfigsCommand,
  ListEventSourceMappingsCommand,
} from '@aws-sdk/client-lambda';
import type {
  ListFunctionsCommandOutput,
  GetFunctionConfigurationCommandOutput,
  ListTagsCommandOutput,
  GetPolicyCommandOutput,
  ListFunctionUrlConfigsCommandOutput,
  ListEventSourceMappingsCommandOutput,
  FunctionUrlConfig,
} from '@aws-sdk/client-lambda';
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
import type { AgentInvocationMode } from '../../services/registry-service';
import { NotImplementedError } from './not-implemented';
import type { CommandSender } from './invoke-support';
import { NO_RESPONSE_TEXT, bytesToString, extractTextOutput } from './invoke-support';

const DEFAULT_REGION = process.env.AWS_REGION || 'ap-southeast-2';

/** Timeout (seconds) at/above which describe() infers async_callback mode. */
const ASYNC_TIMEOUT_THRESHOLD_SECONDS = 60;

/** Optional discovery scope for {@link LambdaInvokeAdapter.discover}. */
interface LambdaDiscoverScope {
  region?: string;
  tagKey?: string;
  tagValue?: string;
}

/**
 * Injectable dependencies for the management path
 * (discover/describe/healthCheck). All optional so the legacy single-arg
 * construction used by the dispatcher (invoke-only) keeps working.
 */
export interface LambdaInvokeAdapterDeps {
  /** Management sender; tests inject a fake, production builds a LambdaClient. */
  controlSender?: CommandSender;
  defaultRegion?: string;
  defaultAccount?: string;
  /** Override the Timeout(s) threshold that flips mode to async_callback. */
  asyncTimeoutThresholdSeconds?: number;
}

export class LambdaInvokeAdapter implements AgentSourceAdapter {
  public readonly protocol: AgentInvocationProtocol = 'LAMBDA_INVOKE';

  /**
   * @param sender Optional data-plane sender for invoke() (tests inject a fake).
   * @param deps   Optional management deps for discover/describe/healthCheck.
   */
  constructor(
    private readonly sender?: CommandSender,
    private readonly deps: LambdaInvokeAdapterDeps = {},
  ) {}

  async invoke(
    req: InvokeRequest,
    descriptor: AgentCapabilityDescriptor,
  ): Promise<InvokeResponse> {
    const { target, region, mode } = descriptor.invocation;
    const invocationType = mode === 'async_callback' ? 'Event' : 'RequestResponse';

    const command = new InvokeCommand({
      FunctionName: target,
      InvocationType: invocationType,
      Payload: new TextEncoder().encode(
        JSON.stringify({
          prompt: req.prompt,
          session_id: req.sessionId,
          attributes: req.attributes ?? {},
        }),
      ),
    });

    const response = this.sender
      ? await this.sender.send(command)
      : await new LambdaClient({ region: region || DEFAULT_REGION }).send(command);

    // Async ('Event') invocations return no payload (HTTP 202); the real
    // result arrives later out-of-band, so there is no synchronous text.
    if (invocationType === 'Event') {
      return { output: '', raw: response };
    }

    const payloadText = bytesToString((response as { Payload?: unknown }).Payload);
    return { output: extractTextOutput(payloadText) || NO_RESPONSE_TEXT, raw: response };
  }

  /**
   * Enumerate importable Lambda functions by paginating ListFunctions. When
   * scope.tagKey is set, each function's tags are fetched (ListTags) and only
   * functions whose tag matches are kept (any value when tagValue is omitted).
   */
  async discover(scope: unknown): Promise<AgentCandidate[]> {
    const s = readScope(scope);
    const region = s.region ?? this.deps.defaultRegion ?? DEFAULT_REGION;
    const sender = this.managementClient(region);
    const discoveredAt = new Date().toISOString();

    const candidates: AgentCandidate[] = [];
    let marker: string | undefined;
    do {
      const out = (await sender.send(
        new ListFunctionsCommand({ Marker: marker }),
      )) as ListFunctionsCommandOutput;
      for (const fn of out.Functions ?? []) {
        const arn = fn.FunctionArn;
        if (!arn) continue;
        if (s.tagKey && !(await this.tagMatches(sender, arn, s.tagKey, s.tagValue))) {
          continue;
        }
        const parsed = parseArn(arn);
        candidates.push({
          origin: {
            sourceArn: arn,
            substrate: 'lambda',
            region: parsed.region ?? region,
            account: parsed.account ?? this.deps.defaultAccount,
            discoveredAt,
            ownership: 'external',
          },
          displayName: fn.FunctionName ?? arn,
          reference: arn,
        });
      }
      marker = out.NextMarker;
    } while (marker);
    return candidates;
  }

  /**
   * Build a Tier-1 capability descriptor from GetFunctionConfiguration + tags,
   * also pulling the resource policy (who may invoke) and function-URL configs.
   *
   * VARIANT -> MODE: invocation.mode defaults to 'sync' and flips to
   * 'async_callback' when the function looks long-running or event-driven —
   * specifically when Timeout >= {@link ASYNC_TIMEOUT_THRESHOLD_SECONDS} (60s)
   * OR at least one event-source mapping (an async trigger) exists.
   *
   * Name/description are inferred from tags (low confidence) falling back to
   * config (medium). Schemas are unknown ({}). Auth is always SIGV4 — the
   * Lambda Invoke API is SigV4-signed regardless of any function-URL auth type.
   */
  async describe(ref: AgentRef): Promise<AgentCapabilityDescriptor> {
    const functionRef = refToString(ref);
    const region =
      parseArn(functionRef).region ?? this.deps.defaultRegion ?? DEFAULT_REGION;
    const sender = this.managementClient(region);

    const config = (await sender.send(
      new GetFunctionConfigurationCommand({ FunctionName: functionRef }),
    )) as GetFunctionConfigurationCommandOutput;

    const functionArn = config.FunctionArn ?? functionRef;
    const parsed = parseArn(functionArn);
    const fnRegion = parsed.region ?? region;
    const account = parsed.account ?? this.deps.defaultAccount;

    const tags = await this.fetchTags(sender, functionArn);
    const policy = await this.fetchPolicy(sender, functionArn);
    const urlConfigs = await this.fetchUrlConfigs(sender, functionArn);
    const asyncTriggers = await this.countEventSourceMappings(sender, functionArn);

    const threshold =
      this.deps.asyncTimeoutThresholdSeconds ?? ASYNC_TIMEOUT_THRESHOLD_SECONDS;
    const timeout = config.Timeout ?? 0;
    const mode: AgentInvocationMode =
      timeout >= threshold || asyncTriggers > 0 ? 'async_callback' : 'sync';

    const tagName = firstTag(tags, ['Name', 'name', 'citadel:name']);
    const tagDesc = firstTag(tags, ['Description', 'description', 'citadel:description']);
    const name = tagName ?? config.FunctionName ?? functionArn;
    const baseDescription = tagDesc ?? config.Description ?? '';
    const categories = splitTag(
      firstTag(tags, ['Category', 'Categories', 'categories', 'citadel:category']),
    );
    const skills = splitTag(firstTag(tags, ['Skills', 'skills', 'citadel:skills']));

    // Surface import-time governance facts (public-URL exposure, resource-policy
    // grants) in the human-readable description — the normalized Tier-1 shape has
    // no dedicated field; a later story maps them structurally.
    const exposure = describeExposure(urlConfigs, policy);
    const description = exposure
      ? `${baseDescription}${baseDescription ? ' ' : ''}${exposure}`
      : baseDescription;

    const fieldConfidence: Record<string, Confidence> = {
      name: tagName ? 'low' : 'medium',
      description: tagDesc ? 'low' : 'medium',
      version: 'medium',
      skills: 'low',
      categories: 'low',
    };

    const origin: AgentOrigin = {
      sourceArn: functionArn,
      substrate: 'lambda',
      region: fnRegion,
      account,
      discoveredAt: new Date().toISOString(),
      ownership: 'external',
    };
    const invocation: AgentInvocationBlock = {
      protocol: 'LAMBDA_INVOKE',
      target: functionArn,
      auth: { mode: 'SIGV4' },
      mode,
      region: fnRegion,
      account,
    };

    return {
      name,
      description,
      version: config.Version ?? '$LATEST',
      skills,
      categories,
      inputSchema: {},
      outputSchema: {},
      invocation,
      origin,
      fieldConfidence,
    };
  }

  /**
   * Reachability probe via GetFunctionConfiguration. Returns { reachable: false }
   * on ResourceNotFoundException WITHOUT throwing; other errors propagate.
   */
  async healthCheck(ref: AgentRef): Promise<HealthCheckResult> {
    const functionRef = refToString(ref);
    const region =
      parseArn(functionRef).region ?? this.deps.defaultRegion ?? DEFAULT_REGION;
    const sender = this.managementClient(region);
    try {
      await sender.send(new GetFunctionConfigurationCommand({ FunctionName: functionRef }));
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

  // --- management-path helpers ---------------------------------------------

  private managementClient(region: string): CommandSender {
    if (this.deps.controlSender) return this.deps.controlSender;
    // The concrete LambdaClient's overloaded send() is structurally a
    // CommandSender (command in -> Promise out); the double assertion bridges
    // the overload set to the loose injection type used on the test path.
    return new LambdaClient({ region }) as unknown as CommandSender;
  }

  private async tagMatches(
    sender: CommandSender,
    arn: string,
    tagKey: string,
    tagValue: string | undefined,
  ): Promise<boolean> {
    const tags = await this.fetchTags(sender, arn);
    const value = tags[tagKey];
    return tagValue !== undefined ? value === tagValue : value !== undefined;
  }

  private async fetchTags(
    sender: CommandSender,
    arn: string,
  ): Promise<Record<string, string>> {
    const out = (await sender.send(
      new ListTagsCommand({ Resource: arn }),
    )) as ListTagsCommandOutput;
    return out.Tags ?? {};
  }

  private async fetchPolicy(
    sender: CommandSender,
    arn: string,
  ): Promise<string | undefined> {
    try {
      const out = (await sender.send(
        new GetPolicyCommand({ FunctionName: arn }),
      )) as GetPolicyCommandOutput;
      return out.Policy;
    } catch (err) {
      if (isResourceNotFound(err)) return undefined; // no resource policy attached
      throw err;
    }
  }

  private async fetchUrlConfigs(
    sender: CommandSender,
    arn: string,
  ): Promise<FunctionUrlConfig[]> {
    const out = (await sender.send(
      new ListFunctionUrlConfigsCommand({ FunctionName: arn }),
    )) as ListFunctionUrlConfigsCommandOutput;
    return out.FunctionUrlConfigs ?? [];
  }

  private async countEventSourceMappings(
    sender: CommandSender,
    arn: string,
  ): Promise<number> {
    const out = (await sender.send(
      new ListEventSourceMappingsCommand({ FunctionName: arn }),
    )) as ListEventSourceMappingsCommandOutput;
    return (out.EventSourceMappings ?? []).length;
  }
}

// --- management-path helpers (ARN parsing / scope / tags / errors) ---------

function readScope(scope: unknown): LambdaDiscoverScope {
  if (typeof scope !== 'object' || scope === null) return {};
  const o = scope as Record<string, unknown>;
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' ? v : undefined;
  return { region: str(o.region), tagKey: str(o.tagKey), tagValue: str(o.tagValue) };
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

function isResourceNotFound(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  return e.name === 'ResourceNotFoundException' || e.$metadata?.httpStatusCode === 404;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** First non-empty tag value among the candidate keys (case variants). */
function firstTag(tags: Record<string, string>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = tags[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

/** Split a comma-separated tag value into a trimmed, non-empty list. */
function splitTag(value: string | undefined): string[] {
  return value
    ? value.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
    : [];
}

/**
 * Compact, human-readable summary of import-time exposure facts: present
 * function URLs (with their auth types) and the count of resource-policy
 * statements that grant invoke permission. Returns '' when nothing notable.
 */
function describeExposure(
  urlConfigs: FunctionUrlConfig[],
  policy: string | undefined,
): string {
  const notes: string[] = [];
  if (urlConfigs.length > 0) {
    const authTypes = urlConfigs.map((u) => u.AuthType ?? 'UNKNOWN').join(',');
    notes.push(`functionUrl:${urlConfigs.length}(${authTypes})`);
  }
  const statements = countPolicyStatements(policy);
  if (statements > 0) notes.push(`resourcePolicy:${statements}`);
  return notes.length > 0 ? `[import ${notes.join(' ')}]` : '';
}

/** Count statements in a Lambda resource policy JSON document. */
function countPolicyStatements(policy: string | undefined): number {
  if (!policy) return 0;
  try {
    const parsed = JSON.parse(policy) as { Statement?: unknown };
    return Array.isArray(parsed.Statement) ? parsed.Statement.length : 0;
  } catch {
    return 0;
  }
}
