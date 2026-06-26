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
import { extractOrgFromEvent, isAdminFromEvent, hasRoleFromEvent } from '../utils/auth-event';
import { v4 as uuidv4 } from 'uuid';
import { publishEvent, EventTypes } from '../utils/events';
import { grantFabricatorAuthority } from './registry-agent-authority-lifecycle';
import { getGovernanceEnforce } from '../utils/governance-flag';
import type { AgentEvent } from '../types';
import {
  resolveSourceRef,
  tagScanDiscover,
  candidateFromManifest,
  UnsupportedSourceError,
  InvalidSourceRefError,
} from '../services/agent-discovery';
import { buildDefaultAgentSourceRegistry } from '../adapters/agent-source/registry-factory';
import type { AgentCandidate } from '../adapters/agent-source/types';
import type {
  AgentConfig,
  AgentCustomMetadata,
  AgentInvocationBlock,
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

const CONFLICT_OPTIONS: readonly ImportConflictResolution[] = ['link', 'replace', 'copy'];

const AGENT_METADATA_DEFAULTS: AgentCustomMetadata = {
  categories: [],
  icon: '',
  state: 'inactive',
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
  arguments?: { input?: unknown; ref?: unknown };
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
): Promise<ImportAgentResult | FlatAgentCandidate[] | string> => {
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
  const buildStampedCustomMetadata = async (): Promise<string> => {
    const enforcementMode = await getGovernanceEnforce(process.env.ENVIRONMENT || 'unknown');
    const governanceAttestation = {
      status: 'pending' as const,
      enforcementMode,
      authorityRequested: true,
      requestedAt: new Date().toISOString(),
    };
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
      const replaced = await registryService.updateResource('agent', match.recordId, {
        name,
        description: buildConfigDescription(name, manifest, invocation, origin),
        customMetadata: await buildStampedCustomMetadata(),
      });
      const config = registryService.mapToAgentConfig(replaced);
      await grantAuthorityBestEffort(replaced.recordId);
      await emitRegistered(config);
      return config;
    }
    // copy → create a new record under a non-colliding suffixed name.
    if (onConflict === 'copy') {
      const taken = new Set(orgRecords.map((r) => r.name));
      const copyName = buildImportCopyName(name, taken);
      const copied = await registryService.createResource('agent', copyName, {
        name: copyName,
        description: buildConfigDescription(copyName, manifest, invocation, origin),
        customMetadata: await buildStampedCustomMetadata(),
      });
      const config = registryService.mapToAgentConfig(copied);
      await grantAuthorityBestEffort(copied.recordId);
      await emitRegistered(config);
      return config;
    }
  }

  // 4. No conflict (or no match for a supplied onConflict) → create a fresh
  //    DRAFT/inactive record. Never auto-activate.
  const created = await registryService.createResource('agent', name, {
    name,
    description: buildConfigDescription(name, manifest, invocation, origin),
    customMetadata: await buildStampedCustomMetadata(),
  });
  const config = registryService.mapToAgentConfig(created);
  await grantAuthorityBestEffort(created.recordId);
  await emitRegistered(config);
  return config;
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
