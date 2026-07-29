/**
 * Trace HTTP Shared — response helpers + entry-key ownership resolution
 * for the waterfall trace viewer's ownership-gated routes (design §1
 * "AUTHORIZATION DECISION", §1 "Resolution order").
 *
 * `resolveExecutionOwnership` / `resolveConversationOwnership` are the
 * ownership checks that MUST run before any X-Ray call (invariant 1) —
 * this module has zero X-Ray/AWS-tracing imports so that invariant is
 * structurally true, not just by convention.
 *
 * Re-exports the generic `json/badRequest/forbidden/notFound` response
 * helpers alongside the org/admin claim extractors, mirroring
 * cost-http-shared.ts's shape so trace-query-handler.ts has one import
 * surface for both the HTTP plumbing and the ownership discipline.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import {
  extractOrgFromHttpEvent,
  isAdminFromHttpEvent,
} from "./auth-http-event";

export { extractOrgFromHttpEvent, isAdminFromHttpEvent };

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

export interface HttpResponse {
  statusCode: number;
  headers?: Record<string, string>;
  body?: string;
}

export function json(statusCode: number, payload: unknown): HttpResponse {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  };
}

export function badRequest(message: string): HttpResponse {
  return json(400, { error: message });
}

export function forbidden(message = "Forbidden"): HttpResponse {
  return json(403, { error: message });
}

export function notFound(): HttpResponse {
  return json(404, { error: "Not found" });
}

export type OwnershipResult =
  | { ok: true; orgId: string; correlationId: string; entryTimestamp?: string }
  | { ok: false; status: 404 };

/**
 * Resolves an executionId's owning org via a direct GetItem on the
 * executions table (`ExecutionRecord.orgId`, confirmed
 * execution-resolver.ts). The correlation id for a workflow execution IS
 * the executionId itself (design §1: "correlation_id == executionId").
 * Never issues a Query/Scan — a single GetItem keyed by executionId.
 * Also surfaces `completedAt` (when present) for the caller's
 * indexing-vs-empty freshness decision (design §2), so a second GetItem
 * is never needed for that purpose.
 */
export async function resolveExecutionOwnership(
  executionId: string,
): Promise<OwnershipResult> {
  const tableName = process.env.EXECUTIONS_TABLE!;
  const result = await docClient.send(
    new GetCommand({
      TableName: tableName,
      Key: { executionId },
    }),
  );

  const item = result.Item as
    { orgId?: string; completedAt?: string } | undefined;
  if (!item || typeof item.orgId !== "string" || item.orgId.length === 0) {
    return { ok: false, status: 404 };
  }

  return {
    ok: true,
    orgId: item.orgId,
    correlationId: executionId,
    entryTimestamp:
      typeof item.completedAt === "string" ? item.completedAt : undefined,
  };
}

/**
 * Resolves a conversation's owning org. Conversations are keyed by
 * `projectId` directly (conversation-resolver.ts's messages table PK) —
 * there is no separate conversationId->projectId indirection to resolve,
 * so the route parameter IS the projectId. Resolves org via a direct
 * GetItem on the projects table (`{ id: projectId }` -> `orgId`,
 * confirmed intake-orchestration-resolver.ts's projectsTable() access
 * pattern). The correlation id for a conversation is the projectId
 * itself (design §1: "session_id"/"correlation_id" per the flow —
 * projectId is the stable entry key we can verify ownership against).
 * Never issues a Query/Scan — a single GetItem keyed by { id: projectId }.
 * Also surfaces `updatedAt` (when present) for the freshness decision.
 */
export async function resolveConversationOwnership(
  conversationId: string,
): Promise<OwnershipResult> {
  const tableName = process.env.PROJECTS_TABLE!;
  const result = await docClient.send(
    new GetCommand({
      TableName: tableName,
      Key: { id: conversationId },
    }),
  );

  const item = result.Item as
    { orgId?: string; updatedAt?: string } | undefined;
  if (!item || typeof item.orgId !== "string" || item.orgId.length === 0) {
    return { ok: false, status: 404 };
  }

  return {
    ok: true,
    orgId: item.orgId,
    correlationId: conversationId,
    entryTimestamp:
      typeof item.updatedAt === "string" ? item.updatedAt : undefined,
  };
}
