/**
 * HTTP_ENDPOINT adapter.
 *
 * invoke() POSTs a JSON body to `descriptor.invocation.target`. When auth.mode
 * is SIGV4 the request is signed with SignatureV4 before sending; otherwise it
 * is sent as-is. API_KEY / OAUTH2 secret resolution is a TODO stub for a later
 * story.
 *
 * discover/describe/healthCheck (US-IMP-011) work by PASTED ENDPOINT (no AWS
 * SDK): discover wraps a single endpoint into a candidate; describe attempts an
 * OpenAPI fetch (GET <url>/openapi.json) and maps it into the descriptor when
 * present; healthCheck does a lightweight GET. global.fetch is injected as a
 * fake in tests.
 */
import { SignatureV4 } from '@aws-sdk/signature-v4';
import { Sha256 } from '@aws-crypto/sha256-js';
import { HttpRequest } from '@smithy/protocol-http';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
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
import {
  NO_RESPONSE_TEXT,
  authHeaderScheme,
  collectOpenApi,
  extractTextOutput,
} from './invoke-support';
import type { AuthHeader } from './invoke-support';

const DEFAULT_REGION = process.env.AWS_REGION || 'ap-southeast-2';

/** The auth sub-block of an invocation descriptor. */
type AuthBlock = AgentInvocationBlock['auth'];

/** Minimal signer surface so tests can inject a double. */
export interface HttpSigner {
  sign(request: HttpRequest): Promise<{ headers: Record<string, string> }>;
}
export type HttpSignerFactory = (region: string) => HttpSigner;

export interface HttpEndpointAdapterDeps {
  fetchFn?: typeof fetch;
  signerFactory?: HttpSignerFactory;
  /** Auth applied to the describe() invocation block (from the import scope). */
  auth?: AuthBlock;
  defaultRegion?: string;
  /**
   * Invoke-side resolver turning an invocation `auth.secretRef` into its raw
   * value (Secrets Manager GetSecretValue, run under the caller's identity).
   * When omitted, secret-backed auth modes invoke without an auth header.
   */
  resolveSecret?: (secretRef: string) => Promise<string>;
}

const defaultSignerFactory: HttpSignerFactory = (region: string): HttpSigner => {
  const signer = new SignatureV4({
    service: 'execute-api',
    region,
    credentials: defaultProvider(),
    sha256: Sha256,
  });
  return { sign: (request: HttpRequest) => signer.sign(request) };
};

export class HttpEndpointAdapter implements AgentSourceAdapter {
  public readonly protocol: AgentInvocationProtocol = 'HTTP_ENDPOINT';
  private readonly fetchFn: typeof fetch;
  private readonly signerFactory: HttpSignerFactory;
  private readonly resolveSecret?: (secretRef: string) => Promise<string>;

  constructor(private readonly deps: HttpEndpointAdapterDeps = {}) {
    // Late-bind to the current global fetch so test stubs are honoured.
    this.fetchFn = deps.fetchFn ?? ((input, init) => globalThis.fetch(input, init));
    this.signerFactory = deps.signerFactory ?? defaultSignerFactory;
    this.resolveSecret = deps.resolveSecret;
  }

  async invoke(
    req: InvokeRequest,
    descriptor: AgentCapabilityDescriptor,
  ): Promise<InvokeResponse> {
    const { target, auth, region } = descriptor.invocation;
    const body = JSON.stringify({
      prompt: req.prompt,
      session_id: req.sessionId,
      attributes: req.attributes ?? {},
    });
    const url = new URL(target);
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      host: url.hostname,
    };

    let requestHeaders: Record<string, string> = headers;

    if (auth.mode === 'SIGV4') {
      const request = new HttpRequest({
        method: 'POST',
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port ? Number(url.port) : undefined,
        path: url.pathname + (url.search || ''),
        headers,
        body,
      });
      const signed = await this.signerFactory(region || DEFAULT_REGION).sign(request);
      requestHeaders = signed.headers;
    } else {
      // Secret-backed auth (API_KEY / OAUTH2 / COGNITO): resolve the secretRef
      // and attach the Authorization header. Unchanged (no header) when no
      // resolver is wired, no secretRef is set, or the mode needs no secret.
      const authHeader = await this.resolveAuthHeader(auth);
      if (authHeader) {
        requestHeaders = { ...headers, [authHeader.name.toLowerCase()]: authHeader.value };
      }
    }

    const response = await this.fetchFn(target, {
      method: 'POST',
      headers: requestHeaders,
      body,
    });
    const text = await response.text();
    return { output: extractTextOutput(text) || NO_RESPONSE_TEXT, raw: text };
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
        msg: 'http-adapter: applied invocation auth header',
        mode: auth.mode,
      }),
    );
    return authHeaderScheme(auth.mode, value, auth.header) ?? undefined;
  }

  /**
   * Discovery is by PASTED ENDPOINT: wrap a single endpoint from the scope into
   * a candidate (substrate 'http', no sourceArn). Returns [] when the scope
   * carries no endpoint.
   */
  async discover(scope: unknown): Promise<AgentCandidate[]> {
    const s = readEndpointScope(scope);
    if (!s.endpoint) return [];
    const origin: AgentOrigin = {
      substrate: 'http',
      discoveredAt: new Date().toISOString(),
      ownership: 'external',
    };
    return [{ origin, displayName: s.name ?? s.endpoint, reference: s.endpoint }];
  }

  /**
   * Tier-0 descriptor for a pasted HTTP endpoint. Attempts GET
   * <url>/openapi.json; when an OpenAPI doc is available its info + path schemas
   * populate the descriptor at confidence 'high'. Otherwise a minimal descriptor
   * with empty schemas is returned at confidence 'low'.
   */
  async describe(ref: AgentRef): Promise<AgentCapabilityDescriptor> {
    const url = refToString(ref);
    const auth = resolveHttpAuth(this.deps.auth);
    const doc = await this.fetchOpenApi(url);

    let name: string;
    let description: string;
    let version: string;
    let skills: string[];
    let inputSchema: JsonSchema;
    let outputSchema: JsonSchema;
    let confidence: Confidence;

    if (doc) {
      const info = isObject(doc.info) ? doc.info : {};
      name = typeof info.title === 'string' ? info.title : hostnameOf(url);
      description = typeof info.description === 'string' ? info.description : '';
      version = typeof info.version === 'string' ? info.version : '1.0.0';
      const { inputs, outputs, ops } = collectOpenApi(doc);
      inputSchema = Object.keys(inputs).length > 0 ? { type: 'object', properties: inputs } : {};
      outputSchema = Object.keys(outputs).length > 0 ? { type: 'object', properties: outputs } : {};
      skills = ops;
      confidence = 'high';
    } else {
      name = hostnameOf(url);
      description = '';
      version = '1.0.0';
      skills = [];
      inputSchema = {};
      outputSchema = {};
      confidence = 'low';
    }

    const invocation: AgentInvocationBlock = {
      protocol: 'HTTP_ENDPOINT',
      target: url,
      auth,
      mode: 'sync',
    };
    if (auth.mode === 'SIGV4') {
      invocation.region = this.deps.defaultRegion ?? DEFAULT_REGION;
    }
    const origin: AgentOrigin = {
      substrate: 'http',
      discoveredAt: new Date().toISOString(),
      ownership: 'external',
    };
    const fieldConfidence: Record<string, Confidence> = {
      name: confidence,
      description: confidence,
      version: confidence,
      skills: confidence,
      inputSchema: confidence,
      outputSchema: confidence,
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
   * Lightweight reachability probe: GET the endpoint. A 2xx -> reachable; a
   * non-2xx or a network error -> { reachable: false, detail } WITHOUT throwing.
   */
  async healthCheck(ref: AgentRef): Promise<HealthCheckResult> {
    const url = refToString(ref);
    try {
      const res = await this.fetchFn(url, { method: 'GET' });
      if (res.ok) return { reachable: true };
      return { reachable: false, detail: `HTTP ${res.status}` };
    } catch (err) {
      return { reachable: false, detail: errMessage(err) };
    }
  }

  async vendCredentials(_ref: AgentRef): Promise<VendedCredentials> {
    throw new NotImplementedError();
  }

  /** Fetch + parse <url>/openapi.json; undefined when unavailable/unparseable. */
  private async fetchOpenApi(url: string): Promise<Record<string, unknown> | undefined> {
    try {
      const res = await this.fetchFn(openApiUrl(url), { method: 'GET' });
      if (!res.ok) return undefined;
      const parsed = tryParseJson(await res.text());
      return isObject(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
}

// --- pasted-endpoint helpers (scope / auth / OpenAPI / errors) -------------

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
 * Resolve the invocation auth from the import scope. Defaults to SIGV4 (the
 * common AWS API Gateway case, which needs no secret); a provided secretRef is
 * carried through (e.g. for API_KEY).
 */
function resolveHttpAuth(auth?: AuthBlock): AuthBlock {
  const mode = auth?.mode ?? 'SIGV4';
  return auth?.secretRef ? { mode, secretRef: auth.secretRef } : { mode };
}

function openApiUrl(base: string): string {
  return `${base.replace(/\/+$/, '')}/openapi.json`;
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
