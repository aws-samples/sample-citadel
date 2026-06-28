/**
 * Small shared helpers used by the per-protocol invoke()/describe()/auth
 * implementations. Kept substrate-agnostic (type-only imports, erased at
 * compile time) so each adapter stays minimal and free of duplicated logic.
 */
import type { AgentInvocationBlock, JsonSchema } from './base';

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
