/**
 * Small shared helpers used by the per-protocol invoke() implementations.
 * Kept dependency-free and substrate-agnostic so each adapter stays minimal.
 */

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
