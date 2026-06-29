/**
 * BACKEND-ONLY best-effort reachability probe for imported-agent endpoints
 * (US-IMP-017b).
 *
 * The import-resolver Lambda runs OUTSIDE any customer VPC, so it can only
 * verify PUBLIC endpoints. A private / cross-account target is therefore
 * classified 'unverifiable_private' with an honest note (NOT falsely
 * 'unreachable') — a peered-VPC prober is a deferred add-on. The probe:
 *   - is BEST-EFFORT: it NEVER throws and always returns a classified result;
 *   - is BOUNDED by an AbortController timeout so a hanging endpoint cannot
 *     stall the Lambda;
 *   - issues a plain unauthenticated GET and NEVER reads the response body, so
 *     no body/secret is ever exfiltrated, logged, or returned.
 */

/** How a probed endpoint was classified. */
export type ReachabilityClassification =
  | 'reachable'
  | 'unreachable'
  | 'unverifiable_private'
  | 'no_endpoint';

/** Whether an endpoint host is reachable from this (non-VPC) Lambda. */
export type EndpointHostClass = 'public' | 'private';

/** Result of a best-effort reachability probe. Never thrown — always returned. */
export interface ReachabilityResult {
  reachable: boolean;
  classification: ReachabilityClassification;
  detail?: string;
}

/** Options for {@link probeReachability}. `fetchFn` is injectable for tests. */
export interface ProbeReachabilityOptions {
  /** AbortController bound in ms (default 5000). */
  timeoutMs?: number;
  /** Injected fetch (defaults to the late-bound global fetch). */
  fetchFn?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 5000;

const PRIVATE_DETAIL =
  'endpoint resolves to a private/internal host; not reachable from the ' +
  'non-VPC import Lambda — needs VPC peering/PrivateLink (out of scope)';

/**
 * Classifies an endpoint's host as 'private' (unreachable-and-unverifiable from
 * this non-VPC Lambda) or 'public'. Private covers:
 *   - RFC1918 IPv4: 10/8, 172.16/12, 192.168/16
 *   - loopback 127/8 (and the `localhost`/`::1` names)
 *   - link-local 169.254/16 (incl. the EC2 IMDS address)
 *   - internal DNS suffixes: `.internal`, `.local`, `.localhost`
 *   - AWS internal ALB/NLB DNS: `internal-*.<...>.elb.amazonaws.com`
 *
 * Unparseable input cannot be proven private, so it defaults to 'public'
 * ({@link probeReachability} validates the URL separately before classifying).
 */
export function classifyEndpointHost(url: string): EndpointHostClass {
  const host = extractHostname(url);
  if (!host) return 'public';

  // Strip IPv6 brackets and lowercase for suffix/name comparisons.
  const h = host.replace(/^\[/, '').replace(/\]$/, '').toLowerCase();

  // Loopback / internal DNS names + suffixes.
  if (
    h === 'localhost' ||
    h === '::1' ||
    h.endsWith('.localhost') ||
    h.endsWith('.internal') ||
    h.endsWith('.local')
  ) {
    return 'private';
  }

  // AWS internal ALB/NLB DNS (e.g. internal-foo-123.us-east-1.elb.amazonaws.com).
  if (h.startsWith('internal-') && h.endsWith('.elb.amazonaws.com')) {
    return 'private';
  }

  // RFC1918 / loopback / link-local IPv4 literals.
  if (isPrivateIpv4(h)) return 'private';

  return 'public';
}

/**
 * Best-effort reachability probe. Classification rules:
 *   - no / invalid / non-http(s) endpoint → 'no_endpoint' (no fetch);
 *   - private/internal host → 'unverifiable_private' (no fetch — honest, not a
 *     false 'unreachable');
 *   - public host → bounded GET: ANY HTTP response (even non-2xx) → 'reachable';
 *     a network error or the AbortController timeout → 'unreachable'.
 *
 * NEVER throws (a fetch rejection/timeout is caught and classified). NEVER reads
 * the response body.
 */
export async function probeReachability(
  url: string | undefined,
  options: ProbeReachabilityOptions = {},
): Promise<ReachabilityResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchFn = options.fetchFn ?? ((input, init) => globalThis.fetch(input, init));

  // 1. No / invalid / non-http(s) endpoint → nothing to probe.
  const parsed = parseHttpUrl(url);
  if (!parsed) {
    return {
      reachable: false,
      classification: 'no_endpoint',
      detail: 'no HTTP(S) endpoint to probe',
    };
  }

  // 2. Private / internal host → unverifiable from this non-VPC Lambda. Do NOT
  //    fetch a private host blindly (it would falsely read as 'unreachable').
  if (classifyEndpointHost(parsed.href) === 'private') {
    return { reachable: false, classification: 'unverifiable_private', detail: PRIVATE_DETAIL };
  }

  // 3. Public host → bounded GET. Any HTTP response means the host is reachable;
  //    a network error or the AbortController timeout means it is not.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchFn(parsed.href, { method: 'GET', signal: controller.signal });
    // Only the status line is inspected — the body is never read (no secret/
    // payload exfiltration).
    return { reachable: true, classification: 'reachable', detail: `HTTP ${res.status}` };
  } catch (err) {
    return { reachable: false, classification: 'unreachable', detail: errMessage(err) };
  } finally {
    clearTimeout(timer);
  }
}

// --- helpers ---------------------------------------------------------------

/** Parse an http(s) URL; undefined for empty/invalid/non-http(s) input. */
function parseHttpUrl(url: string | undefined): URL | undefined {
  if (typeof url !== 'string' || url.trim() === '') return undefined;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
  return parsed;
}

/**
 * Extract a hostname from a URL string, tolerating a scheme-less host so the
 * classifier can be called directly with a bare host. Undefined when neither
 * parse succeeds.
 */
function extractHostname(url: string): string | undefined {
  if (typeof url !== 'string' || url.trim() === '') return undefined;
  try {
    return new URL(url).hostname;
  } catch {
    try {
      return new URL(`http://${url}`).hostname;
    } catch {
      return undefined;
    }
  }
}

/** True for an RFC1918 / loopback / link-local IPv4 literal. */
function isPrivateIpv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const octets = m.slice(1, 5).map(Number);
  if (octets.some((o) => o > 255)) return false;
  const [a, b] = octets;
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local (incl. IMDS)
  return false;
}

/** Network/timeout error → a short, secret-free detail string. */
function errMessage(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === 'AbortError') return 'request timed out';
    return err.message;
  }
  return String(err);
}
