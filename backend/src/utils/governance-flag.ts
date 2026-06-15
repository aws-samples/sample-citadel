/**
 * Governance rollout flag reader.
 *
 * Reads two SSM parameters that control governance enforcement:
 *   /citadel/governance/enforce/{env}       → 'permissive' | 'shadow' | 'strict'
 *   /citadel/governance/effective_at/{env}  → ISO-8601 string or '' (empty)
 *
 * Strict allowlist on enforce values per QT2A-6; any value outside the three
 * literals falls back to 'permissive' (safest — no hard enforcement).
 *
 * Per QT3-8, effective_at is auto-written on the first permissive → shadow
 * flip by a CDK custom resource (defined in backend/lib/).
 *
 * Cache TTL is 60 minutes (process-local, per-Lambda-container).
 */

import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

export type GovernanceEnforce = 'permissive' | 'shadow' | 'strict';

const CACHE_TTL_MS = 60 * 60 * 1000;

interface CacheEntry {
  enforce: GovernanceEnforce;
  effectiveAt: string | null;
  loadedAt: number;
}

const cache: Map<string, CacheEntry> = new Map();

let _client: SSMClient | null = null;
function ssm(): SSMClient {
  if (!_client) _client = new SSMClient({});
  return _client;
}

async function fetchOne(name: string): Promise<string | null> {
  try {
    const resp = await ssm().send(new GetParameterCommand({ Name: name }));
    return resp.Parameter?.Value ?? null;
  } catch {
    return null;
  }
}

function isValidEnforce(v: string | null): v is GovernanceEnforce {
  return v === 'permissive' || v === 'shadow' || v === 'strict';
}

async function refresh(env: string): Promise<CacheEntry> {
  const [enforceRaw, effectiveAtRaw] = await Promise.all([
    fetchOne(`/citadel/governance/enforce/${env}`),
    fetchOne(`/citadel/governance/effective_at/${env}`),
  ]);

  const enforce: GovernanceEnforce = isValidEnforce(enforceRaw) ? enforceRaw : 'permissive';
  const effectiveAt: string | null =
    effectiveAtRaw && effectiveAtRaw.length > 0 ? effectiveAtRaw : null;

  const entry: CacheEntry = { enforce, effectiveAt, loadedAt: Date.now() };
  cache.set(env, entry);
  return entry;
}

async function getOrRefresh(env: string): Promise<CacheEntry> {
  const existing = cache.get(env);
  if (existing && Date.now() - existing.loadedAt < CACHE_TTL_MS) return existing;
  return refresh(env);
}

export async function getGovernanceEnforce(env: string): Promise<GovernanceEnforce> {
  return (await getOrRefresh(env)).enforce;
}

export async function getGovernanceEffectiveAt(env: string): Promise<string | null> {
  return (await getOrRefresh(env)).effectiveAt;
}

/** Test-only: reset the internal cache. Do not call from production code. */
export function __resetGovernanceFlagCacheForTest(): void {
  cache.clear();
  _client = null;
}
