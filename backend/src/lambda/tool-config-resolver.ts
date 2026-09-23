import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  ScanCommand,
  DeleteCommand,
} from "@aws-sdk/lib-dynamodb";
import { getOperations } from "../utils/operations-registry";
import {
  RegistryService,
  RegistryRecordStatusValues,
  type ToolCustomMetadata,
  type ListResourcesOptions,
} from "../services/registry-service";
import {
  extractOrgFromEvent,
  isAdminFromEvent,
  assertRowOrg,
  canCallerSeeRow,
} from "../utils/auth-event";

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);

const TOOLS_CONFIG_TABLE = process.env.TOOLS_CONFIG_TABLE!;

// ---------------------------------------------------------------------------
// Feature flag + Registry Service initialization (task 7.1)
// ---------------------------------------------------------------------------

/**
 * Returns true when the Registry feature flag is enabled.
 * Defaults to false if the environment variable is missing or unreadable.
 */
export function isRegistryEnabled(): boolean {
  try {
    return process.env.REGISTRY_ENABLED === "true";
  } catch {
    return false;
  }
}

/** Lazily-initialised RegistryService singleton (created on first use). */
let registryServiceInstance: RegistryService | null = null;

/**
 * Returns the shared RegistryService instance, creating it on first call.
 * Only call this when `isRegistryEnabled()` is true — the function reads
 * REGISTRY_ID from the environment and will throw if it is missing.
 */
export function getRegistryService(): RegistryService {
  if (!registryServiceInstance) {
    const registryId = process.env.REGISTRY_ID;
    if (!registryId) {
      throw new Error(
        "REGISTRY_ID environment variable is required when REGISTRY_ENABLED is true",
      );
    }
    registryServiceInstance = new RegistryService({
      registryId,
      region: process.env.AWS_REGION || "us-east-1",
    });
  }
  return registryServiceInstance;
}

/**
 * Resets the cached RegistryService instance.
 * Exposed for testing so that tests can clear state between runs.
 * @internal
 */
export function _resetRegistryService(): void {
  registryServiceInstance = null;
}

/**
 * Minimal slice of the Lambda Context this resolver consumes. The runtime
 * always invokes `handler(event, context)`; declaring the parameter keeps
 * unit-test invocations (which omit it) compiling while letting the list
 * path thread the remaining-time budget into the Registry N+1 fetch.
 */
export interface LambdaContextLike {
  getRemainingTimeInMillis?: () => number;
}

/**
 * Builds listResources options carrying the Lambda remaining-time budget so
 * a large registry returns a partial list instead of timing out (live
 * incident: 340 records × sequential GETs > 30s).
 */
function budgetOptionsFrom(
  context?: LambdaContextLike,
): ListResourcesOptions | undefined {
  const getRemainingTimeInMillis = context?.getRemainingTimeInMillis;
  if (typeof getRemainingTimeInMillis !== "function") return undefined;
  return { getRemainingTimeMs: () => getRemainingTimeInMillis.call(context) };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BindingDirection = "INPUT" | "OUTPUT" | "BIDIRECTIONAL";

export interface IntegrationBinding {
  integrationId: string;
  integrationType: string;
  operations?: string[];
  direction?: BindingDirection;
}

export interface DataStoreBinding {
  dataStoreId: string;
  dataStoreType: string;
  operations?: string[];
  direction?: BindingDirection;
}

/**
 * Raw binding shapes as accepted from GraphQL input or read back from
 * legacy DynamoDB rows. Required fields and direction casing are enforced
 * at runtime by the validators/sanitizers below, so everything is optional
 * and `direction` is a plain string here.
 */
interface RawIntegrationBinding {
  integrationId?: string;
  integrationType?: string;
  operations?: string[];
  direction?: string;
}

interface RawDataStoreBinding {
  dataStoreId?: string;
  dataStoreType?: string;
  operations?: string[];
  direction?: string;
}

/** Merged create/update mutation input (config required only on create). */
interface ToolConfigMutationInput {
  toolId: string;
  config?: string | Record<string, unknown>;
  state?: string;
  categories?: string[];
  icon?: string;
  appId?: string;
  integrationBindings?: RawIntegrationBinding[];
  dataStoreBindings?: RawDataStoreBinding[];
}

/** Minimal slice of the AppSync event needed for org/admin extraction. */
type OrgScopedEvent = { identity?: Record<string, unknown> };

/** AppSync event shape as dispatched to this resolver's handler. */
interface ToolConfigResolverEvent extends OrgScopedEvent {
  info: { fieldName: string };
  arguments: Record<string, unknown>;
}

interface ToolConfig {
  toolId: string;
  orgId: string;
  config: string | Record<string, unknown>;
  state: "active" | "inactive" | "maintenance" | "pending" | string;
  categories?: string[];
  integrationBindings?: RawIntegrationBinding[] | null;
  dataStoreBindings?: RawDataStoreBinding[] | null;
  createdAt?: string;
  updatedAt?: string;
}

// ---------------------------------------------------------------------------
// Binding validation
// ---------------------------------------------------------------------------

export function validateIntegrationBindings(
  bindings: RawIntegrationBinding[],
): void {
  for (const binding of bindings) {
    if (!binding.integrationId || typeof binding.integrationId !== "string") {
      throw new Error(
        'Validation error: integrationBinding missing required field "integrationId"',
      );
    }
    if (
      !binding.integrationType ||
      typeof binding.integrationType !== "string"
    ) {
      throw new Error(
        'Validation error: integrationBinding missing required field "integrationType"',
      );
    }
  }
}

export function validateDataStoreBindings(
  bindings: RawDataStoreBinding[],
): void {
  for (const binding of bindings) {
    if (!binding.dataStoreId || typeof binding.dataStoreId !== "string") {
      throw new Error(
        'Validation error: dataStoreBinding missing required field "dataStoreId"',
      );
    }
    if (!binding.dataStoreType || typeof binding.dataStoreType !== "string") {
      throw new Error(
        'Validation error: dataStoreBinding missing required field "dataStoreType"',
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Read-time binding sanitization
// ---------------------------------------------------------------------------

/**
 * Sanitises a list of bindings for GraphQL responses. Drops entries whose
 * required string fields are null/undefined/empty (which would otherwise
 * trip the "Cannot return null for non-nullable type 'String'" AppSync
 * error) and normalises `direction` to its uppercase form.
 *
 * Validators on the write paths prevent invalid bindings going forward, but
 * legacy rows that pre-date validation can still hold corrupt data. This
 * function is the read-time defence.
 *
 * Returns `null` if the input is falsy or no bindings survive the filter.
 */
export function sanitizeIntegrationBindings(
  bindings: unknown,
): IntegrationBinding[] | null {
  if (!Array.isArray(bindings) || bindings.length === 0) return null;
  const cleaned = bindings
    .filter(
      (b) =>
        b &&
        typeof b.integrationId === "string" &&
        b.integrationId.length > 0 &&
        typeof b.integrationType === "string" &&
        b.integrationType.length > 0,
    )
    .map((b) => ({
      ...b,
      direction: b.direction
        ? String(b.direction).toUpperCase()
        : "BIDIRECTIONAL",
    }));
  return cleaned.length > 0 ? cleaned : null;
}

export function sanitizeDataStoreBindings(
  bindings: unknown,
): DataStoreBinding[] | null {
  if (!Array.isArray(bindings) || bindings.length === 0) return null;
  const cleaned = bindings
    .filter(
      (b) =>
        b &&
        typeof b.dataStoreId === "string" &&
        b.dataStoreId.length > 0 &&
        typeof b.dataStoreType === "string" &&
        b.dataStoreType.length > 0,
    )
    .map((b) => ({
      ...b,
      direction: b.direction
        ? String(b.direction).toUpperCase()
        : "BIDIRECTIONAL",
    }));
  return cleaned.length > 0 ? cleaned : null;
}

// ---------------------------------------------------------------------------
// Handler (task 7.5)
// ---------------------------------------------------------------------------

export const handler = async (
  event: ToolConfigResolverEvent,
  context?: LambdaContextLike,
) => {
  console.log("Event:", JSON.stringify(event, null, 2));

  const fieldName = event.info.fieldName;

  // Extract the AppSync caller's user id from the event identity. AppSync
  // `event.identity` shape varies by auth mode (Cognito sets `sub`, IAM sets
  // `username`, API key leaves it undefined). Mirror the fabricator pattern
  // (fabricator-request-resolver.ts) so we stay consistent across resolvers.
  const requestedBy = ((event.identity &&
    ("sub" in event.identity ? event.identity.sub : undefined)) ||
    (event.identity &&
      ("username" in event.identity ? event.identity.username : undefined)) ||
    "unknown") as string;

  try {
    const registryEnabled = isRegistryEnabled();

    switch (fieldName) {
      case "listToolConfigs":
        return registryEnabled
          ? await listToolConfigsRegistry(event, context)
          : await listToolConfigs(event);

      case "getToolConfig":
        return registryEnabled
          ? await getToolConfigRegistry(event.arguments.toolId as string, event)
          : await getToolConfig(event.arguments.toolId as string, event);

      case "createToolConfig":
        return registryEnabled
          ? await createToolConfigRegistry(
              event.arguments.input as ToolConfigMutationInput,
              requestedBy,
              event,
            )
          : await createToolConfig(
              event.arguments.input as ToolConfigMutationInput,
              event,
            );

      case "updateToolConfig":
        return registryEnabled
          ? await updateToolConfigRegistry(
              event.arguments.input as ToolConfigMutationInput,
              requestedBy,
              event,
            )
          : await updateToolConfig(
              event.arguments.input as ToolConfigMutationInput,
              event,
            );

      case "deleteToolConfig":
        return registryEnabled
          ? await deleteToolConfigRegistry(
              event.arguments.toolId as string,
              event,
            )
          : await deleteToolConfig(event.arguments.toolId as string, event);

      case "listIntegrationOperations":
        return getOperations(event.arguments.integrationType as string);

      case "searchToolConfigs":
        return await searchToolConfigs(event.arguments.query as string, event);

      default:
        throw new Error(`Unknown field: ${fieldName}`);
    }
  } catch (error) {
    console.error("Error:", error);
    throw error;
  }
};

// ---------------------------------------------------------------------------
// Registry-backed implementations (tasks 7.2–7.4, 7.6)
// ---------------------------------------------------------------------------

/**
 * Dual-source list: fetches tool configs from both Registry and DynamoDB,
 * merges them with Registry records taking precedence on duplicate toolIds.
 *
 * Results are filtered to the caller's organization unless the caller has
 * `custom:role=admin`, in which case the full list (across all orgs) is
 * returned. A non-admin caller without an orgId receives an empty list
 * with a warning.
 */
export async function listToolConfigsRegistry(
  event?: OrgScopedEvent,
  context?: LambdaContextLike,
): Promise<ToolConfig[]> {
  const callerOrgId =
    event !== undefined ? await extractOrgFromEvent(event) : null;
  const admin = event !== undefined ? isAdminFromEvent(event) : false;

  if (!admin && !callerOrgId) {
    console.warn(
      "listToolConfigsRegistry: no caller orgId and not admin; returning empty list",
    );
    return [];
  }

  const registryService = getRegistryService();
  const budgetOptions = budgetOptionsFrom(context);
  const registryRecords = budgetOptions
    ? await registryService.listResources("tool", budgetOptions)
    : await registryService.listResources("tool");
  const allRegistryConfigs = registryRecords.map((record) =>
    registryService.mapToToolConfig(record),
  );
  const registryConfigs = admin
    ? allRegistryConfigs
    : allRegistryConfigs.filter((t) => t.orgId === callerOrgId);

  const allDynamoConfigs = await listToolConfigs();
  const dynamoConfigs = admin
    ? allDynamoConfigs
    : allDynamoConfigs.filter((t) => t.orgId === callerOrgId);

  // Registry wins on duplicates. Post-420d0ae, registryConfigs[].toolId is a
  // 12-char recordId while dynamoConfigs[].toolId is still the legacy name.
  // Dedupe by the `name` field inside the config payload — the stable human
  // identifier shared by both representations. Guard against unparseable/
  // missing names.
  const extractName = (c: ToolConfig): string | undefined => {
    if (!c.config) return undefined;
    try {
      const parsed =
        typeof c.config === "string" ? JSON.parse(c.config) : c.config;
      const name = parsed?.name;
      return typeof name === "string" && name.length > 0 ? name : undefined;
    } catch {
      return undefined;
    }
  };
  const registryNames = new Set(
    registryConfigs
      .map(extractName)
      .filter((n): n is string => typeof n === "string" && n.length > 0),
  );
  const legacyOnly = dynamoConfigs.filter((c) => {
    const n = extractName(c);
    return !n || !registryNames.has(n);
  });

  return [...registryConfigs, ...legacyOnly];
}

/**
 * Registry-first get: checks Registry for the tool, falls back to DynamoDB
 * if not found. Returns null when neither source has the record.
 *
 * Cross-org access is reported as not-found (404-style, not 403) so we
 * don't leak existence across tenants. Admins bypass the org check.
 *
 * Fail-closed (finding ce470ab0): a record with NO orgId in its metadata is
 * now ALSO treated as not-found for non-admins, not just a mismatched one.
 * The previous `mapped.orgId && mapped.orgId !== callerOrgId` guard was
 * false whenever `mapped.orgId` was falsy (absent/empty), so an org-less
 * record — legacy data, or a record whose customMetadata never got an
 * orgId — was handed to every authenticated non-admin caller regardless of
 * their own org.
 */
export async function getToolConfigRegistry(
  toolId: string,
  event?: OrgScopedEvent,
): Promise<ToolConfig | null> {
  const registryService = getRegistryService();
  const callerOrgId =
    event !== undefined ? await extractOrgFromEvent(event) : null;
  const admin = event !== undefined ? isAdminFromEvent(event) : false;

  const record = await registryService.getResource("tool", toolId);
  if (record) {
    const mapped = registryService.mapToToolConfig(record);
    if (!admin && (!mapped.orgId || mapped.orgId !== callerOrgId)) {
      return null;
    }
    return mapped;
  }
  // Fallback to DynamoDB for legacy records
  const legacy = await getToolConfig(toolId);
  if (!legacy) return null;
  if (!admin && (!legacy.orgId || legacy.orgId !== callerOrgId)) {
    return null;
  }
  return legacy;
}

/**
 * Registry-backed create: validates bindings, serializes custom metadata,
 * and creates a Registry resource. Returns the mapped ToolConfig.
 *
 * `userId` is forwarded from the AppSync handler and stored as `createdBy`
 * inside customMetadata so we retain caller attribution on the Registry
 * record. Defaults to `'unknown'` so other callers (e.g. internal scripts)
 * still work unchanged.
 */
export async function createToolConfigRegistry(
  input: ToolConfigMutationInput,
  userId: string = "unknown",
  event?: OrgScopedEvent,
): Promise<ToolConfig> {
  // Validate bindings before Registry write
  if (input.integrationBindings && Array.isArray(input.integrationBindings)) {
    validateIntegrationBindings(input.integrationBindings);
  }
  if (input.dataStoreBindings && Array.isArray(input.dataStoreBindings)) {
    validateDataStoreBindings(input.dataStoreBindings);
  }

  const registryService = getRegistryService();

  const orgId = await extractOrgFromEvent(event);
  if (!orgId) {
    throw new Error("Cannot determine caller organization");
  }

  const config =
    typeof input.config === "string"
      ? input.config
      : JSON.stringify(input.config);
  const parsedConfig =
    typeof input.config === "string" ? JSON.parse(input.config) : input.config;

  const customMetadata = registryService.serializeCustomMetadata({
    categories: input.categories || [],
    icon: input.icon || "",
    state: input.state || "active",
    integrationBindings: input.integrationBindings || undefined,
    dataStoreBindings: input.dataStoreBindings || undefined,
    appId: input.appId || undefined,
    config,
    createdBy: userId,
    orgId,
  } as ToolCustomMetadata);

  const record = await registryService.createResource("tool", input.toolId, {
    name: parsedConfig.name || input.toolId,
    description: parsedConfig.description ?? "", // plain human-readable (was full JSON)
    customMetadata,
  });

  // If an initial state is provided, update the status accordingly. A newly
  // created record always starts DRAFT; requesting 'inactive' here throws
  // (via toRegistryStatus, decision 3d5843e9/finding 462c17ad) — a
  // just-created record cannot be "deactivated". The only non-activation
  // initial state that reaches the registry is 'maintenance' (deprecate
  // intent -> DEPRECATED).
  if (input.state) {
    const registryStatus = registryService.toRegistryStatus(input.state);
    // DRAFT -> APPROVED is rejected by the registry directly; the sanctioned
    // path for activation is SubmitRegistryRecordForApproval (finding
    // adde5b79).
    if (registryStatus === RegistryRecordStatusValues.APPROVED) {
      await registryService.submitForApproval(input.toolId);
    } else {
      await registryService.updateResourceStatus(
        "tool",
        input.toolId,
        registryStatus,
      );
    }
    // Re-fetch so the returned state reflects the post-transition record
    // rather than the stale DRAFT snapshot from createResource above. Matches
    // the fix in agent-config-resolver (0715f73).
    const refreshed = await registryService.getResource("tool", input.toolId);
    return registryService.mapToToolConfig(refreshed ?? record);
  }

  return registryService.mapToToolConfig(record);
}

/**
 * Registry-backed update: validates bindings, updates the Registry resource
 * with new metadata. If state is being changed, also updates the Registry
 * status via toRegistryStatus. Returns the mapped ToolConfig.
 *
 * `userId` is forwarded from the AppSync handler. Legacy records without a
 * prior `createdBy` get the current caller's id on first edit; existing
 * values are preserved so we never clobber a known creator.
 */
export async function updateToolConfigRegistry(
  input: ToolConfigMutationInput,
  userId: string = "unknown",
  event?: OrgScopedEvent,
): Promise<ToolConfig> {
  // Validate bindings before Registry write
  if (input.integrationBindings && Array.isArray(input.integrationBindings)) {
    validateIntegrationBindings(input.integrationBindings);
  }
  if (input.dataStoreBindings && Array.isArray(input.dataStoreBindings)) {
    validateDataStoreBindings(input.dataStoreBindings);
  }

  const registryService = getRegistryService();

  // Fetch existing record to merge with
  const existing = await registryService.getResource("tool", input.toolId);
  if (!existing) {
    throw new Error(`Tool config not found: ${input.toolId}`);
  }

  // Decision 3d5843e9 (supersedes a3fb5542; finding 462c17ad): the AWS
  // registry rejects DRAFT as an UpdateRegistryRecordStatus target, so the
  // Catalog Deactivate action ('inactive') can no longer be honoured for a
  // registry-backed record. Fail with a structured, actionable error BEFORE
  // any registry call. The deprecate intent is expressed via
  // `state: "maintenance"` — the one ToolState enum value not already
  // claimed by active/inactive and not sent by any current frontend write
  // path — and is routed through the same validated REGISTRY_TRANSITIONS
  // gate used for every other transition.
  if (input.state === "inactive") {
    throw new Error(
      "ValidationError: Deactivation is not supported for registry records; use Deprecate (irreversible)",
    );
  }

  const existingMeta = registryService.deserializeCustomMetadata<{
    categories: string[];
    icon: string;
    state: string;
    integrationBindings?: IntegrationBinding[];
    dataStoreBindings?: DataStoreBinding[];
    appId?: string;
    config?: string;
    createdBy?: string;
    orgId?: string;
  }>(existing.customDescriptorContent ?? null, {
    categories: [],
    icon: "",
    state: "active",
    integrationBindings: undefined,
    dataStoreBindings: undefined,
    appId: undefined,
    config: undefined,
    createdBy: undefined,
    orgId: undefined,
  });

  // Org scoping (finding 13065e38): reconcile the record's orgId against
  // the caller BEFORE any Registry write. Mirrors datastore-resolver.ts's
  // updateDataStore gate (finding ca76d041) — fetch-then-verify via the
  // shared assertRowOrg helper, admin bypass included, fail closed on a
  // missing/unresolvable org on either side.
  await assertRowOrg({ orgId: existingMeta.orgId }, event);

  // Preserve existing orgId; fall back to caller for legacy records.
  // Never derive orgId from input — that field is backend-owned.
  const preservedOrgId =
    existingMeta.orgId ??
    (event !== undefined
      ? ((await extractOrgFromEvent(event)) ?? undefined)
      : undefined);

  // Merge config. Source of truth for the "existing" config is
  // customMetadata.config (new contract), with a fallback to
  // existing.description for legacy records written before this change.
  const existingConfig = existingMeta.config ?? existing.description ?? "";
  const newConfig = input.config
    ? typeof input.config === "string"
      ? input.config
      : JSON.stringify(input.config)
    : existingConfig;

  // Defensive parse: legacy records may carry free-text in description
  // rather than JSON. State-only toggles must not crash on malformed data.
  let parsedNewConfig: Record<string, unknown> = {};
  if (newConfig && typeof newConfig === "string") {
    try {
      parsedNewConfig = JSON.parse(newConfig);
    } catch {
      parsedNewConfig = {};
    }
  } else if (newConfig && typeof newConfig === "object") {
    parsedNewConfig = newConfig;
  }

  // Merge bindings — only overwrite if provided in input
  const integrationBindings =
    input.integrationBindings !== undefined
      ? input.integrationBindings
      : existingMeta.integrationBindings;
  const dataStoreBindings =
    input.dataStoreBindings !== undefined
      ? input.dataStoreBindings
      : existingMeta.dataStoreBindings;

  // Merge custom metadata
  const updatedMeta = registryService.serializeCustomMetadata({
    categories:
      input.categories !== undefined
        ? input.categories
        : existingMeta.categories,
    icon: input.icon !== undefined ? input.icon : existingMeta.icon,
    state: input.state || existingMeta.state,
    integrationBindings: integrationBindings || undefined,
    dataStoreBindings: dataStoreBindings || undefined,
    appId: input.appId !== undefined ? input.appId : existingMeta.appId,
    config: newConfig,
    createdBy: existingMeta.createdBy ?? userId,
    orgId: preservedOrgId,
  } as ToolCustomMetadata);

  // If state is being changed, update the Registry status BEFORE writing
  // metadata (finding adde5b79 ordering requirement): if the transition
  // fails, updateResource (metadata) never runs, so a failed activation
  // leaves no partial metadata drift. The condition compares against the
  // actual Registry status — gating on metadata is unreliable because
  // customMetadata.state can drift out of sync with record.status (e.g.
  // when deserializeCustomMetadata falls back to its 'active' default for
  // records missing the field). The user-facing state is derived from
  // record.status via toInternalState, so that's what must change for the
  // toggle to actually take effect.
  const desiredRegistryStatus = input.state
    ? registryService.toRegistryStatus(input.state)
    : undefined;
  if (
    input.state &&
    desiredRegistryStatus &&
    desiredRegistryStatus !== existing.status
  ) {
    // Activation (-> APPROVED) must go through SubmitRegistryRecordForApproval,
    // never a direct UpdateRegistryRecordStatus(APPROVED) — the AWS registry
    // rejects DRAFT -> APPROVED (finding adde5b79). Decision 3d5843e9
    // (finding 462c17ad): the REJECTED -> DRAFT resubmit step added in #182
    // is removed — UpdateRegistryRecordStatus rejects DRAFT as a target
    // outright, so that step always failed at the registry call. Fail
    // closed with a structured error instead. Every other transition (e.g.
    // -> DEPRECATED) is unaffected.
    if (desiredRegistryStatus === RegistryRecordStatusValues.APPROVED) {
      if (existing.status === RegistryRecordStatusValues.REJECTED) {
        throw new Error(
          "ValidationError: Rejected records cannot be resubmitted; create a new record",
        );
      }
      await registryService.submitForApproval(input.toolId);
    } else {
      // Route through the validated-transition gate: pass existing.status as
      // currentStatus so registry-service.updateResourceStatus enforces
      // REGISTRY_TRANSITIONS (decision 3d5843e9) instead of silently
      // coercing an unvalidated transition. The only non-APPROVED target
      // reachable here is DEPRECATED (deprecate intent, state:"maintenance"
      // — see toRegistryStatus); 'inactive' is rejected above before this
      // block is ever reached.
      await registryService.updateResourceStatus(
        "tool",
        input.toolId,
        desiredRegistryStatus,
        undefined,
        existing.status,
      );
    }

    const record = await registryService.updateResource("tool", input.toolId, {
      name: (parsedNewConfig.name as string | undefined) || existing.name,
      description: (parsedNewConfig.description as string | undefined) ?? "",
      customMetadata: updatedMeta,
    });
    // Re-fetch so the returned state reflects the post-transition record
    // rather than the stale snapshot from updateResource above. Matches the
    // fix in agent-config-resolver (0715f73).
    const refreshed = await registryService.getResource("tool", input.toolId);
    return registryService.mapToToolConfig(refreshed ?? record);
  }

  const record = await registryService.updateResource("tool", input.toolId, {
    name: (parsedNewConfig.name as string | undefined) || existing.name,
    description: (parsedNewConfig.description as string | undefined) ?? "",
    customMetadata: updatedMeta,
  });

  return registryService.mapToToolConfig(record);
}

/**
 * Registry-backed delete: deletes the resource from the Registry.
 * Returns success/failure object matching the existing shape.
 */
export async function deleteToolConfigRegistry(
  toolId: string,
  event?: OrgScopedEvent,
): Promise<{ success: boolean; message?: string }> {
  const registryService = getRegistryService();

  // Org scoping (finding 13065e38): fetch-then-verify BEFORE the Registry
  // delete. A missing record still fails closed via assertRowOrg (no orgId
  // to reconcile against), rather than silently no-op'ing past the check.
  const existing = await registryService.getResource("tool", toolId);
  const existingMeta = existing
    ? registryService.deserializeCustomMetadata<{ orgId?: string }>(
        existing.customDescriptorContent ?? null,
        { orgId: undefined },
      )
    : { orgId: undefined };
  await assertRowOrg({ orgId: existingMeta.orgId }, event);

  try {
    await registryService.deleteResource("tool", toolId);
    return {
      success: true,
      message: `Tool config ${toolId} deleted successfully`,
    };
  } catch (error) {
    console.error("Error deleting tool config from Registry:", error);
    return {
      success: false,
      message: `Failed to delete tool config: ${error}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Search handlers (task 7.6)
// ---------------------------------------------------------------------------

/**
 * Searches for tool configs via Registry semantic search, then filters to
 * the server-derived caller org (finding ce470ab0) exactly like
 * `listToolConfigsRegistry`: admins see every match; non-admins are
 * filtered to rows whose `orgId` equals their own, fail closed (empty
 * result) when their own org cannot be resolved. Previously this returned
 * every match across every tenant to any authenticated caller — the
 * dispatch-gate-enumeration guard's EXEMPT_OPS entry documenting that as
 * "out of scope" is removed in the same change.
 */
async function searchToolConfigs(
  query: string,
  event?: OrgScopedEvent,
): Promise<ToolConfig[]> {
  const registryService = getRegistryService();
  const records = await registryService.searchResources("tool", query);
  const mapped = records.map((record) =>
    registryService.mapToToolConfig(record),
  );

  if (event === undefined) return mapped;

  if (isAdminFromEvent(event)) return mapped;

  const callerOrgId = await extractOrgFromEvent(event);
  if (!callerOrgId) return [];

  return mapped.filter((t) => t.orgId && t.orgId === callerOrgId);
}

// ---------------------------------------------------------------------------
// DynamoDB-backed implementations (existing / legacy)
// ---------------------------------------------------------------------------

/**
 * Legacy DynamoDB-backed list, org-filtered exactly like the Registry path
 * (finding ce470ab0): admins see every row; non-admins see only rows whose
 * `orgId` matches their server-derived org, and fail closed (empty list) if
 * their own org cannot be resolved. Rows without an `orgId` are excluded
 * from a non-admin's results — legacy blank orgId is not a wildcard.
 *
 * `event` is optional so the Registry path (`listToolConfigsRegistry`,
 * which already computed and applied its own org filter to the merged
 * result) can keep reusing this as an unfiltered raw-rows fetch by omitting
 * it; every REGISTRY_ENABLED!='true' caller through the dispatch switch
 * always supplies `event`.
 */
async function listToolConfigs(event?: OrgScopedEvent): Promise<ToolConfig[]> {
  const result = await docClient.send(
    new ScanCommand({
      TableName: TOOLS_CONFIG_TABLE,
    }),
  );

  const items = (result.Items || []).map((item) => ({
    toolId: item.toolId,
    orgId: item.orgId || "",
    // AWSJSON type expects a JSON string, so ensure it's stringified
    config:
      typeof item.config === "string"
        ? item.config
        : JSON.stringify(item.config),
    state: item.state || "active",
    categories: item.categories || [],
    integrationBindings: sanitizeIntegrationBindings(item.integrationBindings),
    dataStoreBindings: sanitizeDataStoreBindings(item.dataStoreBindings),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  }));

  if (event === undefined) return items;

  const admin = isAdminFromEvent(event);
  if (admin) return items;

  const callerOrgId = await extractOrgFromEvent(event);
  if (!callerOrgId) return [];

  return items.filter((item) => item.orgId && item.orgId === callerOrgId);
}

/**
 * Legacy DynamoDB-backed single-record get, org-reconciled exactly like
 * `getToolConfigRegistry`'s DynamoDB fallback (finding ce470ab0): a
 * cross-org or org-less row is reported as not-found (null, 404-style, not
 * a thrown 403) so a caller cannot use this read to distinguish "wrong
 * org" from "doesn't exist". Admins bypass the check.
 *
 * `event` is optional: `getToolConfigRegistry`'s own DynamoDB-fallback call
 * site does its OWN reconciliation against the mapped legacy row (so it
 * calls this without `event` to get the raw row first) — every
 * REGISTRY_ENABLED!='true' caller through the dispatch switch supplies it.
 */
async function getToolConfig(
  toolId: string,
  event?: OrgScopedEvent,
): Promise<ToolConfig | null> {
  const result = await docClient.send(
    new GetCommand({
      TableName: TOOLS_CONFIG_TABLE,
      Key: { toolId },
    }),
  );

  if (!result.Item) {
    return null;
  }

  const item: ToolConfig = {
    toolId: result.Item.toolId,
    orgId: result.Item.orgId || "",
    // AWSJSON type expects a JSON string, so ensure it's stringified
    config:
      typeof result.Item.config === "string"
        ? result.Item.config
        : JSON.stringify(result.Item.config),
    state: result.Item.state || "active",
    categories: result.Item.categories || [],
    integrationBindings: sanitizeIntegrationBindings(
      result.Item.integrationBindings,
    ),
    dataStoreBindings: sanitizeDataStoreBindings(result.Item.dataStoreBindings),
    createdAt: result.Item.createdAt,
    updatedAt: result.Item.updatedAt,
  };

  if (event === undefined) return item;

  if (!(await canCallerSeeRow(item, event))) {
    return null;
  }

  return item;
}

async function createToolConfig(
  input: ToolConfigMutationInput,
  event?: OrgScopedEvent,
): Promise<ToolConfig> {
  const now = new Date().toISOString();
  const config =
    typeof input.config === "string" ? JSON.parse(input.config) : input.config;

  // Validate bindings before persistence
  if (input.integrationBindings && Array.isArray(input.integrationBindings)) {
    validateIntegrationBindings(input.integrationBindings);
  }
  if (input.dataStoreBindings && Array.isArray(input.dataStoreBindings)) {
    validateDataStoreBindings(input.dataStoreBindings);
  }

  // Org scoping (finding 13065e38): ToolConfigMutationInput carries no
  // client-supplied orgId field at all, so there is no client value to
  // reject — but leaving this hardcoded to "" (as before) permanently
  // orphans every legacy-created row from the assertRowOrg gate now
  // guarding updateToolConfig/deleteToolConfig (a row with no orgId always
  // fails closed). Derive orgId server-side from the caller, exactly like
  // createToolConfigRegistry already does, so newly-created legacy rows
  // remain updatable/deletable by their owning org.
  const orgId = event !== undefined ? await extractOrgFromEvent(event) : null;

  const toolConfig: ToolConfig = {
    toolId: input.toolId,
    orgId: orgId ?? "",
    config,
    state: input.state || "active",
    categories: input.categories || [],
    createdAt: now,
    updatedAt: now,
  };

  if (
    input.integrationBindings &&
    Array.isArray(input.integrationBindings) &&
    input.integrationBindings.length > 0
  ) {
    toolConfig.integrationBindings = input.integrationBindings.map((b) => ({
      ...b,
      direction: b.direction ? b.direction.toUpperCase() : "BIDIRECTIONAL",
    }));
  }
  if (
    input.dataStoreBindings &&
    Array.isArray(input.dataStoreBindings) &&
    input.dataStoreBindings.length > 0
  ) {
    toolConfig.dataStoreBindings = input.dataStoreBindings.map((b) => ({
      ...b,
      direction: b.direction ? b.direction.toUpperCase() : "BIDIRECTIONAL",
    }));
  }

  await docClient.send(
    new PutCommand({
      TableName: TOOLS_CONFIG_TABLE,
      Item: toolConfig,
    }),
  );

  return {
    ...toolConfig,
    config: JSON.stringify(config),
    integrationBindings: toolConfig.integrationBindings || null,
    dataStoreBindings: toolConfig.dataStoreBindings || null,
  };
}

async function updateToolConfig(
  input: ToolConfigMutationInput,
  event?: OrgScopedEvent,
): Promise<ToolConfig> {
  const existing = await getToolConfig(input.toolId);
  if (!existing) {
    throw new Error(`Tool config not found: ${input.toolId}`);
  }

  // Org scoping (finding 13065e38): reconcile the row's orgId against the
  // caller BEFORE any write. Mirrors datastore-resolver.ts's updateDataStore
  // gate (finding ca76d041) — fetch-then-verify, admin bypass, fail closed
  // on a missing/unresolvable org on either side.
  await assertRowOrg(existing, event);

  // Validate bindings before persistence
  if (input.integrationBindings && Array.isArray(input.integrationBindings)) {
    validateIntegrationBindings(input.integrationBindings);
  }
  if (input.dataStoreBindings && Array.isArray(input.dataStoreBindings)) {
    validateDataStoreBindings(input.dataStoreBindings);
  }

  const now = new Date().toISOString();
  // Defensive: legacy DynamoDB rows may have non-JSON `config` strings.
  const existingConfig = (() => {
    if (typeof existing.config !== "string") return existing.config ?? {};
    try {
      return JSON.parse(existing.config);
    } catch {
      return {};
    }
  })();
  const newConfig = input.config
    ? typeof input.config === "string"
      ? (() => {
          try {
            return JSON.parse(input.config);
          } catch {
            return {};
          }
        })()
      : input.config
    : existingConfig;

  // Merge bindings independently — only overwrite if provided in input
  const integrationBindings =
    input.integrationBindings !== undefined
      ? input.integrationBindings
      : existing.integrationBindings;
  const dataStoreBindings =
    input.dataStoreBindings !== undefined
      ? input.dataStoreBindings
      : existing.dataStoreBindings;

  const updatedItem: ToolConfig = {
    toolId: input.toolId,
    orgId: existing.orgId || "",
    config: newConfig,
    state: input.state || existing.state,
    categories:
      input.categories !== undefined ? input.categories : existing.categories,
    createdAt: existing.createdAt,
    updatedAt: now,
  };

  if (
    integrationBindings &&
    Array.isArray(integrationBindings) &&
    integrationBindings.length > 0
  ) {
    updatedItem.integrationBindings = integrationBindings;
  }
  if (
    dataStoreBindings &&
    Array.isArray(dataStoreBindings) &&
    dataStoreBindings.length > 0
  ) {
    updatedItem.dataStoreBindings = dataStoreBindings;
  }

  await docClient.send(
    new PutCommand({
      TableName: TOOLS_CONFIG_TABLE,
      Item: updatedItem,
    }),
  );

  return {
    ...updatedItem,
    config: JSON.stringify(newConfig),
    integrationBindings: updatedItem.integrationBindings || null,
    dataStoreBindings: updatedItem.dataStoreBindings || null,
  };
}

async function deleteToolConfig(
  toolId: string,
  event?: OrgScopedEvent,
): Promise<{ success: boolean; message?: string }> {
  // Org scoping (finding 13065e38): fetch-then-verify BEFORE the delete.
  // A missing row fails closed via assertRowOrg (no orgId to reconcile).
  const existing = await getToolConfig(toolId);
  await assertRowOrg(existing, event);

  try {
    await docClient.send(
      new DeleteCommand({
        TableName: TOOLS_CONFIG_TABLE,
        Key: { toolId },
      }),
    );

    return {
      success: true,
      message: `Tool config ${toolId} deleted successfully`,
    };
  } catch (error) {
    console.error("Error deleting tool config:", error);
    return {
      success: false,
      message: `Failed to delete tool config: ${error}`,
    };
  }
}
