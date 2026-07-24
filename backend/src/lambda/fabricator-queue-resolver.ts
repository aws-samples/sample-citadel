import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  QueryCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import { AppSyncResolverEvent } from "aws-lambda";

const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

// Durable per-agent fabrication status table (citadel-fabrication-jobs-${env}).
// Read at call-time so unit tests can toggle it per case.
function getFabricationJobsTable(): string | undefined {
  return process.env.FABRICATION_JOBS_TABLE;
}

// Upper bound on rows returned by the unfiltered (Scan) path so the queue
// view stays cheap regardless of table size.
const SCAN_LIMIT = 100;

type FabricationStatus = "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED";

const VALID_FABRICATION_STATUSES: readonly FabricationStatus[] = [
  "PENDING",
  "PROCESSING",
  "COMPLETED",
  "FAILED",
];

/**
 * Validate a raw row status against the GraphQL enum. Rows the resolver
 * cannot attribute to a real lifecycle state (missing or unrecognized
 * status) normalize to terminal FAILED — never PENDING — so anomalous
 * all-time rows can't read as in-flight work and wedge the queue badge,
 * and unknown values never pass through verbatim as an invalid enum member.
 */
function normalizeStatus(status: string | undefined): FabricationStatus {
  return (VALID_FABRICATION_STATUSES as readonly string[]).includes(
    status ?? "",
  )
    ? (status as FabricationStatus)
    : "FAILED";
}

interface FabricationQueueItem {
  requestId: string;
  agentName: string;
  taskDescription: string;
  status: FabricationStatus;
  submittedAt: string;
  errorMessage?: string;
  metadata?: Record<string, unknown>;
}

/** Fabrication-jobs DynamoDB row slice this resolver reads. */
interface FabricationJobRow {
  agentUseId: string;
  agentName?: string;
  agentId?: string;
  taskDescription?: string;
  status?: string;
  submittedAt?: string;
  updatedAt?: string;
  errorMessage?: string;
  orchestrationId?: string;
  [key: string]: unknown;
}

/**
 * Map a fabrication-jobs DynamoDB row to the GraphQL FabricationQueueItem the
 * frontend drawer already renders. agentUseId is the per-request key the UI
 * uses as requestId; orchestrationId + agentId travel in metadata.
 */
function mapRow(item: FabricationJobRow): FabricationQueueItem {
  return {
    requestId: item.agentUseId,
    agentName:
      item.agentName || item.agentId || item.agentUseId || "Unknown Agent",
    taskDescription: item.taskDescription || "No description",
    status: normalizeStatus(item.status),
    submittedAt:
      item.submittedAt || item.updatedAt || new Date(0).toISOString(),
    errorMessage: item.errorMessage,
    metadata: {
      orchestrationId: item.orchestrationId,
      agentId: item.agentId,
    },
  };
}

/**
 * Read the durable fabrication-jobs table as the source of truth for per-agent
 * fabrication status. Replaces the previous SQS ReceiveMessage approach, which
 * was unreliable and competed with the fabricator consumer for messages.
 *
 * - With projectId: Query PK=orchestrationId (the intake session/project id).
 * - Without projectId: Scan with a bounded Limit.
 * Rows are sorted by submittedAt descending. On any error (or when the table
 * env var is unset) returns [] to preserve the resolver's existing contract.
 */
export const handler = async (
  event: AppSyncResolverEvent<{ projectId?: string }>,
): Promise<FabricationQueueItem[]> => {
  const table = getFabricationJobsTable();
  if (!table) {
    console.warn(
      "FABRICATION_JOBS_TABLE unset; returning empty fabricator queue",
    );
    return [];
  }

  const projectId = event.arguments?.projectId;

  try {
    let items: FabricationJobRow[] = [];
    if (projectId) {
      const response = await docClient.send(
        new QueryCommand({
          TableName: table,
          KeyConditionExpression: "orchestrationId = :pk",
          ExpressionAttributeValues: { ":pk": projectId },
        }),
      );
      items = (response.Items || []) as FabricationJobRow[];
    } else {
      const response = await docClient.send(
        new ScanCommand({
          TableName: table,
          Limit: SCAN_LIMIT,
        }),
      );
      items = (response.Items || []) as FabricationJobRow[];
    }

    const queueItems = items.map(mapRow);
    queueItems.sort((a, b) => (a.submittedAt < b.submittedAt ? 1 : -1));
    console.log(`Returning ${queueItems.length} fabrication queue items`);
    return queueItems;
  } catch (error) {
    console.error("Error reading fabrication-jobs table:", error);
    // Preserve the existing contract: empty array on failure.
    return [];
  }
};
