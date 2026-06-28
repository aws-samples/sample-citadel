/**
 * Small shared helpers used by the per-protocol invoke()/describe()/auth
 * implementations. Kept substrate-agnostic (type-only imports, erased at
 * compile time) so each adapter stays minimal and free of duplicated logic.
 */
import type { AgentInvocationBlock, JsonSchema, VendedCredentials } from './base';
import { PolicyManager } from '../../utils/policy-manager';

/** Placeholder returned when a substrate yields no usable response text. */
export const NO_RESPONSE_TEXT = 'Agent processing completed (no response text)';

/**
 * A minimal "send a command" surface. Real AWS SDK clients satisfy this
 * structurally; tests inject a `{ send: jest.fn() }` double. Adapters call the
 * concrete client's typed `send` on the production path and only use this type
 * for the injected (test) sender.
 */
export interface CommandSender {
  send(command: unknown): Promise<unknown>;
}

/** Narrowing guard for substrate responses delivered as async streams. */
export function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<symbol, unknown>)[Symbol.asyncIterator] === 'function'
  );
}

/** Decode a byte-ish payload (Uint8Array | number[] | string) to UTF-8 text. */
export function bytesToString(payload: unknown): string {
  if (payload == null) return '';
  if (typeof payload === 'string') return payload;
  if (payload instanceof Uint8Array) return Buffer.from(payload).toString('utf-8');
  if (Array.isArray(payload)) return Buffer.from(payload as number[]).toString('utf-8');
  return String(payload);
}

/**
 * Try to parse `text` as JSON and pick a conventional output field, falling
 * back to the raw text. Mirrors the field precedence used by the legacy
 * AgentCore handler (`response` then `output`).
 */
export function extractTextOutput(text: string): string {
  if (!text) return '';
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'string') return parsed;
    if (parsed && typeof parsed === 'object') {
      const o = parsed as Record<string, unknown>;
      if (typeof o.response === 'string') return o.response;
      if (typeof o.output === 'string') return o.output;
      if (typeof o.completion === 'string') return o.completion;
      if (typeof o.text === 'string') return o.text;
    }
    return text;
  } catch {
    return text;
  }
}

// --- OpenAPI -> JSON-Schema mapping (shared by BEDROCK_AGENT + HTTP_ENDPOINT) -

/** Local object guard for the OpenAPI walk; kept private to this module. */
function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Collect operation-level request/response JSON schemas from an OpenAPI doc,
 * keyed by operationId (falling back to "METHOD /path"). Returns the input
 * schemas, output schemas, and the ordered list of operation keys (`ops`).
 *
 * Shared verbatim by the BEDROCK_AGENT action-group schema mapping and the
 * HTTP_ENDPOINT openapi.json mapping — both call sites pass an already-parsed
 * (or unparseable -> non-object) value and rely on the same precedence rules.
 */
export function collectOpenApi(doc: unknown): {
  inputs: Record<string, JsonSchema>;
  outputs: Record<string, JsonSchema>;
  ops: string[];
} {
  const inputs: Record<string, JsonSchema> = {};
  const outputs: Record<string, JsonSchema> = {};
  const ops: string[] = [];
  if (!isObject(doc) || !isObject(doc.paths)) return { inputs, outputs, ops };
  for (const [path, item] of Object.entries(doc.paths)) {
    if (!isObject(item)) continue;
    for (const [method, op] of Object.entries(item)) {
      if (!isObject(op)) continue;
      const opKey =
        typeof op.operationId === 'string' && op.operationId.length > 0
          ? op.operationId
          : `${method.toUpperCase()} ${path}`;
      ops.push(opKey);
      const req = requestJsonSchema(op.requestBody);
      if (req) inputs[opKey] = req;
      const res = responseJsonSchema(op.responses);
      if (res) outputs[opKey] = res;
    }
  }
  return { inputs, outputs, ops };
}

/** Pick the `application/json` schema from an OpenAPI requestBody, if present. */
function requestJsonSchema(requestBody: unknown): JsonSchema | undefined {
  if (!isObject(requestBody) || !isObject(requestBody.content)) return undefined;
  const aj = requestBody.content['application/json'];
  return isObject(aj) && isObject(aj.schema) ? aj.schema : undefined;
}

/**
 * Pick the success-response `application/json` schema from an OpenAPI responses
 * object: prefer "200", then the first other 2xx code in key order.
 */
function responseJsonSchema(responses: unknown): JsonSchema | undefined {
  if (!isObject(responses)) return undefined;
  const pick = (code: string): JsonSchema | undefined => {
    const r = responses[code];
    if (!isObject(r) || !isObject(r.content)) return undefined;
    const aj = r.content['application/json'];
    return isObject(aj) && isObject(aj.schema) ? aj.schema : undefined;
  };
  const direct = pick('200');
  if (direct) return direct;
  for (const code of Object.keys(responses)) {
    if (code.startsWith('2')) {
      const s = pick(code);
      if (s) return s;
    }
  }
  return undefined;
}

// --- auth header scheme (shared by HTTP_ENDPOINT + MCP) ----------------------

/** A concrete request header (name + value) derived from a resolved secret. */
export interface AuthHeader {
  name: string;
  value: string;
}

/**
 * Resolve a secret-backed auth mode + already-resolved secret value into the
 * concrete request header to apply, or `null` when the mode needs no
 * secret-derived header:
 *
 *   - BEARER | OAUTH2 | COGNITO → `Authorization: Bearer <secret>`
 *   - API_KEY                   → `<customHeader|Authorization>: <secret>`
 *       (the secret is sent verbatim; a non-blank `customHeader` overrides the
 *        default `Authorization` header name, e.g. `x-api-key`)
 *   - SIGV4 | NONE              → null (request signing / no auth)
 *
 * Pure and side-effect-free: callers resolve the secret first, then apply the
 * returned {name,value}. The secret value is never logged here. Adapters
 * normalise the header name (lower-case) when writing it onto the request,
 * matching HTTP's case-insensitive header semantics.
 */
export function authHeaderScheme(
  mode: AgentInvocationBlock['auth']['mode'],
  secret: string,
  customHeader?: string,
): AuthHeader | null {
  switch (mode) {
    case 'BEARER':
    case 'OAUTH2':
    case 'COGNITO':
      return { name: 'Authorization', value: `Bearer ${secret}` };
    case 'API_KEY':
      return {
        name: customHeader && customHeader.trim() ? customHeader : 'Authorization',
        value: secret,
      };
    default:
      return null; // SIGV4 / NONE — no secret-derived header
  }
}

// --- cross-account credential vending (shared by every agent-source adapter) -

/**
 * Extract the IAM role name (last path segment) from a role ARN, e.g.
 * `arn:aws:iam::123456789012:role/path/MyRole` -> `MyRole`. Returns undefined
 * when the input is not a role ARN.
 */
function roleNameFromArn(arn: string): string | undefined {
  const match = /:role\/(?:.*\/)?([^/]+)$/.exec(arn);
  return match ? match[1] : undefined;
}

/** Extract the 12-digit account id from any ARN, when present. */
function accountFromArn(arn: string): string | undefined {
  const parts = arn.split(':');
  return parts.length >= 5 && /^\d{12}$/.test(parts[4]) ? parts[4] : undefined;
}

/**
 * Vend short-lived, least-privilege credentials for invoking an imported
 * (possibly cross-account) agent — the single helper every agent-source
 * adapter's `vendCredentials` delegates to.
 *
 *   - `invocation.roleArn` set  → assume that customer-provided role via
 *     {@link PolicyManager.assumeScopedRole} under the `agent` scope, forwarding
 *     `invocation.externalId` as the STS ExternalId (cross-account
 *     confused-deputy guard) and `invocation.account` as the target account.
 *     The assumed credentials are mapped onto a {@link VendedCredentials}.
 *   - no `roleArn`              → the caller invokes under its own (task/Lambda)
 *     identity; return a minimal descriptor carrying no separate credentials.
 *
 * The {@link PolicyManager} is injectable for testing; production callers omit
 * `deps`. NOTE: this helper is not yet wired into the discover/invoke call
 * paths — the consumer lands in a later increment.
 */
export async function vendImportCredentials(
  invocation: AgentInvocationBlock,
  deps: { policyManager?: PolicyManager } = {},
): Promise<VendedCredentials> {
  const roleArn = invocation.roleArn;
  if (!roleArn) {
    // No cross-account role configured — nothing to assume.
    return {};
  }

  const policyManager = deps.policyManager ?? new PolicyManager();
  const account = invocation.account ?? accountFromArn(roleArn) ?? '';
  const resourceId = roleNameFromArn(roleArn) ?? 'imported-agent';

  const creds = await policyManager.assumeScopedRole(
    resourceId,
    account,
    'agent',
    roleArn,
    invocation.externalId,
  );

  return {
    roleArn,
    expiresAt: creds.expiresAt,
    accessKeyId: creds.accessKeyId,
    secretAccessKey: creds.secretAccessKey,
    sessionToken: creds.sessionToken,
  };
}
