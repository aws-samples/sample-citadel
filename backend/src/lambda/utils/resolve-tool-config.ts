/**
 * Shared tool-config resolution: Registry-first with DynamoDB legacy fallback.
 *
 * Extracted so that both tool-config-resolver (CRUD) and tool-sandbox
 * (execution) resolve tools through the SAME dual-source lookup instead of
 * the sandbox hitting only the legacy DynamoDB table.
 *
 * Callers are responsible for org-scoping / permission checks on the
 * returned config — this helper is an unauthenticated read.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import {
  RegistryService,
  type ToolConfig,
} from "../../services/registry-service";

// ---------------------------------------------------------------------------
// Lazy singletons (same pattern as tool-config-resolver.ts)
// ---------------------------------------------------------------------------

let docClient: DynamoDBDocumentClient | null = null;

function getDocClient(): DynamoDBDocumentClient {
  if (!docClient) {
    docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  }
  return docClient;
}

let registryServiceInstance: RegistryService | null = null;

function getRegistryService(): RegistryService {
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

function isRegistryEnabled(): boolean {
  try {
    return process.env.REGISTRY_ENABLED === "true";
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Minimal config slice the sandbox needs (superset kept for future callers). */
export interface ResolvedToolConfig {
  toolId: string;
  orgId: string;
  integrationBindings?: Array<{
    integrationId?: string;
    dataStoreId?: string;
  }> | null;
  dataStoreBindings?: Array<{
    integrationId?: string;
    dataStoreId?: string;
  }> | null;
  /** S3 key prefix for the tool's code (e.g. "tools/smoke-echo-tool"). When
   *  present the sandbox loads `${codeKey}/index.js` instead of
   *  `tools/${toolId}/index.js`, decoupling the code location from the
   *  registry-assigned recordId. */
  codeKey?: string;
}

/**
 * Resolve a tool config by `toolId`: Registry first, DynamoDB fallback.
 *
 * Returns `null` when neither source has the record.
 */
export async function resolveToolConfig(
  toolId: string,
): Promise<ResolvedToolConfig | null> {
  if (isRegistryEnabled()) {
    try {
      const registryService = getRegistryService();
      const record = await registryService.getResource("tool", toolId);
      if (record) {
        const mapped = registryService.mapToToolConfig(record);
        // Extract codeKey from custom metadata if present — allows the
        // sandbox to load code by the original upload key rather than the
        // registry-assigned recordId.
        let codeKey: string | undefined;
        if (record.customDescriptorContent) {
          try {
            const meta = JSON.parse(record.customDescriptorContent);
            codeKey = meta.codeKey ?? undefined;
          } catch {
            // malformed metadata — ignore
          }
        }
        return toResolvedConfig(mapped, codeKey);
      }
    } catch (err) {
      // Registry unavailable — fall through to DynamoDB.
      console.warn(
        "resolveToolConfig: registry lookup failed, falling back to DynamoDB",
        err,
      );
    }
  }

  // Legacy DynamoDB fallback
  const tableName = process.env.TOOLS_CONFIG_TABLE;
  if (!tableName) return null;

  const result = await getDocClient().send(
    new GetCommand({ TableName: tableName, Key: { toolId } }),
  );
  if (!result.Item) return null;

  return {
    toolId: result.Item.toolId ?? toolId,
    orgId: result.Item.orgId ?? "",
    integrationBindings: result.Item.integrationBindings ?? null,
    dataStoreBindings: result.Item.dataStoreBindings ?? null,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function toResolvedConfig(
  tc: ToolConfig,
  codeKey?: string,
): ResolvedToolConfig {
  return {
    toolId: tc.toolId,
    orgId: tc.orgId,
    integrationBindings: tc.integrationBindings ?? null,
    dataStoreBindings: tc.dataStoreBindings ?? null,
    ...(codeKey ? { codeKey } : {}),
  };
}

/**
 * Reset cached singletons — exposed for tests only.
 * @internal
 */
export function _resetResolveToolConfig(): void {
  docClient = null;
  registryServiceInstance = null;
}
