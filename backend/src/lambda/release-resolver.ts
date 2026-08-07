/**
 * release-resolver.ts — cutAgentRelease assembly operation (slice 2).
 *
 * Assembles a content-addressed AgentRelease from its constituents at cut
 * time and writes it through the slice-1 store (release-store.ts, the SOLE
 * writer for AgentReleasesTable — this module never issues a raw DDB
 * command against that table, only against ExecutionSpecificationsTable/
 * EvalRunsTable/EvalSuitesTable for read-side validation and the suite
 * reference freeze).
 *
 * Snapshot vs pin-by-reference (design's Class A / Class B split, mirrored
 * from AgentReleaseConstituents in ../types):
 *   - Class B (mutable at cut time, so SNAPSHOTTED inline): agentConfig,
 *     promptVersions, modelConfigSnapshots, toolConfigs, policySnapshot.
 *     The caller supplies these already-resolved snapshots except
 *     agentConfig, which this resolver derives from the registry record
 *     itself (content = customDescriptorContent, digest = sha256 of that
 *     content) so the release can't drift from what was actually
 *     validated.
 *   - Class A (already frozen/terminal, so PINNED BY REFERENCE):
 *     execSpecId/execSpecVersion (an APPROVED ExecutionSpecification is
 *     terminal — see lifecycle.ts EXECSPEC_TRANSITIONS) and evalEvidence
 *     (evalRunId/evalSuiteId/evalSuiteVersion — EvalRun rows are
 *     append-only and the suite is frozen-by-reference via
 *     markEvalSuiteReferenced below, never snapshotted).
 *
 * Validation order — permission check, then EVERY structural/status/org
 * check, ALL before hashing or any write (design requirement: "validate
 * BEFORE hashing/storing"). Cross-org references are treated as a security
 * rejection (thrown as a distinct error text), not folded into the generic
 * ValidationError bucket, so callers/logs can distinguish "malformed
 * input" from "attempted to pin another tenant's evidence".
 *
 * Org-check scope: RegistryRecord (via customDescriptorContent.orgId),
 * EvalRun (via its own orgId field), and EvalSuite (via its own orgId
 * field) all carry an orgId in this codebase and are checked against the
 * caller's org — each fails CLOSED (rejects) when the org cannot be
 * determined, never open. The registry record's descriptor-derived org
 * check in particular used to fail OPEN when the descriptor lacked an
 * orgId; it now rejects in that case, consistent with every other check
 * here.
 *
 * ExecutionSpecification does NOT carry an orgId field directly anywhere
 * in this codebase (see ../types.ts — it only has projectId, and Project
 * itself has no orgId field either). That does NOT make the exec spec's
 * org boundary inexpressible: an indirect path exists via
 * Project.owner -> lookupUserOrganization (../utils/auth-event.ts), the
 * exact derivation already used in production by
 * intake-orchestration-resolver.ts's resolveOrgId() (project-owner
 * fallback for org-less project rows). This module uses that same
 * precedented path to resolve the exec spec's org and reject a
 * cross-org exec spec. Consistent with this codebase's fail-closed gate
 * doctrine, if the project cannot be found, or the owner's org cannot be
 * resolved (no USER_POOL_ID, Cognito lookup failure, or no
 * custom:organization attribute), the cut is REFUSED — never
 * warn-and-proceed.
 *
 * The release's own orgId field is DERIVED from callerOrgId, not trusted
 * from caller-supplied input — input.orgId is a forgeable label and is
 * never stored verbatim.
 *
 * ORDERING / PARTIAL FAILURE (store-then-freeze, never the reverse):
 * putRelease() is called BEFORE markEvalSuiteReferenced(). If the release
 * put succeeds but the suite-freeze update then fails, the release row
 * exists durably while its evidence's suite is still technically mutable
 * (not yet marked referenced) — a real residual risk, but a strictly
 * smaller one than the alternative ordering. Freezing first and then
 * failing to store the release would leave an over-frozen suite (harmless
 * — freezing is monotonic and idempotent, and a suite gains nothing but a
 * reference id it doesn't strictly need yet) while ALSO not producing the
 * release at all, so the caller has nothing to retry against and no
 * record of intent. Store-then-freeze means: (a) the release, once
 * stored, is the durable source of truth callers care about, and (b) a
 * freeze failure is NOT swallowed — it propagates as a thrown error (see
 * the try/finally-free straight propagation below), making the gap
 * observable to the caller/logs/alerting rather than silently returning a
 * "successful" release whose evidence isn't actually frozen yet. Retrying
 * the identical cutAgentRelease call is safe: putRelease is idempotent on
 * content hash (slice 1), and markEvalSuiteReferenced is idempotent on its
 * Set-based references[] update (eval-resolver.ts) — so a retry re-does
 * the (already-succeeded) store as a no-op and re-attempts the freeze.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { createHash } from "crypto";
import { hasPermission } from "../utils/auth";
import {
  extractOrgFromEvent,
  lookupUserOrganization,
} from "../utils/auth-event";
import { putRelease } from "./release-store";
import { RegistryService } from "../services/registry-service";
import type {
  AgentRelease,
  AgentReleaseConstituents,
  AuthContext,
  ContentSnapshot,
  EvalRun,
  EvalSuite,
  ExecutionSpecification,
  GovernanceEventIdentity,
  GovernanceResolverEvent,
  ModelConfigSnapshot,
  PolicySnapshot,
  Project,
} from "../types";

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

function executionSpecsTable(): string {
  return process.env.EXECUTION_SPECS_TABLE!;
}
function evalRunsTable(): string {
  return process.env.EVAL_RUNS_TABLE!;
}
function evalSuitesTable(): string {
  return process.env.EVAL_SUITES_TABLE!;
}
function projectsTable(): string {
  return process.env.PROJECTS_TABLE!;
}

let registryServiceInstance: RegistryService | null = null;

/** Shared RegistryService instance, created on first call. Mirrors
 * agent-config-resolver.ts's getRegistryService() singleton — kept
 * file-local rather than imported to avoid coupling this resolver's
 * lifecycle to that module's env-var assumptions. */
function getRegistryService(): RegistryService {
  if (!registryServiceInstance) {
    const registryId = process.env.REGISTRY_ID;
    if (!registryId) {
      throw new Error(
        "REGISTRY_ID environment variable is required to cut a release",
      );
    }
    registryServiceInstance = new RegistryService({
      registryId,
      region: process.env.AWS_REGION || "us-east-1",
    });
  }
  return registryServiceInstance;
}

/** Test-only seam mirroring agent-config-resolver.ts's _resetRegistryService. */
export function _resetRegistryService(): void {
  registryServiceInstance = null;
}

function requireReleaseCutPermission(authContext: AuthContext): void {
  if (!hasPermission(authContext, "release:cut")) {
    throw new Error(
      "UnauthorizedError: release:cut permission required to cut agent releases",
    );
  }
}

/** Input to cutAgentRelease — everything the store's AgentReleaseInput
 * needs, but expressed as references to the mutable/frozen sources rather
 * than pre-resolved constituents (agentConfig, execSpecId/Version, and
 * evalEvidence are all DERIVED below, not accepted as caller-supplied
 * data, so a caller can't smuggle in a snapshot that doesn't match what
 * was actually validated). */
export interface CutAgentReleaseInput {
  orgId: string;
  agentTargetId: string;
  semver: string;
  registryRecordId: string;
  execSpecId: string;
  evalRunId: string;
  promptVersions: Record<string, ContentSnapshot>;
  modelConfigSnapshots: ModelConfigSnapshot[];
  toolConfigs: ContentSnapshot[];
  policySnapshot: PolicySnapshot;
  gitSha: string;
  region: string;
  runId: string;
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Deferred quality-gating seam (design: "leave a validateReleaseGate()
 * seam only if it costs nothing"). Intentionally a no-op, not called from
 * cutAgentRelease — environment pointer / dispatch integration / quality
 * gating / promotion / canary / rollback / diff are all out of scope for
 * slice 2. Exists purely so a future slice has a named place to hang gate
 * logic without an interface-shape migration.
 */
export function validateReleaseGate(): void {
  // Intentionally empty — see doc comment above.
}

async function getExecutionSpecification(
  specId: string,
): Promise<ExecutionSpecification | null> {
  const res = await docClient.send(
    new GetCommand({ TableName: executionSpecsTable(), Key: { specId } }),
  );
  return (res.Item as ExecutionSpecification | undefined) ?? null;
}

async function getEvalRun(evalRunId: string): Promise<EvalRun | null> {
  const res = await docClient.send(
    new GetCommand({ TableName: evalRunsTable(), Key: { evalRunId } }),
  );
  return (res.Item as EvalRun | undefined) ?? null;
}

async function getEvalSuite(suiteId: string): Promise<EvalSuite | null> {
  const res = await docClient.send(
    new GetCommand({ TableName: evalSuitesTable(), Key: { suiteId } }),
  );
  return (res.Item as EvalSuite | undefined) ?? null;
}

async function getProjectForOrgCheck(
  projectId: string,
): Promise<Project | null> {
  const res = await docClient.send(
    new GetCommand({ TableName: projectsTable(), Key: { id: projectId } }),
  );
  return (res.Item as Project | undefined) ?? null;
}

/**
 * Resolves the org an ExecutionSpecification was created under via the
 * precedented indirect path: projectId -> Project.owner ->
 * lookupUserOrganization(owner) — the exact derivation used in production
 * by intake-orchestration-resolver.ts's resolveOrgId() (project-owner
 * fallback for org-less project rows). ExecutionSpecification has no
 * orgId field of its own, and Project itself has no orgId field either
 * (only `owner`), so this is the only available signal.
 *
 * Returns null (never throws) when the org cannot be determined — e.g.
 * the project row doesn't exist, the project has no owner, or
 * lookupUserOrganization can't resolve the owner's org (no USER_POOL_ID,
 * Cognito lookup failure, or a missing custom:organization attribute).
 * Callers of this function are responsible for treating null as a
 * rejection (fail closed), per this codebase's established gate doctrine
 * — never warn-and-proceed.
 */
async function resolveExecSpecOrgId(
  execSpec: ExecutionSpecification,
): Promise<string | null> {
  const project = await getProjectForOrgCheck(execSpec.projectId);
  if (!project?.owner) {
    return null;
  }
  return lookupUserOrganization(project.owner);
}

/**
 * Freezes the release's own evidence by marking the referenced eval suite
 * as referenced (adds evalRunId's suite reference, Set-semantics —
 * idempotent on retry). Duplicated here rather than imported from
 * eval-resolver.ts because that module's markEvalSuiteReferenced is itself
 * eval:approve-gated internally (requireEvalApprovePermission) and this
 * resolver's caller has already passed the DISTINCT release:cut gate —
 * re-running an internal eval:approve check against the SAME authContext
 * would incorrectly require the caller to hold both permissions to cut a
 * release. The write shape (Set-union UpdateExpression) is intentionally
 * identical to eval-resolver.ts's implementation.
 */
async function markEvalSuiteReferencedForRelease(
  suite: EvalSuite,
  referenceId: string,
): Promise<void> {
  const nextReferences = Array.from(
    new Set([...(suite.references ?? []), referenceId]),
  );
  await docClient.send(
    new UpdateCommand({
      TableName: evalSuitesTable(),
      Key: { suiteId: suite.suiteId },
      UpdateExpression: "SET #references = :refs",
      ExpressionAttributeNames: { "#references": "references" },
      ExpressionAttributeValues: { ":refs": nextReferences },
    }),
  );
}

export async function cutAgentRelease(
  input: CutAgentReleaseInput,
  authContext: AuthContext,
  callerOrgId: string,
): Promise<AgentRelease> {
  // Permission check FIRST — no DDB access, no Registry call, before any
  // other work (matches execspec-resolver.ts's approveExecutionSpecification
  // convention: "Permission check FIRST").
  requireReleaseCutPermission(authContext);

  // ---- Registry record (agent config) validation ----
  const record = await getRegistryService().getResource(
    "agent",
    input.registryRecordId,
  );
  if (!record) {
    throw new Error(
      `ValidationError: registry record not found: ${input.registryRecordId}`,
    );
  }
  if (record.status !== "APPROVED") {
    throw new Error(
      `ValidationError: registry record ${input.registryRecordId} must be APPROVED to cut a release (status: ${record.status})`,
    );
  }
  const recordMeta = record.customDescriptorContent
    ? (JSON.parse(record.customDescriptorContent) as { orgId?: string })
    : {};
  // Fail CLOSED: a descriptor that lacks an orgId is treated as a
  // rejection, not an all-org bypass. A missing orgId on a registry
  // descriptor must never be interpreted as "no boundary to enforce" —
  // that is exactly the fail-open hole that let a release pin a
  // descriptor with no verifiable org at all.
  if (!recordMeta.orgId) {
    throw new Error(
      `SecurityError: registry record ${input.registryRecordId}'s descriptor carries no orgId — cannot verify org ownership, refusing to cut a release against unverifiable evidence`,
    );
  }
  if (recordMeta.orgId !== callerOrgId) {
    throw new Error(
      `SecurityError: registry record ${input.registryRecordId} belongs to a different org — a release must never pin another org's evidence`,
    );
  }

  // ---- ExecutionSpecification validation ----
  const execSpec = await getExecutionSpecification(input.execSpecId);
  if (!execSpec) {
    throw new Error(
      `ValidationError: exec spec not found: ${input.execSpecId}`,
    );
  }
  if (execSpec.status !== "APPROVED") {
    throw new Error(
      `ValidationError: exec spec ${input.execSpecId} must be APPROVED to cut a release (status: ${execSpec.status})`,
    );
  }
  // Cross-org check via the precedented indirect path: exec spec has no
  // orgId field directly, but its projectId -> Project.owner ->
  // lookupUserOrganization resolves the org the spec was created under
  // (same derivation as intake-orchestration-resolver.ts's resolveOrgId()
  // project-owner fallback). Fail CLOSED at every step — project not
  // found, or the owner's org not resolvable, is a rejection, never a
  // silent pass-through.
  const execSpecOrgId = await resolveExecSpecOrgId(execSpec);
  if (!execSpecOrgId) {
    throw new Error(
      `SecurityError: exec spec ${input.execSpecId}'s owning org could not be determined (project not found or owner's organization unresolvable) — refusing to cut a release against unverifiable evidence`,
    );
  }
  if (execSpecOrgId !== callerOrgId) {
    throw new Error(
      `SecurityError: exec spec ${input.execSpecId} belongs to a different org — a release must never pin another org's evidence`,
    );
  }

  // ---- EvalRun validation ----
  const evalRun = await getEvalRun(input.evalRunId);
  if (!evalRun) {
    throw new Error(`ValidationError: eval run not found: ${input.evalRunId}`);
  }
  if (evalRun.status !== "COMPLETED") {
    throw new Error(
      `ValidationError: eval run ${input.evalRunId} must be COMPLETED to cut a release (status: ${evalRun.status})`,
    );
  }
  if (evalRun.orgId !== callerOrgId) {
    throw new Error(
      `SecurityError: eval run ${input.evalRunId} belongs to a different org — a release must never pin another org's evidence`,
    );
  }
  const evalSuite = await getEvalSuite(evalRun.suiteId);
  if (!evalSuite) {
    throw new Error(
      `ValidationError: eval suite not found for eval run ${input.evalRunId}: ${evalRun.suiteId}`,
    );
  }
  if (evalSuite.orgId !== callerOrgId) {
    throw new Error(
      `SecurityError: eval suite ${evalSuite.suiteId} belongs to a different org — the freeze step must never write to a foreign-org suite`,
    );
  }
  if (evalSuite.version !== evalRun.suiteVersion) {
    throw new Error(
      `ValidationError: eval run ${input.evalRunId}'s suiteVersion (${evalRun.suiteVersion}) does not match the current suite version (${evalSuite.version})`,
    );
  }

  // ---- Assembly: snapshot the mutable constituents, pin the frozen ones ----
  const agentConfigContent = record.customDescriptorContent ?? "{}";
  const constituents: AgentReleaseConstituents = {
    agentConfig: {
      sourceId: input.registryRecordId,
      content: agentConfigContent,
      digest: sha256(agentConfigContent),
    },
    promptVersions: input.promptVersions,
    execSpecId: execSpec.specId,
    execSpecVersion: execSpec.version,
    modelConfigSnapshots: input.modelConfigSnapshots,
    toolConfigs: input.toolConfigs,
    policySnapshot: input.policySnapshot,
    evalEvidence: {
      evalRunId: evalRun.evalRunId,
      evalSuiteId: evalRun.suiteId,
      evalSuiteVersion: evalRun.suiteVersion,
    },
  };

  // ---- Store (create-only, content-addressed, idempotent — slice 1) ----
  // orgId is DERIVED from callerOrgId, never trusted from caller-supplied
  // input.orgId — that field is a forgeable label and must not become the
  // stored record of which org actually cut the release.
  const release = await putRelease({
    ...constituents,
    orgId: callerOrgId,
    agentTargetId: input.agentTargetId,
    semver: input.semver,
    createdAt: new Date().toISOString(),
    createdBy: authContext.userId,
    gitSha: input.gitSha,
    region: input.region,
    runId: input.runId,
  });

  // ---- Freeze the release's own evidence (fail-safe ordering — see
  // module doc comment: store-then-freeze, and a freeze failure here
  // propagates rather than being swallowed). ----
  await markEvalSuiteReferencedForRelease(evalSuite, evalRun.evalRunId);

  return release;
}

/** Merged view of every argument this resolver's fields receive. */
interface ReleaseResolverArguments {
  input: CutAgentReleaseInput;
  releaseId: string;
}

type ReleaseResolverEvent = GovernanceResolverEvent<ReleaseResolverArguments>;

function authContextFromEvent(event: ReleaseResolverEvent): AuthContext {
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
 * Truncate long string values in event.arguments so error logs cannot be
 * weaponised to exfiltrate long payloads. Mirrors execspec-resolver.ts /
 * eval-run-resolver.ts's sanitizeForLog convention.
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

export const handler = async (
  event: ReleaseResolverEvent,
): Promise<unknown> => {
  const fieldName = event?.info?.fieldName;
  const authContext = authContextFromEvent(event);
  try {
    switch (fieldName) {
      case "cutAgentRelease": {
        // Caller org is read from the event identity (custom:organization
        // claim, with the Cognito AdminGetUser fallback), NOT from
        // authContext — AuthContext carries no orgId field in this
        // codebase (see ../types.ts). A missing org is a validation
        // failure, not a silent all-org bypass: the security-critical
        // cross-org checks in cutAgentRelease compare against it directly.
        const callerOrgId = await extractOrgFromEvent(event);
        if (!callerOrgId) {
          throw new Error(
            "ValidationError: caller organization could not be determined",
          );
        }
        return await cutAgentRelease(
          event.arguments.input,
          authContext,
          callerOrgId,
        );
      }
      default:
        throw new Error(`Unsupported field: ${fieldName}`);
    }
  } catch (err: unknown) {
    console.error("release-resolver error", {
      fieldName,
      message: err instanceof Error ? err.message : undefined,
      args: sanitizeForLog(event?.arguments),
    });
    throw err;
  }
};
