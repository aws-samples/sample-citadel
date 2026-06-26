/**
 * Agent Import Resolver (US-IMP) — registration with conflict resolution.
 *
 * TODO(agent-import): wire in AppSync + CDK at infra checkpoint
 *
 * This increment is the resolver HANDLER LOGIC only. The AppSync schema +
 * CDK wiring and the companion `discoverAgents` / `describeAgentCandidate`
 * queries are a deliberately deferred follow-up.
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
import { extractOrgFromEvent } from '../utils/auth-event';
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
  arguments?: { input?: unknown };
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
 * AppSync entry point for the `importAgent` mutation. Maps the flat
 * `ImportAgentInput` into the internal descriptor, delegates to
 * {@link importAgent}, and ALWAYS returns the flat {@link ImportAgentResult}
 * shape. The deferred `discoverAgents` / `describeAgentCandidate` queries are
 * not wired yet (see TODO at the top of this file).
 */
export const handler = async (
  event: ImportAgentEvent,
): Promise<ImportAgentResult> => {
  const fieldName = event.info?.fieldName;
  try {
    switch (fieldName) {
      case 'importAgent': {
        const descriptor = buildImportDescriptor(event.arguments?.input);
        const result = await importAgent(descriptor, event);
        return toImportAgentResult(result);
      }
      default:
        throw new Error(`Unknown field: ${String(fieldName)}`);
    }
  } catch (error) {
    console.error('agent-import-resolver error:', error);
    throw error;
  }
};

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

  const customMetadata = registryService.serializeCustomMetadata(
    buildImportedMetadata({ categories, manifest, invocation, origin, orgId, createdBy }),
  );

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
    // link → idempotent: return the existing record, no mutation.
    if (onConflict === 'link') {
      return registryService.mapToAgentConfig(match);
    }
    // replace → overwrite the existing record in place (preserve its recordId).
    if (onConflict === 'replace') {
      const replaced = await registryService.updateResource('agent', match.recordId, {
        name,
        description: buildConfigDescription(name, manifest, invocation, origin),
        customMetadata,
      });
      return registryService.mapToAgentConfig(replaced);
    }
    // copy → create a new record under a non-colliding suffixed name.
    if (onConflict === 'copy') {
      const taken = new Set(orgRecords.map((r) => r.name));
      const copyName = buildImportCopyName(name, taken);
      const copied = await registryService.createResource('agent', copyName, {
        name: copyName,
        description: buildConfigDescription(copyName, manifest, invocation, origin),
        customMetadata,
      });
      return registryService.mapToAgentConfig(copied);
    }
  }

  // 4. No conflict (or no match for a supplied onConflict) → create a fresh
  //    DRAFT/inactive record. Never auto-activate.
  const created = await registryService.createResource('agent', name, {
    name,
    description: buildConfigDescription(name, manifest, invocation, origin),
    customMetadata,
  });
  return registryService.mapToAgentConfig(created);
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
}): ImportedAgentMetadata {
  return {
    categories: args.categories,
    icon: '',
    state: 'inactive',
    manifest: args.manifest,
    invocation: args.invocation,
    origin: args.origin,
    orgId: args.orgId,
    createdBy: args.createdBy,
  };
}

function buildConfigDescription(
  name: string,
  manifest: Record<string, unknown>,
  invocation: AgentInvocationBlock,
  origin: AgentOrigin,
): string {
  return JSON.stringify({ name, manifest, invocation, origin });
}
