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
  QueryCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { v4 as uuidv4 } from 'uuid';
import Ajv from 'ajv';
import { getUserId } from '../utils/appsync';
import { isAdminFromEvent } from '../utils/auth-event';
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
  name: string;
  description?: string;
  status?: string;
  version?: number;
  createdAt?: string;
  updatedAt?: string;
  sourceProjectId?: string;
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
  const metadata: AgentCustomMetadata & { sourceProjectId?: string } = {
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
const EVENT_BUS_NAME = process.env.EVENT_BUS_NAME!;
const DEFAULT_REGION = process.env.AWS_REGION || 'us-east-1';

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

interface AgentAppManifest {
  orgId?: string;
  version?: number;
  status?: string;
  createdBy?: string;
  workflowIds?: string[];
  agentBindings?: any[];
  permissions?: any[];
  configSchema?: any;
  configValues?: any;
  authConfig?: any;
  access?: Record<string, { role: string; grantedAt: string; grantedBy: string }>;
  routingConfig?: any;
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
function projectAgentApp(record: RegistryRecord): any {
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
function projectAgentAppNormalized(record: RegistryRecord): any {
  const projected = projectAgentApp(record);
  projected.appId = record.recordId;
  return projected;
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

export const handler: AppSyncResolverHandler<any, unknown> = async (event) => {
  console.log('Registry agent record resolver event:', JSON.stringify(event, null, 2));

  const { info, arguments: args, identity } = event;
  const fieldName = info.fieldName;
  const userId = getUserId(identity);

  try {
    switch (fieldName) {
      // AgentApp-shape queries (registry-backed)
      case 'getApp':
        return await getApp(args.appId, userId);
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

async function getApp(appId: string, _userId: string): Promise<unknown> {
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

  // Always return the 12-char recordId as appId (not the UUID from customDescriptorContent).
  projected.appId = appId;

  return projected;
}

async function listApps(
  orgId: string,
  _userId: string,
  event: any,
): Promise<{ items: unknown[]; nextToken: string | null }> {
  const isAllOrgsRequest = !orgId || orgId === 'All Organizations';
  if (isAllOrgsRequest && !isAdminFromEvent(event)) {
    throw new Error('Only admins may list apps across all organizations');
  }

  // Phase 3: read from the AppsTable.OrgIndex GSI rather than scanning the
  // Registry. The GSI carries a complete projection so no Registry call is
  // needed for the list view. The Registry remains the source of truth; the
  // reconciler (Step 4) catches drift between the two.
  if (isAllOrgsRequest) {
    return await scanAllAppsViaMeta();
  }
  return await queryAppsViaOrgIndex(orgId);
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
  let nextToken: any = undefined;
  do {
    const result = await getDocClient().send(
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
    if (result.Items) items.push(...result.Items.map(metaRowToAppShape));
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
  let nextToken: any = undefined;
  do {
    const result = await getDocClient().send(
      new ScanCommand({
        TableName: APPS_TABLE,
        FilterExpression: 'sortId = :meta',
        ExpressionAttributeValues: { ':meta': APP_META_SORT_VALUE },
        ExclusiveStartKey: nextToken,
      }),
    );
    if (result.Items) items.push(...result.Items.map(metaRowToAppShape));
    nextToken = result.LastEvaluatedKey;
  } while (nextToken);
  return { items, nextToken: null };
}

/**
 * Projects a single AppsTable `#META` row onto the AgentApp-shape response
 * used by listApps. Field defaults match the Registry-backed projection so
 * callers see no behavioural difference between the two read paths.
 */
function metaRowToAppShape(row: Record<string, unknown>): Record<string, unknown> {
  return {
    appId: row.appId,
    orgId: row.orgId ?? '',
    name: row.name ?? '',
    description: row.description ?? '',
    status: row.status ?? 'DRAFT',
    workflowIds: row.workflowIds ?? [],
    routingConfig: row.routingConfig ?? '',
    createdBy: row.createdBy ?? '',
    createdAt: row.createdAt ?? '',
    updatedAt: row.updatedAt ?? '',
    version: typeof row.version === 'number' ? row.version : 1,
  };
}

async function createApp(input: any, userId: string): Promise<unknown> {
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
    name: agentAppInput.name,
    description: agentAppInput.description,
    status: 'DRAFT',
    workflowIds: [],
    routingConfig: undefined,
    createdBy: userId,
    createdAt: now,
    updatedAt: now,
    version: 1,
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

async function updateApp(input: any, userId: string): Promise<unknown> {
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
  const metaPartial: Record<string, any> = {
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

async function updateAgentBinding(
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
  const idx = bindings.findIndex((b: any) => b.agentId === input.agentId);
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
    const targetManifest = parseDescriptor(targetAgent);
    if (!targetAgent || targetManifest.state !== 'active') {
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

async function addAppComponent(
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
      const filtered = existing.filter((b: any) => b.agentId !== data.agentId);
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
        (p: any) => p.permissionId !== data.permissionId,
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
          (b: any) => b.agentId !== componentId,
        );
        break;
      case 'permission':
        m.permissions = (m.permissions || []).filter(
          (p: any) => p.permissionId !== componentId,
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
  const ajv = new Ajv();
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
    const ajv = new Ajv({ allErrors: true });
    const validate = ajv.compile(manifest.configSchema);
    const valid = validate(values);
    if (!valid) {
      const errors = (validate.errors || [])
        .map((e: any) => {
          const path =
            e.instancePath ||
            (e.params?.missingProperty ? e.params.missingProperty : '');
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
