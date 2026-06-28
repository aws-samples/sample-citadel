/**
 * MCP adapter.
 *
 * invoke() issues a JSON-RPC `tools/call` POST to `descriptor.invocation.target`
 * and extracts the text content from the MCP result.
 *
 * discover/describe/healthCheck (US-IMP-011) work by PASTED ENDPOINT (no AWS
 * SDK): discover wraps a single endpoint into a candidate; describe drives the
 * JSON-RPC `initialize` + `tools/list` handshake and maps the advertised tools
 * into skills + schemas; healthCheck issues a lightweight `ping`. global.fetch
 * is injected as a fake in tests.
 */
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
import { NO_RESPONSE_TEXT, authHeaderScheme } from './invoke-support';
import type { AuthHeader } from './invoke-support';

/** MCP protocol version advertised during the describe() handshake. */
const MCP_PROTOCOL_VERSION = '2024-11-05';

/** The auth sub-block of an invocation descriptor. */
type AuthBlock = AgentInvocationBlock['auth'];

export interface McpAdapterDeps {
  fetchFn?: typeof fetch;
  /** Auth applied to the describe() invocation block (from the import scope). */
  auth?: AuthBlock;
  /**
   * Invoke-side resolver turning an invocation `auth.secretRef` into its raw
   * value (Secrets Manager GetSecretValue, run under the caller's identity).
   * When omitted, secret-backed auth modes invoke without an auth header.
   */
  resolveSecret?: (secretRef: string) => Promise<string>;
}

export class McpAdapter implements AgentSourceAdapter {
  public readonly protocol: AgentInvocationProtocol = 'MCP';
  private readonly fetchFn: typeof fetch;
  private readonly resolveSecret?: (secretRef: string) => Promise<string>;

  constructor(private readonly deps: McpAdapterDeps = {}) {
    this.fetchFn = deps.fetchFn ?? ((input, init) => globalThis.fetch(input, init));
    this.resolveSecret = deps.resolveSecret;
  }

  async invoke(
    req: InvokeRequest,
    descriptor: AgentCapabilityDescriptor,
  ): Promise<InvokeResponse> {
    const { target, auth } = descriptor.invocation;
    const rpc = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: descriptor.name,
        arguments: {
          prompt: req.prompt,
          sessionId: req.sessionId,
          ...(req.attributes ?? {}),
        },
      },
    };

    // Secret-backed auth (API_KEY / OAUTH2 / COGNITO): resolve the secretRef and
    // attach the Authorization header on the JSON-RPC POST. Unchanged (no
    // header) when no resolver is wired, no secretRef is set, or mode is NONE.
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    const authHeader = await this.resolveAuthHeader(auth);
    if (authHeader) headers[authHeader.name.toLowerCase()] = authHeader.value;

    const response = await this.fetchFn(target, {
      method: 'POST',
      headers,
      body: JSON.stringify(rpc),
    });
    const text = await response.text();
    return { output: parseJsonRpcResult(text), raw: text };
  }

  /**
   * Resolve the request auth header ({name,value}) for a secret-backed auth
   * mode, or undefined (no header) when no resolver is wired, no secretRef is
   * set, or the mode needs no resolved secret (NONE / SIGV4). The header name is
   * `Authorization` for the bearer-token modes and the API_KEY default, or the
   * invocation's custom `auth.header` (e.g. `x-api-key`) for API_KEY. The
   * resolved secret value is NEVER logged — only that auth was applied, and the
   * mode.
   */
  private async resolveAuthHeader(auth: AuthBlock): Promise<AuthHeader | undefined> {
    if (!this.resolveSecret || !auth.secretRef) return undefined;
    // SIGV4 / NONE need no secret-derived header — skip the GetSecretValue.
    if (!authHeaderScheme(auth.mode, '', auth.header)) return undefined;
    const value = await this.resolveSecret(auth.secretRef);
    console.log(
      JSON.stringify({
        level: 'info',
        msg: 'mcp-adapter: applied invocation auth header',
        mode: auth.mode,
      }),
    );
    return authHeaderScheme(auth.mode, value, auth.header) ?? undefined;
  }

  /**
   * Discovery is by PASTED ENDPOINT: wrap a single endpoint from the scope into
   * a candidate (substrate 'mcp', no sourceArn). Returns [] when the scope
   * carries no endpoint.
   */
  async discover(scope: unknown): Promise<AgentCandidate[]> {
    const s = readEndpointScope(scope);
    if (!s.endpoint) return [];
    const origin: AgentOrigin = {
      substrate: 'mcp',
      discoveredAt: new Date().toISOString(),
      ownership: 'external',
    };
    return [{ origin, displayName: s.name ?? s.endpoint, reference: s.endpoint }];
  }

  /**
   * Tier-0 descriptor via the MCP handshake: `initialize` (serverInfo ->
   * name/version, instructions -> description) then `tools/list` (each tool ->
   * a skill; its inputSchema/outputSchema -> the descriptor schemas). All fields
   * are self-described, so fieldConfidence is 'high'.
   */
  async describe(ref: AgentRef): Promise<AgentCapabilityDescriptor> {
    const url = refToString(ref);
    const auth = resolveMcpAuth(this.deps.auth);

    const initResult = await this.rpc(url, 'initialize', 1, {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'citadel-import', version: '1.0.0' },
    });
    const toolsResult = await this.rpc(url, 'tools/list', 2, {});

    const serverInfo = isObject(initResult.serverInfo) ? initResult.serverInfo : {};
    const name = typeof serverInfo.name === 'string' ? serverInfo.name : hostnameOf(url);
    const version = typeof serverInfo.version === 'string' ? serverInfo.version : '1.0.0';
    const description =
      typeof initResult.instructions === 'string' ? initResult.instructions : '';

    const tools = Array.isArray(toolsResult.tools) ? toolsResult.tools : [];
    const skills: string[] = [];
    const inputProps: Record<string, JsonSchema> = {};
    const outputProps: Record<string, JsonSchema> = {};
    for (const tool of tools) {
      if (!isObject(tool) || typeof tool.name !== 'string') continue;
      skills.push(tool.name);
      if (isObject(tool.inputSchema)) inputProps[tool.name] = tool.inputSchema;
      if (isObject(tool.outputSchema)) outputProps[tool.name] = tool.outputSchema;
    }
    const inputSchema: JsonSchema =
      Object.keys(inputProps).length > 0 ? { type: 'object', properties: inputProps } : {};
    const outputSchema: JsonSchema =
      Object.keys(outputProps).length > 0 ? { type: 'object', properties: outputProps } : {};

    const invocation: AgentInvocationBlock = {
      protocol: 'MCP',
      target: url,
      auth,
      mode: 'sync',
    };
    const origin: AgentOrigin = {
      substrate: 'mcp',
      discoveredAt: new Date().toISOString(),
      ownership: 'external',
    };
    const fieldConfidence: Record<string, Confidence> = {
      name: 'high',
      description: 'high',
      version: 'high',
      skills: 'high',
      inputSchema: 'high',
      outputSchema: 'high',
    };

    return {
      name,
      description,
      version,
      skills,
      categories: [],
      inputSchema,
      outputSchema,
      invocation,
      origin,
      fieldConfidence,
    };
  }

  /**
   * Lightweight reachability probe: a JSON-RPC `ping`. A 2xx HTTP response ->
   * reachable; a non-2xx or a network error -> { reachable: false, detail }
   * WITHOUT throwing.
   */
  async healthCheck(ref: AgentRef): Promise<HealthCheckResult> {
    const url = refToString(ref);
    try {
      const res = await this.fetchFn(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      });
      if (res.ok) return { reachable: true };
      return { reachable: false, detail: `HTTP ${res.status}` };
    } catch (err) {
      return { reachable: false, detail: errMessage(err) };
    }
  }

  async vendCredentials(_ref: AgentRef): Promise<VendedCredentials> {
    throw new NotImplementedError();
  }

  /** POST a JSON-RPC request and return its `result` object ({} on any miss). */
  private async rpc(
    url: string,
    method: string,
    id: number,
    params: unknown,
  ): Promise<Record<string, unknown>> {
    const res = await this.fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });
    const parsed = tryParseJson(await res.text());
    if (isObject(parsed) && isObject(parsed.result)) return parsed.result;
    return {};
  }
}

/** Extract the text content of an MCP JSON-RPC `tools/call` result. */
function parseJsonRpcResult(text: string): string {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object') {
      const envelope = parsed as { result?: unknown; error?: unknown };
      if (envelope.result && typeof envelope.result === 'object') {
        const result = envelope.result as { content?: unknown };
        if (Array.isArray(result.content)) {
          const texts = result.content
            .filter(
              (c): c is { text: string } =>
                !!c &&
                typeof c === 'object' &&
                typeof (c as Record<string, unknown>).text === 'string',
            )
            .map((c) => c.text);
          if (texts.length > 0) return texts.join('');
        }
        return JSON.stringify(envelope.result);
      }
      if (envelope.error) return `MCP error: ${JSON.stringify(envelope.error)}`;
    }
    return text || NO_RESPONSE_TEXT;
  } catch {
    return text || NO_RESPONSE_TEXT;
  }
}

// --- pasted-endpoint helpers (scope / auth / parsing / errors) -------------

function readEndpointScope(scope: unknown): { endpoint?: string; name?: string } {
  if (!isObject(scope)) return {};
  const endpoint =
    typeof scope.endpoint === 'string' && scope.endpoint.length > 0 ? scope.endpoint : undefined;
  const name = typeof scope.name === 'string' ? scope.name : undefined;
  return { endpoint, name };
}

function refToString(ref: AgentRef): string {
  return typeof ref === 'string' ? ref : ref.reference;
}

/**
 * Resolve the invocation auth from the import scope. Defaults to NONE (open MCP
 * server); a provided secretRef implies OAUTH2 unless an explicit mode is set.
 */
function resolveMcpAuth(auth?: AuthBlock): AuthBlock {
  if (auth?.secretRef) return { mode: auth.mode ?? 'OAUTH2', secretRef: auth.secretRef };
  return { mode: auth?.mode ?? 'NONE' };
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
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

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
