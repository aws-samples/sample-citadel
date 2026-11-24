import { AppSyncResolverEvent } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  UpdateCommand,
  DeleteCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  SecretsManagerClient,
  CreateSecretCommand,
  GetSecretValueCommand,
  DeleteSecretCommand,
} from "@aws-sdk/client-secrets-manager";
import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "./adapters/registry";
import { AuthenticationMethod, type ConnectorAdapter } from "../adapters/base";
import { PolicyManager, type ScopedCredentials } from "../utils/policy-manager";
import type { RoleTagInput } from "../utils/policy-manager";
import { getDataStoreOperations } from "../utils/operations-registry";
import {
  extractOrgFromEvent,
  isAdminFromEvent,
  assertRowOrg,
} from "../utils/auth-event";
import {
  ConflictError,
  PermissionError,
  ResourceNotFoundError,
  ValidationError,
} from "./adapters/errors";
import {
  assertCrossAccountRole,
  assertSameAccountArn,
  ArnRejectedError,
  emitArnRefused,
} from "../utils/arn-safety";
import { computeTrustPath } from "../utils/trust-path";
import { SECRET_FIELD_KEYS } from "../utils/secret-field-keys";

// --- Clients ---

const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const secretsManager = new SecretsManagerClient({});
const policyManager = new PolicyManager();

const DATASTORES_TABLE = process.env.DATASTORES_TABLE!;
const HEALTH_MONITOR_ROLE_PARAM = process.env.HEALTH_MONITOR_ROLE_PARAM || "";

// Lazy-loaded health monitor role ARN from SSM
let _healthMonitorRoleArn: string | null = null;
async function getAdditionalTrustedPrincipals(): Promise<string[]> {
  if (!HEALTH_MONITOR_ROLE_PARAM) return [];
  if (_healthMonitorRoleArn !== null)
    return _healthMonitorRoleArn ? [_healthMonitorRoleArn] : [];
  try {
    const { SSMClient, GetParameterCommand } =
      await import("@aws-sdk/client-ssm");
    const ssm = new SSMClient({});
    const result = await ssm.send(
      new GetParameterCommand({ Name: HEALTH_MONITOR_ROLE_PARAM }),
    );
    _healthMonitorRoleArn = result.Parameter?.Value || "";
  } catch {
    _healthMonitorRoleArn = "";
  }
  return _healthMonitorRoleArn ? [_healthMonitorRoleArn] : [];
}

// --- Types ---

interface AppSyncEventIdentity {
  username?: string;
  sub?: string;
}

/** Create-mutation input (validated at runtime; config/credentials AWSJSON). */
interface CreateDataStoreInput {
  orgId: string;
  name: string;
  type: string;
  category: string;
  provisionMode: string;
  description?: string;
  config: string | Record<string, unknown>;
  credentials?: string | Record<string, unknown>;
  usage?: string;
  clientRequestToken?: string;
}

/** Update-mutation input; only provided fields are written. */
interface UpdateDataStoreInput {
  dataStoreId: string;
  version: number;
  name?: string;
  description?: string;
  config?: string | Record<string, unknown>;
  usage?: string;
}

/** Merged view of every argument this resolver's fields receive. */
interface DataStoreResolverArguments {
  orgId: string;
  category?: string;
  dataStoreId: string;
  usage?: string;
  input: CreateDataStoreInput & UpdateDataStoreInput;
}

/** DynamoDB data-store row slice this resolver reads. */
interface DataStoreRecord {
  dataStoreId: string;
  type: string;
  config: string | Record<string, unknown>;
  version: number;
  provisionMode?: string;
  secretArn?: string;
  status?: string;
  usage?: string;
  orgId?: string;
  [key: string]: unknown;
}

interface AppSyncEvent extends Omit<
  AppSyncResolverEvent<DataStoreResolverArguments>,
  "identity"
> {
  identity?: AppSyncEventIdentity;
}

// --- Secret-field utilities ---

/**
 * Deep-redact any key that appears in SECRET_FIELD_KEYS (or is exactly
 * "credentials") anywhere in a nested payload, including JSON-encoded
 * string values. Used for sanitising log output.
 */
export function deepRedactSecrets(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === "string") {
    try {
      const parsed: unknown = JSON.parse(obj);
      if (typeof parsed === "object" && parsed !== null) {
        return JSON.stringify(deepRedactSecrets(parsed));
      }
    } catch {
      /* not JSON — return as-is */
    }
    return obj;
  }
  if (Array.isArray(obj)) return obj.map(deepRedactSecrets);
  if (typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      const redactedValue =
        SECRET_FIELD_KEYS.has(key) || key === "credentials"
          ? "[REDACTED]"
          : deepRedactSecrets(value);
      Object.defineProperty(result, key, {
        value: redactedValue,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return result;
  }
  return obj;
}

/**
 * Boundary rule: reject any SECRET_FIELD_KEYS found inside a config object.
 * Throws a clear ValidationError directing the caller to use the credentials
 * bag instead.
 */
function rejectSecretsInConfig(
  config: Record<string, unknown>,
  context: string,
): void {
  const leaked = Object.keys(config).filter((k) => SECRET_FIELD_KEYS.has(k));
  if (leaked.length > 0) {
    throw new ValidationError(
      `Secret-like fields must be submitted in 'credentials', not 'config' ` +
        `(${context}): ${leaked.join(", ")}. ` +
        `Update your client to route these fields into the credentials bag.`,
    );
  }
}

// --- Handler ---

/**
 * Fail-closed resolution of the org a read-path query should be scoped to
 * (finding f0ce2b00, high). Mirrors the `requireCallerOrg` pattern in
 * user-management-resolver.ts, adapted for an explicit client-supplied
 * `orgId` argument rather than a row lookup:
 *
 *   - Admin (explicit `isAdminFromEvent` check): use the supplied argument
 *     as-is — admins may still query any org on request.
 *   - Non-admin: use ONLY the caller's own server-derived org
 *     (extractOrgFromEvent); the argument is never consulted.
 *   - Unresolved effective org (non-admin with no resolvable
 *     `custom:organization` claim — reachable, since adminCreateUser never
 *     sets that attribute, finding cbbc3be1): DENY via PermissionError.
 *
 * The prior shape (`callerOrgId || event.arguments.orgId`) coerced an
 * unresolvable caller org into the client-supplied argument instead of
 * denying — inverting the trust direction. Never reintroduce that `||`
 * fallback; see the `no-caller-org-fallback-idiom` guard test.
 *
 * The denial message intentionally does not confirm or deny whether the
 * requested org exists.
 */
async function requireEffectiveOrgId(event: AppSyncEvent): Promise<string> {
  if (isAdminFromEvent(event)) {
    return event.arguments.orgId;
  }
  const callerOrgId = await extractOrgFromEvent(event);
  if (!callerOrgId) {
    throw new PermissionError(
      "Access denied: no organization is provisioned for your account. Contact an administrator.",
    );
  }
  return callerOrgId;
}

export async function handler(event: AppSyncEvent) {
  const sanitizedEvent = deepRedactSecrets(event);
  console.log(
    "DataStore resolver event:",
    JSON.stringify(sanitizedEvent, null, 2),
  );

  const { fieldName } = event.info;

  try {
    switch (fieldName) {
      case "listDataStores": {
        // Org scoping (finding f0ce2b00, high): fail closed, mirroring
        // requireCallerOrg in user-management-resolver.ts. An admin uses the
        // supplied argument explicitly; a non-admin uses ONLY their own
        // resolved org; an unresolved effective org is a hard denial — it
        // must never fall through to the client-supplied orgId argument
        // (the prior `callerOrgId || event.arguments.orgId` coercion did
        // exactly that, handing a caller with no org claim any tenant's
        // rows on request).
        const effectiveOrgId = await requireEffectiveOrgId(event);
        return await listDataStores(effectiveOrgId, event.arguments.category);
      }
      case "getDataStore":
        return await getDataStoreGuarded(event.arguments.dataStoreId, event);
      case "getDataStoreStats": {
        // Org scoping (finding f0ce2b00, high): same fail-closed gate as
        // listDataStores above.
        const effectiveOrgId = await requireEffectiveOrgId(event);
        return await getDataStoreStats(effectiveOrgId);
      }
      case "createDataStore":
        return await createDataStore(
          event.arguments.input,
          event.identity?.username || "system",
          event,
        );
      case "updateDataStore":
        return await updateDataStore(event.arguments.input, event);
      case "deleteDataStore":
        return await deleteDataStore(event.arguments.dataStoreId, event);
      case "connectDataStore":
        return await connectDataStore(event.arguments.dataStoreId, event);
      case "disconnectDataStore":
        return await disconnectDataStore(event.arguments.dataStoreId, event);
      case "testDataStoreConnection":
        return await testDataStoreConnection(
          event.arguments.dataStoreId,
          event,
        );
      case "listAvailableDataSources": {
        // Org scoping (finding f0ce2b00, high): same fail-closed gate as
        // listDataStores/getDataStoreStats above.
        const effectiveOrgId = await requireEffectiveOrgId(event);
        return await listAvailableDataSources(
          effectiveOrgId,
          event.arguments.usage,
        );
      }
      default:
        throw new Error(`Unknown field: ${fieldName}`);
    }
  } catch (error: unknown) {
    console.error("DataStore resolver error:", error);
    throw error;
  }
}

// --- Helpers ---

async function persistErrorState(
  dataStoreId: string,
  _error: unknown,
): Promise<void> {
  try {
    // Clean up the failed entry so stale records don't accumulate in the UI
    await dynamodb.send(
      new DeleteCommand({
        TableName: DATASTORES_TABLE,
        Key: { dataStoreId },
      }),
    );
  } catch (persistError) {
    console.error("Failed to clean up failed data store entry:", persistError);
  }
}

/**
 * CIT-298: emit a CloudWatch EMF metric when a vended IAM role is rolled
 * back after a failed connect or provision.
 */
function emitRoleRolledBack(): void {
  try {
    console.log(
      JSON.stringify({
        _aws: {
          Timestamp: Date.now(),
          CloudWatchMetrics: [
            {
              Namespace: "Citadel/Adapters",
              Dimensions: [["Scope"]],
              Metrics: [{ Name: "RoleRolledBack", Unit: "Count" }],
            },
          ],
        },
        Scope: "datastore",
        RoleRolledBack: 1,
      }),
    );
  } catch {
    // metrics must never break the caller
  }
}

async function retryOptimisticLock<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  baseDelayMs = 100,
): Promise<T> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: unknown) {
      if (
        (error instanceof Error &&
          error.name === "ConditionalCheckFailedException") ||
        error instanceof ConflictError
      ) {
        lastError = error;
        if (attempt < maxRetries) {
          const delay = baseDelayMs * Math.pow(2, attempt);
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
      }
      throw error;
    }
  }
  throw new ConflictError(
    "Version conflict: data store was modified concurrently",
    lastError,
  );
}

/**
 * Error names AWS SDK v3 clients use for an IAM AccessDenied rejection.
 * Any other error name/shape is NOT retried — it propagates immediately.
 */
const ACCESS_DENIED_ERROR_NAMES = new Set([
  "AccessDenied",
  "AccessDeniedException",
]);

function isAccessDeniedError(error: unknown): boolean {
  return error instanceof Error && ACCESS_DENIED_ERROR_NAMES.has(error.name);
}

/**
 * Bounded retry for the FIRST scoped call made with a freshly assumed IAM
 * role (connect or getMetrics in createDataStore). Replaces a fixed 10s
 * sleep after `PolicyManager.ensureRole`: IAM is eventually consistent, so
 * the inline policy may not have propagated yet, producing an AccessDenied
 * on the very first scoped call. Retries ONLY on AccessDenied/
 * AccessDeniedException, up to `maxAttempts` total attempts, with the given
 * backoff schedule (ms) between attempts. Any other error is rethrown
 * immediately without retrying. Total worst-case wait (2+4+6+8 = 20s) stays
 * well inside the 10-minute resolver timeout (backend-stack.ts
 * DataStoreResolverFunction).
 */
async function retryFirstScopedCallOnAccessDenied<T>(
  fn: () => Promise<T>,
  options: { maxAttempts?: number; backoffMs?: number[] } = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 5;
  const backoffMs = options.backoffMs ?? [2000, 4000, 6000, 8000];

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (!isAccessDeniedError(error)) {
        throw error;
      }
      lastError = error;
      if (attempt < maxAttempts) {
        const delay = backoffMs[attempt - 1] ?? backoffMs[backoffMs.length - 1];
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  throw lastError;
}

/**
 * H4: dispatch credentials for an adapter call. Replaces the
 * `scopedCredentials || credentials` idiom, which fell back to the
 * CALLER-SUPPLIED `credentials` (parsed from `input.credentials`, an
 * attacker-controlled GraphQL argument) whenever no scoped role was
 * vended for that adapter — exactly the KnowledgeBaseAdapter's
 * CREATE_NEW connect path before this fix, since its provision policies
 * were empty (CIT-299) so `scopedCredentials` stayed `undefined`.
 *
 * All AWS datastore adapters use IAM_ROLE authentication: for those,
 * ONLY the platform-vended scoped credentials are ever dispatched —
 * caller-supplied `credentials` can never reach an IAM_ROLE adapter's
 * data-plane call. Non-AWS (external/SaaS) adapters keep their existing
 * caller-credential model, since they have no scoped-role concept.
 */
function dispatchCreds(
  adapter: ConnectorAdapter,
  scopedCredentials: ScopedCredentials | undefined,
  credentials: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (adapter.spec.authentication.method === AuthenticationMethod.IAM_ROLE) {
    return scopedCredentials;
  }
  return scopedCredentials ?? credentials;
}

// --- Queries ---

async function listDataStores(orgId: string, category?: string) {
  const params: {
    TableName: string;
    IndexName: string;
    KeyConditionExpression: string;
    ExpressionAttributeValues: Record<string, string>;
    ScanIndexForward: boolean;
    FilterExpression?: string;
  } = {
    TableName: DATASTORES_TABLE,
    IndexName: "OrgIndex",
    KeyConditionExpression: "orgId = :orgId",
    ExpressionAttributeValues: { ":orgId": orgId },
    ScanIndexForward: false,
  };

  if (category) {
    params.FilterExpression = "category = :category";
    params.ExpressionAttributeValues[":category"] = category;
  }

  const result = await dynamodb.send(new QueryCommand(params));
  // Backward compatibility: default usage to 'both' for legacy items (Req 1.10)
  const items = result.Items || [];
  for (const item of items) {
    item.usage = (item.usage || "both").toUpperCase();
  }
  return items;
}

async function getDataStore(dataStoreId: string): Promise<DataStoreRecord> {
  const result = await dynamodb.send(
    new GetCommand({
      TableName: DATASTORES_TABLE,
      Key: { dataStoreId },
    }),
  );

  if (!result.Item) {
    throw new ResourceNotFoundError(`Data store not found: ${dataStoreId}`);
  }

  // Backward compatibility: default usage to 'both' for legacy items (Req 1.10)
  const item = result.Item;
  item.usage = (item.usage || "both").toUpperCase();

  return item as DataStoreRecord;
}

/**
 * Fetch-then-verify gate for the `getDataStore` GraphQL field itself
 * (finding ca76d041, datastore half; CRE item 2). Unlike the collection
 * reads above (listDataStores/getDataStoreStats/listAvailableDataSources),
 * a single by-ID read has no orgId argument to coerce against — there is
 * nothing to fall back to, so an unresolvable/mismatched caller org is a
 * hard denial via the shared `assertRowOrg` gate, same as every mutation
 * below. Admins bypass (assertRowOrg honours isAdminFromEvent).
 */
async function getDataStoreGuarded(
  dataStoreId: string,
  event: unknown,
): Promise<DataStoreRecord> {
  const item = await getDataStore(dataStoreId);
  await assertRowOrg(item, event);
  return item;
}

async function getDataStoreStats(orgId: string) {
  const result = await dynamodb.send(
    new QueryCommand({
      TableName: DATASTORES_TABLE,
      IndexName: "OrgIndex",
      KeyConditionExpression: "orgId = :orgId",
      ExpressionAttributeValues: { ":orgId": orgId },
    }),
  );

  const items = result.Items || [];
  const byCategory: Record<string, number> = {};
  const byType: Record<string, number> = {};
  let connected = 0;
  let errorCount = 0;

  for (const item of items) {
    byCategory[item.category] = (byCategory[item.category] || 0) + 1;
    byType[item.type] = (byType[item.type] || 0) + 1;
    if (item.status === "CONNECTED") connected++;
    if (item.status === "ERROR") errorCount++;
  }

  return {
    total: items.length,
    connected,
    error: errorCount,
    byCategory: JSON.stringify(byCategory),
    byType: JSON.stringify(byType),
  };
}

async function listAvailableDataSources(orgId: string, usage?: string) {
  // Query all data stores for the org
  const result = await dynamodb.send(
    new QueryCommand({
      TableName: DATASTORES_TABLE,
      IndexName: "OrgIndex",
      KeyConditionExpression: "orgId = :orgId",
      ExpressionAttributeValues: { ":orgId": orgId },
    }),
  );

  const items = result.Items || [];

  // Filter to only CONNECTED stores (Req 3.7)
  let connectedStores = items.filter((item) => item.status === "CONNECTED");

  // Apply usage filter when provided (Req 3.5)
  if (usage) {
    const filterUpper = usage.toUpperCase();
    if (filterUpper !== "BOTH") {
      connectedStores = connectedStores.filter((item) => {
        const storeUsage = (item.usage || "BOTH").toUpperCase();
        return storeUsage === filterUpper || storeUsage === "BOTH";
      });
    }
    // When filter is 'both', return all connected stores (no additional filtering)
  }

  // Get account context for scopedRoleArn computation
  let accountId: string | null = null;
  try {
    const ctx = await policyManager.getAccountContext();
    accountId = ctx.accountId;
  } catch (error) {
    console.warn("Failed to get account context for scopedRoleArn:", error);
  }

  // Enrich each store with capabilities and scopedRoleArn (Req 3.3, 3.4)
  return connectedStores.map((item) => ({
    dataStoreId: item.dataStoreId,
    name: item.name,
    type: item.type,
    category: item.category,
    usage: (item.usage || "BOTH").toUpperCase(),
    status: item.status,
    provider: item.provider,
    capabilities: getDataStoreOperations(item.type),
    scopedRoleArn: accountId
      ? `arn:aws:iam::${accountId}:role/citadel-ds-${item.dataStoreId}`
      : null,
  }));
}

// --- Mutations ---

/**
 * CIT-254 C12: validate `config.crossAccountRoleArn` at mutation time.
 *
 * Same-account ARNs must match the platform account (from STS, not caller).
 * Cross-account ARNs require a non-blank externalId. Non-IAM or malformed
 * ARNs are rejected. Returns `{ externalId }` on success for cross-account,
 * or `undefined` for same-account / absent.
 */
async function validateCrossAccountConfig(
  config: Record<string, unknown>,
  pm: PolicyManager,
): Promise<string | undefined> {
  const crossAccountRoleArn = config.crossAccountRoleArn;
  if (!crossAccountRoleArn || typeof crossAccountRoleArn !== "string") {
    return undefined;
  }

  const { accountId: platformAccountId } = await pm.getAccountContext();
  const externalId =
    typeof config.externalId === "string" ? config.externalId : "";

  try {
    // Try same-account first — must exactly equal platform account
    try {
      assertSameAccountArn(crossAccountRoleArn, {
        platformAccountId,
        allowedServices: ["iam"],
      });
      return undefined; // same-account, no externalId needed
    } catch {
      // Not same-account — must be cross-account role with externalId
      assertCrossAccountRole(crossAccountRoleArn, {
        platformAccountId,
        externalId,
      });
      return externalId;
    }
  } catch (e) {
    if (e instanceof ArnRejectedError) {
      emitArnRefused("datastore-resolver");
    }
    throw new ValidationError("Invalid resource reference");
  }
}

async function createDataStore(
  input: CreateDataStoreInput,
  createdBy: string,
  event: unknown,
) {
  // Org scoping (finding ca76d041, datastore half; CRE item 2; superseded by
  // Wave-3B design item 4): createDataStore now derives the caller's org
  // server-side and uses it for EVERY write, ignoring a client-supplied
  // input.orgId outright rather than comparing against it. The prior
  // reject-not-coerce equality check (decision b5d463f2) closed the
  // privilege-escalation angle (an admin writing an arbitrary orgId) but
  // left a diagnosability/staleness trap: a caller whose cached profile org
  // drifted from their live token org (e.g. right after an
  // AdminUserGlobalSignOut-triggered re-auth) got a confusing
  // "does not match your organization" rejection even though they were
  // never trying to write into another tenant. Making the server the SOLE
  // authority for orgId removes that failure mode without reopening the
  // escalation: input.orgId is still REQUIRED on the wire (no schema
  // change) but its value is now vestigial — accepted, never trusted.
  //
  // Diagnosability: the only remaining fail-closed case is "no org claim
  // resolved for the caller at all" — a genuine provisioning gap, not a
  // security check to bypass.
  const callerOrgId = await extractOrgFromEvent(event);
  if (!callerOrgId) {
    console.warn("createDataStore: no organization claim resolved for caller", {
      createdBy,
    });
    throw new PermissionError(
      "Access denied: no organization is provisioned for your account. Contact an administrator.",
    );
  }

  const dataStoreId = uuidv4();
  const timestamp = new Date().toISOString();

  // CIT-042 PR2: tag-policy enforcement at provisioning time. Datastores are
  // org-scoped with no bound owning agent, and CreateDataStoreInput carries
  // no tags field — skip enforcement with a debug log. When owning-agent
  // binding is added in a future iteration, this block should look up the
  // agent's tags and call enforceTagPolicy.
  console.debug(
    JSON.stringify({
      level: "debug",
      message: "tag-policy-check: skipped_no_owning_agent",
      action: "createDatastore",
      orgId: callerOrgId,
      dataStoreId,
    }),
  );

  // Check for idempotent creation via clientRequestToken
  if (input.clientRequestToken) {
    const existingResult = await dynamodb.send(
      new QueryCommand({
        TableName: DATASTORES_TABLE,
        IndexName: "OrgIndex",
        KeyConditionExpression: "orgId = :orgId",
        FilterExpression: "clientRequestToken = :token",
        ExpressionAttributeValues: {
          ":orgId": callerOrgId,
          ":token": input.clientRequestToken,
        },
      }),
    );

    if (existingResult.Items && existingResult.Items.length > 0) {
      return existingResult.Items[0];
    }
  }

  const adapter = getAdapter(input.type);
  const config =
    typeof input.config === "string" ? JSON.parse(input.config) : input.config;

  // Inject the data store name into config so adapters can use it as the
  // resource name. This bridges the gap between the frontend wizard (which
  // sends a separate `name` field) and adapters (which read from config).
  if (!config.name && input.name) {
    config.name = input.name;
  }

  const credentials = input.credentials
    ? typeof input.credentials === "string"
      ? JSON.parse(input.credentials)
      : input.credentials
    : undefined;

  // Boundary rule: reject secret-like keys in config
  rejectSecretsInConfig(config, "createDataStore");

  // Determine icon and provider from type metadata
  const icon = "Database";
  const provider = input.type.startsWith("EXTERNAL_")
    ? "External"
    : "Amazon Web Services";

  // Validate and default usage field (defense in depth — Req 10.2)
  const VALID_USAGE_VALUES = ["KNOWLEDGE", "OPERATIONAL", "BOTH"];
  const usage = input.usage ? input.usage.toUpperCase() : "BOTH";
  if (!VALID_USAGE_VALUES.includes(usage)) {
    throw new ValidationError(
      `Invalid usage value: ${input.usage}. Allowed values: KNOWLEDGE, OPERATIONAL, BOTH`,
    );
  }

  // Conditional PutItem to prevent duplicate dataStoreId
  const item: Record<string, unknown> = {
    dataStoreId,
    name: input.name,
    description: input.description || null,
    type: input.type,
    category: input.category,
    status: "CREATED",
    icon,
    provider,
    provisionMode: input.provisionMode,
    orgId: callerOrgId,
    createdBy,
    createdAt: timestamp,
    updatedAt: timestamp,
    config: typeof config === "string" ? config : JSON.stringify(config),
    usage,
    version: 1,
    clientRequestToken: input.clientRequestToken || null,
  };

  try {
    await dynamodb.send(
      new PutCommand({
        TableName: DATASTORES_TABLE,
        Item: item,
        ConditionExpression: "attribute_not_exists(dataStoreId)",
      }),
    );
  } catch (error: unknown) {
    if (
      error instanceof Error &&
      error.name === "ConditionalCheckFailedException"
    ) {
      throw new ConflictError(
        `Data store with ID ${dataStoreId} already exists`,
      );
    }
    throw error;
  }

  let roleCreated = false;
  try {
    // Store credentials in Secrets Manager
    let secretArn: string | undefined;
    if (credentials) {
      const secretName = `/citadel/datastores/${callerOrgId}/${input.type.toLowerCase()}-${dataStoreId}`;
      const createSecretResponse = await secretsManager.send(
        new CreateSecretCommand({
          Name: secretName,
          SecretString: JSON.stringify(credentials),
        }),
      );
      secretArn = createSecretResponse.ARN;
    }

    // Inject dataStoreId + orgId BEFORE requiredPolicies/preflight so both
    // the policy derivation and the ownership check see the real ids.
    config.dataStoreId = dataStoreId;
    config.orgId = callerOrgId;

    const { accountId, region } = await policyManager.getAccountContext();

    // C2: preflight ownership check BEFORE creating any IAM role OR
    // provisioning anything, run UNCONDITIONALLY. Uses platform Lambda
    // credentials, not scoped creds.
    if (adapter.preflight) {
      await adapter.preflight(config, {
        dataStoreId,
        orgId: callerOrgId,
        provisionMode: input.provisionMode,
      });
    }

    // Dispatch to adapter
    let resourceArn: string | undefined;
    let size: string | undefined;
    let records: number | undefined;

    if (input.provisionMode === "CREATE_NEW") {
      // Continuum C3 (PR-2): provisioning runs on the PLATFORM path BEFORE
      // any tenant-assumable role exists. Adapters build their own
      // ambient/named platform clients internally for provision/deprovision
      // (DynamoDBAdapter.platformProvisionClient, RdsAdapter.platformProvisionClient,
      // KnowledgeBaseAdapter.platformBedrockProvisionClient) — no scoped
      // credentials are passed here, and none are needed: `ensureRole` for
      // this data store has not run yet, so there is no role to assume.
      //
      // Update status to PROVISIONING
      await dynamodb.send(
        new UpdateCommand({
          TableName: DATASTORES_TABLE,
          Key: { dataStoreId },
          UpdateExpression: "SET #status = :status, updatedAt = :now",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: {
            ":status": "PROVISIONING",
            ":now": new Date().toISOString(),
          },
        }),
      );

      const provisionResult = await adapter.provision!(config, undefined);
      resourceArn = provisionResult.resourceArn;
      size = provisionResult.size;
      records = provisionResult.records;

      // CIT-299: adapters may enrich config during provision (e.g.
      // KnowledgeBaseAdapter adds collectionId). Persist the updated config
      // so subsequent connect operations have the scoping identifiers.
      await dynamodb.send(
        new UpdateCommand({
          TableName: DATASTORES_TABLE,
          Key: { dataStoreId },
          UpdateExpression: "SET config = :config",
          ExpressionAttributeValues: {
            ":config": JSON.stringify(config),
          },
        }),
      );
    }

    // Continuum C3 (PR-2): the tenant-assumable citadel-ds-<id> role is
    // ALWAYS minted from `.connect` — never `.provision`. For CREATE_NEW,
    // provisioning (above) has already resolved concrete resource
    // identifiers into `config`, so `.connect` now reflects the real
    // resource ARN rather than a placeholder. This is the ONLY `ensureRole`
    // call on the create path, and `roleCreated` flips true only here, so
    // a provisioning failure above has no role to roll back.
    const policies = adapter.requiredPolicies(
      config,
      accountId,
      region,
    ).connect;

    let scopedCredentials: ScopedCredentials | undefined;
    if (policies.length > 0) {
      // CIT-254 C12: validate crossAccountRoleArn at write time + trust-path probe
      const crossAccountExternalId = await validateCrossAccountConfig(
        config,
        policyManager,
      );
      const roleTagInput: RoleTagInput = {
        orgId: callerOrgId,
        agentId: dataStoreId,
      };
      await policyManager.ensureRole(
        dataStoreId,
        policies,
        accountId,
        "datastore",
        config.crossAccountRoleArn,
        await getAdditionalTrustedPrincipals(),
        crossAccountExternalId,
        roleTagInput,
      );
      roleCreated = true;
      // Trust-path probe (soft gate — log findings, do not block)
      if (config.crossAccountRoleArn) {
        try {
          const dsRoleArn = `arn:aws:iam::${accountId}:role/citadel-ds-${dataStoreId}`;
          const tp = await computeTrustPath(dsRoleArn, {
            crossAccountRoleArn: config.crossAccountRoleArn as string,
          });
          if (!tp.clean) {
            console.warn("createDataStore: trust-path probe findings", {
              dataStoreId,
              findings: tp.findings,
            });
          }
        } catch (e) {
          console.warn(
            "createDataStore: trust-path probe error (non-fatal)",
            e,
          );
        }
      }
      const creds = await policyManager.assumeScopedRole(
        dataStoreId,
        accountId,
        "datastore",
        config.crossAccountRoleArn,
        crossAccountExternalId,
      );
      scopedCredentials = creds;
    }

    // The first scoped call made with the freshly assumed role may hit
    // AccessDenied while the inline policy propagates — retry it (bounded)
    // instead of sleeping a fixed 10s beforehand. Only the FIRST call is
    // wrapped: whichever of connect/getMetrics runs first for this
    // provisionMode. A non-AccessDenied error is not retried.
    let firstScopedCallDone = false;

    if (input.provisionMode !== "CREATE_NEW") {
      await retryFirstScopedCallOnAccessDenied(() =>
        adapter.connect(
          config,
          dispatchCreds(adapter, scopedCredentials, credentials),
        ),
      );
      firstScopedCallDone = true;
    }

    // Get metrics (use scoped credentials if available). A metrics
    // failure (e.g. AccessDenied listing bucket objects) does not block
    // the connection — the resource itself is reachable — but it MUST be
    // visible on the record via errorMessage instead of a silent warning
    // behind status=CONNECTED, so an operator can tell "connected, no
    // metrics" apart from "connected, metrics unknown because IAM is
    // still wrong".
    let metricsErrorMessage: string | undefined;
    try {
      const metrics = firstScopedCallDone
        ? await adapter.getMetrics!(
            config,
            resourceArn,
            dispatchCreds(adapter, scopedCredentials, credentials),
          )
        : await retryFirstScopedCallOnAccessDenied(() =>
            adapter.getMetrics!(
              config,
              resourceArn,
              dispatchCreds(adapter, scopedCredentials, credentials),
            ),
          );
      size = size || metrics.size;
      records = records ?? metrics.records;
    } catch (metricsError) {
      console.warn("Failed to get metrics (non-fatal):", metricsError);
      metricsErrorMessage =
        metricsError instanceof Error
          ? `Metrics unavailable: ${metricsError.message}`
          : "Metrics unavailable: unknown error";
    }

    // Update final state
    const finalUpdate = await dynamodb.send(
      new UpdateCommand({
        TableName: DATASTORES_TABLE,
        Key: { dataStoreId },
        UpdateExpression: metricsErrorMessage
          ? "SET #status = :status, updatedAt = :now, resourceArn = :arn, secretArn = :secret, #size = :size, records = :records, errorMessage = :errorMessage"
          : "SET #status = :status, updatedAt = :now, resourceArn = :arn, secretArn = :secret, #size = :size, records = :records REMOVE errorMessage",
        ExpressionAttributeNames: {
          "#status": "status",
          "#size": "size",
        },
        ExpressionAttributeValues: {
          ":status": "CONNECTED",
          ":now": new Date().toISOString(),
          ":arn": resourceArn || null,
          ":secret": secretArn || null,
          ":size": size || null,
          ":records": records ?? null,
          ...(metricsErrorMessage
            ? { ":errorMessage": metricsErrorMessage }
            : {}),
        },
        ReturnValues: "ALL_NEW",
      }),
    );

    return finalUpdate.Attributes;
  } catch (error) {
    // CIT-298: roll back the IAM role on failed provision/connect so it doesn't persist
    if (roleCreated) {
      try {
        await policyManager.deleteRole(dataStoreId, "datastore");
        emitRoleRolledBack();
      } catch (rollbackErr) {
        console.error(
          "createDataStore: failed to roll back IAM role (best-effort)",
          { dataStoreId, rollbackErr },
        );
      }
    }
    await persistErrorState(dataStoreId, error);
    throw error;
  }
}

async function updateDataStore(input: UpdateDataStoreInput, event: unknown) {
  const dataStoreId = input.dataStoreId;
  const existing = await getDataStore(dataStoreId);

  // Org scoping (finding ca76d041): reconcile BEFORE the optimistic-lock
  // check or any write — a cross-org caller must never learn version info
  // via a ConflictError side channel either.
  await assertRowOrg(existing, event);

  // Optimistic locking
  if (existing.version !== input.version) {
    throw new ConflictError(
      `Version conflict: expected ${input.version}, found ${existing.version}`,
    );
  }

  const updates: Record<string, unknown> = {
    updatedAt: new Date().toISOString(),
    version: existing.version + 1,
  };

  if (input.name !== undefined) updates.name = input.name;
  if (input.description !== undefined) updates.description = input.description;
  if (input.config !== undefined) {
    // Boundary rule: reject secret-like keys in config on update too
    const parsedConfig =
      typeof input.config === "string"
        ? JSON.parse(input.config)
        : input.config;
    rejectSecretsInConfig(parsedConfig, "updateDataStore");
    updates.config =
      typeof input.config === "string"
        ? input.config
        : JSON.stringify(input.config);
  }
  if (input.usage !== undefined) {
    // Validate usage field (defense in depth — Req 10.2)
    const VALID_USAGE_VALUES = ["KNOWLEDGE", "OPERATIONAL", "BOTH"];
    const usageValue = input.usage.toUpperCase();
    if (!VALID_USAGE_VALUES.includes(usageValue)) {
      throw new ValidationError(
        `Invalid usage value: ${input.usage}. Allowed values: KNOWLEDGE, OPERATIONAL, BOTH`,
      );
    }
    updates.usage = usageValue;
  }

  const setExpressions: string[] = [];
  const exprNames: Record<string, string> = {};
  const exprValues: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(updates)) {
    const nameKey = `#${key}`;
    const valueKey = `:${key}`;
    setExpressions.push(`${nameKey} = ${valueKey}`);
    exprNames[nameKey] = key;
    exprValues[valueKey] = value;
  }

  exprValues[":expectedVersion"] = input.version;

  try {
    const result = await dynamodb.send(
      new UpdateCommand({
        TableName: DATASTORES_TABLE,
        Key: { dataStoreId },
        UpdateExpression: `SET ${setExpressions.join(", ")}`,
        ConditionExpression: "#version = :expectedVersion",
        ExpressionAttributeNames: { ...exprNames, "#version": "version" },
        ExpressionAttributeValues: exprValues,
        ReturnValues: "ALL_NEW",
      }),
    );

    return result.Attributes;
  } catch (error: unknown) {
    if (
      error instanceof Error &&
      error.name === "ConditionalCheckFailedException"
    ) {
      throw new ConflictError(
        "Version conflict: data store was modified concurrently",
      );
    }
    await persistErrorState(dataStoreId, error);
    throw error;
  }
}

async function deleteDataStore(dataStoreId: string, event: unknown) {
  let existing: DataStoreRecord | undefined;

  try {
    existing = await getDataStore(dataStoreId);
  } catch (error) {
    if (error instanceof ResourceNotFoundError) {
      return {
        success: true,
        message: "Data store not found or already deleted",
      };
    }
    throw error;
  }

  // Org scoping (finding ca76d041): reconcile BEFORE disconnect, deprovision,
  // secret deletion, IAM role deletion, or the DynamoDB delete — this is the
  // worst-case operation (it deprovisions infrastructure, force-deletes the
  // secret, and deletes the citadel-ds IAM role), so the gate must run before
  // any of that, not just before the final DynamoDB delete.
  await assertRowOrg(existing, event);

  const adapter = getAdapter(existing.type);
  const config =
    typeof existing.config === "string"
      ? JSON.parse(existing.config)
      : existing.config;

  // Get scoped credentials for disconnect (data-plane; the connect-only
  // citadel-ds-<id> role still applies here).
  let scopedCredentials: ScopedCredentials | undefined;
  try {
    const { accountId } = await policyManager.getAccountContext();
    scopedCredentials = await policyManager.assumeScopedRole(
      dataStoreId,
      accountId,
      "datastore",
    );
  } catch (error) {
    console.warn("Failed to assume scoped role for cleanup:", error);
  }

  // Disconnect first
  try {
    await adapter.disconnect(config, scopedCredentials);
  } catch (error) {
    console.warn("Failed to disconnect:", error);
  }

  // Continuum C3 (PR-2): deprovision (Delete*) runs on the PLATFORM path,
  // scoped to the recorded identifiers persisted in `config` — NEVER under
  // the tenant-assumable citadel-ds-<id> role, which (post-PR-2) no longer
  // even carries a Delete* grant. Adapters build their own ambient/named
  // platform clients internally for deprovision.
  if (existing.provisionMode === "CREATE_NEW" && adapter.deprovision) {
    try {
      await adapter.deprovision(config, undefined);
    } catch (error) {
      console.warn("Failed to deprovision infrastructure:", error);
    }
  }

  // Delete secret from Secrets Manager
  if (existing.secretArn) {
    try {
      await secretsManager.send(
        new DeleteSecretCommand({
          SecretId: existing.secretArn,
          ForceDeleteWithoutRecovery: true,
        }),
      );
    } catch (error) {
      console.warn("Failed to delete secret:", error);
    }
  }

  // Delete IAM role
  try {
    await policyManager.deleteRole(dataStoreId, "datastore");
  } catch (error) {
    console.warn("Failed to delete IAM role:", error);
  }

  // Delete from DynamoDB
  await dynamodb.send(
    new DeleteCommand({
      TableName: DATASTORES_TABLE,
      Key: { dataStoreId },
    }),
  );

  return { success: true, message: "Data store deleted successfully" };
}

async function connectDataStore(dataStoreId: string, event: unknown) {
  return retryOptimisticLock(async () => {
    const existing = await getDataStore(dataStoreId);

    // Org scoping (finding ca76d041): reconcile BEFORE assuming any scoped
    // role, retrieving credentials, or calling adapter.connect.
    await assertRowOrg(existing, event);

    const currentVersion = existing.version;

    const adapter = getAdapter(existing.type);
    const config =
      typeof existing.config === "string"
        ? JSON.parse(existing.config)
        : existing.config;

    // CIT-298: inject dataStoreId and orgId into config so adapters (e.g.
    // S3Adapter.connect) can verify resource ownership tags.
    config.dataStoreId = dataStoreId;
    config.orgId = existing.orgId;

    // Retrieve credentials from Secrets Manager if available
    let credentials: Record<string, unknown> | undefined;
    if (existing.secretArn) {
      try {
        const secretResult = await secretsManager.send(
          new GetSecretValueCommand({ SecretId: existing.secretArn }),
        );
        credentials = JSON.parse(secretResult.SecretString || "{}");
      } catch (error) {
        console.warn("Failed to retrieve credentials:", error);
      }
    }

    // Set up scoped credentials if needed
    const { accountId, region } = await policyManager.getAccountContext();
    const policies = adapter.requiredPolicies(
      config,
      accountId,
      region,
    ).connect;
    let scopedCredentials: ScopedCredentials | undefined;

    // C2: preflight ownership check BEFORE creating any IAM role, run
    // UNCONDITIONALLY — see the matching comment in createDataStore for why
    // gating this on policies.length silently skips the ownership check on
    // adapters whose connect policies are empty when scoping identifiers
    // are absent. Uses platform Lambda credentials, not scoped creds.
    if (adapter.preflight) {
      await adapter.preflight(config, {
        dataStoreId,
        orgId: existing.orgId as string,
        provisionMode: "CONNECT_EXISTING",
      });
    }

    if (policies.length > 0) {
      // CIT-254 C12: validate crossAccountRoleArn at connect time + trust-path probe
      const crossAccountExternalId = await validateCrossAccountConfig(
        config,
        policyManager,
      );
      const roleTagInput: RoleTagInput = {
        orgId: existing.orgId as string | undefined,
        agentId: dataStoreId,
      };
      await policyManager.ensureRole(
        dataStoreId,
        policies,
        accountId,
        "datastore",
        config.crossAccountRoleArn,
        await getAdditionalTrustedPrincipals(),
        crossAccountExternalId,
        roleTagInput,
      );
      // Trust-path probe (soft gate — log findings, do not block)
      if (config.crossAccountRoleArn) {
        try {
          const dsRoleArn = `arn:aws:iam::${accountId}:role/citadel-ds-${dataStoreId}`;
          const tp = await computeTrustPath(dsRoleArn, {
            crossAccountRoleArn: config.crossAccountRoleArn as string,
          });
          if (!tp.clean) {
            console.warn("connectDataStore: trust-path probe findings", {
              dataStoreId,
              findings: tp.findings,
            });
          }
        } catch (e) {
          console.warn(
            "connectDataStore: trust-path probe error (non-fatal)",
            e,
          );
        }
      }
      // IAM is eventually consistent — wait for policy propagation
      await new Promise((resolve) => setTimeout(resolve, 5000));
      scopedCredentials = await policyManager.assumeScopedRole(
        dataStoreId,
        accountId,
        "datastore",
        config.crossAccountRoleArn,
        crossAccountExternalId,
      );
    }

    try {
      await adapter.connect(
        config,
        dispatchCreds(adapter, scopedCredentials, credentials),
      );
    } catch (error) {
      // CIT-298: roll back the IAM role on failed connect so it doesn't persist
      if (policies.length > 0) {
        try {
          await policyManager.deleteRole(dataStoreId, "datastore");
          emitRoleRolledBack();
        } catch (rollbackErr) {
          console.error(
            "connectDataStore: failed to roll back IAM role (best-effort)",
            { dataStoreId, rollbackErr },
          );
        }
      }
      await persistErrorState(dataStoreId, error);
      throw error;
    }

    try {
      const result = await dynamodb.send(
        new UpdateCommand({
          TableName: DATASTORES_TABLE,
          Key: { dataStoreId },
          UpdateExpression:
            "SET #status = :status, updatedAt = :now, #version = :newVersion REMOVE errorMessage",
          ConditionExpression: "#version = :expectedVersion",
          ExpressionAttributeNames: {
            "#status": "status",
            "#version": "version",
          },
          ExpressionAttributeValues: {
            ":status": "CONNECTED",
            ":now": new Date().toISOString(),
            ":newVersion": currentVersion + 1,
            ":expectedVersion": currentVersion,
          },
          ReturnValues: "ALL_NEW",
        }),
      );

      return result.Attributes;
    } catch (error: unknown) {
      if (
        error instanceof Error &&
        error.name === "ConditionalCheckFailedException"
      ) {
        throw new ConflictError(
          "Version conflict: data store was modified concurrently",
        );
      }
      throw error;
    }
  });
}

async function disconnectDataStore(dataStoreId: string, event: unknown) {
  return retryOptimisticLock(async () => {
    const existing = await getDataStore(dataStoreId);

    // Org scoping (finding ca76d041): reconcile BEFORE adapter.disconnect.
    await assertRowOrg(existing, event);

    const currentVersion = existing.version;

    const adapter = getAdapter(existing.type);
    const config =
      typeof existing.config === "string"
        ? JSON.parse(existing.config)
        : existing.config;

    // Vend scoped credentials for disconnect (same as connect path)
    let scopedCredentials: ScopedCredentials | undefined;
    try {
      const { accountId } = await policyManager.getAccountContext();
      scopedCredentials = await policyManager.assumeScopedRole(
        dataStoreId,
        accountId,
        "datastore",
      );
    } catch (error) {
      console.warn("Failed to assume scoped role for disconnect:", error);
    }

    try {
      await adapter.disconnect(config, scopedCredentials);
    } catch (error) {
      console.warn("Disconnect warning:", error);
    }

    try {
      const result = await dynamodb.send(
        new UpdateCommand({
          TableName: DATASTORES_TABLE,
          Key: { dataStoreId },
          UpdateExpression:
            "SET #status = :status, updatedAt = :now, #version = :newVersion",
          ConditionExpression: "#version = :expectedVersion",
          ExpressionAttributeNames: {
            "#status": "status",
            "#version": "version",
          },
          ExpressionAttributeValues: {
            ":status": "DISCONNECTED",
            ":now": new Date().toISOString(),
            ":newVersion": currentVersion + 1,
            ":expectedVersion": currentVersion,
          },
          ReturnValues: "ALL_NEW",
        }),
      );

      return result.Attributes;
    } catch (error: unknown) {
      if (
        error instanceof Error &&
        error.name === "ConditionalCheckFailedException"
      ) {
        throw new ConflictError(
          "Version conflict: data store was modified concurrently",
        );
      }
      throw error;
    }
  });
}

async function testDataStoreConnection(dataStoreId: string, event: unknown) {
  const existing = await getDataStore(dataStoreId);

  // Org scoping (finding ca76d041): reconcile BEFORE retrieving credentials
  // from Secrets Manager or calling adapter.testConnection.
  await assertRowOrg(existing, event);

  const adapter = getAdapter(existing.type);
  const config =
    typeof existing.config === "string"
      ? JSON.parse(existing.config)
      : existing.config;

  // Retrieve credentials if available
  let credentials: Record<string, unknown> | undefined;
  if (existing.secretArn) {
    try {
      const secretResult = await secretsManager.send(
        new GetSecretValueCommand({ SecretId: existing.secretArn }),
      );
      credentials = JSON.parse(secretResult.SecretString || "{}");
    } catch (error) {
      console.warn("Failed to retrieve credentials:", error);
    }
  }

  // Set up scoped credentials if needed
  let scopedCredentials: ScopedCredentials | undefined;
  const { accountId, region } = await policyManager.getAccountContext();
  const policies = adapter.requiredPolicies(config, accountId, region).connect;

  if (policies.length > 0) {
    try {
      scopedCredentials = await policyManager.assumeScopedRole(
        dataStoreId,
        accountId,
        "datastore",
        config.crossAccountRoleArn,
      );
    } catch (error) {
      console.warn("Failed to assume scoped role for test:", error);
    }
  }

  const testResult = await adapter.testConnection(
    config,
    dispatchCreds(adapter, scopedCredentials, credentials),
  );

  return {
    success: testResult.success,
    message: testResult.message,
    details: testResult.details ? JSON.stringify(testResult.details) : null,
  };
}
