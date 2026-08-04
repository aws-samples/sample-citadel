/**
 * EvalSuite / EvalCase resolver (CIT-101).
 *
 * Structural mirror of execspec-resolver.ts. Eval suites are release
 * evidence, governed exactly like ExecutionSpecifications: architect
 * authors (create/update/delete/addCase/updateCase/import/clone), architect
 * approves/freezes (admin retains both via the hasPermission bypass) — see
 * backend/src/utils/auth.ts eval:author / eval:approve / eval:read.
 *
 * Lifecycle transitions are validated through LifecycleManager with
 * EVALSUITE_TRANSITIONS — see backend/src/adapters/lifecycle.ts:
 *   DRAFT    -> FROZEN | ARCHIVED
 *   FROZEN   -> ARCHIVED
 *   ARCHIVED -> (terminal)
 *
 * IMMUTABILITY WRITE-PATH GUARD (the story's acceptance property):
 * every case-mutating or suite-content-mutating operation
 * (updateEvalSuite, addEvalCase, updateEvalCase, deleteEvalCase,
 * importReplayAsEvalCase) MUST first load the parent suite and reject if
 * status === 'FROZEN' OR references.length > 0, throwing a ValidationError
 * BEFORE any DDB write. This mirrors assert_spec_approved
 * (arbiter/fabricator/tools_config.py:197-234): a referenced/frozen
 * artifact is read-only to consumers, enforced on the write path itself
 * (not just via lifecycle), so it holds against direct case edits too.
 *
 * Optimistic concurrency: every mutating write asserts the current DDB
 * version with a ConditionExpression on the `version` attribute.
 *
 * freezeEvalSuite implements audit-before-auth (execspec-resolver.ts
 * rejectExecutionSpecification parity): structured console.log lines
 * (phase='audit' -> PENDING, phase='audit-outcome' -> ALLOWED | DENIED)
 * bracket the permission check so denied freeze attempts are still
 * durable in CloudWatch (no dedicated audit table provisioned in this
 * story, same trade-off as execspec-resolver).
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  QueryCommand,
  DeleteCommand,
} from "@aws-sdk/lib-dynamodb";
import { v4 as uuidv4 } from "uuid";
import { createHash } from "crypto";
import { LifecycleManager, EVALSUITE_TRANSITIONS } from "../adapters/lifecycle";
import { emitGovernanceEvent } from "../utils/notifier-base";
import { hasPermission } from "../utils/auth";
import { sanitizeUntrustedJson } from "../utils/sanitize-untrusted-json";
import type {
  AuthContext,
  EvalSuite,
  EvalSuiteInput,
  EvalCase,
  EvalCaseInput,
  EvalSuiteStatusLiteral,
  GovernanceEventIdentity,
  GovernanceResolverEvent,
} from "../types";

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const EVAL_SUITES_TABLE = process.env.EVAL_SUITES_TABLE!;
const EVAL_CASES_TABLE = process.env.EVAL_CASES_TABLE!;
const evalSuiteLifecycle = new LifecycleManager(EVALSUITE_TRANSITIONS);

/** REPLAY_SCHEMA_VERSION major pin — see replay-package-builder.ts. Kept as
 * a local literal (rather than importing the builder module, which pulls in
 * DynamoDB read helpers this Lambda doesn't need) so the accepted major is
 * a single, greppable source of truth. */
const REPLAY_SCHEMA_MAJOR = "1";

/** Size caps per §3 validation seam. Guide: 256 KiB per large JSON field,
 * total row budget < 400 KiB DDB item limit. */
const MAX_JSON_FIELD_BYTES = 256 * 1024;
const MAX_TOOL_LIST_LENGTH = 50;

/** Merged view of every argument this resolver's fields receive. */
interface EvalResolverArguments {
  input: EvalSuiteInput & EvalCaseInput;
  suiteId: string;
  caseId: string;
  orgId: string;
  agentTargetId: string;
  semver: string;
  referenceId: string;
  package: unknown;
}

type EvalResolverEvent = GovernanceResolverEvent<EvalResolverArguments>;

function authContextFromEvent(event: EvalResolverEvent): AuthContext {
  const identity: GovernanceEventIdentity = event?.identity || {};
  const claimRole = identity["custom:role"] ?? identity.claims?.["custom:role"];
  return {
    userId: identity.sub || identity.username || "anonymous",
    username: identity.username,
    groups: identity["cognito:groups"] || [],
    roles: claimRole ? [claimRole] : [],
  };
}

/**
 * Truncate long string values in event.arguments so that error logs cannot
 * be weaponised to exfiltrate long payloads. Non-string values pass through.
 */
function sanitizeForLog(input: unknown): unknown {
  if (!input || typeof input !== "object") return input;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    out[k] =
      typeof v === "string" && v.length > 200 ? v.slice(0, 200) + "…" : v;
  }
  return out;
}

function requireEvalAuthorPermission(
  authContext: AuthContext,
  action: string,
): void {
  if (!hasPermission(authContext, "eval:author")) {
    throw new Error(
      `UnauthorizedError: eval:author permission required to ${action}`,
    );
  }
}

function requireEvalApprovePermission(
  authContext: AuthContext,
  action: string,
): void {
  if (!hasPermission(authContext, "eval:approve")) {
    throw new Error(
      `UnauthorizedError: eval:approve permission required to ${action}`,
    );
  }
}

function validateSuiteInput(input: EvalSuiteInput): void {
  if (typeof input.orgId !== "string" || !input.orgId) {
    throw new Error("ValidationError: orgId is required");
  }
  if (typeof input.agentTargetId !== "string" || !input.agentTargetId) {
    throw new Error("ValidationError: agentTargetId is required");
  }
  if (typeof input.name !== "string" || !input.name) {
    throw new Error("ValidationError: name is required");
  }
  if (typeof input.semver !== "string" || !input.semver) {
    throw new Error("ValidationError: semver is required");
  }
}

function assertWithinSizeCap(label: string, value: unknown): void {
  if (value === undefined || value === null) return;
  const size = Buffer.byteLength(
    typeof value === "string" ? value : JSON.stringify(value),
    "utf8",
  );
  if (size > MAX_JSON_FIELD_BYTES) {
    throw new Error(
      `ValidationError: ${label} exceeds maximum size of ${MAX_JSON_FIELD_BYTES} bytes`,
    );
  }
}

function validateCaseInput(input: EvalCaseInput): void {
  if (typeof input.name !== "string" || !input.name) {
    throw new Error("ValidationError: name is required");
  }
  if (input.kind !== "CONVERSATION" && input.kind !== "EXECUTION") {
    throw new Error("ValidationError: kind must be CONVERSATION or EXECUTION");
  }
  if (!input.expectedOutcome || typeof input.expectedOutcome !== "object") {
    throw new Error("ValidationError: expectedOutcome is required");
  }
  if (
    input.requiredTools &&
    input.requiredTools.length > MAX_TOOL_LIST_LENGTH
  ) {
    throw new Error(
      `ValidationError: requiredTools exceeds maximum of ${MAX_TOOL_LIST_LENGTH} entries`,
    );
  }
  if (
    input.forbiddenTools &&
    input.forbiddenTools.length > MAX_TOOL_LIST_LENGTH
  ) {
    throw new Error(
      `ValidationError: forbiddenTools exceeds maximum of ${MAX_TOOL_LIST_LENGTH} entries`,
    );
  }
  assertWithinSizeCap("input.structuredInput", input.input?.structuredInput);
  assertWithinSizeCap("input.transcript", input.input?.transcript);
  assertWithinSizeCap("expectedOutcome", input.expectedOutcome);
  assertWithinSizeCap("trajectorySpec", input.trajectorySpec);
}

// ── Immutability write-path guard ─────────────────────────────────────────

/**
 * Load the parent suite and reject BEFORE any DDB write if it is FROZEN or
 * referenced. Every mutating operation on a suite's content or its cases
 * routes through this guard first. Returns the loaded suite so callers
 * don't re-fetch.
 */
async function assertSuiteMutable(suiteId: string): Promise<EvalSuite> {
  const suite = await getEvalSuite(suiteId);
  if (!suite) {
    throw new Error(`EvalSuite not found: ${suiteId}`);
  }
  if (suite.status === "FROZEN" || (suite.references?.length ?? 0) > 0) {
    throw new Error(
      `ValidationError: eval suite ${suiteId} is frozen/referenced and cannot be mutated`,
    );
  }
  return suite;
}

// ── EvalSuite CRUD ─────────────────────────────────────────────────────────

export async function createEvalSuite(
  input: EvalSuiteInput,
  authContext: AuthContext,
): Promise<EvalSuite> {
  requireEvalAuthorPermission(authContext, "create eval suites");
  validateSuiteInput(input);

  const now = new Date().toISOString();
  const suite: EvalSuite = {
    suiteId: uuidv4(),
    orgId: input.orgId,
    agentTargetId: input.agentTargetId,
    name: input.name,
    description: input.description ?? "",
    semver: input.semver,
    status: "DRAFT",
    version: 1,
    references: [],
    createdAt: now,
    createdBy: authContext.userId,
    updatedAt: now,
  };

  await docClient.send(
    new PutCommand({
      TableName: EVAL_SUITES_TABLE,
      Item: suite,
      ConditionExpression: "attribute_not_exists(suiteId)",
    }),
  );
  return suite;
}

export async function getEvalSuite(suiteId: string): Promise<EvalSuite | null> {
  const res = await docClient.send(
    new GetCommand({ TableName: EVAL_SUITES_TABLE, Key: { suiteId } }),
  );
  return (res.Item as EvalSuite | undefined) ?? null;
}

export async function listEvalSuites(
  orgId: string,
  agentTargetId?: string,
): Promise<EvalSuite[]> {
  if (agentTargetId) {
    const res = await docClient.send(
      new QueryCommand({
        TableName: EVAL_SUITES_TABLE,
        IndexName: "agent-target-index",
        KeyConditionExpression: "agentTargetId = :aid",
        ExpressionAttributeValues: { ":aid": agentTargetId },
      }),
    );
    return (res.Items as EvalSuite[] | undefined) ?? [];
  }
  const res = await docClient.send(
    new QueryCommand({
      TableName: EVAL_SUITES_TABLE,
      IndexName: "org-index",
      KeyConditionExpression: "orgId = :oid",
      ExpressionAttributeValues: { ":oid": orgId },
    }),
  );
  return (res.Items as EvalSuite[] | undefined) ?? [];
}

async function updateSuiteStatus(
  suiteId: string,
  currentVersion: number,
  nextStatus: EvalSuiteStatusLiteral,
  extraSet: Record<string, unknown> = {},
): Promise<EvalSuite> {
  const now = new Date().toISOString();
  const setParts: string[] = [
    "#status = :newStatus",
    "#version = :newVersion",
    "#updatedAt = :updatedAt",
  ];
  const exprNames: Record<string, string> = {
    "#status": "status",
    "#version": "version",
    "#updatedAt": "updatedAt",
  };
  const exprValues: Record<string, unknown> = {
    ":newStatus": nextStatus,
    ":newVersion": currentVersion + 1,
    ":currentVersion": currentVersion,
    ":updatedAt": now,
  };
  for (const [k, v] of Object.entries(extraSet)) {
    const nameKey = `#${k}`;
    const valueKey = `:${k}`;
    exprNames[nameKey] = k;
    exprValues[valueKey] = v;
    setParts.push(`${nameKey} = ${valueKey}`);
  }
  const res = await docClient.send(
    new UpdateCommand({
      TableName: EVAL_SUITES_TABLE,
      Key: { suiteId },
      UpdateExpression: "SET " + setParts.join(", "),
      ConditionExpression: "#version = :currentVersion",
      ExpressionAttributeNames: exprNames,
      ExpressionAttributeValues: exprValues,
      ReturnValues: "ALL_NEW",
    }),
  );
  return res.Attributes as EvalSuite;
}

/** Generic field-level update used by updateEvalSuite and
 * markEvalSuiteReferenced — separate from updateSuiteStatus (status
 * transitions route through the lifecycle guard; field updates do not
 * change status). */
async function updateSuiteFields(
  suiteId: string,
  currentVersion: number,
  fields: Record<string, unknown>,
): Promise<EvalSuite> {
  const now = new Date().toISOString();
  const allFields = { ...fields, updatedAt: now };
  const setParts: string[] = ["#version = :newVersion"];
  const exprNames: Record<string, string> = { "#version": "version" };
  const exprValues: Record<string, unknown> = {
    ":newVersion": currentVersion + 1,
    ":currentVersion": currentVersion,
  };
  for (const [k, v] of Object.entries(allFields)) {
    const nameKey = `#${k}`;
    const valueKey = `:${k}`;
    exprNames[nameKey] = k;
    exprValues[valueKey] = v;
    setParts.push(`${nameKey} = ${valueKey}`);
  }
  const res = await docClient.send(
    new UpdateCommand({
      TableName: EVAL_SUITES_TABLE,
      Key: { suiteId },
      UpdateExpression: "SET " + setParts.join(", "),
      ConditionExpression: "#version = :currentVersion",
      ExpressionAttributeNames: exprNames,
      ExpressionAttributeValues: exprValues,
      ReturnValues: "ALL_NEW",
    }),
  );
  return res.Attributes as EvalSuite;
}

export async function updateEvalSuite(
  suiteId: string,
  input: EvalSuiteInput,
  authContext: AuthContext,
): Promise<EvalSuite> {
  requireEvalAuthorPermission(authContext, "update eval suites");
  validateSuiteInput(input);
  // Immutability guard FIRST — before any write, mirrors assert_spec_approved.
  const suite = await assertSuiteMutable(suiteId);
  return updateSuiteFields(suiteId, suite.version, {
    orgId: input.orgId,
    agentTargetId: input.agentTargetId,
    name: input.name,
    description: input.description ?? "",
    semver: input.semver,
  });
}

export async function freezeEvalSuite(
  suiteId: string,
  authContext: AuthContext,
): Promise<EvalSuite> {
  // AUDIT-BEFORE-AUTH per execspec-resolver rejectExecutionSpecification
  // parity — a governance freeze/approve action needs a durable trail
  // regardless of outcome.
  const suite = await getEvalSuite(suiteId);
  const orgId = suite?.orgId ?? "";
  const attemptId = uuidv4();
  const attemptedAt = new Date().toISOString();

  console.log({
    phase: "audit",
    attemptId,
    suiteId,
    orgId,
    attemptedBy: authContext.userId,
    attemptedAt,
    authResult: "PENDING",
  });

  const authorised = hasPermission(authContext, "eval:approve");

  console.log({
    phase: "audit-outcome",
    attemptId,
    suiteId,
    attemptedBy: authContext.userId,
    authResult: authorised ? "ALLOWED" : "DENIED",
  });

  if (!authorised) {
    throw new Error(
      "UnauthorizedError: eval:approve permission required to freeze eval suites",
    );
  }
  if (!suite) {
    throw new Error(`EvalSuite not found: ${suiteId}`);
  }
  evalSuiteLifecycle.validateTransition(suite.status, "FROZEN");

  const updated = await updateSuiteStatus(suiteId, suite.version, "FROZEN", {
    frozenAt: attemptedAt,
    frozenBy: authContext.userId,
  });

  await emitGovernanceEvent("governance.eval.suite.frozen", {
    orgId: updated.orgId,
    suiteId: updated.suiteId,
    frozenBy: authContext.userId,
    version: updated.version,
  });

  return updated;
}

export async function archiveEvalSuite(
  suiteId: string,
  authContext: AuthContext,
): Promise<EvalSuite> {
  requireEvalAuthorPermission(authContext, "archive eval suites");
  const suite = await getEvalSuite(suiteId);
  if (!suite) {
    throw new Error(`EvalSuite not found: ${suiteId}`);
  }
  evalSuiteLifecycle.validateTransition(suite.status, "ARCHIVED");
  return updateSuiteStatus(suiteId, suite.version, "ARCHIVED");
}

export async function cloneEvalSuite(
  suiteId: string,
  semver: string,
  authContext: AuthContext,
): Promise<EvalSuite> {
  requireEvalAuthorPermission(authContext, "clone eval suites");
  const source = await getEvalSuite(suiteId);
  if (!source) {
    throw new Error(`EvalSuite not found: ${suiteId}`);
  }
  const cases = await listEvalCases(suiteId);

  const now = new Date().toISOString();
  const newSuiteId = uuidv4();
  const cloned: EvalSuite = {
    suiteId: newSuiteId,
    orgId: source.orgId,
    agentTargetId: source.agentTargetId,
    name: source.name,
    description: source.description,
    semver,
    status: "DRAFT",
    version: 1,
    references: [],
    parentSuiteId: suiteId,
    createdAt: now,
    createdBy: authContext.userId,
    updatedAt: now,
  };

  await docClient.send(
    new PutCommand({
      TableName: EVAL_SUITES_TABLE,
      Item: cloned,
      ConditionExpression: "attribute_not_exists(suiteId)",
    }),
  );

  for (const c of cases) {
    const clonedCase: EvalCase = {
      ...c,
      suiteId: newSuiteId,
      caseId: uuidv4(),
      version: 1,
      createdAt: now,
      createdBy: authContext.userId,
      updatedAt: now,
    };
    await docClient.send(
      new PutCommand({
        TableName: EVAL_CASES_TABLE,
        Item: clonedCase,
        ConditionExpression: "attribute_not_exists(caseId)",
      }),
    );
  }

  return cloned;
}

export async function markEvalSuiteReferenced(
  suiteId: string,
  referenceId: string,
  authContext: AuthContext,
): Promise<EvalSuite> {
  requireEvalApprovePermission(authContext, "mark eval suites referenced");
  const suite = await getEvalSuite(suiteId);
  if (!suite) {
    throw new Error(`EvalSuite not found: ${suiteId}`);
  }
  const nextReferences = Array.from(
    new Set([...(suite.references ?? []), referenceId]),
  );
  return updateSuiteFields(suiteId, suite.version, {
    references: nextReferences,
  });
}

// ── EvalCase CRUD ──────────────────────────────────────────────────────────

export async function addEvalCase(
  suiteId: string,
  input: EvalCaseInput,
  authContext: AuthContext,
): Promise<EvalCase> {
  requireEvalAuthorPermission(authContext, "add eval cases");
  validateCaseInput(input);
  // Immutability guard FIRST — before any write.
  await assertSuiteMutable(suiteId);

  const now = new Date().toISOString();
  const evalCase: EvalCase = {
    suiteId,
    caseId: uuidv4(),
    name: input.name,
    description: input.description ?? "",
    kind: input.kind,
    input: input.input,
    expectedOutcome: input.expectedOutcome,
    requiredTools: input.requiredTools ?? [],
    forbiddenTools: input.forbiddenTools ?? [],
    expectedPolicyOutcome: input.expectedPolicyOutcome,
    groundingRequirements: input.groundingRequirements,
    maxLatencyMs: input.maxLatencyMs,
    maxCostUsd: input.maxCostUsd,
    trajectorySpec: input.trajectorySpec,
    provenance: { source: "AUTHORED", producerCommit: null },
    version: 1,
    createdAt: now,
    createdBy: authContext.userId,
    updatedAt: now,
  };

  await docClient.send(
    new PutCommand({
      TableName: EVAL_CASES_TABLE,
      Item: evalCase,
      ConditionExpression: "attribute_not_exists(caseId)",
    }),
  );
  return evalCase;
}

export async function getEvalCase(
  suiteId: string,
  caseId: string,
): Promise<EvalCase | null> {
  const res = await docClient.send(
    new GetCommand({ TableName: EVAL_CASES_TABLE, Key: { suiteId, caseId } }),
  );
  return (res.Item as EvalCase | undefined) ?? null;
}

export async function listEvalCases(suiteId: string): Promise<EvalCase[]> {
  const res = await docClient.send(
    new QueryCommand({
      TableName: EVAL_CASES_TABLE,
      KeyConditionExpression: "suiteId = :sid",
      ExpressionAttributeValues: { ":sid": suiteId },
    }),
  );
  return (res.Items as EvalCase[] | undefined) ?? [];
}

export async function updateEvalCase(
  suiteId: string,
  caseId: string,
  input: EvalCaseInput,
  authContext: AuthContext,
): Promise<EvalCase> {
  requireEvalAuthorPermission(authContext, "update eval cases");
  validateCaseInput(input);
  // Immutability guard FIRST — before any write.
  await assertSuiteMutable(suiteId);

  const existing = await getEvalCase(suiteId, caseId);
  if (!existing) {
    throw new Error(`EvalCase not found: ${suiteId}/${caseId}`);
  }

  const now = new Date().toISOString();
  const setParts: string[] = [
    "#version = :newVersion",
    "#updatedAt = :updatedAt",
  ];
  const exprNames: Record<string, string> = {
    "#version": "version",
    "#updatedAt": "updatedAt",
  };
  const exprValues: Record<string, unknown> = {
    ":newVersion": existing.version + 1,
    ":currentVersion": existing.version,
    ":updatedAt": now,
  };
  const fields: Record<string, unknown> = {
    name: input.name,
    description: input.description ?? "",
    kind: input.kind,
    input: input.input,
    expectedOutcome: input.expectedOutcome,
    requiredTools: input.requiredTools ?? [],
    forbiddenTools: input.forbiddenTools ?? [],
    expectedPolicyOutcome: input.expectedPolicyOutcome,
    groundingRequirements: input.groundingRequirements,
    maxLatencyMs: input.maxLatencyMs,
    maxCostUsd: input.maxCostUsd,
    trajectorySpec: input.trajectorySpec,
  };
  for (const [k, v] of Object.entries(fields)) {
    const nameKey = `#${k}`;
    const valueKey = `:${k}`;
    exprNames[nameKey] = k;
    exprValues[valueKey] = v;
    setParts.push(`${nameKey} = ${valueKey}`);
  }

  const res = await docClient.send(
    new UpdateCommand({
      TableName: EVAL_CASES_TABLE,
      Key: { suiteId, caseId },
      UpdateExpression: "SET " + setParts.join(", "),
      ConditionExpression: "#version = :currentVersion",
      ExpressionAttributeNames: exprNames,
      ExpressionAttributeValues: exprValues,
      ReturnValues: "ALL_NEW",
    }),
  );
  return res.Attributes as EvalCase;
}

export async function deleteEvalCase(
  suiteId: string,
  caseId: string,
  authContext: AuthContext,
): Promise<{ success: boolean }> {
  requireEvalAuthorPermission(authContext, "delete eval cases");
  // Immutability guard FIRST — before any write.
  await assertSuiteMutable(suiteId);

  await docClient.send(
    new DeleteCommand({
      TableName: EVAL_CASES_TABLE,
      Key: { suiteId, caseId },
    }),
  );
  return { success: true };
}

// ── Replay import ──────────────────────────────────────────────────────────

interface ReplayEnvelopeShape {
  schemaVersion?: string;
  producerCommit?: string | null;
  kind?: "execution" | "conversation";
  correlationId?: string;
  sections?: {
    nodes?: Array<{ nodeId?: string; outputs?: unknown }>;
    toolResults?: { partial?: boolean; results?: unknown[] };
    findings?: unknown[] | { partial?: boolean };
    messages?: Array<{ role?: string; content?: string }>;
  };
}

function sha256Hex(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/**
 * Maps a ReplayPackageEnvelope (unchanged, per docs/REPLAY_PACKAGE.md's
 * eval-ingestion contract) into an EvalCaseInput-shaped payload plus
 * provenance. Pure function — no DDB access — so it's independently
 * testable against the real fixture.
 */
export function mapReplayPackageToEvalCase(pkg: unknown): {
  kind: "CONVERSATION" | "EXECUTION";
  input: {
    prompt?: string | null;
    transcript?: Array<{ role: string; content: string }>;
    structuredInput: string | null;
  };
  expectedOutcome: { mode: "CONTAINS" | "JSON_SUBSET"; target: string };
  requiredTools: string[];
  expectedPolicyOutcome?: {
    decision: "PERMIT" | "DENY" | "ESCALATE";
    findingTypes: string[];
  };
  provenance: {
    source: "IMPORTED_FROM_REPLAY";
    packageHash: string;
    producerCommit: string | null;
    correlationId?: string;
    importedAt: string;
    toolResultsPartial?: boolean;
    note?: string;
  };
} {
  const envelope = pkg as ReplayEnvelopeShape;

  // schemaVersion MAJOR pin — minor/patch tolerated.
  const schemaVersion =
    typeof envelope.schemaVersion === "string" ? envelope.schemaVersion : "";
  const major = schemaVersion.split(".")[0];
  if (major !== REPLAY_SCHEMA_MAJOR) {
    throw new Error(
      `ValidationError: unsupported replay schemaVersion ${schemaVersion || "(missing)"}`,
    );
  }

  // Sanitize the untrusted import payload structurally before deriving fields.
  const sanitized = sanitizeUntrustedJson(pkg).value as ReplayEnvelopeShape;

  const packageHash = sha256Hex(pkg);
  const importedAt = new Date().toISOString();
  // producerCommit null = unknown provenance; stored as-is (not rejected).
  const producerCommit =
    typeof sanitized.producerCommit === "string"
      ? sanitized.producerCommit
      : null;

  const sections = sanitized.sections ?? {};
  const toolResults = sections.toolResults;
  const toolResultsPartial = toolResults?.partial === true;
  // Never assume `results` is populated when partial — derive requiredTools
  // only from a genuinely non-empty results array.
  const requiredTools =
    !toolResultsPartial &&
    Array.isArray(toolResults?.results) &&
    toolResults.results.length > 0
      ? (toolResults.results as Array<{ tool?: string }>)
          .map((r) => r.tool)
          .filter((t): t is string => typeof t === "string")
      : [];

  const findingsSection = sections.findings;
  const findingsIsArray = Array.isArray(findingsSection);
  let expectedPolicyOutcome:
    | { decision: "PERMIT" | "DENY" | "ESCALATE"; findingTypes: string[] }
    | undefined;
  if (findingsIsArray && (findingsSection as unknown[]).length > 0) {
    const first = (findingsSection as Array<{ decision?: string }>)[0];
    if (
      first?.decision === "PERMIT" ||
      first?.decision === "DENY" ||
      first?.decision === "ESCALATE"
    ) {
      expectedPolicyOutcome = {
        decision: first.decision,
        findingTypes: (findingsSection as Array<{ decision?: string }>)
          .map((f) => (f as { decision?: string }).decision)
          .filter((d): d is string => typeof d === "string"),
      };
    }
  }
  // findings partial-marker object (conversation, no join key) -> skip derivation
  // (handled implicitly: findingsIsArray is false in that case).

  if (envelope.kind === "conversation") {
    const rawMessages = sections.messages ?? [];
    const firstUserMessage =
      rawMessages.find((m) => m.role === "user")?.content ?? null;
    // Normalize to required-field shape (TranscriptMessage requires
    // role/content as non-optional strings); untrusted/malformed entries
    // fall back to empty strings rather than being dropped, preserving
    // message ordering/count for the imported transcript.
    const messages = rawMessages.map((m) => ({
      role: typeof m.role === "string" ? m.role : "",
      content: typeof m.content === "string" ? m.content : "",
    }));
    return {
      kind: "CONVERSATION",
      input: {
        prompt: firstUserMessage,
        transcript: messages,
        structuredInput: null,
      },
      expectedOutcome: { mode: "CONTAINS", target: firstUserMessage ?? "" },
      requiredTools,
      expectedPolicyOutcome,
      provenance: {
        source: "IMPORTED_FROM_REPLAY",
        packageHash,
        producerCommit,
        correlationId: sanitized.correlationId,
        importedAt,
        toolResultsPartial,
      },
    };
  }

  // EXECUTION kind — honest v1 limitation: nodes[].inputs is null upstream
  // (replay-package-builder.ts:474), so structuredInput stays null and a
  // limitation note is stamped. expectedOutcome is derived from
  // nodes[].outputs (best-effort JSON_SUBSET match target).
  const nodes = sections.nodes ?? [];
  const firstOutput = nodes.find(
    (n) => n.outputs !== undefined && n.outputs !== null,
  )?.outputs;
  const outcomeTarget =
    typeof firstOutput === "string"
      ? firstOutput
      : firstOutput !== undefined
        ? JSON.stringify(firstOutput)
        : "";

  return {
    kind: "EXECUTION",
    input: { structuredInput: null },
    expectedOutcome: { mode: "JSON_SUBSET", target: outcomeTarget },
    requiredTools,
    expectedPolicyOutcome,
    provenance: {
      source: "IMPORTED_FROM_REPLAY",
      packageHash,
      producerCommit,
      correlationId: sanitized.correlationId,
      importedAt,
      toolResultsPartial,
      note:
        "execution-kind input unavailable (nodes[].inputs null upstream); " +
        "assertions limited to outputs/tools/findings/usage",
    },
  };
}

export async function importReplayAsEvalCase(
  suiteId: string,
  pkg: unknown,
  authContext: AuthContext,
): Promise<EvalCase> {
  requireEvalAuthorPermission(
    authContext,
    "import replay packages as eval cases",
  );
  // Immutability guard FIRST — before any write. Import into a frozen suite
  // is rejected by the same guard as any other mutation.
  await assertSuiteMutable(suiteId);

  const mapped = mapReplayPackageToEvalCase(pkg);
  const now = new Date().toISOString();
  const evalCase: EvalCase = {
    suiteId,
    caseId: uuidv4(),
    name: `imported-${mapped.provenance.correlationId ?? uuidv4()}`,
    description: "Imported from replay package",
    kind: mapped.kind,
    input: mapped.input,
    expectedOutcome: mapped.expectedOutcome,
    requiredTools: mapped.requiredTools,
    forbiddenTools: [],
    expectedPolicyOutcome: mapped.expectedPolicyOutcome,
    provenance: mapped.provenance,
    version: 1,
    createdAt: now,
    createdBy: authContext.userId,
    updatedAt: now,
  };

  await docClient.send(
    new PutCommand({
      TableName: EVAL_CASES_TABLE,
      Item: evalCase,
      ConditionExpression: "attribute_not_exists(caseId)",
    }),
  );
  return evalCase;
}

// ── Handler dispatch ────────────────────────────────────────────────────────

export const handler = async (event: EvalResolverEvent): Promise<unknown> => {
  const fieldName = event?.info?.fieldName;
  const authContext = authContextFromEvent(event);
  try {
    switch (fieldName) {
      case "createEvalSuite":
        return await createEvalSuite(
          event.arguments.input as EvalSuiteInput,
          authContext,
        );
      case "updateEvalSuite":
        return await updateEvalSuite(
          event.arguments.suiteId,
          event.arguments.input as EvalSuiteInput,
          authContext,
        );
      case "freezeEvalSuite":
        return await freezeEvalSuite(event.arguments.suiteId, authContext);
      case "archiveEvalSuite":
        return await archiveEvalSuite(event.arguments.suiteId, authContext);
      case "cloneEvalSuite":
        return await cloneEvalSuite(
          event.arguments.suiteId,
          event.arguments.semver,
          authContext,
        );
      case "markEvalSuiteReferenced":
        return await markEvalSuiteReferenced(
          event.arguments.suiteId,
          event.arguments.referenceId,
          authContext,
        );
      case "addEvalCase":
        return await addEvalCase(
          event.arguments.suiteId,
          event.arguments.input as EvalCaseInput,
          authContext,
        );
      case "updateEvalCase":
        return await updateEvalCase(
          event.arguments.suiteId,
          event.arguments.caseId,
          event.arguments.input as EvalCaseInput,
          authContext,
        );
      case "deleteEvalCase":
        return await deleteEvalCase(
          event.arguments.suiteId,
          event.arguments.caseId,
          authContext,
        );
      case "importReplayAsEvalCase":
        return await importReplayAsEvalCase(
          event.arguments.suiteId,
          event.arguments.package,
          authContext,
        );
      case "getEvalSuite":
        return await getEvalSuite(event.arguments.suiteId);
      case "listEvalSuites":
        return await listEvalSuites(
          event.arguments.orgId,
          event.arguments.agentTargetId,
        );
      case "listEvalCases":
        return await listEvalCases(event.arguments.suiteId);
      default:
        throw new Error(`Unsupported field: ${fieldName}`);
    }
  } catch (err: unknown) {
    console.error("eval-resolver error", {
      fieldName,
      message: err instanceof Error ? err.message : undefined,
      args: sanitizeForLog(event?.arguments),
    });
    throw err;
  }
};
