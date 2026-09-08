/**
 * Shared project-to-organization reconciliation gate (finding 677c1a6c).
 *
 * `assertProjectOrgAccess(projectId, event)` is the pilot piece for the
 * governance-module family: adr-resolver is the first caller; execspec,
 * program-review, interrogation-round, and agent-design-assessment are
 * expected to adopt it in follow-on findings, since their triage entries
 * describe the identical shape (client-supplied projectId -> key op, no
 * project-to-organization reconciliation).
 *
 * This deliberately reuses project-resolver.ts's OWN "may access this
 * project" semantics rather than inventing a second definition:
 *
 *   hasAccess = project.owner === callerId
 *            || (callerOrg && project.organization === callerOrg)
 *
 * (see `getProject` in project-resolver.ts). project.organization is the
 * server-derived tenant boundary stamped onto the row at createProject time
 * from the caller's `custom:organization` claim (or DEFAULT_ORGANIZATION) —
 * never a client-suppliable value. project-resolver.ts is not imported
 * here to avoid pulling its EventBridge/S3/lifecycle dependencies into
 * every governance module; instead the identical GetCommand-against-
 * PROJECTS_TABLE shape used there (and by agent-resolver.ts, which performs
 * the same read-the-parent-project join) is duplicated at the single-row
 * level.
 *
 * Fail-closed matrix (mirrors assertRowOrg / assertManifestAccess):
 *  - absent/unresolvable caller identity            -> deny
 *  - unresolvable caller organization (and not owner) -> deny
 *  - missing project                                 -> deny
 *  - project whose organization cannot be determined
 *    (no `organization` attribute) and caller is not the owner -> deny
 *
 * Admin bypass is preserved via `isAdminFromEvent`, matching the sibling
 * helpers' convention exactly (short-circuits BEFORE the DynamoDB read, so
 * an admin's request never even needs the row to exist).
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { getUserId } from "./appsync";
import { extractOrgFromEvent, isAdminFromEvent } from "./auth-event";

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

/**
 * Thrown by {@link assertProjectOrgAccess} on any denial. Callers should let
 * this propagate (fail closed) rather than catching and continuing — same
 * contract as {@link CrossOrgAccessError} from auth-event.ts.
 */
export class ProjectOrgAccessError extends Error {
  constructor(message = "Access denied") {
    super(message);
    this.name = "ProjectOrgAccessError";
  }
}

interface ProjectOrgRow {
  id?: string;
  owner?: unknown;
  organization?: unknown;
}

/**
 * Asserts the caller may access `projectId`, reconciling it against the
 * caller's organization the same way project-resolver.getProject does.
 * Throws {@link ProjectOrgAccessError} on any denial; resolves silently on
 * success. Must be called BEFORE any write or before returning any data
 * derived from the project's governance sub-resources (ADRs, exec specs,
 * rounds, assessments).
 */
export async function assertProjectOrgAccess(
  projectId: string,
  event: unknown,
): Promise<void> {
  if (isAdminFromEvent(event)) {
    return;
  }

  if (typeof projectId !== "string" || projectId.length === 0) {
    throw new ProjectOrgAccessError();
  }

  const callerId = getUserId(
    (event as { identity?: Parameters<typeof getUserId>[0] })?.identity,
  );
  if (!callerId || callerId === "anonymous") {
    throw new ProjectOrgAccessError();
  }

  const projectsTable = process.env.PROJECTS_TABLE;
  if (!projectsTable) {
    // No table configured means we cannot verify anything — fail closed
    // rather than silently allowing every caller through.
    throw new ProjectOrgAccessError();
  }

  const result = await docClient.send(
    new GetCommand({
      TableName: projectsTable,
      Key: { id: projectId },
    }),
  );

  const project = result.Item as ProjectOrgRow | undefined;
  if (!project) {
    throw new ProjectOrgAccessError();
  }

  if (project.owner === callerId) {
    return;
  }

  const callerOrg = await extractOrgFromEvent(event);
  const projectOrg =
    typeof project.organization === "string" ? project.organization : undefined;

  if (!callerOrg || !projectOrg || callerOrg !== projectOrg) {
    throw new ProjectOrgAccessError();
  }
}
