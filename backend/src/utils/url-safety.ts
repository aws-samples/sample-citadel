/**
 * URL safety helpers for SSRF prevention on caller-supplied endpoints.
 *
 * Design: CIT-254 SH-2. Uses a resolve-then-connect-by-IP strategy:
 * 1. Parse the URL (https only, no userinfo).
 * 2. DNS-resolve → reject if ANY address is non-public.
 * 3. Connect to the pinned IP with the original Host + SNI (servername).
 *
 * No new dependencies — uses `node:dns`, `node:https`, `node:net`.
 */

import * as dns from "dns";
import * as https from "https";
import * as net from "net";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** IP address classification. */
export type IpClass =
  "public" | "private" | "loopback" | "link-local" | "metadata" | "reserved";

/** Result of a successful {@link resolveAndPin}. */
export interface PinnedEndpoint {
  /** First resolved public IP address. */
  ip: string;
  /** Original hostname for SNI / Host header. */
  servername: string;
  /** Original host (hostname + port). */
  host: string;
}

/** Options for {@link parsePublicHttpsUrl}. */
export interface ParseUrlOptions {
  /** Ports allowed beyond the implicit 443 (default: `[8443]`). */
  allowedPorts?: number[];
}

/** Injectable DNS lookup returning IP strings. */
export type DnsLookupFn = (hostname: string) => Promise<string[]>;

/** Options for {@link resolveAndPin}. */
export interface ResolveAndPinOptions {
  lookup?: DnsLookupFn;
}

/** Options for {@link safeHttpsRequest}. */
export interface SafeHttpsRequestOptions {
  /** Request timeout in ms (default 10_000). */
  timeoutMs?: number;
  /** Maximum response body bytes (default 1_048_576 = 1 MiB). */
  maxBodyBytes?: number;
  /** Injectable DNS lookup. */
  lookup?: DnsLookupFn;
}

/** Minimal fetch-shaped response from {@link safeHttpsRequest}. */
export interface SafeResponse {
  status: number;
  headers: Record<string, string | undefined>;
  body: Buffer;
}

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

const OPAQUE_MESSAGE = "Invalid endpoint";

export class UrlRejectedError extends Error {
  constructor(detail?: string) {
    super(OPAQUE_MESSAGE);
    this.name = "UrlRejectedError";
    // Detail is for internal logging only — never surfaced to callers.
    if (detail) (this as Record<string, unknown>)["_detail"] = detail;
  }
}

// ---------------------------------------------------------------------------
// IP classification
// ---------------------------------------------------------------------------

/**
 * Classify an IPv4 address string.
 *
 * Covers: 10/8, 172.16/12, 192.168/16, 127/8, 169.254/16 (link-local +
 * metadata 169.254.169.254), 0/8, 100.64/10 (CGN), 224/3 (multicast +
 * reserved), 255.255.255.255.
 */
export function classifyIpv4(ip: string): IpClass {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return "public"; // not a dotted-quad → caller handles
  const octets = m.slice(1, 5).map(Number);
  if (octets.some((o) => o > 255)) return "public";
  const [a, b, c, d] = octets;

  // Loopback: 127.0.0.0/8
  if (a === 127) return "loopback";

  // Link-local: 169.254.0.0/16 — metadata is the specific 169.254.169.254
  if (a === 169 && b === 254) {
    if (c === 169 && d === 254) return "metadata";
    return "link-local";
  }

  // RFC1918
  if (a === 10) return "private";
  if (a === 172 && b >= 16 && b <= 31) return "private";
  if (a === 192 && b === 168) return "private";

  // CGN: 100.64.0.0/10
  if (a === 100 && b >= 64 && b <= 127) return "private";

  // "This host" network: 0.0.0.0/8
  if (a === 0) return "reserved";

  // Multicast (224/4) + reserved (240/4) + broadcast
  if (a >= 224) return "reserved";

  return "public";
}

/**
 * Classify an IPv6 address string.
 *
 * Covers: ::1 (loopback), fc00::/7 (ULA), fe80::/10 (link-local),
 * ::ffff:x.x.x.x (IPv4-mapped — delegates to {@link classifyIpv4}),
 * :: (unspecified).
 */
export function classifyIpv6(ip: string): IpClass {
  // Normalise: lowercase, strip brackets
  const norm = ip.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();

  // Unspecified
  if (norm === "::") return "reserved";

  // Loopback
  if (norm === "::1") return "loopback";

  // IPv4-mapped ::ffff:x.x.x.x (dotted-quad form)
  const v4mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(norm);
  if (v4mapped) return classifyIpv4(v4mapped[1]);

  // IPv4-mapped in hex form: ::ffff:HHHH:HHHH or 0:0:0:0:0:ffff:HHHH:HHHH
  // where each H-group is a 16-bit big-endian pair of the IPv4 octets.
  const v4hex =
    /^(?:0:){0,4}0{0,4}:0{0,4}:ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(
      norm,
    ) ?? /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(norm);
  if (v4hex) {
    const hi = parseInt(v4hex[1], 16);
    const lo = parseInt(v4hex[2], 16);
    const a = (hi >> 8) & 0xff;
    const b = hi & 0xff;
    const c = (lo >> 8) & 0xff;
    const d = lo & 0xff;
    return classifyIpv4(`${a}.${b}.${c}.${d}`);
  }

  // Expand enough to check the first 16-bit group.
  const firstGroup = norm.split(":")[0];
  const fg = parseInt(firstGroup, 16);
  if (!isNaN(fg)) {
    // fc00::/7 — ULA (fc00-fdff)
    if (fg >= 0xfc00 && fg <= 0xfdff) return "private";
    // fe80::/10 — link-local (fe80-febf)
    if (fg >= 0xfe80 && fg <= 0xfebf) return "link-local";
  }

  return "public";
}

/**
 * Classify any IP address string (IPv4 or IPv6).
 *
 * Returns `'public'` only when the address is confirmed public.
 */
export function classifyIp(ip: string): IpClass {
  if (net.isIPv4(ip)) return classifyIpv4(ip);
  if (net.isIPv6(ip)) return classifyIpv6(ip);

  // Try bracket-stripped form for IPv6
  const stripped = ip.replace(/^\[/, "").replace(/\]$/, "");
  if (net.isIPv6(stripped)) return classifyIpv6(stripped);

  return "public"; // not an IP literal — caller decides
}

// ---------------------------------------------------------------------------
// URL parsing
// ---------------------------------------------------------------------------

/**
 * Parse and validate a public HTTPS URL.
 *
 * Rejects: non-https, userinfo (e.g. `user:pass@`), disallowed ports,
 * literal private/loopback/link-local/metadata IPs.
 *
 * @returns a validated `URL` object.
 * @throws {UrlRejectedError} on any violation.
 */
export function parsePublicHttpsUrl(
  url: string,
  opts: ParseUrlOptions = {},
): URL {
  const allowedPorts = opts.allowedPorts ?? [8443];

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new UrlRejectedError("parse failure");
  }

  // HTTPS only
  if (parsed.protocol !== "https:") {
    throw new UrlRejectedError("not https");
  }

  // No userinfo
  if (parsed.username || parsed.password) {
    throw new UrlRejectedError("userinfo present");
  }

  // Port check — empty means implicit 443
  if (parsed.port !== "") {
    const port = Number(parsed.port);
    if (port !== 443 && !allowedPorts.includes(port)) {
      throw new UrlRejectedError("disallowed port");
    }
  }

  // Reject literal IP addresses that are non-public.
  // URL.hostname keeps brackets on IPv6 (e.g. `[::1]`), so strip them.
  const hostname = parsed.hostname;
  const bareHostname = hostname.replace(/^\[/, "").replace(/\]$/, "");
  if (net.isIPv4(bareHostname) || net.isIPv6(bareHostname)) {
    const cls = classifyIp(bareHostname);
    if (cls !== "public") {
      throw new UrlRejectedError(`literal IP is ${cls}`);
    }
  }

  // Reject numeric-encoding tricks for IPv4 (decimal, octal, hex, shorthand).
  // These bypass the standard dotted-quad check above.
  if (isNumericIpEncoding(hostname)) {
    throw new UrlRejectedError("numeric IP encoding");
  }

  return parsed;
}

// ---------------------------------------------------------------------------
// DNS resolution + pinning
// ---------------------------------------------------------------------------

/** Default lookup: resolve A + AAAA records. */
async function defaultLookup(hostname: string): Promise<string[]> {
  const results: string[] = [];
  try {
    const v4 = await dns.promises.resolve4(hostname);
    results.push(...v4);
  } catch {
    // NODATA / NXDOMAIN for v4 is fine if v6 succeeds
  }
  try {
    const v6 = await dns.promises.resolve6(hostname);
    results.push(...v6);
  } catch {
    // same
  }
  return results;
}

/**
 * Resolve a parsed HTTPS URL's hostname to IP addresses and reject if ANY
 * address is non-public.
 *
 * @returns a {@link PinnedEndpoint} with the first resolved public IP.
 * @throws {UrlRejectedError} if resolution fails or any address is non-public.
 */
export async function resolveAndPin(
  url: URL,
  opts: ResolveAndPinOptions = {},
): Promise<PinnedEndpoint> {
  const lookup = opts.lookup ?? defaultLookup;
  const hostname = url.hostname;

  let addresses: string[];
  try {
    addresses = await lookup(hostname);
  } catch {
    throw new UrlRejectedError("dns resolution failed");
  }

  if (addresses.length === 0) {
    throw new UrlRejectedError("no addresses resolved");
  }

  // Reject if ANY resolved address is non-public.
  for (const addr of addresses) {
    const cls = classifyIp(addr);
    if (cls !== "public") {
      throw new UrlRejectedError(`resolved address ${addr} is ${cls}`);
    }
  }

  return {
    ip: addresses[0],
    servername: hostname,
    host: url.host,
  };
}

// ---------------------------------------------------------------------------
// Safe HTTPS request (pinned IP, no redirects)
// ---------------------------------------------------------------------------

/**
 * Make an HTTPS request connecting to the DNS-pinned IP with the original
 * Host header and SNI servername. Redirects (3xx) are treated as errors.
 *
 * This is a fetch-shaped wrapper suitable for existing `fetchFn` injection
 * points.
 *
 * @throws {UrlRejectedError} on redirect, timeout, or body overflow.
 */
export async function safeHttpsRequest(
  url: string,
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {},
  deps: SafeHttpsRequestOptions = {},
): Promise<SafeResponse> {
  const parsed = parsePublicHttpsUrl(url);
  const pinned = await resolveAndPin(parsed, { lookup: deps.lookup });

  const timeoutMs = deps.timeoutMs ?? 10_000;
  const maxBodyBytes = deps.maxBodyBytes ?? 1_048_576;

  return new Promise<SafeResponse>((resolve, reject) => {
    const reqOpts: https.RequestOptions = {
      hostname: pinned.ip,
      port: parsed.port ? Number(parsed.port) : 443,
      path: parsed.pathname + parsed.search,
      method: init.method ?? "GET",
      headers: {
        ...init.headers,
        Host: pinned.host,
      },
      servername: pinned.servername,
      timeout: timeoutMs,
      // Reject self-signed / invalid certs
      rejectUnauthorized: true,
    };

    const req = https.request(reqOpts, (res) => {
      const status = res.statusCode ?? 0;

      // Redirect → error (refuse to follow)
      if (status >= 300 && status < 400) {
        res.destroy();
        reject(new UrlRejectedError("redirect refused"));
        return;
      }

      const chunks: Buffer[] = [];
      let totalBytes = 0;

      res.on("data", (chunk: Buffer) => {
        totalBytes += chunk.length;
        if (totalBytes > maxBodyBytes) {
          res.destroy();
          reject(new UrlRejectedError("response body exceeds max size"));
          return;
        }
        chunks.push(chunk);
      });

      res.on("end", () => {
        const headers: Record<string, string | undefined> = {};
        for (const [k, v] of Object.entries(res.headers)) {
          headers[k] = Array.isArray(v) ? v.join(", ") : v;
        }
        resolve({ status, headers, body: Buffer.concat(chunks) });
      });

      res.on("error", (err) => reject(new UrlRejectedError(err.message)));
    });

    req.on("timeout", () => {
      req.destroy();
      reject(new UrlRejectedError("request timed out"));
    });

    req.on("error", (err) => reject(new UrlRejectedError(err.message)));

    if (init.body) req.write(init.body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Detect numeric IP encoding tricks (decimal, octal, hex, shorthand) that
 * bypass the standard dotted-quad regex.
 *
 * Examples: `2130706433` (decimal 127.0.0.1), `0x7f000001` (hex),
 * `0177.0.0.1` (octal), `127.1` (shorthand for 127.0.0.1).
 */
function isNumericIpEncoding(hostname: string): boolean {
  // Pure decimal integer (e.g. 2130706433)
  if (/^\d+$/.test(hostname)) {
    const n = Number(hostname);
    if (n >= 0 && n <= 0xffffffff) return true;
  }

  // Hex integer (e.g. 0x7f000001)
  if (/^0x[0-9a-f]+$/i.test(hostname)) {
    const n = parseInt(hostname, 16);
    if (n >= 0 && n <= 0xffffffff) return true;
  }

  // Shorthand dotted notation (e.g. 127.1 = 127.0.0.1) or octal (e.g. 0177.0.0.1)
  // These have fewer than 4 parts or parts with leading zeros (octal).
  const parts = hostname.split(".");
  if (
    parts.length >= 2 &&
    parts.length <= 4 &&
    parts.every((p) => /^\d+$/.test(p))
  ) {
    // Shorthand: fewer than 4 parts
    if (parts.length < 4) return true;
    // Octal: any part with a leading zero and length > 1
    if (parts.some((p) => p.length > 1 && p.startsWith("0"))) return true;
  }

  return false;
}
