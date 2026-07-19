/**
 * Health Monitor Lambda
 *
 * EventBridge scheduled rule triggers this Lambda to periodically check
 * the health of all CONNECTED and ERROR data stores. Each store is tested
 * independently — one failure does not block others.
 *
 * Requirement references: 6.1–6.9, 10.3, 10.5, 10.6
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { STSClient, AssumeRoleCommand, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { getAdapter as getAdapterFromRegistry } from './adapters/registry';

// --- Clients ---

const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const stsClient = new STSClient({});

const DATASTORES_TABLE = process.env.DATASTORES_TABLE!;
const BATCH_SIZE = parseInt(process.env.HEALTH_CHECK_BATCH_SIZE || '10', 10);

// --- Types ---

export interface HealthCheckResult {
  dataStoreId: string;
  orgId: string;
  previousStatus: string;
  newStatus: string;
  errorMessage?: string;
}

interface DataStoreItem {
  dataStoreId: string;
  orgId: string;
  type: string;
  status: string;
  config: string;
  errorMessage?: string | null;
  secretArn?: string;
  [key: string]: unknown;
}

interface AdapterLike {
  testConnection(
    config: Record<string, unknown>,
    credentials?: Record<string, unknown>
  ): Promise<{ success: boolean; message: string }>;
}

type GetAdapterFn = (store: DataStoreItem) => AdapterLike;

type UpdateStoreFn = (
  dataStoreId: string,
  newStatus: string,
  errorMessage: string | null
) => Promise<void>;

// --- Permission error detection ---

const PERMISSION_ERROR_NAMES = new Set([
  'AccessDenied',
  'AccessDeniedException',
  'UnauthorizedAccess',
  'Forbidden',
  'AuthorizationError',
]);

/**
 * Detect whether a failed testConnection result or thrown error is due to
 * insufficient Lambda IAM permissions rather than a genuine connectivity issue.
 * When the health monitor Lambda lacks permissions to reach a resource,
 * the store's status should be preserved (not flipped to ERROR).
 */
function isPermissionError(
  testResult?: { details?: Record<string, unknown>; message?: string },
  thrownError?: unknown,
): boolean {
  // Structural view of the thrown value — health checks re-throw AWS SDK
  // errors, so name/message are the fields of interest.
  const err = thrownError as { name?: string; message?: string } | undefined;
  if (testResult?.details?.isPermissionError) return true;
  if (testResult?.details?.errorName && PERMISSION_ERROR_NAMES.has(testResult.details.errorName as string)) return true;
  if (err?.name && PERMISSION_ERROR_NAMES.has(err.name)) return true;
  // Heuristic: check message for common permission phrases
  const msg = (testResult?.message || err?.message || '').toLowerCase();
  if (msg.includes('access denied') || msg.includes('not authorized') || msg.includes('forbidden')) return true;
  // AWS SDK returns UnknownError when the caller has no permissions for the service at all
  const errorName = ((testResult?.details?.errorName as string | undefined) || err?.name || '').toLowerCase();
  if (errorName === 'unknownerror') return true;
  return false;
}

// --- Testable core logic ---

/**
 * Process health checks for a list of data stores.
 *
 * This function is extracted from the Lambda handler to enable property-based
 * testing with mock adapters and update functions.
 *
 * @param stores - Data stores to check (should be CONNECTED or ERROR status)
 * @param getAdapterFn - Factory that returns an adapter for a given store
 * @param updateStoreFn - Function to persist status changes
 * @param batchSize - Number of stores to process in parallel (default 10)
 */
export async function processHealthChecks(
  stores: DataStoreItem[],
  getAdapterFn: GetAdapterFn,
  updateStoreFn: UpdateStoreFn,
  batchSize: number = 10
): Promise<HealthCheckResult[]> {
  const results: HealthCheckResult[] = [];

  // Process in parallel batches (Req 10.6)
  for (let i = 0; i < stores.length; i += batchSize) {
    const batch = stores.slice(i, i + batchSize);

    const batchResults = await Promise.allSettled(
      batch.map(async (store) => {
        const previousStatus = store.status;
        const config =
          typeof store.config === 'string'
            ? JSON.parse(store.config)
            : store.config;

        try {
          const adapter = getAdapterFn(store);

          // Try to assume scoped role for this datastore
          let scopedCreds: Record<string, unknown> | undefined;
          try {
            const callerIdentity = await stsClient.send(new GetCallerIdentityCommand({}));
            const accountId = callerIdentity.Account!;
            const roleName = `citadel-ds-${store.dataStoreId}`;
            const roleArn = `arn:aws:iam::${accountId}:role/${roleName}`;
            const assumeResult = await stsClient.send(new AssumeRoleCommand({
              RoleArn: roleArn,
              RoleSessionName: `health-check-${store.dataStoreId.substring(0, 16)}`,
              DurationSeconds: 900,
            }));
            if (assumeResult.Credentials) {
              scopedCreds = {
                accessKeyId: assumeResult.Credentials.AccessKeyId,
                secretAccessKey: assumeResult.Credentials.SecretAccessKey,
                sessionToken: assumeResult.Credentials.SessionToken,
              };
            }
          } catch (roleError: unknown) {
            // Role may not exist (e.g. CONNECT_EXISTING without scoped role) — fall through to default creds
            console.log(JSON.stringify({ level: 'DEBUG', component: 'HealthMonitor', message: `No scoped role for ${store.dataStoreId}, using default creds`, error: roleError instanceof Error ? roleError.name : String(roleError) }));
          }

          const testResult = await adapter.testConnection(config, scopedCreds);

          if (testResult.success) {
            // Connection healthy
            if (previousStatus === 'ERROR') {
              // Recovery: ERROR → CONNECTED, clear errorMessage (Req 6.4)
              await updateStoreFn(store.dataStoreId, 'CONNECTED', null);
            } else {
              // Already CONNECTED — ensure errorMessage is cleared (idempotent)
              await updateStoreFn(store.dataStoreId, 'CONNECTED', null);
            }

            const result: HealthCheckResult = {
              dataStoreId: store.dataStoreId,
              orgId: store.orgId,
              previousStatus,
              newStatus: 'CONNECTED',
            };
            logHealthCheckResult(result);
            return result;
          } else {
            // Connection failed — check if it's a permission error
            if (isPermissionError(testResult)) {
              // Permission error: preserve current status, don't mark as ERROR
              const result: HealthCheckResult = {
                dataStoreId: store.dataStoreId,
                orgId: store.orgId,
                previousStatus,
                newStatus: previousStatus, // unchanged
              };
              logHealthCheckResult(result);
              return result;
            }

            // Genuine connectivity failure (Req 6.3)
            await updateStoreFn(store.dataStoreId, 'ERROR', testResult.message);

            const result: HealthCheckResult = {
              dataStoreId: store.dataStoreId,
              orgId: store.orgId,
              previousStatus,
              newStatus: 'ERROR',
              errorMessage: testResult.message,
            };
            logHealthCheckResult(result);
            return result;
          }
        } catch (error: unknown) {
          // Check if the exception is a permission error
          if (isPermissionError(undefined, error)) {
            // Permission error: preserve current status
            const result: HealthCheckResult = {
              dataStoreId: store.dataStoreId,
              orgId: store.orgId,
              previousStatus,
              newStatus: previousStatus, // unchanged
            };
            logHealthCheckResult(result);
            return result;
          }

          // Adapter threw a genuine exception — treat as unhealthy (Req 10.3)
          const errorMessage = (error instanceof Error ? error.message : '') || 'Unknown error during health check';
          await updateStoreFn(store.dataStoreId, 'ERROR', errorMessage);

          const result: HealthCheckResult = {
            dataStoreId: store.dataStoreId,
            orgId: store.orgId,
            previousStatus,
            newStatus: 'ERROR',
            errorMessage,
          };
          logHealthCheckResult(result);
          return result;
        }
      })
    );

    // Collect results from settled promises
    for (const settled of batchResults) {
      if (settled.status === 'fulfilled') {
        results.push(settled.value);
      }
      // Rejected promises are swallowed — each store is independent (Req 6.8)
    }
  }

  return results;
}

// --- Structured logging (Req 10.5) ---

function logHealthCheckResult(result: HealthCheckResult): void {
  const level =
    result.newStatus === 'ERROR'
      ? 'WARN'
      : result.previousStatus === 'ERROR' && result.newStatus === 'CONNECTED'
        ? 'INFO'
        : 'DEBUG';

  console.log(
    JSON.stringify({
      level,
      component: 'HealthMonitor',
      dataStoreId: result.dataStoreId,
      orgId: result.orgId,
      previousStatus: result.previousStatus,
      newStatus: result.newStatus,
      errorMessage: result.errorMessage || null,
      timestamp: new Date().toISOString(),
    })
  );
}

// --- Lambda handler ---

export async function handler(): Promise<void> {
  console.log(
    JSON.stringify({
      level: 'INFO',
      component: 'HealthMonitor',
      message: 'Starting health check run',
      batchSize: BATCH_SIZE,
      timestamp: new Date().toISOString(),
    })
  );

  // 1. Query all stores with status CONNECTED or ERROR (Req 6.2, 6.9)
  const stores = await fetchCheckableStores();

  if (stores.length === 0) {
    console.log(
      JSON.stringify({
        level: 'INFO',
        component: 'HealthMonitor',
        message: 'No stores to check',
        timestamp: new Date().toISOString(),
      })
    );
    return;
  }

  // 2. Process health checks using the core logic
  const results = await processHealthChecks(
    stores,
    (store) => getAdapterFromRegistry(store.type),
    updateStoreInDynamo,
    BATCH_SIZE
  );

  console.log(
    JSON.stringify({
      level: 'INFO',
      component: 'HealthMonitor',
      message: 'Health check run complete',
      totalChecked: results.length,
      healthy: results.filter((r) => r.newStatus === 'CONNECTED').length,
      unhealthy: results.filter((r) => r.newStatus === 'ERROR').length,
      recovered: results.filter(
        (r) => r.previousStatus === 'ERROR' && r.newStatus === 'CONNECTED'
      ).length,
      timestamp: new Date().toISOString(),
    })
  );
}

// --- DynamoDB helpers ---

async function fetchCheckableStores(): Promise<DataStoreItem[]> {
  // Scan for stores with status CONNECTED or ERROR
  // Skip PROVISIONING, DELETING, CREATED (Req 6.9)
  const result = await dynamodb.send(
    new ScanCommand({
      TableName: DATASTORES_TABLE,
      FilterExpression: '#status IN (:connected, :error)',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':connected': 'CONNECTED',
        ':error': 'ERROR',
      },
    })
  );

  return (result.Items || []) as DataStoreItem[];
}

async function updateStoreInDynamo(
  dataStoreId: string,
  newStatus: string,
  errorMessage: string | null
): Promise<void> {
  if (errorMessage) {
    await dynamodb.send(
      new UpdateCommand({
        TableName: DATASTORES_TABLE,
        Key: { dataStoreId },
        UpdateExpression:
          'SET #status = :status, errorMessage = :errorMessage, updatedAt = :now',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':status': newStatus,
          ':errorMessage': errorMessage,
          ':now': new Date().toISOString(),
        },
      })
    );
  } else {
    await dynamodb.send(
      new UpdateCommand({
        TableName: DATASTORES_TABLE,
        Key: { dataStoreId },
        UpdateExpression:
          'SET #status = :status, updatedAt = :now REMOVE errorMessage',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':status': newStatus,
          ':now': new Date().toISOString(),
        },
      })
    );
  }
}
