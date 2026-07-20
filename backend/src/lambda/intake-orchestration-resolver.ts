/**
 * Intake post-fabrication orchestration resolver.
 *
 * Backs the 4 IAM-only AppSync mutations the intake AgentCore runtime calls
 * over SigV4 after a fabrication completes:
 *
 *   intakeActivateProjectAgents(sessionId)                    → activate fabricated agents
 *   intakeCreateApp(sessionId, name, description)             → create the Agent App
 *   intakeCreateBlueprint(sessionId, name, definition)        → create + publish a blueprint
 *   intakeImportBlueprintToApp(sessionId, blueprintId, appId) → import it as an in-app DRAFT workflow
 *
 * This module is a THIN boundary: identity guard, input validation, and
 * server-side org/project derivation only. All substantive governance is
 * delegated to the existing resolver cores (activateProjectAgents, createApp,
 * createWorkflow/publishWorkflow/importBlueprint) so no invariant is
 * re-implemented here.
 *
 * Security model:
 *  - The schema declares the 4 fields `@aws_iam` ONLY; this handler adds a
 *    defence-in-depth identity check so even a misconfigured directive change
 *    cannot leak them to user-pool callers.
 *  - `extractOrgFromEvent` returns null for IAM identities, which makes the
 *    delegated cores' own org guards no-ops. Scoping is therefore enforced
 *    HERE: orgId/sourceProjectId are derived server-side from the session's
 *    conversations→project linkage and never read from client arguments, and
 *    cross-org app/blueprint access is rejected before delegation. When the
 *    linked project row is org-less (project-resolver writes `organization:
 *    userOrganization || undefined`), the org falls back to the project
 *    owner's Cognito `custom:organization`, then to the same literal an
 *    org-less caller produces on the Cognito-auth path (see resolveOrgId).
 *  - Logging is restricted to identifiers (field, correlationId, ids) — no
 *    argument payloads are ever logged, so credentials cannot leak by
 *    construction.
 */
import type { AppSyncResolverEvent } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { getUserId } from '../utils/appsync';
import { lookupUserOrganization } from '../utils/auth-event';
import { ValidationError, sanitizeString } from '../utils/validation';
import { activateProjectAgents, type ActivateAgentsResult } from './agent-config-resolver';
import { createApp } from './registry-agent-record-resolver';
import { createWorkflow, publishWorkflow, importBlueprint } from './workflow-resolver';

const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

// Env is read lazily (not at module load) so the values reflect the runtime
// environment at call time and the module can be imported in tests before
// the env is prepared.
function projectsTable(): string {
  return process.env.PROJECTS_TABLE ?? '';
}
function conversationsTable(): string {
  return process.env.CONVERSATIONS_TABLE ?? '';
}
function appsTable(): string {
  return process.env.APPS_TABLE ?? '';
}
function workflowsTable(): string {
  return process.env.WORKFLOWS_TABLE ?? '';
}

/** Merged view of the arguments the 4 intake fields receive. */
interface IntakeOrchestrationArguments {
  sessionId?: unknown;
  name?: unknown;
  description?: unknown;
  definition?: unknown;
  blueprintId?: unknown;
  appId?: unknown;
}

type IntakeOrchestrationEvent = AppSyncResolverEvent<IntakeOrchestrationArguments>;

/** ActivateAgentsResult extended with the explicit zero-activated signal. */
interface IntakeActivateAgentsResult extends ActivateAgentsResult {
  matchedBy: 'sessionId' | 'projectId' | null;
}

interface IntakeBlueprintResult {
  ok: boolean;
  blueprintId: string | null;
  status: 'PUBLISHED' | 'AGENTS_SYNCING' | 'VALIDATION_FAILED';
  nodeCount: number | null;
  missing: string[];
  errors: string[];
}

/**
 * Defence-in-depth IAM identity check (mirrors the publishGovernanceFinding
 * guard). An IAM-authed AppSync invocation surfaces `accountId` and lacks the
 * Cognito/OIDC `sub`/`claims` shape; anything else is rejected even though
 * the `@aws_iam`-only directive should already have kept it out.
 */
function isIamIdentity(identity: unknown): boolean {
  if (!identity || typeof identity !== 'object') return false;
  const id = identity as Record<string, unknown>;
  if (id.claims !== undefined) return false;
  if (typeof id.sub === 'string') return false;
  return typeof id.accountId === 'string' && id.accountId.length > 0;
}

function requireId(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ValidationError(`${field} is required and must be a non-empty string`, field);
  }
  if (value.length > 256) {
    throw new ValidationError(`${field} must be at most 256 characters`, field);
  }
  return value.trim();
}

/**
 * AWSJSON normalization (RESOLVER_GUIDE §7): AppSync delivers AWSJSON as a
 * parsed object; strings pass through unchanged so they are never
 * double-encoded.
 */
function toJsonString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

interface SessionContext {
  sessionId: string;
  /** Conversations-linked project id; falls back to the sessionId itself. */
  projectId: string;
  /** projects[projectId].organization — null when the attribute is absent. */
  orgId: string | null;
  /** projects[projectId].name — null when the project row is absent. */
  projectName: string | null;
  /** projects[projectId].owner — null when absent; drives the org fallback. */
  owner: string | null;
}

/**
 * Finds the conversations row carrying `id = sessionId` and returns its
 * projectId. The table is keyed PK=projectId/SK=timestamp with no GSI on
 * `id` (backend-stack.ts ConversationsTable), so a Query cannot target the
 * session id — a filtered Scan is the only correct read. Scan `Limit` caps
 * items EVALUATED (pre-filter), so a single page routinely misses the row
 * once the table grows: follow LastEvaluatedKey to exhaustion, returning as
 * soon as the linked row is found.
 */
async function findLinkedProjectId(sessionId: string): Promise<string | null> {
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await docClient.send(
      new ScanCommand({
        TableName: conversationsTable(),
        FilterExpression: '#cid = :cid',
        ExpressionAttributeNames: { '#cid': 'id' },
        ExpressionAttributeValues: { ':cid': sessionId },
        ProjectionExpression: 'projectId',
        ...(exclusiveStartKey && { ExclusiveStartKey: exclusiveStartKey }),
      }),
    );
    const linked = page.Items?.find((item) => typeof item.projectId === 'string');
    if (linked) {
      return linked.projectId as string;
    }
    exclusiveStartKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey);
  return null;
}

/**
 * Server-side session→project→org derivation. Mirrors the intake runtime's
 * own linkage (state.py `_update_project_status`): conversations rows carry
 * `id` (the session id) + `projectId`; when no row links the session, the
 * projectId falls back to the sessionId. The org comes from the project
 * record's `organization` attribute (project-resolver `createProject`).
 */
async function deriveSessionContext(sessionId: string): Promise<SessionContext> {
  const projectId = (await findLinkedProjectId(sessionId)) ?? sessionId;

  const project = await docClient.send(
    new GetCommand({ TableName: projectsTable(), Key: { id: projectId } }),
  );
  const orgId =
    typeof project.Item?.organization === 'string' && project.Item.organization.length > 0
      ? (project.Item.organization as string)
      : null;
  const projectName = typeof project.Item?.name === 'string' ? (project.Item.name as string) : null;
  const owner =
    typeof project.Item?.owner === 'string' && project.Item.owner.length > 0
      ? (project.Item.owner as string)
      : null;

  return { sessionId, projectId, orgId, projectName, owner };
}

/**
 * Org value an org-less Cognito caller lands on. The delegated cores never
 * derive or validate org — `createApp` consumes `input.orgId` verbatim
 * (registry-agent-record-resolver.ts) and the schema makes it a required
 * client-supplied string (`CreateAppInput.orgId: String!`). Users without
 * an organization send the UI's literal fallback `selectedOrganization ||
 * 'default'` (AppBuilderWizard.tsx), so the same literal keeps intake-made
 * apps on exactly the downstream semantics (OrgIndex visibility, org-scoped
 * listing) the UI path produces.
 */
const ORGLESS_CALLER_ORG = 'default';

/**
 * Org derivation fallback chain (self-healing — no data patch needed):
 *  1. `project.organization` when the project row carries it.
 *  2. The project owner's Cognito `custom:organization` via AdminGetUser —
 *     project-resolver writes `organization: userOrganization || undefined`,
 *     so users whose token lacked the claim at project creation produced
 *     org-less rows; the owner attribute is the durable pointer back to the
 *     org they belong to today.
 *  3. `'default'` — exactly what an org-less caller produces on the
 *     Cognito-auth createApp/createWorkflow paths (see ORGLESS_CALLER_ORG).
 */
async function resolveOrgId(ctx: SessionContext): Promise<string> {
  if (ctx.orgId) {
    return ctx.orgId;
  }
  if (ctx.owner) {
    const ownerOrg = await lookupUserOrganization(ctx.owner);
    if (ownerOrg) {
      log('resolveOrgId', ctx.sessionId, { orgSource: 'ownerCognitoAttribute' });
      return ownerOrg;
    }
  }
  log('resolveOrgId', ctx.sessionId, { orgSource: 'orglessCallerDefault' });
  return ORGLESS_CALLER_ORG;
}

function log(fieldName: string, correlationId: string, detail: Record<string, unknown>): void {
  // Identifiers only — never argument payloads (credential sanitization by
  // construction at this boundary).
  console.log(
    JSON.stringify({
      resolver: 'intake-orchestration-resolver',
      fieldName,
      correlationId,
      ...detail,
    }),
  );
}

function isEmptyActivation(result: ActivateAgentsResult): boolean {
  return (
    result.activated.length === 0 &&
    result.failed.length === 0 &&
    result.alreadyActive.length === 0
  );
}

/**
 * Activation with R1-informed matching. Fabricated agents carry
 * `sourceProjectId = session_id` (the fabricator threads the SQS
 * `orchestration_id`, which intake sets to the session id, into the registry
 * record's custom metadata), so the sessionId is tried FIRST. When it matches
 * zero records, the conversations-linked projectId is tried as the fallback.
 * Zero matches on both keys is surfaced explicitly via `matchedBy: null`.
 */
async function intakeActivateProjectAgents(
  sessionId: string,
): Promise<IntakeActivateAgentsResult> {
  const bySession = await activateProjectAgents(sessionId);
  if (!isEmptyActivation(bySession)) {
    return { ...bySession, matchedBy: 'sessionId' };
  }

  const ctx = await deriveSessionContext(sessionId);
  if (ctx.projectId !== sessionId) {
    const byProject = await activateProjectAgents(ctx.projectId);
    if (!isEmptyActivation(byProject)) {
      return { ...byProject, matchedBy: 'projectId' };
    }
  }

  log('intakeActivateProjectAgents', sessionId, {
    zeroActivated: true,
    triedProjectFallback: ctx.projectId !== sessionId,
  });
  return { ...bySession, matchedBy: null };
}

async function intakeCreateApp(
  sessionId: string,
  rawName: unknown,
  rawDescription: unknown,
  userId: string,
): Promise<unknown> {
  const name = sanitizeString(requireId(rawName, 'name'), 100);
  if (name.length === 0) {
    throw new ValidationError('name must contain visible characters', 'name');
  }
  const description =
    rawDescription === null || rawDescription === undefined
      ? undefined
      : sanitizeString(requireId(rawDescription, 'description'), 1000);

  const ctx = await deriveSessionContext(sessionId);
  const orgId = await resolveOrgId(ctx);

  // Scoping fields are server-derived only: orgId from the linked project,
  // sourceProjectId from the sessionId (the fabrication orchestration key) so
  // the app can be found again by the same key the fabricated agents carry.
  return createApp(
    {
      orgId,
      name,
      ...(description !== undefined && { description }),
      sourceProjectId: sessionId,
    },
    userId,
  );
}

/** Parses the agentIds out of publishWorkflow's missing-agents message. */
function parseMissingAgentIds(message: string): string[] {
  const missing: string[] = [];
  const pattern = /agentId '([^']+)'/g;
  let match = pattern.exec(message);
  while (match !== null) {
    missing.push(match[1]);
    match = pattern.exec(message);
  }
  return missing;
}

function countNodes(definition: string): number | null {
  try {
    const parsed: unknown = JSON.parse(definition);
    if (
      parsed &&
      typeof parsed === 'object' &&
      Array.isArray((parsed as { nodes?: unknown }).nodes)
    ) {
      return ((parsed as { nodes: unknown[] }).nodes).length;
    }
  } catch {
    // Not parseable — node count simply unknown.
  }
  return null;
}

async function intakeCreateBlueprint(
  sessionId: string,
  rawName: unknown,
  rawDefinition: unknown,
  userId: string,
  event: IntakeOrchestrationEvent,
): Promise<IntakeBlueprintResult> {
  const name = sanitizeString(requireId(rawName, 'name'), 100);
  if (name.length === 0) {
    throw new ValidationError('name must contain visible characters', 'name');
  }
  const definition = toJsonString(rawDefinition);
  if (!definition) {
    throw new ValidationError('definition is required', 'definition');
  }

  const ctx = await deriveSessionContext(sessionId);
  const orgId = await resolveOrgId(ctx);
  const nodeCount = countNodes(definition);

  let workflowId: string;
  try {
    const created = (await createWorkflow(
      { orgId, name, isBlueprint: true, definition },
      userId,
    )) as { workflowId: string };
    workflowId = created.workflowId;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log('intakeCreateBlueprint', sessionId, { stage: 'create', failed: true });
    return {
      ok: false,
      blueprintId: null,
      status: 'VALIDATION_FAILED',
      nodeCount,
      missing: [],
      errors: [message],
    };
  }

  try {
    await publishWorkflow(workflowId, userId, event);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const missing = message.includes('do not exist') ? parseMissingAgentIds(message) : [];
    log('intakeCreateBlueprint', sessionId, {
      stage: 'publish',
      failed: true,
      blueprintId: workflowId,
      missingCount: missing.length,
    });
    return {
      ok: false,
      blueprintId: workflowId,
      status: missing.length > 0 ? 'AGENTS_SYNCING' : 'VALIDATION_FAILED',
      nodeCount,
      missing,
      errors: [message],
    };
  }

  return {
    ok: true,
    blueprintId: workflowId,
    status: 'PUBLISHED',
    nodeCount,
    missing: [],
    errors: [],
  };
}

async function intakeImportBlueprintToApp(
  sessionId: string,
  rawBlueprintId: unknown,
  rawAppId: unknown,
  rawName: unknown,
  userId: string,
  event: IntakeOrchestrationEvent,
): Promise<unknown> {
  const blueprintId = requireId(rawBlueprintId, 'blueprintId');
  const appId = requireId(rawAppId, 'appId');
  const name =
    rawName === null || rawName === undefined
      ? undefined
      : sanitizeString(requireId(rawName, 'name'), 100);

  const ctx = await deriveSessionContext(sessionId);
  const orgId = await resolveOrgId(ctx);

  // Org enforcement happens HERE: the delegated core's own org guard relies
  // on extractOrgFromEvent, which is null for IAM callers.
  const appRow = await docClient.send(
    new GetCommand({ TableName: appsTable(), Key: { appId } }),
  );
  if (!appRow.Item) {
    throw new Error('App not found');
  }
  if (appRow.Item.orgId !== orgId) {
    throw new Error('Access denied: the app belongs to a different organization');
  }

  const blueprintRow = await docClient.send(
    new GetCommand({ TableName: workflowsTable(), Key: { workflowId: blueprintId } }),
  );
  if (!blueprintRow.Item) {
    throw new Error('Blueprint not found');
  }
  if (blueprintRow.Item.orgId !== orgId) {
    throw new Error('Access denied: the blueprint belongs to a different organization');
  }

  // agentMapping is the identity mapping — intake blueprints are composed
  // with REAL registry recordIds, never placeholders.
  return importBlueprint(blueprintId, appId, name, {}, userId, event);
}

const KNOWN_FIELDS = new Set([
  'intakeActivateProjectAgents',
  'intakeCreateApp',
  'intakeCreateBlueprint',
  'intakeImportBlueprintToApp',
]);

export const handler = async (event: IntakeOrchestrationEvent): Promise<unknown> => {
  const fieldName = event.info.fieldName;
  const args = event.arguments ?? {};

  if (!isIamIdentity(event.identity)) {
    throw new Error(`Forbidden: ${fieldName} is IAM-only`);
  }
  if (!KNOWN_FIELDS.has(fieldName)) {
    throw new Error(`Unknown field: ${fieldName}`);
  }

  const userId = getUserId(event.identity);
  const sessionId = requireId(args.sessionId, 'sessionId');
  log(fieldName, sessionId, { argKeys: Object.keys(args) });

  try {
    switch (fieldName) {
      case 'intakeActivateProjectAgents':
        return await intakeActivateProjectAgents(sessionId);
      case 'intakeCreateApp':
        return await intakeCreateApp(sessionId, args.name, args.description, userId);
      case 'intakeCreateBlueprint':
        return await intakeCreateBlueprint(sessionId, args.name, args.definition, userId, event);
      default:
        return await intakeImportBlueprintToApp(
          sessionId,
          args.blueprintId,
          args.appId,
          args.name,
          userId,
          event,
        );
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        resolver: 'intake-orchestration-resolver',
        fieldName,
        correlationId: sessionId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    throw error;
  }
};
