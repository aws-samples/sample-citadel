/**
 * Agent Import Resolver (US-IMP) — registration with conflict resolution.
 *
 * In addition to the `importAgent` mutation, this resolver now serves the
 * account-level discovery queries `discoverAgents` (SCAN / PASTE / MANIFEST)
 * and `describeAgentCandidate`, dispatched by {@link handler} on the AppSync
 * field name. Discovery is read-only and NEVER org-filtered (it enumerates the
 * customer's account); `importAgent` remains org-scoped.
 *
 * `importAgent` registers an externally-owned agent into the Registry as a
 * DRAFT/inactive record. Invariants enforced here:
 *   - Imported agents are NEVER auto-activated (no SubmitRegistryRecordForApproval
 *     / APPROVED transition). They land as DRAFT/inactive and require an explicit
 *     activation later.
 *   - `origin.ownership` is always forced to 'external' — Citadel orchestrates
 *     imported agents but never owns the customer's infrastructure.
 *   - Tenant assignment (`orgId`) is derived from the AppSync identity, never
 *     from the input payload (backend is the sole source of truth for tenancy).
 *   - Dedupe is scoped to the caller's organization so one tenant can never
 *     link to, replace, or collide with another tenant's record.
 *
 * RegistryService lifecycle (getRegistryService / _resetRegistryService) and
 * the shared import-descriptor validator are reused from agent-config-resolver
 * so import and create stay in lock-step.
 */
import { getRegistryService, validateImportDescriptor } from './agent-config-resolver';
import { createADR } from './adr-resolver';
import { extractOrgFromEvent, isAdminFromEvent, hasRoleFromEvent } from '../utils/auth-event';
import { v4 as uuidv4 } from 'uuid';
import { publishEvent, EventTypes } from '../utils/events';
import { grantFabricatorAuthority } from './registry-agent-authority-lifecycle';
import { getGovernanceEnforce } from '../utils/governance-flag';
import {
  storeAgentInvocationSecret,
  getAgentInvocationSecret,
  type StoreAgentInvocationSecretResult,
} from '../utils/credential-manager';
import { sanitizeUntrustedAgentOutput } from '../utils/sanitize-agent-output';
import type { AgentEvent, AuthContext } from '../types';
import {
  resolveSourceRef,
  tagScanDiscover,
  candidateFromManifest,
  UnsupportedSourceError,
  InvalidSourceRefError,
} from '../services/agent-discovery';
import { buildDefaultAgentSourceRegistry } from '../adapters/agent-source/registry-factory';
import type { AgentCandidate, AgentCapabilityDescriptor } from '../adapters/agent-source/types';
import type {
  AgentConfig,
  AgentCustomMetadata,
  AgentInvocationBlock,
  AgentInvocationProtocol,
  AgentInvocationAuthMode,
  AgentInvocationMode,
  AgentOrigin,
  RegistryRecord,
} from '../services/registry-service';

// Re-export the shared RegistryService singleton reset so the whole import
// surface (and tests) can be imported from this module.
export { _resetRegistryService } from './agent-config-resolver';

/** How a detected import conflict should be resolved by the caller. */
export type ImportConflictResolution = 'link' | 'replace' | 'copy';

/** Why an incoming import collided with an existing record. */
export type ImportConflictReason = 'sourceArn' | 'name';

/**
 * Returned (instead of an AgentConfig) when an import collides with an
 * existing record and the caller has not yet chosen how to resolve it. The
 * caller re-issues importAgent with `onConflict` set to one of `options`.
 */
export interface ImportConflictResult {
  conflict: true;
  existingId: string;
  reason: ImportConflictReason;
  options: ImportConflictResolution[];
}

/**
 * Flat result shape returned by the AppSync `importAgent` mutation (and the
 * {@link handler}). Always present: on success `agent` is populated and
 * `conflict` is false; on an unresolved collision `agent` is null and the
 * conflict fields ({@link ImportConflictResult}) are surfaced to the caller.
 */
export interface ImportAgentResult {
  agent: AgentConfig | null;
  conflict: boolean;
  existingId: string | null;
  reason: string | null;
  options: string[] | null;
}

/**
 * Flat AppSync input for the pre-activation TEST-INVOKE
 * ({@link testImportedAgent}). Mirrors the invocation-bearing fields of
 * {@link buildImportDescriptor}'s input, plus an optional `prompt`. There is no
 * `name`/`manifest`/`origin` because a test-invoke never creates a record — it
 * only needs enough to reach and call the candidate.
 */
export interface TestImportedAgentInput {
  invocationProtocol: string;
  invocationTarget: string;
  invocationAuthMode?: string;
  invocationAuthHeader?: string;
  invocationSecretRef?: string;
  /** RAW secret used for THIS test only — resolved transiently, never persisted. */
  invocationSecret?: string;
  invocationMode?: string;
  region?: string;
  account?: string;
  prompt?: string;
}

/**
 * Result of a pre-activation test-invoke. A reachable candidate returns
 * `{ ok:true, output:<sanitized> }`; an unreachable/erroring candidate returns
 * `{ ok:false, error }` — a failed invoke is a NORMAL result, not a thrown
 * error. `latencyMs` is always the wall-clock duration of the attempt.
 */
export interface ImportTestResult {
  ok: boolean;
  output: string | null;
  error: string | null;
  latencyMs: number;
}

const CONFLICT_OPTIONS: readonly ImportConflictResolution[] = ['link', 'replace', 'copy'];

const AGENT_METADATA_DEFAULTS: AgentCustomMetadata = {
  categories: [],
  icon: '',
  state: 'inactive',
};

/**
 * Synthetic GLOBAL project that every import-triggered Architecture Decision
 * Record is keyed to. An agent import is an account/org-level governance event
 * with no owning Citadel project, so its ADRs need a stable, well-known
 * `projectId`. createADR stores `projectId` as a plain attribute (no
 * foreign-key / existence check), so a synthetic constant is safe; it is kept
 * human-readable rather than a UUID because createADR does not validate
 * `projectId` as a UUID.
 */
export const SYNTHETIC_IMPORT_PROJECT_ID = 'citadel-imports-global';

/**
 * System principal under which import-triggered ADRs are written. The import
 * path is ITSELF the authorized governance trigger: the ADR is system-generated,
 * not a user `adr:create` action, so recording it must NOT require the importing
 * caller to hold the architect/admin role. createADR enforces `adr:create` and
 * performs its DynamoDB write inline (there is no lower-level write export to
 * call instead), so that check is satisfied with this dedicated, clearly
 * non-human system context rather than the caller's identity. The `system:`
 * userId becomes the ADR's `createdBy`, yielding a clean audit trail.
 */
const SYSTEM_IMPORT_ADR_AUTHOR: AuthContext = {
  userId: 'system:agent-import',
  username: 'system:agent-import',
  groups: [],
  roles: ['admin'],
};

/** Imported-agent metadata: standard agent metadata plus the importer identity. */
interface ImportedAgentMetadata extends AgentCustomMetadata {
  createdBy: string;
}

// --- AppSync event shape (minimal) -----------------------------------------

interface ImportEventIdentity {
  sub?: string;
  username?: string;
  claims?: Record<string, unknown>;
}

interface ImportAgentEvent {
  info?: { fieldName?: string };
  arguments?: { input?: unknown; ref?: unknown; agentId?: unknown };
  identity?: ImportEventIdentity;
}

// --- Narrowing helpers ------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((v) => typeof v === 'string')
    ? (value as string[])
    : undefined;
}

function isConflictResolution(value: unknown): value is ImportConflictResolution {
  return value === 'link' || value === 'replace' || value === 'copy';
}

// --- Best-effort import lifecycle event emission ---------------------------

/**
 * Emits an import lifecycle event (`agent.import.{registered,discovered,failed}`)
 * through the shared {@link publishEvent} helper (source `citadel.backend`,
 * bus from `EVENT_BUS_NAME`). BEST-EFFORT by contract: any failure is logged
 * and swallowed so a telemetry outage can NEVER fail — or alter the result
 * of — the underlying import mutation/query.
 *
 * The fixed `AgentEvent` envelope carries `correlationId` + ISO `timestamp`;
 * the import-specific fields live in `payload` (consistent with the existing
 * backend event schema). A `correlationId` is generated here when the caller
 * does not supply one (no request id is exposed on the AppSync event).
 */
async function emitImportEvent(
  eventType: string,
  payload: Record<string, unknown>,
  correlationId: string = uuidv4(),
): Promise<void> {
  try {
    const event: AgentEvent = {
      eventType,
      projectId: '',
      payload,
      timestamp: new Date().toISOString(),
      correlationId,
    };
    await publishEvent(event);
  } catch (err) {
    console.error(
      `agent-import-resolver: best-effort emit of ${eventType} failed (swallowed):`,
      err,
    );
  }
}

/** Unique substrates present in a discovery result, for the summary event. */
function uniqueSubstrates(candidates: FlatAgentCandidate[]): string[] {
  return [...new Set(candidates.map((c) => c.substrate))];
}

/**
 * Computes a non-colliding "imported copy" name. Returns
 * `"<base> (imported copy)"` when free, otherwise appends an incrementing
 * integer (`"<base> (imported copy 2)"`, `3`, …) until an unused name is
 * found. Exported for direct unit testing of the increment logic.
 */
export function buildImportCopyName(baseName: string, takenNames: Set<string>): string {
  const first = `${baseName} (imported copy)`;
  if (!takenNames.has(first)) return first;
  let n = 2;
  while (takenNames.has(`${baseName} (imported copy ${n})`)) n++;
  return `${baseName} (imported copy ${n})`;
}

// --- AppSync flat input → internal import descriptor -----------------------

/**
 * Maps the GraphQL `ImportConflictPolicy` enum (uppercase LINK/REPLACE/COPY)
 * onto the internal lower-case {@link ImportConflictResolution}. Returns
 * undefined for any absent/unrecognised value so the caller is re-prompted.
 */
function mapConflictPolicy(value: unknown): ImportConflictResolution | undefined {
  if (typeof value !== 'string') return undefined;
  const lowered = value.toLowerCase();
  return isConflictResolution(lowered) ? lowered : undefined;
}

/**
 * Parses an AWSJSON `manifest`, which AppSync may deliver either as a JSON
 * string or as an already-parsed object. Falls back to `{}` when absent or
 * unparseable so imported records always classify as agents (not tools).
 */
function parseManifestInput(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    try {
      const parsed: unknown = JSON.parse(value);
      if (isRecord(parsed)) return parsed;
    } catch {
      // fall through to the empty-manifest default
    }
  }
  return {};
}

/**
 * Maps the flat AppSync `ImportAgentInput` into the nested import descriptor
 * consumed by {@link importAgent}: `{ name, manifest, invocation:{ protocol,
 * target, auth:{ mode, secretRef }, mode, region, account }, origin:{ sourceArn,
 * account, region, substrate, ownership:'external' }, categories, onConflict }`.
 *
 * `ownership` is forced to 'external' and `discoveredAt` is stamped at import
 * time. Validation stays the sole responsibility of `validateImportDescriptor`
 * inside {@link importAgent}, so malformed inputs (e.g. a missing protocol)
 * flow through unchanged and are rejected there with a field-specific error.
 */
export function buildImportDescriptor(input: unknown): Record<string, unknown> {
  const flat = isRecord(input) ? input : {};

  const auth: Record<string, unknown> = {
    mode: asNonEmptyString(flat.invocationAuthMode) ?? 'NONE',
  };
  const secretRef = asNonEmptyString(flat.invocationSecretRef);
  if (secretRef) auth.secretRef = secretRef;
  // Optional custom API-key header name (e.g. 'x-api-key'); set ONLY when
  // provided so existing imports keep an unchanged { mode[, secretRef] } auth.
  const authHeader = asNonEmptyString(flat.invocationAuthHeader);
  if (authHeader) auth.header = authHeader;

  const region = asNonEmptyString(flat.region);
  const account = asNonEmptyString(flat.account);

  const invocation: Record<string, unknown> = {
    protocol: flat.invocationProtocol,
    target: flat.invocationTarget,
    auth,
    mode: asNonEmptyString(flat.invocationMode) ?? 'sync',
  };
  if (region) invocation.region = region;
  if (account) invocation.account = account;

  const origin: Record<string, unknown> = {
    substrate: flat.substrate,
    discoveredAt: new Date().toISOString(),
    ownership: 'external',
  };
  const sourceArn = asNonEmptyString(flat.sourceArn);
  if (sourceArn) origin.sourceArn = sourceArn;
  if (account) origin.account = account;
  if (region) origin.region = region;

  const descriptor: Record<string, unknown> = {
    name: flat.name,
    manifest: parseManifestInput(flat.manifest),
    invocation,
    origin,
    categories: asStringArray(flat.categories) ?? [],
  };
  const onConflict = mapConflictPolicy(flat.onConflict);
  if (onConflict) descriptor.onConflict = onConflict;
  // RAW caller-submitted secret (transient): carried as a top-level field so
  // importAgent can persist it to Secrets Manager. Deliberately kept OUT of
  // `invocation`/`origin` so it can never be serialized into the Registry
  // record (description/customMetadata are built from those two sub-objects).
  const invocationSecret = asNonEmptyString(flat.invocationSecret);
  if (invocationSecret) descriptor.invocationSecret = invocationSecret;
  return descriptor;
}

/** Type guard distinguishing an unresolved conflict from a mapped AgentConfig. */
function isConflictResult(
  value: AgentConfig | ImportConflictResult,
): value is ImportConflictResult {
  return (value as Partial<ImportConflictResult>).conflict === true;
}

/**
 * Wraps {@link importAgent}'s union return into the flat {@link ImportAgentResult}
 * shape expected by the GraphQL `ImportAgentResult` type: a mapped AgentConfig
 * becomes `{ agent, conflict:false }`; an {@link ImportConflictResult} becomes
 * `{ agent:null, conflict:true, existingId, reason, options }`.
 */
export function toImportAgentResult(
  result: AgentConfig | ImportConflictResult,
): ImportAgentResult {
  if (isConflictResult(result)) {
    return {
      agent: null,
      conflict: true,
      existingId: result.existingId,
      reason: result.reason,
      options: [...result.options],
    };
  }
  return { agent: result, conflict: false, existingId: null, reason: null, options: null };
}

/**
 * AppSync entry point for the agent-import surface. Dispatches on the AppSync
 * field name:
 *   - `importAgent` (Mutation)         → flat {@link ImportAgentResult}
 *   - `discoverAgents` (Query)         → flat {@link FlatAgentCandidate}[]
 *   - `describeAgentCandidate` (Query) → AWSJSON string (serialized descriptor)
 *
 * The two discovery queries are account-level enumeration: they require a
 * caller holding the `admin` or `architect` role (they enumerate/inspect the
 * customer's AWS account, so authentication alone is insufficient) and are
 * NEVER org-filtered. `UnsupportedSourceError` / `InvalidSourceRefError` are
 * surfaced as clean GraphQL errors (message only).
 */
export const handler = async (
  event: ImportAgentEvent,
): Promise<ImportAgentResult | FlatAgentCandidate[] | string | AgentConfig | ImportTestResult> => {
  const fieldName = event.info?.fieldName;
  // One correlationId per resolver invocation, shared by the discovery summary
  // event and the failure event for this call.
  const correlationId = uuidv4();
  try {
    switch (fieldName) {
      case 'importAgent': {
        const descriptor = buildImportDescriptor(event.arguments?.input);
        const result = await importAgent(descriptor, event);
        return toImportAgentResult(result);
      }
      case 'attestAgentImport': {
        // Authentication is required up-front (mirrors the discovery queries);
        // the admin/architect authorization gate lives inside attestAgentImport.
        requireAuthenticated(event);
        const agentId = asNonEmptyString(event.arguments?.agentId);
        if (!agentId) {
          throw new Error('attestAgentImport: agentId is required');
        }
        return await attestAgentImport(agentId, event, correlationId);
      }
      case 'testImportedAgent': {
        // Authentication is required up-front (mirrors attestAgentImport); the
        // admin/architect authorization gate lives inside testImportedAgent.
        requireAuthenticated(event);
        return await testImportedAgent(event.arguments?.input, event);
      }
      case 'discoverAgents': {
        requireAuthenticated(event);
        requireDiscoveryRole(event);
        const input = event.arguments?.input;
        const candidates = await discoverAgents(input);
        // Best-effort discovery summary — exactly one event per discovery call.
        const source = isRecord(input) ? asNonEmptyString(input.source) ?? null : null;
        await emitImportEvent(
          EventTypes.AGENT_IMPORT_DISCOVERED,
          { source, candidateCount: candidates.length, substrates: uniqueSubstrates(candidates) },
          correlationId,
        );
        return candidates;
      }
      case 'describeAgentCandidate': {
        requireAuthenticated(event);
        requireDiscoveryRole(event);
        const ref = asNonEmptyString(event.arguments?.ref);
        if (!ref) {
          throw new InvalidSourceRefError('describeAgentCandidate: ref is required');
        }
        return await describeAgentCandidate(ref);
      }
      default:
        throw new Error(`Unknown field: ${String(fieldName)}`);
    }
  } catch (error) {
    console.error('agent-import-resolver error:', error);
    // Best-effort failure telemetry, emitted BEFORE rethrowing. The original
    // error is always what propagates to the caller — emission never alters it.
    const operation =
      fieldName === 'importAgent'
        ? 'import'
        : fieldName === 'discoverAgents'
          ? 'discover'
          : fieldName === 'describeAgentCandidate'
            ? 'describe'
            : undefined;
    if (operation) {
      const message = error instanceof Error ? error.message : String(error);
      await emitImportEvent(
        EventTypes.AGENT_IMPORT_FAILED,
        { operation, message },
        correlationId,
      );
    }
    // Surface discovery errors (unsupported substrate / unparseable ref) as
    // clean GraphQL errors — message only, no internal stack — so the caller
    // gets an actionable message instead of an opaque failure.
    if (error instanceof UnsupportedSourceError || error instanceof InvalidSourceRefError) {
      throw new Error(error.message);
    }
    throw error;
  }
};

// ===========================================================================
// Discovery queries: discoverAgents + describeAgentCandidate
// ===========================================================================

/**
 * Flat GraphQL `AgentCandidate` shape returned by `discoverAgents`. The
 * internal {@link AgentCandidate} nests provenance under `origin`; AppSync
 * exposes it flattened, so {@link toFlatCandidate} maps between the two.
 */
export interface FlatAgentCandidate {
  displayName: string;
  reference: string;
  substrate: string;
  sourceArn: string | null;
  region: string | null;
  account: string | null;
  ownership: string;
  discoveredAt: string;
}

/**
 * Guards the discovery queries: they enumerate the customer ACCOUNT (not a
 * single org), so they require an authenticated caller but are never
 * org-filtered. AppSync enforces the API auth mode before the resolver runs;
 * this is a defence-in-depth check that some principal is present, rejecting a
 * wholly anonymous invocation.
 */
function requireAuthenticated(event: ImportAgentEvent): void {
  const identity = event.identity;
  if (!identity || typeof identity !== 'object' || Object.keys(identity).length === 0) {
    throw new Error('Unauthenticated: discovery queries require an authenticated caller');
  }
}

/**
 * Authorization gate for the discovery queries (`discoverAgents`,
 * `describeAgentCandidate`). These enumerate/inspect the customer's AWS
 * ACCOUNT infrastructure, so authentication alone is insufficient — only the
 * `admin` or `architect` roles may run them. Admin is recognised via
 * {@link isAdminFromEvent} (custom:role or cognito:groups); architect via
 * {@link hasRoleFromEvent}. Throws an authorization error otherwise.
 *
 * `importAgent` is intentionally NOT gated by this check — it keeps its
 * existing org-scoped flow (tenant derived from the caller's identity).
 */
function requireDiscoveryRole(event: ImportAgentEvent): void {
  if (isAdminFromEvent(event) || hasRoleFromEvent(event, 'architect')) {
    return;
  }
  throw new Error('Unauthorized: discovery queries require the admin or architect role');
}

/** Maps an internal (origin-nested) {@link AgentCandidate} to the flat GraphQL shape. */
function toFlatCandidate(candidate: AgentCandidate): FlatAgentCandidate {
  const { origin } = candidate;
  return {
    displayName: candidate.displayName,
    reference: candidate.reference,
    substrate: origin.substrate,
    sourceArn: origin.sourceArn ?? null,
    region: origin.region ?? null,
    account: origin.account ?? null,
    ownership: origin.ownership,
    discoveredAt: origin.discoveredAt,
  };
}

/** Standard ARN field extraction: `arn:partition:service:region:account:…`. */
function parseArnFields(arn: string): { region?: string; account?: string } {
  const parts = arn.split(':');
  if (parts[0] !== 'arn' || parts.length < 6) return {};
  return { region: parts[3] || undefined, account: parts[4] || undefined };
}

/**
 * Human-readable display name derived from a ref: the trailing segment of an
 * ARN resource or the last URL path segment, falling back to the ref itself.
 * Mirrors the (private) helper in agent-discovery.ts so SCAN and PASTE produce
 * consistent display names.
 */
function deriveDisplayName(ref: string): string {
  if (ref.startsWith('arn:')) {
    const parts = ref.split(':');
    const resource = parts.length >= 6 ? parts.slice(5).join(':') : ref;
    const tail = resource.split(/[/:]/).filter((s) => s.length > 0).pop();
    return tail ?? ref;
  }
  try {
    const url = new URL(ref);
    const seg = url.pathname.split('/').filter((s) => s.length > 0).pop();
    return seg ?? url.host ?? ref;
  } catch {
    return ref;
  }
}

/** Narrows an AWSJSON `manifest` argument (string or object) for candidateFromManifest. */
function asManifestInput(value: unknown): string | Record<string, unknown> {
  if (typeof value === 'string' && value.trim() !== '') return value;
  if (isRecord(value)) return value;
  throw new InvalidSourceRefError('manifest is required when source is MANIFEST');
}

/**
 * `discoverAgents` query: enumerate importable candidates by source.
 *   - SCAN     → Resource Groups Tagging API scan ({@link tagScanDiscover})
 *   - PASTE    → resolve a single pasted ARN/URL ref ({@link resolveSourceRef})
 *   - MANIFEST → validate a pasted manifest ({@link candidateFromManifest})
 * Returns the FLAT GraphQL candidate shape in every case. Throws
 * `InvalidSourceRefError` for a missing/unrecognised source or PASTE ref (the
 * handler surfaces it as a clean GraphQL error).
 */
async function discoverAgents(input: unknown): Promise<FlatAgentCandidate[]> {
  const flat = isRecord(input) ? input : {};
  const source = asNonEmptyString(flat.source);

  switch (source) {
    case 'SCAN': {
      const candidates = await tagScanDiscover({
        region: asNonEmptyString(flat.region),
        tagKey: asNonEmptyString(flat.tagKey),
        tagValue: asNonEmptyString(flat.tagValue),
      });
      return candidates.map(toFlatCandidate);
    }
    case 'PASTE': {
      const ref = asNonEmptyString(flat.ref);
      if (!ref) {
        throw new InvalidSourceRefError('discoverAgents: ref is required when source is PASTE');
      }
      const { substrate } = resolveSourceRef(ref);
      const isArn = ref.startsWith('arn:');
      const arnFields = isArn ? parseArnFields(ref) : {};
      return [
        {
          displayName: deriveDisplayName(ref),
          reference: ref,
          substrate,
          sourceArn: isArn ? ref : null,
          region: arnFields.region ?? null,
          account: arnFields.account ?? null,
          ownership: 'external',
          discoveredAt: new Date().toISOString(),
        },
      ];
    }
    case 'MANIFEST': {
      const { candidate } = candidateFromManifest(asManifestInput(flat.manifest));
      return [toFlatCandidate(candidate)];
    }
    default:
      throw new InvalidSourceRefError(
        `discoverAgents: unsupported source '${String(flat.source)}' (expected SCAN | PASTE | MANIFEST)`,
      );
  }
}

/**
 * `describeAgentCandidate` query: resolve a pasted ref to its protocol, build a
 * minimal candidate, and delegate to the per-protocol adapter's `describe()`.
 * Returns the capability descriptor serialized as an AWSJSON string. Adapter
 * signatures are unchanged — a candidate is constructed and passed in.
 */
async function describeAgentCandidate(ref: string): Promise<string> {
  const { protocol, substrate, target } = resolveSourceRef(ref);
  const isArn = ref.startsWith('arn:');
  const arnFields = isArn ? parseArnFields(ref) : {};

  const origin: AgentOrigin = {
    substrate,
    discoveredAt: new Date().toISOString(),
    ownership: 'external',
  };
  if (isArn) origin.sourceArn = ref;
  if (arnFields.region) origin.region = arnFields.region;
  if (arnFields.account) origin.account = arnFields.account;

  const candidate: AgentCandidate = {
    origin,
    displayName: deriveDisplayName(ref),
    reference: target,
  };

  const adapter = buildDefaultAgentSourceRegistry().resolve(protocol);
  const descriptor = await adapter.describe(candidate);
  return JSON.stringify(descriptor);
}

/**
 * Registers an externally-owned agent into the Registry, resolving collisions
 * against existing records in the caller's organization.
 *
 * @returns the mapped AgentConfig on create/replace/link, or an
 *   {@link ImportConflictResult} when a collision is found and `onConflict`
 *   was not supplied.
 */
export async function importAgent(
  input: unknown,
  event: ImportAgentEvent,
): Promise<AgentConfig | ImportConflictResult> {
  // 1. Validate the import descriptor (invocation + origin). Reused from the
  //    agent-config resolver so import and create stay in lock-step.
  const validation = validateImportDescriptor(input);
  if (!validation.valid) {
    throw new Error(`Invalid import descriptor: ${validation.errors.join('; ')}`);
  }
  // validateImportDescriptor guarantees `input` is an object with plain
  // invocation/origin sub-objects; re-narrow so the type-checker agrees.
  if (!isRecord(input) || !isRecord(input.invocation) || !isRecord(input.origin)) {
    throw new Error('Invalid import descriptor: malformed structure');
  }
  const root = input;

  const name = asNonEmptyString(root.name);
  if (!name) {
    throw new Error('Invalid import descriptor: name is required and must be a non-empty string');
  }

  // 2. Tenant is ALWAYS derived from the caller's identity, never the input.
  const orgId = await extractOrgFromEvent(event);
  if (!orgId) {
    throw new Error('Cannot determine caller organization');
  }

  // Build the typed descriptor blocks. validateImportDescriptor confirmed
  // protocol ∈ enum and target is a non-empty string; preserve the customer's
  // invocation block verbatim. Ownership is force-set to 'external'.
  const invocation = root.invocation as unknown as AgentInvocationBlock;
  const origin = {
    ...(root.origin as Record<string, unknown>),
    ownership: 'external',
  } as unknown as AgentOrigin;
  // An imported agent always carries a manifest so Registry reads classify the
  // record as an agent (vs a tool). Fall back to {} when absent.
  const manifest = isRecord(root.manifest) ? root.manifest : {};
  const categories = asStringArray(root.categories) ?? [];
  const createdBy =
    asNonEmptyString(event.identity?.sub) ?? asNonEmptyString(event.identity?.username) ?? 'import';
  const onConflict = isConflictResolution(root.onConflict) ? root.onConflict : undefined;
  // RAW caller-submitted invocation secret (transient; see buildImportDescriptor).
  // Persisted to Secrets Manager on a record-creating path — only the returned
  // ref is ever written to the record. Read here; consumed by
  // ensureInvocationSecretStored below.
  const rawInvocationSecret = asNonEmptyString(root.invocationSecret);

  const registryService = getRegistryService();

  // 3. Conflict resolution. Scope dedupe to the caller's org so one tenant can
  //    never link to / replace another tenant's record (cross-tenant
  //    isolation). Primary key: origin.sourceArn; secondary: display name.
  const allRecords = await registryService.listResources('agent');
  const orgRecords = allRecords.filter(
    (rec) => readMeta(registryService, rec).orgId === orgId,
  );

  const inputSourceArn = asNonEmptyString((root.origin as Record<string, unknown>).sourceArn);
  const inputSubstrate = asNonEmptyString((root.origin as Record<string, unknown>).substrate);

  // Best-effort `agent.import.registered` emission for the paths that CREATE,
  // REPLACE, or COPY a record (never on a no-op link or unresolved conflict).
  const emitRegistered = (config: AgentConfig): Promise<void> =>
    emitImportEvent(EventTypes.AGENT_IMPORT_REGISTERED, {
      agentId: config.agentId,
      sourceArn: inputSourceArn ?? null,
      substrate: inputSubstrate ?? null,
      orgId,
    });

  let match: RegistryRecord | undefined;
  let reason: ImportConflictReason | undefined;

  if (inputSourceArn) {
    match = orgRecords.find(
      (rec) => readMeta(registryService, rec).origin?.sourceArn === inputSourceArn,
    );
    if (match) reason = 'sourceArn';
  }
  if (!match) {
    const nameMatch = orgRecords.find((rec) => rec.name === name);
    if (nameMatch) {
      match = nameMatch;
      reason = 'name';
    }
  }

  // Governance attestation + fabricator-authority grant apply ONLY on the
  // record-creating paths (create / replace / copy) — never a no-op link or an
  // unresolved conflict. Both are produced per-branch (lazily) so neither can
  // leak onto a path that does not write a record.

  // Serialised custom metadata carrying a fresh 'pending' governance attestation.
  // enforcementMode comes from the governance rollout flag (env name from
  // ENVIRONMENT; the reader fails-open to 'permissive' internally and never
  // throws). Built lazily so attestation is stamped only when a record is
  // actually written.
  const buildStampedCustomMetadata = async (adrId?: string): Promise<string> => {
    const enforcementMode = await getGovernanceEnforce(process.env.ENVIRONMENT || 'unknown');
    const governanceAttestation: NonNullable<
      AgentCustomMetadata['governanceAttestation']
    > = {
      status: 'pending',
      enforcementMode,
      authorityRequested: true,
      requestedAt: new Date().toISOString(),
    };
    // Additive: stamped only once the system-generated import ADR is recorded.
    // On a best-effort ADR failure adrId is undefined and the field is omitted.
    if (adrId) {
      governanceAttestation.adrId = adrId;
    }
    return registryService.serializeCustomMetadata(
      buildImportedMetadata({
        categories,
        manifest,
        invocation,
        origin,
        orgId,
        createdBy,
        governanceAttestation,
      }),
    );
  };

  // Grants exactly one fabricator authority unit for the new record. The
  // lifecycle helper is itself idempotent and WARN-skips when
  // AUTHORITY_UNITS_TABLE is unset (partial-deploy safe); we additionally guard
  // BEST-EFFORT so a thrown error is logged and NEVER fails the import.
  const grantAuthorityBestEffort = async (recordId: string): Promise<void> => {
    try {
      await grantFabricatorAuthority(recordId);
    } catch (err) {
      console.error(
        `agent-import-resolver: best-effort grantFabricatorAuthority for ${recordId} failed (swallowed):`,
        err,
      );
    }
  };

  // Records a system-generated Architecture Decision Record for this import,
  // keyed to the synthetic GLOBAL import project. Returns the new adrId, or
  // undefined when the ADR write fails (logged + swallowed — an ADR/governance
  // outage must NEVER fail the import). Created BEFORE the record write so the
  // adrId is stamped into the SAME customMetadata write (no follow-up
  // updateResource); this keeps the replace path a single in-place update and
  // preserves the existing create/replace/copy write counts. Reuses the ADR
  // resolver's createADR via SYSTEM_IMPORT_ADR_AUTHOR (see its docblock) so the
  // write does not require the importing caller to hold adr:create.
  const createImportAdrBestEffort = async (): Promise<string | undefined> => {
    try {
      const adr = await createADR(
        {
          projectId: SYNTHETIC_IMPORT_PROJECT_ID,
          title: `Import external agent: ${name}`,
          decision:
            `Registered externally-owned agent "${name}" as a DRAFT/inactive ` +
            `Registry record (substrate=${inputSubstrate ?? 'unknown'}, ` +
            `sourceArn=${inputSourceArn ?? 'none'}, orgId=${orgId}). Ownership is ` +
            `external and the agent is never auto-activated by import.`,
          reasoning:
            'System-generated governance record: importing an externally-owned ' +
            'agent introduces third-party execution surface into the organization, ' +
            'so it is tracked as an architecture decision for audit and for the ' +
            'later DRAFT→APPROVED activation review.',
          constraints: [],
          alternativesConsidered: [],
          revisitConditions: [],
          severity: 'LOW',
          affectsModules: ['agent-registry'],
          reviewers: [],
          sourceRoundIds: [],
        },
        SYSTEM_IMPORT_ADR_AUTHOR,
      );
      return adr.adrId;
    } catch (err) {
      console.error(
        'agent-import-resolver: best-effort import ADR creation failed (swallowed):',
        err,
      );
      return undefined;
    }
  };

  // Persist a caller-submitted RAW invocation secret to Secrets Manager and
  // attach ONLY the returned reference to invocation.auth.secretRef. Memoised so
  // the single record-creating branch that runs stores at most once, and a no-op
  // when no raw secret was submitted. Called BEFORE any record write so a store
  // FAILURE throws ahead of createResource/updateResource — never leaving a
  // record whose secretRef points at a secret that was never written. This is a
  // HARD error (unlike the best-effort governance/ADR/authority calls above): an
  // agent that needs auth must not be half-registered. The raw value is NEVER
  // logged and NEVER copied into the record/description/customMetadata.
  let invocationSecretStored = false;
  const ensureInvocationSecretStored = async (): Promise<void> => {
    if (invocationSecretStored || !rawInvocationSecret) return;
    let stored: StoreAgentInvocationSecretResult;
    try {
      // Keyed by a fresh UUID under /citadel/agents/{orgId}/{id} so concurrent
      // imports never collide; the returned ARN becomes the secretRef.
      stored = await storeAgentInvocationSecret(orgId, uuidv4(), rawInvocationSecret);
    } catch (err) {
      // Redaction: the raw secret is never interpolated into the logged or
      // thrown message — only the (secret-free) underlying error is surfaced.
      console.error(
        'agent-import-resolver: failed to store imported-agent invocation secret (raw value not logged):',
        err,
      );
      throw new Error(
        'Failed to persist invocation secret to Secrets Manager for imported agent',
      );
    }
    // mode is already set from invocationAuthMode by buildImportDescriptor; we
    // only attach the resolved reference here.
    invocation.auth.secretRef = stored.secretArn;
    invocationSecretStored = true;
    // TODO(agent-import): invoke-side secretRef resolution is a follow-up
  };

  if (match && reason) {
    // Conflict detected but no resolution chosen → ask the caller to pick.
    if (!onConflict) {
      return {
        conflict: true,
        existingId: match.recordId,
        reason,
        options: [...CONFLICT_OPTIONS],
      };
    }
    // link → idempotent: return the existing record, no mutation (no stamp/grant).
    if (onConflict === 'link') {
      return registryService.mapToAgentConfig(match);
    }
    // replace → overwrite the existing record in place (preserve its recordId).
    if (onConflict === 'replace') {
      await ensureInvocationSecretStored();
      const adrId = await createImportAdrBestEffort();
      const replaced = await registryService.updateResource('agent', match.recordId, {
        name,
        description: buildConfigDescription(name, manifest, invocation, origin),
        customMetadata: await buildStampedCustomMetadata(adrId),
      });
      const config = registryService.mapToAgentConfig(replaced);
      await grantAuthorityBestEffort(replaced.recordId);
      await emitRegistered(config);
      return config;
    }
    // copy → create a new record under a non-colliding suffixed name.
    if (onConflict === 'copy') {
      await ensureInvocationSecretStored();
      const taken = new Set(orgRecords.map((r) => r.name));
      const copyName = buildImportCopyName(name, taken);
      const adrId = await createImportAdrBestEffort();
      const copied = await registryService.createResource('agent', copyName, {
        name: copyName,
        description: buildConfigDescription(copyName, manifest, invocation, origin),
        customMetadata: await buildStampedCustomMetadata(adrId),
      });
      const config = registryService.mapToAgentConfig(copied);
      await grantAuthorityBestEffort(copied.recordId);
      await emitRegistered(config);
      return config;
    }
  }

  // 4. No conflict (or no match for a supplied onConflict) → create a fresh
  //    DRAFT/inactive record. Never auto-activate.
  await ensureInvocationSecretStored();
  const adrId = await createImportAdrBestEffort();
  const created = await registryService.createResource('agent', name, {
    name,
    description: buildConfigDescription(name, manifest, invocation, origin),
    customMetadata: await buildStampedCustomMetadata(adrId),
  });
  const config = registryService.mapToAgentConfig(created);
  await grantAuthorityBestEffort(created.recordId);
  await emitRegistered(config);
  return config;
}

/**
 * Attests an imported agent: advances its `governanceAttestation.status` from
 * 'pending' to 'attested', recording WHO attested (`attestedBy`) and WHEN
 * (`attestedAt`). This is the explicit governance acknowledgement that an
 * externally-owned agent's requested authority grant has been reviewed — the
 * prerequisite the activation gate checks before an imported record may be
 * activated (APPROVED).
 *
 * Authorization mirrors the discovery queries: only the `admin` or `architect`
 * role may attest (attestation is an account/org-level governance action, not a
 * tenant self-service operation). Non-admin callers are additionally org-scoped:
 * the record must belong to the caller's organization, and a mismatch surfaces
 * the SAME not-found error as a missing record so a cross-tenant probe cannot
 * tell "exists in another org" apart from "does not exist".
 *
 * Idempotent: attesting an already-'attested' record returns the mapped agent
 * unchanged with no second write and no duplicate event. A record that carries
 * no `governanceAttestation` (i.e. not an imported agent) is rejected — there is
 * nothing to attest.
 *
 * Emits a BEST-EFFORT {@link EventTypes.AGENT_IMPORT_ATTESTED} event on a real
 * transition; an emit failure is logged and swallowed and NEVER fails (or alters
 * the result of) the attestation. The event's `orgId` reflects the RECORD's
 * organization (the agent being attested), not necessarily the caller's.
 *
 * @returns the mapped AgentConfig (attested on a transition, unchanged on a
 *   no-op idempotent attestation).
 */
export async function attestAgentImport(
  agentId: string,
  event: ImportAgentEvent,
  correlationId: string = uuidv4(),
): Promise<AgentConfig> {
  // 1. Authorization: admin OR architect only (same gate as discovery).
  const isAdmin = isAdminFromEvent(event);
  if (!isAdmin && !hasRoleFromEvent(event, 'architect')) {
    throw new Error('Unauthorized: attestAgentImport requires the admin or architect role');
  }

  const registryService = getRegistryService();

  // 2. Load the record. getResource returns null on a 404 → clean not-found.
  const record = await registryService.getResource('agent', agentId);
  if (!record) {
    throw new Error(`Agent not found: ${agentId}`);
  }

  // 3. Deserialize the stored custom metadata.
  const meta = readMeta(registryService, record);

  // 4. Org-scope (non-admin only): the record must belong to the caller's org.
  //    On a mismatch throw the SAME not-found error as a missing record so a
  //    cross-tenant caller cannot distinguish "exists elsewhere" from "absent"
  //    (no existence leak). Matches the existing get/update org checks.
  if (!isAdmin) {
    const callerOrg = await extractOrgFromEvent(event);
    if (!callerOrg || meta.orgId !== callerOrg) {
      throw new Error(`Agent not found: ${agentId}`);
    }
  }

  // 5. Only imported agents carry a governanceAttestation block. Absent ⇒ this
  //    is not an imported record, so there is nothing to attest.
  const attestation = meta.governanceAttestation;
  if (!attestation) {
    throw new Error('not an imported agent: nothing to attest');
  }

  // 6. Idempotent no-op: already attested → return unchanged (no write/event).
  if (attestation.status === 'attested') {
    return registryService.mapToAgentConfig(record);
  }

  // 7. Advance 'pending' → 'attested', preserving every existing attestation
  //    field (enforcementMode / authorityRequested / requestedAt / adrId) and
  //    stamping the attesting identity + ISO timestamp.
  const attestedBy =
    asNonEmptyString(event.identity?.sub) ??
    asNonEmptyString(event.identity?.username) ??
    'unknown';
  const updatedAttestation: NonNullable<AgentCustomMetadata['governanceAttestation']> = {
    ...attestation,
    status: 'attested',
    attestedBy,
    attestedAt: new Date().toISOString(),
  };
  const mergedMeta: AgentCustomMetadata = {
    ...meta,
    governanceAttestation: updatedAttestation,
  };

  // Update only the custom metadata in place (recordId preserved); name and
  // description are intentionally left untouched.
  const updated = await registryService.updateResource('agent', record.recordId, {
    customMetadata: registryService.serializeCustomMetadata(mergedMeta),
  });
  const config = registryService.mapToAgentConfig(updated);

  // 8. Best-effort lifecycle event — never fails the mutation on emit error.
  //    orgId reflects the RECORD's org (the agent being attested), not the caller's.
  await emitImportEvent(
    EventTypes.AGENT_IMPORT_ATTESTED,
    { agentId: record.recordId, attestedBy, orgId: meta.orgId ?? null },
    correlationId,
  );

  return config;
}

/**
 * Sentinel `auth.secretRef` used for a TEST-INVOKE that carries a RAW
 * `invocationSecret` but no pre-existing reference. The HTTP/MCP adapters only
 * call the injected `resolveSecret` when `auth.secretRef` is set, so a transient
 * placeholder is attached to trigger resolution; the resolver closure returns
 * the raw value verbatim and ignores the ref. NEVER persisted.
 */
const TRANSIENT_TEST_SECRET_REF = 'inline-test-invocation-secret';

/**
 * Builds the minimal {@link AgentCapabilityDescriptor} a TEST-INVOKE needs. Only
 * the `invocation` block is meaningful (the adapters read it for invoke);
 * name/description/schemas are inert placeholders. The invocation is assembled
 * from the flat input (protocol/target/auth{mode,header,secretRef}/mode/region/
 * account). When a raw secret was submitted, a transient secretRef is attached
 * so secret-backed adapters (HTTP/MCP) resolve it.
 */
function buildTestInvocationDescriptor(
  flat: Record<string, unknown>,
  hasRawSecret: boolean,
): AgentCapabilityDescriptor {
  const auth: AgentInvocationBlock['auth'] = {
    mode: (asNonEmptyString(flat.invocationAuthMode) ?? 'NONE') as AgentInvocationAuthMode,
  };
  const authHeader = asNonEmptyString(flat.invocationAuthHeader);
  if (authHeader) auth.header = authHeader;
  const secretRef = asNonEmptyString(flat.invocationSecretRef);
  if (hasRawSecret) {
    // Transient ref so the adapter calls resolveSecret (which returns the raw
    // value). Prefer a supplied ref name; else a clearly-labelled sentinel.
    auth.secretRef = secretRef ?? TRANSIENT_TEST_SECRET_REF;
  } else if (secretRef) {
    auth.secretRef = secretRef;
  }

  const invocation: AgentInvocationBlock = {
    protocol: flat.invocationProtocol as AgentInvocationProtocol,
    target: flat.invocationTarget as string,
    auth,
    mode: (asNonEmptyString(flat.invocationMode) ?? 'sync') as AgentInvocationMode,
  };
  const region = asNonEmptyString(flat.region);
  const account = asNonEmptyString(flat.account);
  if (region) invocation.region = region;
  if (account) invocation.account = account;

  const origin: AgentOrigin = {
    substrate: 'test-invoke',
    discoveredAt: new Date().toISOString(),
    ownership: 'external',
  };
  if (region) origin.region = region;
  if (account) origin.account = account;

  return {
    name: 'import-test-candidate',
    description: '',
    version: '0.0.0',
    skills: [],
    categories: [],
    inputSchema: {},
    outputSchema: {},
    invocation,
    origin,
  };
}

/**
 * Pre-activation TEST-INVOKE for an import candidate. Actually invokes the
 * operator-supplied target through the existing per-protocol agent-source
 * adapters and returns a SANITIZED result WITHOUT persisting anything (no
 * Registry record, no stored secret) — it is the dry-run that precedes the
 * DRAFT→APPROVED activation review.
 *
 * Authorization mirrors the discovery/attest gate: only the `admin` or
 * `architect` role may run a test-invoke (it executes operator-supplied,
 * arbitrary invocation paths against the customer account). A non-privileged
 * caller gets an authorization error — the ONLY outcome that THROWS. Every
 * other outcome, including an unreachable target, an unknown protocol, or an
 * adapter error, is a NORMAL result: `{ ok:false, error }` with the latency.
 *
 * Secret handling is TRANSIENT (RD1, least-privilege invariant 2): a RAW
 * `invocationSecret` is resolved by an in-memory closure that returns it
 * verbatim and is discarded when the call returns; a pre-existing
 * `invocationSecretRef` is resolved on demand via {@link getAgentInvocationSecret}.
 * Nothing is written to Secrets Manager or the Registry. The raw value is NEVER
 * logged, and the candidate's UNTRUSTED output is ALWAYS passed through
 * {@link sanitizeUntrustedAgentOutput} before it is returned.
 */
export async function testImportedAgent(
  input: unknown,
  event: ImportAgentEvent,
): Promise<ImportTestResult> {
  // Authorization: admin OR architect only (same gate as discovery/attest).
  // This is the ONLY path that throws — every invoke outcome is a normal result.
  if (!isAdminFromEvent(event) && !hasRoleFromEvent(event, 'architect')) {
    throw new Error('Unauthorized: testImportedAgent requires the admin or architect role');
  }

  const flat = isRecord(input) ? input : {};
  const rawSecret = asNonEmptyString(flat.invocationSecret);
  const secretRef = asNonEmptyString(flat.invocationSecretRef);

  const start = Date.now();
  try {
    const protocol = asNonEmptyString(flat.invocationProtocol);
    const target = asNonEmptyString(flat.invocationTarget);
    if (!protocol) throw new Error('testImportedAgent: invocationProtocol is required');
    if (!target) throw new Error('testImportedAgent: invocationTarget is required');

    // Transient secret resolver — NEVER persisted. A RAW secret is returned
    // verbatim (ref ignored); else a provided ref is fetched on demand; else no
    // resolver is wired (the adapter invokes without an auth header).
    let resolveSecret: ((ref: string) => Promise<string>) | undefined;
    if (rawSecret) {
      resolveSecret = async () => rawSecret;
    } else if (secretRef) {
      resolveSecret = (ref: string) => getAgentInvocationSecret(ref);
    }

    const registry = buildDefaultAgentSourceRegistry({ resolveSecret });
    const descriptor = buildTestInvocationDescriptor(flat, Boolean(rawSecret));
    const adapter = registry.resolve(descriptor.invocation.protocol);
    const resp = await adapter.invoke(
      { prompt: asNonEmptyString(flat.prompt) ?? 'ping', sessionId: `import-test-${uuidv4()}` },
      descriptor,
    );
    // The candidate is an UNTRUSTED foreign agent — neutralize injection markers
    // in its output before it re-enters our flow / reaches the caller.
    const sanitized = sanitizeUntrustedAgentOutput(resp.output);
    return { ok: true, output: sanitized.sanitized, error: null, latencyMs: Date.now() - start };
  } catch (err) {
    // A failed test-invoke is a NORMAL result (NOT a thrown error). The raw
    // secret is never interpolated into the message — only the underlying error.
    return {
      ok: false,
      output: null,
      error: err instanceof Error ? err.message : String(err),
      latencyMs: Date.now() - start,
    };
  }
}

/** Deserializes a record's custom metadata against the agent defaults. */
function readMeta(
  registryService: ReturnType<typeof getRegistryService>,
  rec: RegistryRecord,
): AgentCustomMetadata {
  return registryService.deserializeCustomMetadata<AgentCustomMetadata>(
    rec.customDescriptorContent ?? null,
    AGENT_METADATA_DEFAULTS,
  );
}

function buildImportedMetadata(args: {
  categories: string[];
  manifest: Record<string, unknown>;
  invocation: AgentInvocationBlock;
  origin: AgentOrigin;
  orgId: string;
  createdBy: string;
  governanceAttestation?: AgentCustomMetadata['governanceAttestation'];
}): ImportedAgentMetadata {
  const meta: ImportedAgentMetadata = {
    categories: args.categories,
    icon: '',
    state: 'inactive',
    manifest: args.manifest,
    invocation: args.invocation,
    origin: args.origin,
    orgId: args.orgId,
    createdBy: args.createdBy,
  };
  // Additive: only present on the record-creating import paths.
  if (args.governanceAttestation) {
    meta.governanceAttestation = args.governanceAttestation;
  }
  return meta;
}

function buildConfigDescription(
  name: string,
  manifest: Record<string, unknown>,
  invocation: AgentInvocationBlock,
  origin: AgentOrigin,
): string {
  return JSON.stringify({ name, manifest, invocation, origin });
}
