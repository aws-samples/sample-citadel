/**
 * API key hashing — HMAC-SHA-256 with a server-side pepper.
 *
 * Threat-model decision (security-architect, see planning pipeline task
 * c5525012-faaa-4f17-9176-54ef4c633931): a plain SHA-256 hash of a stored
 * API key is a CodeQL js/insufficient-password-hash finding. HMAC-SHA-256
 * keyed with a secret pepper (never stored in the DB) preserves the
 * deterministic find-by-hashedKey lookup used by the authorizer while
 * making the DB dump alone useless for offline verification.
 *
 * `legacyHashApiKey` is an isolated, single-purpose helper used ONLY by the
 * authorizer's dual-read branch during the migration window (see
 * app-api-authorizer.ts). It must never be used to produce new stored
 * hashes — new keys are always written with `hashApiKey` + `HASH_ALG`.
 */
import { createHash, createHmac } from "crypto";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";

/** Versioned identifier for the current hashing algorithm. Stored alongside
 * new hashedKey values (as `hashAlg`) so the authorizer can distinguish
 * HMAC records from legacy plain-SHA-256 records without a schema migration. */
export const HASH_ALG = "hmac-sha256-v1";

/**
 * Computes the HMAC-SHA-256 digest of a plaintext API key using the
 * server-side pepper as the HMAC key. Returns a 64-char hex digest.
 */
export function hashApiKey(plaintext: string, pepper: string): string {
  return createHmac("sha256", pepper).update(plaintext).digest("hex");
}

/**
 * Legacy plain SHA-256 digest — matches the hashing scheme used before the
 * HMAC-with-pepper migration. This is intentionally isolated to a single
 * line so it is trivially auditable and greppable.
 *
 * Backward-compat verification of pre-existing Agent App API keys — 256-bit
 * cryptographically-random machine tokens (randomBytes(32) base64url), NOT
 * human passwords, so offline brute-force/dictionary/rainbow-table attacks
 * against SHA-256 are infeasible (CWE-916 threat model does not apply). New
 * keys use HMAC-SHA-256 with a server-side pepper; legacy plaintext cannot
 * be re-derived, so this comparison is required for the bounded dual-read
 * migration window and is scheduled for removal once legacy keys
 * expire/rotate out.
 */
export function legacyHashApiKey(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

// ── Pepper sourcing (SSM SecureString, module-scope cache per cold start) ──

let _ssmClient: SSMClient | undefined;
function getSsmClient(): SSMClient {
  if (!_ssmClient) _ssmClient = new SSMClient({});
  return _ssmClient;
}

interface PepperCacheEntry {
  pepper: string;
}

let _pepperCache: PepperCacheEntry | undefined;

/**
 * Reads the API key pepper from SSM Parameter Store
 * (`/citadel/${ENVIRONMENT}/app-api-key-pepper`, SecureString, KMS-encrypted)
 * and caches it for the lifetime of the Lambda execution environment.
 *
 * Throws (does not swallow) on any failure — callers (authorizer, key
 * producers) must fail closed rather than proceed without a pepper.
 */
export async function getApiKeyPepper(): Promise<string> {
  if (_pepperCache) return _pepperCache.pepper;

  const environment = process.env.ENVIRONMENT || "dev";
  const name = `/citadel/${environment}/app-api-key-pepper`;

  const client = getSsmClient();
  const response = await client.send(
    new GetParameterCommand({ Name: name, WithDecryption: true }),
  );

  const pepper = response.Parameter?.Value;
  if (!pepper) {
    throw new Error(`API key pepper not found at SSM parameter ${name}`);
  }

  _pepperCache = { pepper };
  return pepper;
}

/** Test-only: reset the internal pepper cache. Do not call from production code. */
export function __resetApiKeyPepperCacheForTest(): void {
  _pepperCache = undefined;
  _ssmClient = undefined;
}
