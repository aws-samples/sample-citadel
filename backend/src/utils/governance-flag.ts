/**
 * Governance rollout flag reader.
 *
 * Reads two SSM parameters that control governance enforcement:
 *   /citadel/governance/enforce/{env}       → 'permissive' | 'shadow' | 'strict'
 *   /citadel/governance/effective_at/{env}  → ISO-8601 string or '' (empty)
 *
 * Strict allowlist on enforce values per QT2A-6; any value outside the three
 * literals falls back to 'shadow', NOT 'permissive'.
 *
 * FALLBACK MODE ('shadow', not 'permissive' or 'strict') — this default was
 * changed from 'permissive'. Rationale (see the enforcement-lookup fallback
 * assessment this change implements):
 *   - 'permissive' was the ORIGINAL default, chosen because
 *     `fetchOne()` swallowed every SSM error in an empty `catch {}` — a
 *     resolution failure silently became "no enforcement, no record".
 *     That is the defect: outages produce zero durable evidence they
 *     ever happened (permissive never writes a governance-ledger
 *     finding — see governance-disposition.ts), which is precisely why
 *     it stayed unnoticed.
 *   - 'strict' would be OVER-enforcing: the two consumers that actually
 *     gate on this value (agent-config-resolver's
 *     enforceImportActivationGate, environment-release-pointer-resolver's
 *     promotion gate) only block in strict mode. A transient SSM blip
 *     would escalate to the MOST restrictive mode and block imported-agent
 *     activations and release promotions that the operator never
 *     configured to be blocking — a surprising, self-inflicted outage.
 *   - 'shadow' is the correct middle ground: every consumer still
 *     evaluates and records (a ledger finding is written — see
 *     governanceDisposition('shadow') === { recordFinding: true, block:
 *     false }), so a degraded read is now a durable, queryable event
 *     instead of a silent one, while introducing no new VERDICT-blocking
 *     behavior versus the old 'permissive' default (permissive and
 *     shadow are both `block: false` for the verdict itself). CORRECTED
 *     (finding 23971f32): this does NOT mean shadow mode is blocking-free
 *     end to end. Per the USER DECISION that ledger recording is
 *     fail-closed in BOTH modes, the recording write in shadow mode is a
 *     bare, unguarded `await` — if GOVERNANCE_LEDGER_TABLE write fails
 *     (e.g. an infrastructure fault such as a missing IAM grant), that
 *     failure propagates and blocks the promotion, even though the
 *     underlying gate VERDICT never asked for a block. Shadow is also
 *     the fallback mode this file resolves to on any SSM read failure or
 *     out-of-allowlist value, so a ledger outage co-occurring with an
 *     SSM outage is a real, non-hypothetical failure mode to consider,
 *     not just a theoretical edge case.
 * This mirrors `arbiter/governance/hierarchy.py`'s
 * `_DEFAULT_ENFORCEMENT_MODE = "shadow"`, which already used this value —
 * see the cross-runtime contract test in this file's test suite
 * ("TS fallback literal matches the shared cross-runtime default") and in
 * `test_hierarchy_enforcement_mode.py`. The two readers are deliberately
 * THE SAME here, not differentiated — see the module doc in hierarchy.py's
 * `_resolve_enforcement_mode` for the mirrored rationale on that side.
 *
 * Per QT3-8, effective_at is auto-written on the first permissive → shadow
 * flip by a CDK custom resource (defined in backend/lib/).
 *
 * Cache TTL defaults to 60 seconds (process-local, per-Lambda-container),
 * overridable via the GOVERNANCE_FLAG_CACHE_TTL_SECONDS env variable.
 * On SSM error the cache keeps the last good value and logs; a cold-start
 * error (no prior value) still falls back to DEFAULT_ENFORCEMENT_MODE.
 */

import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import { emitMetrics } from "./emf";

export type GovernanceEnforce = "permissive" | "shadow" | "strict";

/**
 * Fallback value used when the SSM parameter cannot be read or holds a
 * value outside the three-literal contract. Kept as a single named
 * constant (rather than inlined 'shadow' literals) so the cross-runtime
 * contract test can assert this exact binding equals Python's
 * `_DEFAULT_ENFORCEMENT_MODE`.
 */
export const DEFAULT_ENFORCEMENT_MODE: GovernanceEnforce = "shadow";

const DEFAULT_CACHE_TTL_SECONDS = 60;

function cacheTtlMs(): number {
  const envVal = process.env.GOVERNANCE_FLAG_CACHE_TTL_SECONDS;
  if (envVal !== undefined) {
    const parsed = Number(envVal);
    if (Number.isFinite(parsed) && parsed > 0) return parsed * 1000;
  }
  return DEFAULT_CACHE_TTL_SECONDS * 1000;
}

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
  } catch (err) {
    // Visibility fix: this catch used to be empty, which is exactly how
    // a config read failure stayed silent. Mirrors Python's
    // `logger.warning` on the identical SSM-failure branch in
    // `hierarchy.py::_resolve_enforcement_mode`.
    console.warn(`governance-flag: SSM read failed for "${name}":`, err);
    return null;
  }
}

function isValidEnforce(v: string | null): v is GovernanceEnforce {
  return v === "permissive" || v === "shadow" || v === "strict";
}

/**
 * Emits a distinct "governance flag defaulted" signal so a defaulted mode
 * is observably different from a mode that was actually read from SSM. A
 * gate that defaults must never be indistinguishable from a gate that
 * read its configured mode. Reuses the existing dependency-free EMF
 * emitter (`./emf`) — the same structured-log/CloudWatch surface already
 * used elsewhere in this codebase (e.g. `eval-drift-detector.ts`,
 * `agent-message-handler.ts`) — rather than introducing a new AWS client
 * into this hot, frequently-invoked shared reader. `emitMetrics` never
 * throws, so this call cannot destabilize a caller of `getGovernanceEnforce`.
 */
function emitGovernanceFlagDefaulted(
  env: string,
  reason: "ssm_error" | "invalid_value",
): void {
  emitMetrics({
    namespace: "Citadel/Governance",
    metrics: [{ name: "GovernanceFlagDefaulted", value: 1, unit: "Count" }],
    dimensions: { Environment: env },
    properties: { reason, defaultedTo: DEFAULT_ENFORCEMENT_MODE },
  });
}

async function refresh(env: string): Promise<CacheEntry> {
  const previous = cache.get(env);

  let enforceRaw: string | null;
  let effectiveAtRaw: string | null;
  try {
    [enforceRaw, effectiveAtRaw] = await Promise.all([
      fetchOne(`/citadel/governance/enforce/${env}`),
      fetchOne(`/citadel/governance/effective_at/${env}`),
    ]);
  } catch (err) {
    // Unexpected error from Promise.all itself — keep last good value.
    console.warn("governance-flag: refresh failed unexpectedly:", err);
    if (previous) return previous;
    const fallback: CacheEntry = {
      enforce: DEFAULT_ENFORCEMENT_MODE,
      effectiveAt: null,
      loadedAt: Date.now(),
    };
    cache.set(env, fallback);
    return fallback;
  }

  // If both SSM reads returned null (fetchOne catches per-call errors and
  // returns null), keep the last good cached entry instead of overwriting
  // with the default — this preserves the last successfully-read mode
  // through transient SSM outages.
  if (enforceRaw === null && effectiveAtRaw === null && previous) {
    console.warn(
      `governance-flag: both SSM reads failed for env="${env}"; keeping last good cached value ("${previous.enforce}").`,
    );
    emitGovernanceFlagDefaulted(env, "ssm_error");
    return previous;
  }

  let enforce: GovernanceEnforce;
  if (isValidEnforce(enforceRaw)) {
    enforce = enforceRaw;
  } else {
    // Single-parameter failure with a prior good value: keep it.
    if (enforceRaw === null && previous) {
      console.warn(
        `governance-flag: enforce SSM read failed for env="${env}"; keeping last good cached value ("${previous.enforce}").`,
      );
      emitGovernanceFlagDefaulted(env, "ssm_error");
      enforce = previous.enforce;
    } else {
      enforce = DEFAULT_ENFORCEMENT_MODE;
      if (enforceRaw === null) {
        emitGovernanceFlagDefaulted(env, "ssm_error");
      } else {
        console.warn(
          `governance-flag: unresolvable enforcement mode value "${enforceRaw}" for env="${env}"; defaulting to "${DEFAULT_ENFORCEMENT_MODE}".`,
        );
        emitGovernanceFlagDefaulted(env, "invalid_value");
      }
    }
  }

  const effectiveAt: string | null =
    effectiveAtRaw && effectiveAtRaw.length > 0 ? effectiveAtRaw : null;

  const entry: CacheEntry = { enforce, effectiveAt, loadedAt: Date.now() };
  cache.set(env, entry);
  return entry;
}

async function getOrRefresh(env: string): Promise<CacheEntry> {
  const existing = cache.get(env);
  if (existing && Date.now() - existing.loadedAt < cacheTtlMs())
    return existing;
  return refresh(env);
}

export async function getGovernanceEnforce(
  env: string,
): Promise<GovernanceEnforce> {
  return (await getOrRefresh(env)).enforce;
}

export async function getGovernanceEffectiveAt(
  env: string,
): Promise<string | null> {
  return (await getOrRefresh(env)).effectiveAt;
}

/** Test-only: reset the internal cache. Do not call from production code. */
export function __resetGovernanceFlagCacheForTest(): void {
  cache.clear();
  _client = null;
}
