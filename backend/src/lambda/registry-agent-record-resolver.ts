/**
 * Registry-native AgentApp-shape resolver. PR 6a of the AgentCore Registry
 * governance retrofit — replaces the PR-3 shim now that the @deprecated
 * `type AgentApp` has been removed from schema.graphql and renamed to
 * `type RegistryAgentRecord`.
 *
 * The 22 AppSync resolver wirings that previously targeted this module as
 * `agent-app-shim-resolver.ts` continue to dispatch on the same field names
 * (getApp, listApps, createApp, …). Only the GraphQL return TYPE changed
 * from `AgentApp` to `RegistryAgentRecord`; the runtime projection shape,
 * the 22 handler branches, and the RegistryService customDescriptorContent
 * manifest schema are all preserved verbatim.
 *
 * US-ARB-014 authority lifecycle lives in ./registry-agent-authority-lifecycle.ts;
 * this resolver calls it for createApp / deleteApp paths.
 *
 * Boundaries enforced by this module:
 *   - AgentApp-shape reads/writes go through the AgentCore Registry via
 *     RegistryService; they MUST NOT touch the deprecated AppsTable. The
 *     inline `projectAgentAppShape` / `recordFromInput` helpers (previously
 *     exported from the deleted `agent-record-factory.ts`) are the only
 *     legal output/input projection path.
 *   - Non-AgentApp surfaces (API keys, access-entry listing, metrics,
 *     EventBridge publish) keep their original storage backings. APPS_TABLE
 *     still provides the deps struct for those co-located helpers during
 *     the migration; once their registry-native replacements land the env
 *     var and this resolver will both be retired.
 *   - Authority-unit writes go exclusively through
 *     grantFabricatorAuthority / revokeFabricatorAuthority — this resolver
 *     does not import getAuthorityUnitsTable (internal to T1's module).
 *
 * Manifest schema (stored inside RegistryRecord.customDescriptorContent as
 * JSON under the `manifest` key):
 *   { orgId, version, status, workflowIds, agentBindings, permissions,
 *     configSchema, configValues, authConfig, access, routingConfig,
 *     sourceProjectId }
 * The full JSON blob is opaque to the Registry SDK; this resolver is the
 * sole reader/writer of the manifest surface.
 */
import type { AppSyncResolverHandler } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  BatchGetCommand,
  QueryCommand,
  ScanCommand,
  type NativeAttributeValue,
  type QueryCommandOutput,
  type ScanCommandOutput,
} from '@aws-sdk/lib-dynamodb';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import {
  CognitoIdentityProviderClient,
  AdminGetUserCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { v4 as uuidv4 } from 'uuid';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { getUserId } from '../utils/appsync';
import { isAdminFromEvent, extractOrgFromEvent } from '../utils/auth-event';
import { publishAppStatusEvent as publishAppStatusSubscription } from '../utils/appsync-publish';
import {
  RegistryService,
  TypeMismatchError,
  type RegistryRecord,
  type RegistryRecordStatusValue,
  type AgentCustomMetadata,
} from '../services/registry-service';
import {
  grantFabricatorAuthority,
  revokeFabricatorAuthority,
} from './registry-agent-authority-lifecycle';
import {
  createAppApiKey as createAppApiKeyImpl,
  revokeAppApiKey as revokeAppApiKeyImpl,
  rotateAppApiKey as rotateAppApiKeyImpl,
  listAppApiKeys as listAppApiKeysImpl,
  type ApiKeyDeps,
} from './app-api-key-management';
import {
  listAppAccessEntries as listAppAccessEntriesImpl,
  type AccessControlDeps,
} from './app-access-control';
import { getAppMetrics as getAppMetricsImpl } from './app-metrics-handler';
import {
  upsertAppMeta,
  updateAppMetaFields,
  deleteAppMeta,
  APP_META_SORT_VALUE,
  type AppMetaRow,
} from '../utils/apps-table-meta';

// ---------------------------------------------------------------------------
// AgentApp-shape projection helpers (inlined from the deleted
// `agent-record-factory.ts` module). These are the canonical input-boundary
// and output-projection functions for the legacy AgentApp shape during the
// RegistryAgentRecord migration. Kept file-private because only this
// resolver consumes them.
// ---------------------------------------------------------------------------

/**
 * Minimal in-file shape mirroring the deprecated AgentApp type. Used as the
 * input type for `recordFromInput` and the projected return type for
 * `projectAgentAppShape`. Kept intentionally lightweight — only the fields
 * the projection actually maps are listed.
 */
interface DeprecatedAgentAppShape {
  appId: string;
  orgId?: string;
  name?: string;
  description?: string;
  status?: string;
  version?: number;
  createdAt?: string;
  updatedAt?: string;
  sourceProjectId?: string | null;
}

/**
 * Extracts a human-readable description from the Registry record's `description` field.
 *
 * The Fabricator (and tool-config-resolver) currently store the entire agent/tool manifest
 * as a JSON string in the Registry `description` field. The actual human-readable description
 * lives nested inside that JSON, either at `.description` (tool-shaped manifests) or
 * `.info.description` (OpenAPI-shaped manifests). When the raw field is plain text or empty,
 * return it unchanged.
 *
 * TODO (follow-up): refactor the Fabricator to store the manifest in customDescriptorContent
 * and only a plain string in `description`; then this helper becomes unnecessary.
 */
export function extractHumanDescription(raw: string | null | undefined): string {
  if (!raw) return '';
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{')) return raw;
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed?.description === 'string' && parsed.description.trim()) {
      return parsed.description;
    }
    if (typeof parsed?.info?.description === 'string' && parsed.info.description.trim()) {
      return parsed.info.description;
    }
  } catch {
    // not JSON — fall through
  }
  return raw;
}

/**
 * Coerces a record's version field to a non-negative integer. Legacy records
 * stored version as a string (e.g. '1.0') which violates the `version: Int!`
 * GraphQL contract. Parses safely and falls back to 1.
 */
export function toIntVersion(raw: unknown): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return Math.max(1, Math.trunc(raw));
  }
  if (typeof raw === 'string' && raw.trim()) {
    const parsed = parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 1;
}

/**
 * Project the registry record into the fields downstream code previously
 * read from AgentApp. Nulls for fields not present in the registry record's
 * customDescriptorContent.
 *
 * Inlined in PR 6a from the deleted `agent-record-factory.ts#agentAppFromRegistryRecord`.
 */
function projectAgentAppShape(
  record: RegistryRecord,
): Partial<DeprecatedAgentAppShape> {
  const out: Partial<DeprecatedAgentAppShape> = {};

  if (record.recordId) {
    out.appId = record.recordId;
  }
  if (record.name !== undefined) {
    out.name = record.name;
  }
  if (record.description !== undefined) {
    out.description = extractHumanDescription(record.description);
  }
  if (record.status !== undefined) {
    out.status = record.status;
  }
  if (record.createdAt) {
    out.createdAt = record.createdAt.toISOString();
  }
  if (record.updatedAt) {
    out.updatedAt = record.updatedAt.toISOString();
  }

  // Pull appId / sourceProjectId out of the custom descriptor JSON when
  // present. Malformed JSON is swallowed — we return whatever has been
  // populated so far rather than throw.
  if (record.customDescriptorContent) {
    try {
      const parsed = JSON.parse(record.customDescriptorContent);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        if (typeof parsed.appId === 'string') {
          out.appId = parsed.appId;
        }
        if (typeof parsed.sourceProjectId === 'string') {
          out.sourceProjectId = parsed.sourceProjectId;
        }
      }
    } catch {
      // Intentionally empty — malformed JSON must not throw.
    }
  }

  return out;
}

/**
 * Build a registry record skeleton from an AgentApp-shaped input.
 * customDescriptorContent carries the AgentCustomMetadata as JSON.
 *
 * Inlined in PR 6a from the deleted `agent-record-factory.ts#registryRecordFromAgentApp`.
 */
function recordFromInput(
  app: DeprecatedAgentAppShape,
): Partial<RegistryRecord> {
  const metadata: AgentCustomMetadata & { sourceProjectId?: string | null } = {
    categories: [],
    icon: '',
    state: 'active',
    appId: app.appId,
    sourceProjectId: app.sourceProjectId,
  };

  const out: Partial<RegistryRecord> = {
    recordId: app.appId,
    name: app.name,
    customDescriptorContent: JSON.stringify(metadata),
  };

  if (app.description !== undefined) {
    out.description = app.description;
  }
  if (app.status !== undefined) {
    out.status = app.status;
  }
  if (app.createdAt) {
    const d = new Date(app.createdAt);
    if (!Number.isNaN(d.getTime())) {
      out.createdAt = d;
    }
  }
  if (app.updatedAt) {
    const d = new Date(app.updatedAt);
    if (!Number.isNaN(d.getTime())) {
      out.updatedAt = d;
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Module-level environment & lazy singletons
// ---------------------------------------------------------------------------

const APPS_TABLE = process.env.APPS_TABLE!;
// Denormalized Registry -> DynamoDB projection (kept in sync by
// registry-sync.ts off `citadel.agentcore.*` EventBridge events). Used ONLY
// for the agentBindings[].name enrichment's fast path: a single
// BatchGetItem for every 12-char Registry recordId binding, instead of one
// GetRegistryRecord Registry call per binding (the N+1 fix — see
// resolveAgentBindingNames). Read-only; this resolver never writes here.
const AGENT_CONFIG_TABLE = process.env.AGENT_CONFIG_TABLE || '';
const EVENT_BUS_NAME = process.env.EVENT_BUS_NAME!;
const DEFAULT_REGION = process.env.AWS_REGION || 'us-east-1';
const USER_POOL_ID = process.env.USER_POOL_ID || '';

/**
 * Lazy DynamoDBDocumentClient singleton. Constructed on first call — keeps the
 * module free of top-level SDK construction so tests can install mocks before
 * any handler fires. The AppApiKey / AccessControl / Metrics helpers still
 * expect a doc client for their deps struct; we share one instance.
 */
let _docClient: DynamoDBDocumentClient | undefined;
function getDocClient(): DynamoDBDocumentClient {
  if (!_docClient) {
    _docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  }
  return _docClient;
}

/** Lazy EventBridge singleton for publishAppStatusEvent and emitEvent. */
let _eventBridgeClient: EventBridgeClient | undefined;
function getEventBridgeClient(): EventBridgeClient {
  if (!_eventBridgeClient) {
    _eventBridgeClient = new EventBridgeClient({});
  }
  return _eventBridgeClient;
}

/** Lazy RegistryService singleton. Same pattern as agent-config-resolver. */
let _registryService: RegistryService | undefined;
function getRegistryService(): RegistryService {
  if (!_registryService) {
    const registryId = process.env.REGISTRY_ID;
    if (!registryId) {
      throw new Error(
        'REGISTRY_ID environment variable is required by registry-agent-record-resolver',
      );
    }
    _registryService = new RegistryService({
      registryId,
      region: DEFAULT_REGION,
    });
  }
  return _registryService;
}

/** Lazy CognitoIdentityProviderClient singleton for createdBy name resolution. */
let _cognitoClient: CognitoIdentityProviderClient | undefined;
function getCognitoClient(): CognitoIdentityProviderClient {
  if (!_cognitoClient) {
    _cognitoClient = new CognitoIdentityProviderClient({});
  }
  return _cognitoClient;
}

/**
 * Per-invocation cache for userId -> display name lookups. Declared at
 * module scope (so it's reachable from both getApp and metaRowToAppShape)
 * but explicitly cleared at the top of `handler` on every invocation — a
 * warm Lambda container must never serve a stale name from a prior request.
 *
 * Caches the in-flight `Promise<string>`, not just the resolved value: both
 * `listApps` list projections (`metaRowToAppShape`) run concurrently via
 * `Promise.all`, so multiple rows created by the SAME user all observe a
 * cache miss before any single one resolves if only settled values were
 * cached. Storing the promise itself means the second-and-later concurrent
 * callers for a given userId await the SAME in-flight `AdminGetUser` call
 * instead of issuing their own — exactly one Cognito call per unique
 * creator per invocation, however many rows/bindings reference them.
 */
const createdByNameCache = new Map<string, Promise<string>>();

/**
 * Resolves a Cognito user ID to a human-readable display name via
 * AdminGetUser. Falls back to the raw userId on any failure (missing
 * USER_POOL_ID, user not found, Cognito error) — this must never throw,
 * since it is a display-only enrichment and must not block getApp/listApps.
 *
 * Deliberately scoped to a single admin-privileged call per userId
 * (AdminGetUser, not the unscoped ListUsers) and never exposes any Cognito
 * attribute beyond the display name itself.
 *
 * Concurrency-safe: the in-flight promise is memoized (see
 * `createdByNameCache`), so N concurrent callers for the same userId within
 * one invocation share a single AdminGetUser call.
 */
async function resolveCreatedByName(userId: string | undefined | null): Promise<string> {
  if (!userId) return 'unknown';
  const cached = createdByNameCache.get(userId);
  if (cached !== undefined) return cached;

  const lookup = (async (): Promise<string> => {
    if (!USER_POOL_ID) {
      return userId;
    }
    try {
      const response = await getCognitoClient().send(
        new AdminGetUserCommand({
          UserPoolId: USER_POOL_ID,
          Username: userId,
        }),
      );
      const attributes = response.UserAttributes || [];
      const givenName = attributes.find((a) => a.Name === 'given_name')?.Value;
      const familyName = attributes.find((a) => a.Name === 'family_name')?.Value;
      const email = attributes.find((a) => a.Name === 'email')?.Value;
      return givenName && familyName ? `${givenName} ${familyName}` : email || userId;
    } catch (err) {
      console.warn('resolveCreatedByName: AdminGetUser failed, falling back to userId', {
        userId,
        error: err instanceof Error ? err.message : String(err),
      });
      return userId;
    }
  })();

  createdByNameCache.set(userId, lookup);
  return lookup;
}

/**
 * Returns the deps struct for the preserved API-key / access / metrics
 * helpers. APPS_TABLE lives here (and only here) during the deprecation
 * window; AgentApp-shape surfaces do not read this struct.
 */
function getSharedDeps(): ApiKeyDeps & AccessControlDeps {
  return {
    docClient: getDocClient(),
    appsTable: APPS_TABLE,
    eventBridgeClient: getEventBridgeClient(),
    eventBusName: EVENT_BUS_NAME,
  };
}

/**
 * Validates that a per-agent-binding `modelOverride` refers to a model that
 * exists in the shared model catalog AND is currently `enabled`.
 *
 * Non-breaking / grandfathering contract:
 *   - When `MODEL_CATALOG_TABLE` is not configured (local runs and unit-test
 *     paths that do not wire the catalog), this is a deliberate no-op: it logs
 *     a warning and returns, so unconfigured environments are never blocked.
 *   - Callers only invoke this for a NEW or CHANGED, non-empty override, so
 *     legacy/unchanged stored values are grandfathered and never re-validated.
 *
 * Throws a descriptive Error when the model key is unknown or disabled. Uses
 * the file's shared lazy DynamoDBDocumentClient (read-only GetItem).
 */
async function assertEnabledCatalogModel(modelKey: string): Promise<void> {
  const table = process.env.MODEL_CATALOG_TABLE;
  if (!table) {
    console.warn(
      'MODEL_CATALOG_TABLE is not configured; skipping modelOverride catalog validation',
    );
    return;
  }
  const res = await getDocClient().send(
    new GetCommand({ TableName: table, Key: { modelKey } }),
  );
  if (!res.Item) {
    throw new Error(
      `Invalid modelOverride '${modelKey}': not found in the model catalog`,
    );
  }
  if (res.Item.status !== 'enabled') {
    throw new Error(`Invalid modelOverride '${modelKey}': model is not enabled`);
  }
}

// ---------------------------------------------------------------------------
// Manifest helpers — the RegistryRecord.customDescriptorContent JSON is the
// single source of truth for AgentApp state during the deprecation window.
// ---------------------------------------------------------------------------

/** A single agent binding entry stored in the manifest. */
interface AgentBinding {
  agentId: string;
  status?: string;
  addedAt?: string;
  systemPromptAddition?: string;
  toolRestrictions?: string[];
  modelOverride?: string;
  /**
   * Server-resolved display name of the bound agent (Registry record's
   * `name` field). NOT persisted in the manifest — populated at read time
   * by `resolveAgentBindingNames` so the frontend never has to make N+1
   * per-binding lookups. Optional because it is absent until resolution
   * runs (e.g. write-path projections that don't call resolveAgentBindingNames).
   */
  name?: string;
}

/** A single permission entry stored in the manifest. */
interface AppPermission {
  permissionId: string;
  actions?: string[];
  resources?: string[];
  description?: string;
}

interface AgentAppManifest {
  orgId?: string;
  version?: number;
  status?: string;
  createdBy?: string;
  workflowIds?: string[];
  agentBindings?: AgentBinding[];
  permissions?: AppPermission[];
  configSchema?: Record<string, unknown> | null;
  configValues?: unknown;
  authConfig?: unknown;
  access?: Record<string, { role: string; grantedAt: string; grantedBy: string }>;
  routingConfig?: unknown;
  sourceProjectId?: string;
}

interface CustomDescriptor extends AgentAppManifest {
  manifest?: AgentAppManifest;
  appId?: string;
  categories?: string[];
  icon?: string;
  state?: string;
}

function parseDescriptor(record: RegistryRecord | null | undefined): CustomDescriptor {
  if (!record?.customDescriptorContent) {
    return {};
  }
  try {
    const parsed = JSON.parse(record.customDescriptorContent);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as CustomDescriptor;
    }
  } catch {
    // Swallow — malformed JSON becomes an empty descriptor.
  }
  return {};
}

function readManifest(record: RegistryRecord | null | undefined): AgentAppManifest {
  const descriptor = parseDescriptor(record);
  const manifest = descriptor.manifest;
  if (manifest && typeof manifest === 'object' && !Array.isArray(manifest)) {
    return manifest;
  }
  return {};
}

/**
 * Applies `mutator` to a shallow clone of the record's manifest and returns
 * the serialised `customDescriptorContent` string ready for a Registry
 * update. The appId/sourceProjectId/categories/icon/state top-level fields
 * on the descriptor (recognised by the inline `projectAgentAppShape` /
 * `recordFromInput` helpers above) are preserved.
 */
function writeManifestMutation(
  record: RegistryRecord | null | undefined,
  mutator: (manifest: AgentAppManifest) => void,
): string {
  const descriptor = parseDescriptor(record);
  const manifest: AgentAppManifest = { ...(descriptor.manifest || {}) };
  mutator(manifest);
  descriptor.manifest = manifest;
  return JSON.stringify(descriptor);
}

/**
 * Projects a RegistryRecord into an AgentApp-shaped object via the inline
 * `projectAgentAppShape` helper, then enriches with manifest-derived fields
 * so downstream callers see the full AgentApp payload (workflowIds,
 * agentBindings, permissions, config, auth, access) that the legacy resolver
 * returned.
 */
/**
 * The AgentApp-shaped projection returned by this resolver's read/mutation
 * paths — DeprecatedAgentAppShape fields enriched with the manifest-derived
 * payload plus the publish-time fields merged in from the AppsTable.
 */
interface ProjectedAgentApp {
  appId?: string;
  name?: string;
  description?: string;
  createdAt?: string;
  updatedAt?: string;
  status: string;
  orgId: string;
  createdBy: string;
  /**
   * Server-resolved display name for `createdBy` (Cognito AdminGetUser
   * given_name + family_name, or email, falling back to the raw userId on
   * any lookup failure). Populated by `getApp` and `metaRowToAppShape` at
   * read time — NEVER persisted, so it always reflects the current Cognito
   * profile. Optional because write-path projections (createApp, updateApp,
   * etc.) do not resolve it.
   */
  createdByName?: string;
  version: number;
  workflowIds: string[];
  agentBindings: AgentBinding[];
  permissions: AppPermission[];
  configSchema: Record<string, unknown> | null;
  configValues: unknown;
  authConfig: unknown;
  access: { userId: string; role: string; grantedAt: string; grantedBy: string }[];
  routingConfig: unknown;
  sourceProjectId: string | null;
  endpointUrl?: string;
  apiId?: string;
}

function projectAgentApp(record: RegistryRecord): ProjectedAgentApp {
  const base = projectAgentAppShape(record);
  const descriptor = parseDescriptor(record);
  const manifest = readManifest(record);

  const access = manifest.access || {};
  const accessEntries = Object.entries(access).map(([userId, entry]) => ({
    userId,
    role: entry.role,
    grantedAt: entry.grantedAt,
    grantedBy: entry.grantedBy,
  }));

  return {
    ...base,
    status: record.status ?? 'DRAFT',
    orgId: manifest.orgId ?? descriptor.orgId ?? '',
    createdBy: manifest.createdBy ?? descriptor.createdBy ?? '',
    version: toIntVersion(manifest.version ?? descriptor.version),
    workflowIds: manifest.workflowIds ?? [],
    agentBindings: manifest.agentBindings ?? [],
    permissions: manifest.permissions ?? [],
    configSchema: manifest.configSchema ?? null,
    configValues: manifest.configValues ?? null,
    authConfig: manifest.authConfig ?? null,
    access: accessEntries,
    routingConfig: manifest.routingConfig ?? null,
    sourceProjectId:
      manifest.sourceProjectId ?? base.sourceProjectId ?? descriptor.sourceProjectId ?? null,
  };
}

/**
 * `projectAgentApp` + identity normalization for mutation return paths.
 *
 * The Registry assigns its OWN 12-char recordId on create (the uuid the
 * resolver passes in is discarded), while customDescriptorContent may still
 * embed the ORIGINAL client-side UUID as `appId` — which
 * `projectAgentAppShape` lets OVERRIDE the projected appId. Everything
 * persisted (registry record, AppsTable #META mirror, authority unit) is
 * keyed by record.recordId, so returning the UUID makes follow-up lookups
 * (e.g. importBlueprint's GetItem) miss deterministically. Always return the
 * 12-char recordId as appId — mirrors the normalization getApp applies.
 */
function projectAgentAppNormalized(record: RegistryRecord): ProjectedAgentApp {
  const projected = projectAgentApp(record);
  projected.appId = record.recordId;
  return projected;
}

/**
 * Enriches each agent binding with the bound agent's `name` field so the
 * frontend never has to resolve raw agentIds itself (eliminates the N+1
 * per-page-load agent lookups the client used to perform).
 *
 * Resolution runs within THIS Lambda invocation only (no cross-Lambda
 * calls) and is genuinely bounded independent of binding count:
 *
 *   - Fast path (the common case — bindings carry the Registry's own
 *     12-char recordId): a SINGLE `BatchGetItem` against `AGENT_CONFIG_TABLE`,
 *     the denormalized Registry->DynamoDB projection that registry-sync.ts
 *     keeps current off EventBridge resource-change events. One DynamoDB
 *     round trip for the whole batch of unique agent ids (DynamoDB's
 *     100-item BatchGetItem limit is chunked, so even that stays O(ceil(n/100))
 *     round trips rather than O(n) Registry GETs).
 *   - Slow path (legacy human-readable agentId, not a 12-char recordId —
 *     rare, pre-Registry-native bindings only): falls back to
 *     `RegistryService.getResourcesByRefs`, a single shared name->recordId
 *     summary-list pass plus one detail GET per unique legacy agent. This
 *     path still costs real Registry reads because the installed AgentCore
 *     Control SDK has no batch-get operation — but it is only reached for
 *     the small, shrinking set of legacy non-recordId bindings, never for
 *     ordinary pages of recordId-shaped bindings.
 *
 * Tenant validation: a binding's `name` is populated ONLY when the bound
 * agent's own manifest orgId EXPLICITLY matches `appOrgId`, or is an
 * EXPLICIT empty string (`orgId === ''`, the established "system-shared"
 * convention `agent-config-resolver` also uses). An agent record whose
 * orgId is missing/undefined (malformed or legacy metadata) is treated as
 * belonging to neither org and FAILS CLOSED — it must never be treated as
 * system-shared merely because the field is absent. An agent belonging to a
 * different (non-empty) org is likewise left unresolved (name unset,
 * callers fall back to displaying the raw agentId) rather than leaking its
 * name across tenants.
 *
 * Failures (unresolvable legacy name, missing record, transient DynamoDB/
 * Registry error, cross-org or org-less agent) are isolated per-binding and
 * non-fatal — matching the "always fall back gracefully" constraint.
 *
 * Mutates and returns the same array reference for convenience.
 */
async function resolveAgentBindingNames(
  bindings: AgentBinding[],
  appOrgId: string,
): Promise<AgentBinding[]> {
  if (!bindings || bindings.length === 0) {
    return bindings;
  }

  const isRecordId = (r: string) => /^[a-zA-Z0-9]{12}$/.test(r);
  const uniqueRefs = Array.from(new Set(bindings.map((b) => b.agentId).filter((r) => !!r)));
  const recordIdRefs = uniqueRefs.filter(isRecordId);
  const legacyRefs = uniqueRefs.filter((r) => !isRecordId(r));

  // ref -> { name, orgId } for every ref we manage to resolve, from EITHER
  // path. `orgId` is `undefined` when the source record omitted it — kept
  // distinct from `''` so the tenant check below fails closed correctly.
  const resolved = new Map<string, { name: string; orgId: string | undefined }>();

  await Promise.all([
    resolveRecordIdRefsViaCache(recordIdRefs, resolved),
    resolveLegacyRefsViaRegistry(legacyRefs, resolved),
  ]);

  // Fallback: any recordId refs not resolved from DDB cache → try the Registry directly
  const unresolvedRecordIds = recordIdRefs.filter((r) => !resolved.has(r));
  if (unresolvedRecordIds.length > 0) {
    try {
      const registry = getRegistryService();
      const results = await Promise.allSettled(
        unresolvedRecordIds.map((id) => registry.getResource('agent', id))
      );
      for (let i = 0; i < unresolvedRecordIds.length; i++) {
        const result = results[i];
        if (result.status === 'fulfilled' && result.value) {
          const record = result.value;
          const orgId = readRawManifestOrgId(record);
          resolved.set(unresolvedRecordIds[i], { name: record.name ?? '', orgId });
        }
      }
    } catch (err) {
      console.warn('resolveAgentBindingNames: Registry fallback for unresolved recordIds failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  for (const binding of bindings) {
    const entry = resolved.get(binding.agentId);
    if (!entry) continue;
    const sameOrg = entry.orgId === appOrgId || entry.orgId === '';
    if (sameOrg && entry.name) {
      binding.name = entry.name;
    }
  }
  return bindings;
}

/** DynamoDB BatchGetItem hard limit — chunk any larger ref set. */
const BATCH_GET_CHUNK_SIZE = 100;

/**
 * Fast path for `resolveAgentBindingNames`: resolves 12-char Registry
 * recordId refs via BatchGetItem against the AGENT_CONFIG_TABLE projection —
 * O(ceil(n/100)) DynamoDB round trips for the WHOLE batch, never one Registry
 * call per binding. Populates `out` in place; never throws (falls back to
 * leaving those refs unresolved on any table/config failure).
 */
async function resolveRecordIdRefsViaCache(
  refs: string[],
  out: Map<string, { name: string; orgId: string | undefined }>,
): Promise<void> {
  if (refs.length === 0 || !AGENT_CONFIG_TABLE) {
    return;
  }
  try {
    for (let i = 0; i < refs.length; i += BATCH_GET_CHUNK_SIZE) {
      const chunk = refs.slice(i, i + BATCH_GET_CHUNK_SIZE);
      const result = await getDocClient().send(
        new BatchGetCommand({
          RequestItems: {
            [AGENT_CONFIG_TABLE]: {
              Keys: chunk.map((agentId) => ({ agentId })),
            },
          },
        }),
      );
      const items = result.Responses?.[AGENT_CONFIG_TABLE] ?? [];
      for (const item of items) {
        const agentId = item.agentId as string;
        const name = typeof item.name === 'string' ? item.name : '';
        const orgId = typeof item.orgId === 'string' ? item.orgId : undefined;
        if (agentId) out.set(agentId, { name, orgId });
      }
    }
  } catch (err) {
    console.warn(
      'resolveAgentBindingNames: BatchGetItem against AGENT_CONFIG_TABLE failed, leaving recordId bindings unset',
      { error: err instanceof Error ? err.message : String(err) },
    );
  }
}

/**
 * Slow path for `resolveAgentBindingNames`: resolves legacy human-readable
 * agentId refs (pre-Registry-native bindings, not a 12-char recordId) via
 * RegistryService.getResourcesByRefs — a single shared summary-list pass
 * for the whole batch plus one detail GET per unique resolved record.
 * Populates `out` in place; never throws.
 */
async function resolveLegacyRefsViaRegistry(
  refs: string[],
  out: Map<string, { name: string; orgId: string | undefined }>,
): Promise<void> {
  if (refs.length === 0) {
    return;
  }
  const registry = getRegistryService();
  try {
    const recordsByRef = await registry.getResourcesByRefs('agent', refs);
    for (const [ref, record] of recordsByRef.entries()) {
      const orgId = readRawManifestOrgId(record);
      out.set(ref, { name: record.name ?? '', orgId });
    }
  } catch (err) {
    console.warn('resolveAgentBindingNames: legacy-ref batch resolution failed, leaving names unset', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Reads the RAW `orgId` from a Registry record's custom metadata, preserving
 * the "absent" (undefined) vs "explicit empty string" distinction that
 * `RegistryService.mapToAgentConfig` deliberately collapses (its
 * `meta.orgId ?? ''` is correct for ITS callers, which treat every org-less
 * agent as visible — but would make this enrichment fail OPEN for any
 * legacy/malformed record that merely omits orgId). Never throws.
 */
function readRawManifestOrgId(record: RegistryRecord): string | undefined {
  try {
    const meta = record.customDescriptorContent
      ? JSON.parse(record.customDescriptorContent)
      : undefined;
    if (meta && typeof meta === 'object' && typeof meta.orgId === 'string') {
      return meta.orgId;
    }
    return undefined;
  } catch {
    return undefined;
  }
}


// ---------------------------------------------------------------------------
// IAM action validation (preserved from app-resolver.ts)
// ---------------------------------------------------------------------------

export function validatePermissionActions(
  actions: string[],
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  for (const action of actions) {
    if (action === '*') {
      errors.push(
        'Bare wildcard (*) not allowed — must specify service prefix (e.g., s3:*)',
      );
    } else if (!/^[a-zA-Z0-9-]+:[a-zA-Z0-9*]+$/.test(action)) {
      errors.push(`Invalid IAM action format: ${action}`);
    }
  }
  return { valid: errors.length === 0, errors };
}

async function emitEvent(eventType: string, detail: unknown): Promise<void> {
  await getEventBridgeClient().send(new PutEventsCommand({
    Entries: [
      {
        Source: 'citadel.apps',
        DetailType: eventType,
        Detail: JSON.stringify(detail),
        EventBusName: EVENT_BUS_NAME,
      },
    ],
  }));
}

// ---------------------------------------------------------------------------
// Entry point — single handler dispatched on event.info.fieldName
// ---------------------------------------------------------------------------

export interface CreateAppInput {
  orgId: string;
  name: string;
  description?: string;
  sourceProjectId?: string;
}

interface UpdateAppInput {
  appId: string;
  orgId?: string;
  name?: string;
  description?: string;
  status?: string;
  version?: number;
  routingConfig?: string;
  sourceProjectId?: string;
}

/**
 * Merged view of every `input` argument shape the dispatched mutations
 * receive (createApp, updateApp, updateAgentBinding, publishAppStatusEvent).
 */
interface RegistryAppInputArgument {
  appId: string;
  orgId: string;
  name: string;
  description?: string;
  status?: string;
  version?: number;
  routingConfig?: string;
  sourceProjectId?: string;
  agentId: string;
  systemPromptAddition?: string;
  toolRestrictions?: string[];
  modelOverride?: string;
  previousStatus: string;
  newStatus: string;
  timestamp: string;
}

/**
 * Merged view of every argument shape this resolver's 22 fields receive.
 * AppSync only populates the arguments relevant to the dispatched field.
 */
interface RegistryResolverArguments {
  appId: string;
  orgId: string;
  workflowId: string;
  input: RegistryAppInputArgument;
  component: { type: string; data: string };
  componentType: string;
  componentId: string;
  schema: string | object;
  values: string | object;
  version: number;
  authConfig: string | object;
  userId: string;
  role: string;
  startTime: string;
  endTime: string;
  keyId: string;
  name: string;
  expiresIn?: number;
}

export const handler: AppSyncResolverHandler<RegistryResolverArguments, unknown> = async (event) => {
  console.log('Registry agent record resolver event:', JSON.stringify(event, null, 2));

  // Clear the invocation-scoped createdByName cache. It exists to dedupe
  // repeated AdminGetUser calls for the SAME userId across many rows WITHIN
  // one getApp/listApps call (e.g. many apps created by the same user) —
  // not to persist stale names across separate invocations on a warm
  // container, which would let a Cognito profile update go unreflected.
  createdByNameCache.clear();

  const { info, arguments: args, identity } = event;
  const fieldName = info.fieldName;
  const userId = getUserId(identity);

  try {
    switch (fieldName) {
      // AgentApp-shape queries (registry-backed)
      case 'getApp':
        return await getApp(args.appId, userId, event);
      case 'listApps':
        return await listApps(args.orgId, userId, event);

      // AgentApp-shape mutations (registry-backed, factory-projected)
      case 'createApp':
        return await createApp(args.input, userId);
      case 'updateApp':
        return await updateApp(args.input, userId);
      case 'deleteApp':
        return await deleteApp(args.appId, userId);
      case 'bindWorkflowToApp':
        return await bindWorkflowToApp(args.appId, args.workflowId, userId);
      case 'unbindWorkflowFromApp':
        return await unbindWorkflowFromApp(args.appId, args.workflowId, userId);
      case 'updateAgentBinding':
        return await updateAgentBinding(args.input, userId);
      case 'addAppComponent':
        return await addAppComponent(args.appId, args.component, userId);
      case 'removeAppComponent':
        return await removeAppComponent(
          args.appId,
          args.componentType,
          args.componentId,
          userId,
        );
      case 'setAppConfigSchema':
        return await setAppConfigSchema(args.appId, args.schema, args.version, userId);
      case 'setAppConfigValues':
        return await setAppConfigValues(args.appId, args.values, args.version, userId);
      case 'setAppAuthConfig':
        return await setAppAuthConfig(args.appId, args.authConfig, userId);
      case 'grantAppAccess':
        return await grantAppAccess(args.appId, args.userId, args.role, userId);
      case 'revokeAppAccess':
        return await revokeAppAccess(args.appId, args.userId, userId);

      // Non-AgentApp queries (preserved DDB / subscription paths)
      case 'listAppApiKeys':
        return await listAppApiKeys(args.appId);
      case 'listAppAccessEntries':
        return await listAppAccessEntries(args.appId);
      case 'getAppMetrics':
        return await getAppMetrics(args.appId, args.startTime, args.endTime);

      // Non-AgentApp mutations (EventBridge / DDB-backed API keys)
      case 'publishAppStatusEvent':
        return await publishAppStatusEvent(args.input);
      case 'createAppApiKey':
        return await createAppApiKey(args.appId, args.name, args.expiresIn, userId);
      case 'revokeAppApiKey':
        return await revokeAppApiKey(args.appId, args.keyId, userId);
      case 'rotateAppApiKey':
        return await rotateAppApiKey(args.appId, args.keyId, userId);

      default:
        throw new Error(`Unknown field: ${fieldName}`);
    }
  } catch (error) {
    console.error('Registry agent record resolver error:', error);
    throw error;
  }
};

// ===========================================================================
// Registry-backed (AgentApp-shape) handlers
// ===========================================================================

async function getApp(appId: string, _userId: string, event: unknown): Promise<unknown> {
  let record;
  try {
    record = await getRegistryService().getResource('agent', appId);
  } catch (err) {
    if (err instanceof TypeMismatchError) {
      throw new Error(`App ${appId} not found`);
    }
    throw err;
  }
  if (!record) {
    return null;
  }
  const projected = projectAgentApp(record);

  // Tenant gate — MUST run before any Cognito/agent-name enrichment (both of
  // which are privileged, PII-bearing lookups) and before returning the
  // record at all. The AppSync mapping for getApp is a direct Lambda
  // pass-through with no upstream authorization, so this resolver is the
  // only place that can enforce it. Admins bypass; everyone else must
  // belong to the app's own org. A denied caller sees the same "not found"
  // shape as a missing app — this must not distinguish "exists in another
  // org" from "doesn't exist" (that distinction is itself a disclosure).
  if (!isAdminFromEvent(event)) {
    const callerOrgId = await extractOrgFromEvent(event);
    if (!callerOrgId || callerOrgId !== projected.orgId) {
      return null;
    }
  }

  // Merge publish-time fields from the AppsTable (DDB is authoritative for
  // status, endpointUrl, apiId after publishApp runs).
  try {
    const ddbResult = await getDocClient().send(new GetCommand({
      TableName: APPS_TABLE,
      Key: { appId },
    }));
    const meta = ddbResult.Item;
    if (meta) {
      if (meta.status) projected.status = meta.status;
      if (meta.endpointUrl) projected.endpointUrl = meta.endpointUrl;
      if (meta.apiId) projected.apiId = meta.apiId;
      if (meta.workflowIds?.length) projected.workflowIds = meta.workflowIds;
    }
  } catch {
    // DDB read failure is non-fatal — return Registry-only projection.
  }

  // Server-side resolution of createdBy -> display name and per-binding
  // agent names — runs in parallel since they hit independent backends
  // (Cognito vs Registry) and neither result depends on the other. Both
  // helpers are individually fail-safe (fall back to the raw id), so no
  // try/catch is needed here. Only reached once the tenant gate above has
  // authorized this caller for this app's org, so it's safe to call
  // AdminGetUser and resolve bound-agent names here.
  await Promise.all([
    resolveCreatedByName(projected.createdBy).then((name) => {
      projected.createdByName = name;
    }),
    resolveAgentBindingNames(projected.agentBindings, projected.orgId),
  ]);

  // Always return the 12-char recordId as appId (not the UUID from customDescriptorContent).
  projected.appId = appId;

  return projected;
}

async function listApps(
  orgId: string,
  _userId: string,
  event: unknown,
): Promise<{ items: unknown[]; nextToken: string | null }> {
  const isAllOrgsRequest = !orgId || orgId === 'All Organizations';
  const admin = isAdminFromEvent(event);
  if (isAllOrgsRequest && !admin) {
    throw new Error('Only admins may list apps across all organizations');
  }

  // Tenant gate for a specific-org request: a non-admin caller may only
  // list their OWN org's apps. Silently coerce a mismatched requested orgId
  // to the caller's actual org rather than trusting the argument outright —
  // AppSync has no upstream authorization for this field (direct Lambda
  // pass-through), so a non-admin could otherwise pass an arbitrary orgId
  // and enumerate another tenant's apps (plus trigger AdminGetUser /
  // agent-name enrichment for each one).
  let effectiveOrgId = orgId;
  if (!isAllOrgsRequest && !admin) {
    const callerOrgId = await extractOrgFromEvent(event);
    if (!callerOrgId) {
      return { items: [], nextToken: null };
    }
    effectiveOrgId = callerOrgId;
  }

  // Phase 3: read from the AppsTable.OrgIndex GSI rather than scanning the
  // Registry. The GSI carries a complete projection so no Registry call is
  // needed for the list view. The Registry remains the source of truth; the
  // reconciler (Step 4) catches drift between the two.
  if (isAllOrgsRequest) {
    return await scanAllAppsViaMeta();
  }
  return await queryAppsViaOrgIndex(effectiveOrgId);
}

/**
 * Org-scoped list path. Pages through the AppsTable.OrgIndex GSI for the
 * given orgId. The OrgIndex GSI only includes rows that have BOTH `orgId`
 * AND `createdAt` attributes — metadata rows have those, API/component
 * rows don't, so the GSI auto-excludes non-metadata rows by construction
 * and no FilterExpression is needed.
 */
async function queryAppsViaOrgIndex(
  orgId: string,
): Promise<{ items: unknown[]; nextToken: string | null }> {
  const items: unknown[] = [];
  let nextToken: Record<string, NativeAttributeValue> | undefined = undefined;
  do {
    // Explicit annotation breaks the let-variable flow-analysis cycle
    // (nextToken → send() overload → result → nextToken) under TS 5.9.
    const result: QueryCommandOutput = await getDocClient().send(
      new QueryCommand({
        TableName: APPS_TABLE,
        IndexName: 'OrgIndex',
        KeyConditionExpression: 'orgId = :org',
        ExpressionAttributeValues: {
          ':org': orgId,
        },
        ExclusiveStartKey: nextToken,
      }),
    );
    if (result.Items) items.push(...(await Promise.all(result.Items.map(metaRowToAppShape))));
    nextToken = result.LastEvaluatedKey;
  } while (nextToken);
  return { items, nextToken: null };
}

/**
 * Admin "All Organizations" path. Scans the AppsTable, filtering on the
 * `sortId` data attribute so non-metadata rows (API keys, components,
 * etc.) sharing the same table are excluded.
 */
async function scanAllAppsViaMeta(): Promise<{
  items: unknown[];
  nextToken: string | null;
}> {
  const items: unknown[] = [];
  let nextToken: Record<string, NativeAttributeValue> | undefined = undefined;
  do {
    // Same explicit annotation as queryAppsViaOrgIndex — breaks the
    // let-variable flow-analysis cycle under TS 5.9.
    const result: ScanCommandOutput = await getDocClient().send(
      new ScanCommand({
        TableName: APPS_TABLE,
        FilterExpression: 'sortId = :meta',
        ExpressionAttributeValues: { ':meta': APP_META_SORT_VALUE },
        ExclusiveStartKey: nextToken,
      }),
    );
    if (result.Items) items.push(...(await Promise.all(result.Items.map(metaRowToAppShape))));
    nextToken = result.LastEvaluatedKey;
  } while (nextToken);
  return { items, nextToken: null };
}

/**
 * Projects a single AppsTable `#META` row onto the AgentApp-shape response
 * used by listApps. Field defaults match the Registry-backed projection so
 * callers see no behavioural difference between the two read paths.
 *
 * Resolves `createdByName` via Cognito AdminGetUser (same helper getApp
 * uses), sharing the invocation-scoped `createdByNameCache` — rows created
 * by the same user across a page of listApps results incur only one
 * AdminGetUser call, not one per row.
 */
async function metaRowToAppShape(row: Record<string, unknown>): Promise<Record<string, unknown>> {
  const createdBy = (row.createdBy as string) ?? '';
  return {
    appId: row.appId,
    orgId: row.orgId ?? '',
    name: row.name ?? '',
    description: row.description ?? '',
    status: row.status ?? 'DRAFT',
    workflowIds: row.workflowIds ?? [],
    routingConfig: row.routingConfig ?? '',
    createdBy,
    createdByName: await resolveCreatedByName(createdBy),
    createdAt: row.createdAt ?? '',
    updatedAt: row.updatedAt ?? '',
    version: typeof row.version === 'number' ? row.version : 1,
  };
}

/**
 * Finds the app created for an intake session by its server-stamped
 * `sourceProjectId` — the intakeCreateApp idempotency guard (triplicate-
 * create fix: one consent produced three apps when the client timed out and
 * retried while the first invocation had already persisted the app).
 *
 * Reads the AppsTable #META mirror (createApp's upsertAppMeta stamps
 * sourceProjectId there), scoped to the caller's org, then projects the live
 * registry record exactly as createApp's return path does — a retry response
 * is indistinguishable from the original create response. Deliberately NOT a
 * registry list-scan: the mirror scan is the cheap read (the create path
 * must return in seconds).
 *
 * Returns null when no mirror row matches, or when every matching row is
 * stale (its registry record was deleted) — a fresh create is then correct.
 *
 * Exported for reuse by intake-orchestration-resolver.
 */
export async function findAppBySourceProjectId(
  sourceProjectId: string,
  orgId: string,
): Promise<unknown | null> {
  let nextToken: Record<string, NativeAttributeValue> | undefined = undefined;
  do {
    // Same explicit annotation as scanAllAppsViaMeta — breaks the
    // let-variable flow-analysis cycle under TS 5.9.
    const result: ScanCommandOutput = await getDocClient().send(
      new ScanCommand({
        TableName: APPS_TABLE,
        FilterExpression: 'sortId = :meta AND sourceProjectId = :spid AND orgId = :org',
        ExpressionAttributeValues: {
          ':meta': APP_META_SORT_VALUE,
          ':spid': sourceProjectId,
          ':org': orgId,
        },
        ExclusiveStartKey: nextToken,
      }),
    );
    for (const row of result.Items ?? []) {
      if (typeof row.appId !== 'string' || row.appId.length === 0) {
        continue;
      }
      let record: RegistryRecord | null = null;
      try {
        record = await getRegistryService().getResource('agent', row.appId);
      } catch (err) {
        if (!(err instanceof TypeMismatchError)) {
          throw err;
        }
        // Type-mismatched record — treat as stale, same as a missing one.
      }
      if (record) {
        return projectAgentAppNormalized(record);
      }
      // deleteApp removes the registry record first and the mirror row
      // best-effort; a surviving mirror row must not resurrect a deleted
      // app. Log and keep scanning.
      console.warn('findAppBySourceProjectId: stale AppsTable mirror row (registry record gone)', {
        appId: row.appId,
      });
    }
    nextToken = result.LastEvaluatedKey;
  } while (nextToken);
  return null;
}

// Exported for reuse by intake-orchestration-resolver (IAM-only intake
// mutations delegate to this core so app-creation governance — registry
// record, #META mirror, fabricator authority grant, app.created event —
// stays in exactly one place).
export async function createApp(input: CreateAppInput, userId: string): Promise<unknown> {
  const now = new Date().toISOString();
  const appId = uuidv4();

  // The AgentCore Registry API requires description length >= 1. The Import
  // Blueprint dialog's New App mode sends only { name, orgId }, so an
  // absent/blank description defaults to the app name. Resolved once here so
  // the registry record and the AppsTable #META mirror stay consistent.
  const description = (input.description ?? '').trim() || input.name;

  // Build the AgentApp-shaped input, then project to a RegistryRecord skeleton
  // via the factory. The manifest sub-object carries the fields the legacy
  // resolver stored as separate DDB rows (workflowIds, bindings, permissions).
  const agentAppInput = {
    appId,
    orgId: input.orgId,
    name: input.name,
    description,
    status: 'DRAFT',
    version: 1,
    createdAt: now,
    updatedAt: now,
    sourceProjectId: input.sourceProjectId,
  };
  const skeleton = recordFromInput(agentAppInput);

  const initialManifest: AgentAppManifest = {
    orgId: input.orgId,
    version: 1,
    status: 'DRAFT',
    createdBy: userId,
    workflowIds: [],
    agentBindings: [],
    permissions: [],
    configSchema: null,
    configValues: null,
    authConfig: null,
    access: {},
    routingConfig: null,
    ...(input.sourceProjectId !== undefined && {
      sourceProjectId: input.sourceProjectId,
    }),
  };
  const descriptor: CustomDescriptor = {
    ...(skeleton.customDescriptorContent
      ? (JSON.parse(skeleton.customDescriptorContent) as CustomDescriptor)
      : {}),
    manifest: initialManifest,
  };

  const record = await getRegistryService().createResource('agent', appId, {
    name: skeleton.name || agentAppInput.name,
    description: skeleton.description,
    customMetadata: JSON.stringify(descriptor),
  });

  // Eventually-consistent mirror to AppsTable.#META so OrgIndex stays current
  // for `listApps`. Helper logs and returns false on failure; never throws —
  // but a silent miss here strands the app out of listApps until the
  // reconciler runs, so surface it in the resolver log too.
  const metaMirrored = await upsertAppMeta(APPS_TABLE, {
    appId: record.recordId,
    orgId: input.orgId,
    // The CREATED name (RegistryService sanitizes to the registry's
    // ^[a-zA-Z0-9][a-zA-Z0-9_\-./]*$ constraint) — not the raw input — so
    // listApps (mirror) and getApp (registry) render the same name.
    name: record.name || agentAppInput.name,
    description: agentAppInput.description,
    status: 'DRAFT',
    workflowIds: [],
    routingConfig: undefined,
    createdBy: userId,
    createdAt: now,
    updatedAt: now,
    version: 1,
    // Intake linkage mirrored onto the AppsTable METADATA row so the publish
    // handler (which reads AppsTable, not the Registry) can finish the
    // project's Build segment on publish. Optional — absent for UI-created apps.
    ...(typeof input.sourceProjectId === 'string' && input.sourceProjectId.length > 0
      ? { sourceProjectId: input.sourceProjectId }
      : {}),
  });
  if (!metaMirrored) {
    console.error('createApp: AppsTable #META mirror write failed', {
      appId: record.recordId,
      tableName: APPS_TABLE,
    });
  }

  // US-ARB-014: grant the per-app fabricator authority unit AFTER the registry
  // record exists but BEFORE the success event so subscribers see a fully
  // consistent state. If grant throws, the record is left in place; we do NOT
  // attempt to roll back the registry create (matches legacy behaviour).
  await grantFabricatorAuthority(record.recordId);

  await emitEvent('app.created', {
    appId: record.recordId,
    orgId: input.orgId,
    userId,
  });

  // Always return the 12-char recordId as appId (not the UUID from
  // customDescriptorContent) — the mirror row, authority unit, and event
  // above are all keyed by record.recordId. Mirrors getApp's normalization.
  return projectAgentAppNormalized(record);
}

async function updateApp(input: UpdateAppInput, userId: string): Promise<unknown> {
  const existing = await getRegistryService().getResource('agent', input.appId);
  if (!existing) {
    throw new Error('App not found');
  }

  const existingManifest = readManifest(existing);
  const existingVersion = existingManifest.version ?? 1;
  if (input.version !== undefined && input.version !== existingVersion) {
    throw new Error('Conflict: app was modified concurrently. Please retry.');
  }

  // Merge the input fields over the existing AgentApp projection, then run
  // through the factory so the Registry write goes through the canonical
  // input-boundary projection rule.
  const existingProjection = projectAgentApp(existing);
  // Same guard as createApp: the Registry API rejects descriptions shorter
  // than 1 char, so an explicit-blank input (or an absent input over a legacy
  // record whose stored description is blank) falls back to the app name.
  const resolvedName = input.name ?? existingProjection.name;
  const resolvedDescription =
    ((input.description ?? existingProjection.description ?? '') as string).trim() ||
    resolvedName;
  const mergedAgentApp = {
    appId: input.appId,
    orgId: input.orgId ?? existingProjection.orgId,
    name: resolvedName,
    description: resolvedDescription,
    status: input.status ?? existingProjection.status,
    version: existingVersion + 1,
    createdAt: existingProjection.createdAt,
    updatedAt: new Date().toISOString(),
    sourceProjectId:
      input.sourceProjectId !== undefined
        ? input.sourceProjectId
        : existingProjection.sourceProjectId,
  };
  const skeleton = recordFromInput(mergedAgentApp);

  const updatedContent = writeManifestMutation(existing, (manifest) => {
    if (input.status !== undefined) manifest.status = input.status;
    if (input.routingConfig !== undefined) manifest.routingConfig = input.routingConfig;
    if (input.sourceProjectId !== undefined) {
      manifest.sourceProjectId = input.sourceProjectId;
    }
    manifest.orgId = mergedAgentApp.orgId;
    manifest.version = mergedAgentApp.version;
  });

  const record = await getRegistryService().updateResource('agent', input.appId, {
    name: skeleton.name,
    description: skeleton.description,
    customMetadata: updatedContent,
  });

  // Eventually-consistent mirror to AppsTable.#META — only the fields the
  // caller actually changed, plus the always-bumped updatedAt + version so
  // OrgIndex projections (Step 3) stay correct. Helper never throws.
  const metaPartial: Partial<Omit<AppMetaRow, 'appId' | 'createdAt' | 'createdBy'>> = {
    updatedAt: mergedAgentApp.updatedAt,
    version: mergedAgentApp.version,
  };
  if (input.name !== undefined) metaPartial.name = input.name;
  if (input.description !== undefined) metaPartial.description = resolvedDescription;
  if (input.status !== undefined) metaPartial.status = input.status;
  if (input.routingConfig !== undefined) metaPartial.routingConfig = input.routingConfig;
  await updateAppMetaFields(APPS_TABLE, input.appId, metaPartial);

  if (input.status) {
    // Propagate to Registry record status so the lifecycle state is authoritative
    // there, not just in the local manifest. Accepts Registry-native status values
    // (DRAFT, PENDING_APPROVAL, APPROVED, REJECTED, DEPRECATED) plus the
    // app-specific PUBLISHED which is stored in manifest only.
    if (input.status !== 'PUBLISHED') {
      await getRegistryService().updateResourceStatus(
        'agent',
        input.appId,
        input.status as RegistryRecordStatusValue,
      );
    }
  }

  await emitEvent('app.updated', {
    appId: input.appId,
    userId,
    changes: input,
  });

  // Emit status-transition events (matches legacy resolver semantics).
  if (input.status !== undefined && input.status !== existingProjection.status) {
    const previousStatus = String(existingProjection.status || '').toLowerCase();
    const newStatus = String(input.status).toLowerCase();
    const timestamp = new Date().toISOString();
    const correlationId = uuidv4();

    await emitEvent(`app.status.${previousStatus}_to_${newStatus}`, {
      appId: input.appId,
      orgId: existingProjection.orgId,
      previousStatus: existingProjection.status,
      newStatus: input.status,
      userId,
      timestamp,
      correlationId,
    });

    // Best-effort subscription fan-out — mirrors the legacy non-fatal contract.
    try {
      await publishAppStatusSubscription({
        appId: input.appId,
        previousStatus: existingProjection.status,
        newStatus: input.status,
        timestamp,
      });
    } catch (err) {
      console.error('Failed to publish AppSync status event (non-fatal):', err);
    }
  }

  return projectAgentAppNormalized(record);
}

async function deleteApp(appId: string, userId: string): Promise<unknown> {
  const existing = await getRegistryService().getResource('agent', appId);
  if (!existing) {
    throw new Error('App not found');
  }
  const projection = projectAgentApp(existing);

  // US-ARB-014: revoke the per-app fabricator authority unit BEFORE the
  // registry delete. If revoke throws an unrecoverable error we do NOT
  // continue to the delete — this prevents the dangerous state "record gone
  // but authority unit still active". Benign ConditionalCheckFailedException
  // (already revoked / missing) is swallowed inside revokeFabricatorAuthority.
  await revokeFabricatorAuthority(appId);

  await getRegistryService().deleteResource('agent', appId);

  // Eventually-consistent mirror: drop the AppsTable #META row so OrgIndex
  // (Step 3) stops surfacing the deleted app. Helper never throws.
  await deleteAppMeta(APPS_TABLE, appId);

  await emitEvent('app.deleted', {
    appId,
    orgId: projection.orgId,
    userId,
  });

  return { success: true, message: `App ${appId} deleted` };
}

async function bindWorkflowToApp(
  appId: string,
  workflowId: string,
  userId: string,
): Promise<unknown> {
  const record = await getRegistryService().getResource('agent', appId);
  if (!record) {
    throw new Error('App not found');
  }
  const manifest = readManifest(record);
  const existingIds = manifest.workflowIds || [];
  if (existingIds.includes(workflowId)) {
    // Idempotent — already bound, return the current projection unchanged.
    return projectAgentAppNormalized(record);
  }

  const updatedContent = writeManifestMutation(record, (m) => {
    m.workflowIds = [...existingIds, workflowId];
    m.version = (m.version ?? 1) + 1;
  });

  const updated = await getRegistryService().updateResource('agent', appId, {
    customMetadata: updatedContent,
  });

  await emitEvent('app.workflow.bound', { appId, workflowId, userId });

  return projectAgentAppNormalized(updated);
}

async function unbindWorkflowFromApp(
  appId: string,
  workflowId: string,
  userId: string,
): Promise<unknown> {
  const record = await getRegistryService().getResource('agent', appId);
  if (!record) {
    throw new Error('App not found');
  }
  const manifest = readManifest(record);
  const remaining = (manifest.workflowIds || []).filter((id) => id !== workflowId);

  const updatedContent = writeManifestMutation(record, (m) => {
    m.workflowIds = remaining;
    m.version = (m.version ?? 1) + 1;
  });

  const updated = await getRegistryService().updateResource('agent', appId, {
    customMetadata: updatedContent,
  });

  await emitEvent('app.workflow.unbound', { appId, workflowId, userId });

  return projectAgentAppNormalized(updated);
}

// Exported for reuse by intake-orchestration-resolver (via
// ensureAppAgentBindings) — the canonical READY-promotion core. Export-only
// refactor: behaviour is identical for the AppSync mutation path.
export async function updateAgentBinding(
  input: {
    appId: string;
    agentId: string;
    systemPromptAddition?: string;
    toolRestrictions?: string[];
    modelOverride?: string;
    status?: string;
  },
  userId: string,
): Promise<unknown> {
  const record = await getRegistryService().getResource('agent', input.appId);
  if (!record) {
    throw new Error('App not found');
  }
  const manifest = readManifest(record);
  const bindings = manifest.agentBindings || [];
  const idx = bindings.findIndex((b) => b.agentId === input.agentId);
  if (idx === -1) {
    throw new Error('Agent is not a component of this app');
  }

  // Transition to READY requires the underlying agent record to itself be
  // active (matches legacy validation — keeps a half-wired agent from being
  // flipped live). Consult the registry for the target agent's state.
  if (input.status === 'READY') {
    // Bindings may carry a human-readable agentId (legacy DynamoDB agents) OR a
    // 12-char Registry recordId. The Registry SDK's GetRegistryRecord rejects
    // anything that isn't a recordId. Resolve first; treat a resolution failure
    // as "agent not found" so the user sees the normal activation-gate error
    // rather than a raw regex violation.
    let targetAgent;
    try {
      const targetRecordId = await getRegistryService().resolveRecordId('agent', input.agentId);
      targetAgent = await getRegistryService().getResource('agent', targetRecordId);
    } catch (err) {
      if (err instanceof TypeMismatchError) {
        throw new Error('Agent must be active before it can be marked as ready');
      }
      // Distinguish 'not found' (resolveRecordId failure) from 'not active'
      // so the user sees a useful message rather than a misleading
      // activation-gate error for a missing agent.
      if (err instanceof Error && /not found/i.test(err.message)) {
        throw new Error(`Agent ${input.agentId} not found`);
      }
      throw err;
    }
    // The agent's state is derived from the AUTHORITATIVE record.status via
    // toInternalState — never from the descriptor's `state` mirror, which
    // drifts: the fabricator writes `state: 'inactive'` and activation
    // (SubmitRegistryRecordForApproval) flips only record.status, so
    // registry-fabricated agents carry a stale inactive descriptor while
    // being genuinely active. The inverse drift (descriptor stuck 'active'
    // on a DRAFT record) must equally not let a half-wired agent flip live.
    // Matches the state-authority rule documented in agent-config-resolver's
    // updateAgentConfig.
    if (
      !targetAgent ||
      getRegistryService().toInternalState(targetAgent.status) !== 'active'
    ) {
      throw new Error('Agent must be active before it can be marked as ready');
    }
  }

  const updatedBinding = { ...bindings[idx] };
  if (input.systemPromptAddition !== undefined) {
    updatedBinding.systemPromptAddition = input.systemPromptAddition;
  }
  if (input.toolRestrictions !== undefined) {
    updatedBinding.toolRestrictions = input.toolRestrictions;
  }
  if (input.modelOverride !== undefined) {
    // Catalog validation on CHANGE only. A new, non-empty override that
    // differs from the currently-stored binding value must reference an
    // enabled catalog model. Unchanged/legacy values and the empty string
    // (which clears the override) are grandfathered — never re-validated.
    if (
      input.modelOverride !== '' &&
      input.modelOverride !== bindings[idx].modelOverride
    ) {
      await assertEnabledCatalogModel(input.modelOverride);
    }
    updatedBinding.modelOverride = input.modelOverride;
  }
  if (input.status !== undefined) {
    updatedBinding.status = input.status;
  }
  const updatedBindings = [...bindings];
  updatedBindings[idx] = updatedBinding;

  const updatedContent = writeManifestMutation(record, (m) => {
    m.agentBindings = updatedBindings;
    m.version = (m.version ?? 1) + 1;
  });

  const updated = await getRegistryService().updateResource('agent', input.appId, {
    customMetadata: updatedContent,
  });

  await emitEvent('app.agent.binding.updated', {
    appId: input.appId,
    agentId: input.agentId,
    userId,
  });

  return projectAgentAppNormalized(updated);
}

// Exported for reuse by intake-orchestration-resolver (via
// ensureAppAgentBindings) — the canonical agent-binding core. Export-only
// refactor: behaviour is identical for the AppSync mutation path.
export async function addAppComponent(
  appId: string,
  component: { type: string; data: string },
  userId: string,
): Promise<unknown> {
  const record = await getRegistryService().getResource('agent', appId);
  if (!record) {
    throw new Error('App not found');
  }

  const data =
    typeof component.data === 'string' ? JSON.parse(component.data) : component.data;
  const now = new Date().toISOString();

  const manifest = readManifest(record);
  let componentId: string;
  let mutatedContent: string;

  switch (component.type.toLowerCase()) {
    case 'agent': {
      // Creation-path catalog validation: a non-empty modelOverride supplied
      // at bind time must reference an enabled catalog model before we
      // persist. Absent/empty override → no validation (grandfathered; mirrors
      // updateAgentBinding).
      if (typeof data.modelOverride === 'string' && data.modelOverride !== '') {
        await assertEnabledCatalogModel(data.modelOverride);
      }
      componentId = data.agentId;
      const existing = manifest.agentBindings || [];
      const filtered = existing.filter((b) => b.agentId !== data.agentId);
      const binding = {
        agentId: data.agentId,
        status: 'DESIGN',
        addedAt: now,
        ...(data.systemPromptAddition !== undefined && {
          systemPromptAddition: data.systemPromptAddition,
        }),
        ...(data.toolRestrictions !== undefined && {
          toolRestrictions: data.toolRestrictions,
        }),
        ...(data.modelOverride !== undefined && { modelOverride: data.modelOverride }),
      };
      mutatedContent = writeManifestMutation(record, (m) => {
        m.agentBindings = [...filtered, binding];
        m.version = (m.version ?? 1) + 1;
      });
      break;
    }
    case 'permission': {
      const validation = validatePermissionActions(data.actions || []);
      if (!validation.valid) {
        throw new Error(
          `Permission validation failed: ${validation.errors.join('; ')}`,
        );
      }
      componentId = data.permissionId;
      const existing = manifest.permissions || [];
      const filtered = existing.filter(
        (p) => p.permissionId !== data.permissionId,
      );
      const permission = {
        permissionId: data.permissionId,
        actions: data.actions,
        resources: data.resources,
        ...(data.description !== undefined && { description: data.description }),
      };
      mutatedContent = writeManifestMutation(record, (m) => {
        m.permissions = [...filtered, permission];
        m.version = (m.version ?? 1) + 1;
      });
      break;
    }
    default:
      throw new Error(`Unsupported component type: ${component.type}`);
  }

  const updated = await getRegistryService().updateResource('agent', appId, {
    customMetadata: mutatedContent,
  });

  await emitEvent('app.component.added', {
    appId,
    componentType: component.type,
    componentId,
    userId,
  });

  return projectAgentAppNormalized(updated);
}

/** Itemized outcome of `ensureAppAgentBindings` (partial success by design). */
export interface EnsureBindingsResult {
  /** Agents newly bound (or promoted from a stray DESIGN binding) to READY. */
  bound: string[];
  /** Agents that already had a READY binding — untouched. */
  alreadyBound: string[];
  /** Per-agent failures; the rest of the batch is unaffected. */
  failed: { agentId: string; error: string }[];
  /**
   * The app projection returned by the LAST successful core call (the same
   * shape the binding mutations return), or null when nothing was written.
   * Lets callers return a bindings-inclusive payload without an extra read.
   */
  finalApp: unknown | null;
}

/** Bounded retry for transient registry write conflicts (record UPDATING). */
const BINDING_CONFLICT_MAX_ATTEMPTS = 3;
const BINDING_CONFLICT_RETRY_DELAY_MS = 250;

function isRegistryConflict(err: unknown): boolean {
  const name = err instanceof Error ? err.name : '';
  const message = err instanceof Error ? err.message : String(err);
  return name === 'ConflictException' || /conflict|updating/i.test(message);
}

async function withConflictRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= BINDING_CONFLICT_MAX_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!isRegistryConflict(err) || attempt === BINDING_CONFLICT_MAX_ATTEMPTS) {
        throw err;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, BINDING_CONFLICT_RETRY_DELAY_MS * attempt),
      );
    }
  }
  throw lastError;
}

/**
 * Ensures every agent in `agentIds` is bound to the app at READY status,
 * reusing the canonical binding cores (`addAppComponent` for the bind,
 * `updateAgentBinding` for the READY promotion) — no binding invariant is
 * re-implemented here.
 *
 * Exported for the intake post-fabrication resolver, whose apps are created
 * with empty `agentBindings` and would otherwise fail the UI's
 * "All agents are READY" publish precondition with nothing to evaluate.
 *
 * Semantics:
 *  - idempotent: agents with an existing READY binding are skipped untouched
 *    (no duplicate, no reset of `addedAt`/config fields);
 *  - convergent: an existing DESIGN binding is promoted to READY without
 *    being re-added (heals a previous partial failure);
 *  - partial success: a per-agent failure (e.g. the READY activation gate)
 *    is itemized in `failed` and never aborts the rest or throws;
 *  - transient registry write conflicts are retried with a small bounded
 *    budget (the registry briefly holds records in UPDATING between the
 *    sequential per-agent writes).
 *
 * Throws only when the app record itself does not exist.
 */
export async function ensureAppAgentBindings(
  appId: string,
  agentIds: string[],
  userId: string,
): Promise<EnsureBindingsResult> {
  const result: EnsureBindingsResult = {
    bound: [],
    alreadyBound: [],
    failed: [],
    finalApp: null,
  };
  const uniqueIds = [...new Set(agentIds)];
  if (uniqueIds.length === 0) {
    return result;
  }

  const record = await getRegistryService().getResource('agent', appId);
  if (!record) {
    throw new Error('App not found');
  }
  const existingBindings = readManifest(record).agentBindings || [];
  const statusByAgentId = new Map(
    existingBindings.map((b) => [b.agentId, b.status]),
  );

  for (const agentId of uniqueIds) {
    const existingStatus = statusByAgentId.get(agentId);
    if (existingStatus === 'READY') {
      result.alreadyBound.push(agentId);
      continue;
    }
    try {
      if (existingStatus === undefined) {
        // Not bound yet — canonical bind (lands at DESIGN)…
        result.finalApp = await withConflictRetry(() =>
          addAppComponent(
            appId,
            { type: 'agent', data: JSON.stringify({ agentId }) },
            userId,
          ),
        );
      }
      // …then canonical promotion to READY (activation-gated). An existing
      // DESIGN binding takes only this step, preserving its fields.
      result.finalApp = await withConflictRetry(() =>
        updateAgentBinding({ appId, agentId, status: 'READY' }, userId),
      );
      result.bound.push(agentId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('ensureAppAgentBindings: bind failed', { appId, agentId, error: message });
      result.failed.push({ agentId, error: message });
    }
  }

  return result;
}

async function removeAppComponent(
  appId: string,
  componentType: string,
  componentId: string,
  userId: string,
): Promise<unknown> {
  const record = await getRegistryService().getResource('agent', appId);
  if (!record) {
    throw new Error('App not found');
  }

  const mutatedContent = writeManifestMutation(record, (m) => {
    switch (componentType) {
      case 'agent':
        m.agentBindings = (m.agentBindings || []).filter(
          (b) => b.agentId !== componentId,
        );
        break;
      case 'permission':
        m.permissions = (m.permissions || []).filter(
          (p) => p.permissionId !== componentId,
        );
        break;
      default:
        throw new Error(`Unsupported component type: ${componentType}`);
    }
    m.version = (m.version ?? 1) + 1;
  });

  const updated = await getRegistryService().updateResource('agent', appId, {
    customMetadata: mutatedContent,
  });

  await emitEvent('app.component.removed', {
    appId,
    componentType,
    componentId,
    userId,
  });

  return projectAgentAppNormalized(updated);
}

async function setAppConfigSchema(
  appId: string,
  schemaInput: string | object,
  version: number,
  userId: string,
): Promise<unknown> {
  const record = await getRegistryService().getResource('agent', appId);
  if (!record) {
    throw new Error('App not found');
  }
  const manifest = readManifest(record);
  if ((manifest.version ?? 1) !== version) {
    throw new Error('Conflict: app was modified concurrently. Please retry.');
  }

  const schema =
    typeof schemaInput === 'string' ? JSON.parse(schemaInput) : schemaInput;
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    throw new Error('Invalid JSON Schema: schema must be a JSON object');
  }
  // ajv 8 compat for user-supplied schemas: strictSchema is relaxed because
  // config schemas are authored by API callers and may carry benign unknown
  // keywords (silently ignored by ajv 6, which this endpoint accepted and
  // stored). addFormats restores the `format` validation built into ajv 6.
  const ajv = new Ajv({ strictSchema: false });
  addFormats(ajv);
  const isValid = ajv.validateSchema(schema);
  if (!isValid) {
    const errors =
      ajv.errors?.map((e) => e.message).join('; ') || 'unknown validation error';
    throw new Error(`Invalid JSON Schema: ${errors}`);
  }

  const mutatedContent = writeManifestMutation(record, (m) => {
    m.configSchema = schema;
    m.version = version + 1;
  });

  const updated = await getRegistryService().updateResource('agent', appId, {
    customMetadata: mutatedContent,
  });

  await emitEvent('app.config.schema.set', { appId, userId });

  return projectAgentAppNormalized(updated);
}

async function setAppConfigValues(
  appId: string,
  valuesInput: string | object,
  version: number,
  userId: string,
): Promise<unknown> {
  const record = await getRegistryService().getResource('agent', appId);
  if (!record) {
    throw new Error('App not found');
  }
  const manifest = readManifest(record);
  if ((manifest.version ?? 1) !== version) {
    throw new Error('Conflict: app was modified concurrently. Please retry.');
  }

  const values =
    typeof valuesInput === 'string' ? JSON.parse(valuesInput) : valuesInput;

  if (manifest.configSchema) {
    // ajv 8 compat: stored schemas were accepted under ajv 6, which ignored
    // unknown keywords and validated `format` built-in. strictSchema: false +
    // addFormats preserves that behavior so previously stored schemas keep
    // compiling instead of throwing at this call site.
    const ajv = new Ajv({ allErrors: true, strictSchema: false });
    addFormats(ajv);
    const validate = ajv.compile(manifest.configSchema);
    const valid = validate(values);
    if (!valid) {
      const errors = (validate.errors || [])
        .map((e) => {
          const path =
            e.instancePath ||
            ((e.params as { missingProperty?: string }).missingProperty ?? '');
          return `${path ? path + ': ' : ''}${e.message}`;
        })
        .join('; ');
      throw new Error(`Config validation failed: ${errors}`);
    }
  }

  const mutatedContent = writeManifestMutation(record, (m) => {
    m.configValues = values;
    m.version = version + 1;
  });

  const updated = await getRegistryService().updateResource('agent', appId, {
    customMetadata: mutatedContent,
  });

  await emitEvent('app.config.values.set', { appId, userId });

  return projectAgentAppNormalized(updated);
}

async function setAppAuthConfig(
  appId: string,
  authConfigInput: string | object,
  userId: string,
): Promise<unknown> {
  const record = await getRegistryService().getResource('agent', appId);
  if (!record) {
    throw new Error('App not found');
  }

  const authConfig =
    typeof authConfigInput === 'string'
      ? JSON.parse(authConfigInput)
      : authConfigInput;

  const mutatedContent = writeManifestMutation(record, (m) => {
    m.authConfig = authConfig;
    m.version = (m.version ?? 1) + 1;
  });

  const updated = await getRegistryService().updateResource('agent', appId, {
    customMetadata: mutatedContent,
  });

  await emitEvent('app.auth.config.set', { appId, userId });

  return projectAgentAppNormalized(updated);
}

async function grantAppAccess(
  appId: string,
  targetUserId: string,
  role: string,
  grantingUserId: string,
): Promise<unknown> {
  const record = await getRegistryService().getResource('agent', appId);
  if (!record) {
    throw new Error('App not found');
  }

  const now = new Date().toISOString();
  const mutatedContent = writeManifestMutation(record, (m) => {
    const access = m.access || {};
    access[targetUserId] = {
      role,
      grantedAt: now,
      grantedBy: grantingUserId,
    };
    m.access = access;
    m.version = (m.version ?? 1) + 1;
  });

  const updated = await getRegistryService().updateResource('agent', appId, {
    customMetadata: mutatedContent,
  });

  await emitEvent('app.access.granted', {
    appId,
    userId: targetUserId,
    role,
    grantedBy: grantingUserId,
  });

  return projectAgentAppNormalized(updated);
}

async function revokeAppAccess(
  appId: string,
  targetUserId: string,
  revokingUserId: string,
): Promise<unknown> {
  const record = await getRegistryService().getResource('agent', appId);
  if (!record) {
    throw new Error('App not found');
  }

  const mutatedContent = writeManifestMutation(record, (m) => {
    const access = m.access || {};
    delete access[targetUserId];
    m.access = access;
    m.version = (m.version ?? 1) + 1;
  });

  const updated = await getRegistryService().updateResource('agent', appId, {
    customMetadata: mutatedContent,
  });

  await emitEvent('app.access.revoked', {
    appId,
    userId: targetUserId,
    revokedBy: revokingUserId,
  });

  return projectAgentAppNormalized(updated);
}

// ===========================================================================
// Non-AgentApp handlers — preserved DDB / EventBridge paths
// ===========================================================================

async function listAppApiKeys(appId: string): Promise<unknown> {
  return listAppApiKeysImpl(appId, getSharedDeps());
}

async function listAppAccessEntries(appId: string): Promise<unknown> {
  return listAppAccessEntriesImpl(appId, getSharedDeps());
}

async function getAppMetrics(
  appId: string,
  startTime: string,
  endTime: string,
): Promise<unknown> {
  return getAppMetricsImpl(appId, startTime, endTime, getSharedDeps());
}

async function publishAppStatusEvent(input: {
  appId: string;
  previousStatus: string;
  newStatus: string;
  timestamp: string;
}): Promise<unknown> {
  // IAM-authed passthrough: emit a structured event to the shared bus and
  // echo the payload so AppSync subscriptions receive a deterministic shape.
  // No registry interaction — matches the "existing EventBridge put preserved"
  // rule in the PR 3 contract.
  await emitEvent('app.status.published', input);
  return {
    appId: input.appId,
    previousStatus: input.previousStatus,
    newStatus: input.newStatus,
    timestamp: input.timestamp,
  };
}

async function createAppApiKey(
  appId: string,
  name: string,
  expiresIn: number | undefined,
  userId: string,
): Promise<unknown> {
  const result = await createAppApiKeyImpl(appId, name, userId, getSharedDeps(), expiresIn);
  // Shape to the AppApiKeyWithPlaintext GraphQL type — plaintext is returned
  // exactly once here at creation and is never persisted in retrievable form.
  return {
    keyId: result.keyId,
    name: result.name,
    prefix: result.prefix,
    status: result.status,
    createdAt: result.createdAt,
    expiresAt: result.expiresAt ?? null,
    lastUsedAt: null,
    apiKey: result.plaintext,
  };
}

async function revokeAppApiKey(
  appId: string,
  keyId: string,
  userId: string,
): Promise<unknown> {
  return revokeAppApiKeyImpl(appId, keyId, userId, getSharedDeps());
}

async function rotateAppApiKey(
  appId: string,
  keyId: string,
  userId: string,
): Promise<unknown> {
  const result = await rotateAppApiKeyImpl(appId, keyId, userId, getSharedDeps());
  // Shape to AppApiKeyWithPlaintext — flatten result.newKey to the top level
  // and drop revokedKeyId. Plaintext is returned exactly once on rotation.
  return {
    keyId: result.newKey.keyId,
    name: result.newKey.name,
    prefix: result.newKey.prefix,
    status: result.newKey.status,
    createdAt: result.newKey.createdAt,
    expiresAt: null,
    lastUsedAt: null,
    apiKey: result.newKey.plaintext,
  };
}
// force-redeploy: appid-fix-v4
