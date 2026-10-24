/**
 * Intake consent gate resolver.
 *
 * Backs the Cognito-auth `recordIntakeConsent(projectId, action)` mutation.
 * Writes a short-lived consent record to the session-memory table that the
 * Python intake tool checks and consumes before performing a privileged
 * post-fabrication mutation.
 *
 * Security model:
 *  - Cognito-auth only (`@aws_cognito_user_pools`): the caller is a real,
 *    authenticated user — never the agent runtime.
 *  - The projectId (== sessionId for the intake path) is cross-checked
 *    against the Cognito caller's org via the same project→org derivation
 *    the intake-orchestration-resolver uses, so a user cannot write consent
 *    records for another org's session.
 *  - The consent record has a 10-minute TTL. The Python tool verifies the
 *    TTL explicitly (DynamoDB TTL has eventual deletion) and deletes the
 *    record on consumption (single-use).
 */
import type { AppSyncResolverEvent } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import { extractOrgFromEvent } from "../utils/auth-event";
import { lookupOwnerOrganization } from "../utils/org-membership";
import { ORGLESS_CALLER_ORG } from "./utils/org-sentinel";

const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

function sessionMemoryTable(): string {
  return process.env.SESSION_MEMORY_TABLE ?? "";
}
function projectsTable(): string {
  return process.env.PROJECTS_TABLE ?? "";
}
function conversationsTable(): string {
  return process.env.CONVERSATIONS_TABLE ?? "";
}

/** 10-minute window for the user to confirm and the agent to consume. */
export const CONSENT_TTL_SECONDS = 600;

const VALID_ACTIONS = new Set([
  "activate_agents",
  "create_agent_app",
  "generate_process_blueprint",
  "import_blueprint_to_app",
]);

interface ConsentArgs {
  projectId?: unknown;
  action?: unknown;
}

type ConsentEvent = AppSyncResolverEvent<ConsentArgs>;

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} is required and must be a non-empty string`);
  }
  if (value.length > 256) {
    throw new Error(`${field} must be at most 256 characters`);
  }
  return value.trim();
}

/**
 * Paginated conversations-table scan mirroring
 * intake-orchestration-resolver.ts:findLinkedProjectId.
 */
async function findLinkedProjectId(sessionId: string): Promise<string | null> {
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await docClient.send(
      new ScanCommand({
        TableName: conversationsTable(),
        FilterExpression: "#cid = :cid",
        ExpressionAttributeNames: { "#cid": "id" },
        ExpressionAttributeValues: { ":cid": sessionId },
        ProjectionExpression: "projectId",
        ...(exclusiveStartKey && { ExclusiveStartKey: exclusiveStartKey }),
      }),
    );
    const linked = page.Items?.find(
      (item) => typeof item.projectId === "string",
    );
    if (linked) {
      return linked.projectId as string;
    }
    exclusiveStartKey = page.LastEvaluatedKey as
      Record<string, unknown> | undefined;
  } while (exclusiveStartKey);
  return null;
}

/**
 * Resolves the org for a given sessionId via project→org derivation,
 * mirroring intake-orchestration-resolver.ts:deriveSessionContext + resolveOrgId.
 */
async function resolveSessionOrg(sessionId: string): Promise<string> {
  const projectId = (await findLinkedProjectId(sessionId)) ?? sessionId;

  const project = await docClient.send(
    new GetCommand({ TableName: projectsTable(), Key: { id: projectId } }),
  );

  const orgId =
    typeof project.Item?.organization === "string" &&
    project.Item.organization.length > 0
      ? (project.Item.organization as string)
      : null;

  if (orgId) return orgId;

  const owner =
    typeof project.Item?.owner === "string" && project.Item.owner.length > 0
      ? (project.Item.owner as string)
      : null;

  if (owner) {
    const ownerOrg = await lookupOwnerOrganization(owner);
    if (ownerOrg) return ownerOrg;
  }

  return ORGLESS_CALLER_ORG;
}

function log(detail: Record<string, unknown>): void {
  console.log(
    JSON.stringify({
      resolver: "intake-consent-resolver",
      ...detail,
    }),
  );
}

export const handler = async (event: ConsentEvent): Promise<unknown> => {
  const args = event.arguments ?? {};
  const projectId = requireString(args.projectId, "projectId");
  const action = requireString(args.action, "action");

  if (!VALID_ACTIONS.has(action)) {
    throw new Error(
      `Invalid action '${action}'. Must be one of: ${[...VALID_ACTIONS].join(", ")}`,
    );
  }

  // Cognito org guard: derive the caller's org from the event identity and
  // the session's org from the project linkage, then compare.
  const callerOrg = (await extractOrgFromEvent(event)) ?? ORGLESS_CALLER_ORG;
  const sessionOrg = await resolveSessionOrg(projectId);

  if (callerOrg !== sessionOrg) {
    log({
      action,
      projectId,
      denied: true,
      callerOrg,
      sessionOrg,
    });
    throw new Error(
      "Access denied: session belongs to a different organization",
    );
  }

  const now = Math.floor(Date.now() / 1000);
  const ttl = now + CONSENT_TTL_SECONDS;
  const expiresAt = new Date(ttl * 1000).toISOString();

  await docClient.send(
    new PutCommand({
      TableName: sessionMemoryTable(),
      Item: {
        p_key: projectId,
        s_key: `consent#${action}`,
        grantedAt: new Date(now * 1000).toISOString(),
        ttl,
      },
    }),
  );

  log({ action, projectId, expiresAt });

  return {
    ok: true,
    action,
    expiresAt,
  };
};
