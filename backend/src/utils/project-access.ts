/**
 * Shared project-access gate.
 *
 * Security fix for finding 60a5a6ae (CRE item 1): the document,
 * document-upload, and conversation resolvers accepted a CLIENT-SUPPLIED
 * `projectId` and used it to build S3 keys / query DynamoDB / dispatch agent
 * messages WITHOUT reconciling it against the caller — a cross-tenant IDOR.
 *
 * This module factors out the access-check logic that project-resolver.ts's
 * `getProject` already implements correctly (admin bypass, else
 * owner-or-same-org, else deny) so the other resolvers can REUSE the same
 * gate instead of re-deriving it. Fail-closed: any identity/lookup failure
 * (missing org claim, project not found, Cognito lookup failure) results in
 * denial, never a silent allow.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { extractOrgFromEvent, isAdminFromEvent } from "./auth-event";

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

/** Minimal shape needed for the access decision — avoids coupling to the full Project type. */
interface ProjectAccessRecord {
  owner: string;
  organization?: string;
}

/**
 * Thrown when the caller is not entitled to the given projectId. Callers
 * should let this propagate (fail closed) rather than catching and
 * continuing.
 */
export class ProjectAccessDeniedError extends Error {
  constructor(message = "Access denied") {
    super(message);
    this.name = "ProjectAccessDeniedError";
  }
}

/**
 * Reconciles a client-supplied `projectId` against the caller, mirroring
 * project-resolver.ts's `getProject` gate exactly:
 *   1. Admins bypass (isAdminFromEvent) — same as getProject.
 *   2. Otherwise the caller must be the project owner OR share the
 *      project's organization (extractOrgFromEvent).
 *   3. Any failure to determine identity/org, or a missing project row,
 *      is treated as denial (fail closed) — never warn-and-proceed.
 *
 * Throws {@link ProjectAccessDeniedError} on denial. Callers MUST call this
 * BEFORE constructing any S3 key, presigning any URL, reading conversation
 * history, or dispatching any agent message.
 */
export async function assertProjectAccess(
  projectId: string,
  userId: string,
  event: unknown,
): Promise<void> {
  if (!projectId) {
    throw new ProjectAccessDeniedError("Access denied");
  }

  const projectsTable = process.env.PROJECTS_TABLE;
  if (!projectsTable) {
    // Fail closed: without the table we cannot reconcile ownership/org.
    throw new ProjectAccessDeniedError("Access denied");
  }

  if (isAdminFromEvent(event)) {
    return;
  }

  let project: ProjectAccessRecord | undefined;
  try {
    const result = await docClient.send(
      new GetCommand({ TableName: projectsTable, Key: { id: projectId } }),
    );
    project = result.Item as ProjectAccessRecord | undefined;
  } catch (err) {
    console.error("assertProjectAccess: project lookup failed", {
      projectId,
      err,
    });
    throw new ProjectAccessDeniedError("Access denied");
  }

  if (!project) {
    throw new ProjectAccessDeniedError("Access denied");
  }

  let userOrganization: string | null = null;
  try {
    userOrganization = await extractOrgFromEvent(event);
  } catch (err) {
    console.error("assertProjectAccess: org lookup failed", { projectId, err });
    throw new ProjectAccessDeniedError("Access denied");
  }

  const hasAccess =
    project.owner === userId ||
    (!!userOrganization && project.organization === userOrganization);

  if (!hasAccess) {
    throw new ProjectAccessDeniedError("Access denied");
  }
}
