/**
 * fixtures.ts — sentinel constants + idempotent arrange for the
 * release-path smoke fixture set.
 *
 * Seeds (create-if-absent, never update-in-place) every prerequisite
 * `cutAgentRelease` / `promoteEnvironmentReleasePointer` READ but never
 * write, per the field-by-field validation read directly out of
 * backend/src/lambda/release-resolver.ts and
 * environment-release-pointer-resolver.ts:
 *
 *   - a Project (owner = the fixture Cognito user, so
 *     resolveExecSpecOrgId's Project.owner -> lookupUserOrganization path
 *     resolves to SENTINEL_ORG)
 *   - an APPROVED agent registry record via createAgentConfig (AppSync
 *     createAgentConfig -> createAgentConfigRegistry ->
 *     RegistryService.createResource + updateResourceStatus("active")
 *     ->  RegistryRecordStatusValues.APPROVED, customDescriptorContent.orgId
 *     = the caller's org, exactly what cutAgentRelease's registry check
 *     reads)
 *   - an APPROVED ExecutionSpecification (createExecutionSpecification ->
 *     approveExecutionSpecification)
 *   - a DEDICATED THROWAWAY EvalSuite (createEvalSuite) + one EvalCase
 *     (addEvalCase), then FROZEN (freezeEvalSuite) — never the shipped
 *     seed suite. See the module docstring on SENTINEL_* below for why
 *     this is safe under the permanent-freeze constraint.
 *   - a COMPLETED EvalRun whose suiteVersion matches the frozen suite's
 *     version — seeded directly (there is no AppSync mutation that can
 *     drive a run to COMPLETED; startEvalRun only ever creates PENDING
 *     runs, and driving the real eval-runner/judge pipeline to COMPLETED
 *     is out of scope for this smoke fixture, per the approved design).
 *     This is the ONE direct-DynamoDB write in this file, and it targets
 *     EvalRunsTable, which is not the release-store or
 *     environment-release-pointer-store choke point — cutAgentRelease
 *     only ever GetItems that table.
 *
 * IDEMPOTENCY / BOUNDED-ROW GUARANTEE (constraint: "re-running must
 * converge, not accumulate"):
 *   - Project / EvalSuite / ExecutionSpecification IDs are server-minted
 *     (uuidv4) on every AppSync create call — there is no field in any of
 *     createProject / createEvalSuite / createExecutionSpecification that
 *     lets a caller pin a deterministic id. So "create-if-absent" here
 *     means "list, find-by-sentinel-name, create only if not found",
 *     never "create, ignore AlreadyExists" — the fixed set is enforced by
 *     this script's own lookup-before-create discipline, not by a
 *     database-level conditional key.
 *   - The EvalRun is the one row that CAN be pinned deterministically: it
 *     is seeded directly with a fixed evalRunId derived exactly the way
 *     eval-run-resolver.ts's deriveEvalRunId does (uuidv5 over
 *     `${suiteId}:${suiteVersion}:${agentTargetVersion}:${idempotencyKey}`
 *     using the same EVAL_RUN_NAMESPACE constant), keyed off the sentinel
 *     suite's own id/version, so re-running always recomputes the SAME
 *     evalRunId and the direct PutCommand is a create-if-absent
 *     (attribute_not_exists) no-op on repeat.
 *   - The eventual AgentRelease row cut against these fixtures is
 *     content-addressed (release-store.ts's computeReleaseHash over
 *     constituents only) — see run-smoke.ts's module doc for why holding
 *     every constituent constant here caps the AgentReleasesTable
 *     footprint at exactly one row forever.
 *
 * NAMESPACING (constraint: "everything must be obviously namespaced"):
 * every string this file creates or looks up carries the
 * `SMOKE-RELEASE-FIXTURE` marker and/or lives under SENTINEL_ORG, so a
 * table scan or console browse trivially distinguishes fixture rows from
 * real tenant data.
 */

import { randomUUID } from "crypto";
import { appsyncRequest } from "./appsync-client";
import { REQUIRED_ENV, readRequiredEnv, cognitoAuth } from "./env";

// ---------------------------------------------------------------------------
// Sentinel constants
// ---------------------------------------------------------------------------

/** Never used for any shipped/seed suite — this org exists ONLY for this
 * fixture harness. Distinguishable at a glance in any table scan. */
export const SENTINEL_ORG = "SMOKE-RELEASE-FIXTURE-ORG";

/** The (fictitious) agent this fixture cuts a release for. */
export const SENTINEL_AGENT_TARGET_ID = "smoke-release-fixture-agent";

/** DeploymentEnvironment enum literal the pointer is promoted into.
 * DEV only — this harness never touches STAGING/PROD pointers. */
export const SENTINEL_ENVIRONMENT = "DEV" as const;

export const SENTINEL_PROJECT_NAME = "SMOKE-RELEASE-FIXTURE-PROJECT";
export const SENTINEL_SUITE_NAME = "SMOKE-RELEASE-FIXTURE-SUITE";
export const SENTINEL_CASE_NAME = "SMOKE-RELEASE-FIXTURE-CASE";
export const SENTINEL_SEMVER = "0.0.1-smoke";

/** Fixed idempotencyKey feeding deriveEvalRunId's hash — see module doc:
 * this is what lets the seeded EvalRun's id stay stable across reruns. */
export const SENTINEL_EVAL_IDEMPOTENCY_KEY =
  "SMOKE-RELEASE-FIXTURE-EVAL-IDEMPOTENCY-KEY";

/** Mirrors eval-run-resolver.ts's EVAL_RUN_NAMESPACE constant exactly —
 * deriveEvalRunId must be reproduced bit-for-bit here so the seeded run's
 * id is stable and matches the shape a real startEvalRun call would have
 * produced for the same suite/version/agentTargetVersion/idempotencyKey. */
const EVAL_RUN_NAMESPACE = "1b7e3b2a-6b7b-4b9a-9c9b-4b7b2a6b7b3a";

export const SENTINEL_AGENT_TARGET_VERSION = "v0.0.1-smoke";

/** Fixed provenance stamped on every constituent this harness snapshots
 * into the release — see run-smoke.ts. Constant content is what keeps
 * the eventual release content-addressed to a single row. */
export const SENTINEL_GIT_SHA = "0000000000000000000000000000000000smoke";
export const SENTINEL_REGION = "us-east-1";
export const SENTINEL_RUN_ID = "SMOKE-RELEASE-FIXTURE-RUN-ID";

// ---------------------------------------------------------------------------
// uuidv5 (RFC 4122) — reproduced locally, zero new dependency, to mirror
// deriveEvalRunId exactly without importing backend/src/lambda internals
// (which are esbuild-bundled for Lambda and not meant to be imported by
// a standalone script).
// ---------------------------------------------------------------------------

function uuidv5(name: string, namespace: string): string {
  const ns = namespace
    .replace(/-/g, "")
    .match(/.{2}/g)!
    .map((h) => parseInt(h, 16));
  const nameBytes = Buffer.from(name, "utf8");
  const data = Buffer.concat([Buffer.from(ns), nameBytes]);
  const hash = require("crypto").createHash("sha1").update(data).digest();
  hash[6] = (hash[6] & 0x0f) | 0x50; // version 5
  hash[8] = (hash[8] & 0x3f) | 0x80; // variant
  const hex = hash.subarray(0, 16).toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

export function deriveSentinelEvalRunId(
  suiteId: string,
  suiteVersion: number,
): string {
  return uuidv5(
    `${suiteId}:${suiteVersion}:${SENTINEL_AGENT_TARGET_VERSION}:${SENTINEL_EVAL_IDEMPOTENCY_KEY}`,
    EVAL_RUN_NAMESPACE,
  );
}

// ---------------------------------------------------------------------------
// GraphQL documents
// ---------------------------------------------------------------------------

const LIST_PROJECTS = /* GraphQL */ `
  query ListProjects {
    listProjects {
      items {
        id
        name
        owner
      }
    }
  }
`;

const CREATE_PROJECT = /* GraphQL */ `
  mutation CreateProject($input: CreateProjectInput!) {
    createProject(input: $input) {
      id
      name
      owner
    }
  }
`;

const CREATE_AGENT_CONFIG = /* GraphQL */ `
  mutation CreateAgentConfig($input: CreateAgentConfigInput!) {
    createAgentConfig(input: $input) {
      agentId
      orgId
      state
    }
  }
`;

const LIST_EXEC_SPECS = /* GraphQL */ `
  query ListExecutionSpecifications($projectId: ID!) {
    listExecutionSpecifications(projectId: $projectId) {
      specId
      status
      version
      structuredPayload
    }
  }
`;

const CREATE_EXEC_SPEC = /* GraphQL */ `
  mutation CreateExecSpec($input: ExecutionSpecificationInput!) {
    createExecutionSpecification(input: $input) {
      specId
      status
      version
    }
  }
`;

const APPROVE_EXEC_SPEC = /* GraphQL */ `
  mutation ApproveExecSpec($specId: ID!) {
    approveExecutionSpecification(specId: $specId) {
      specId
      status
      version
    }
  }
`;

const LIST_EVAL_SUITES = /* GraphQL */ `
  query ListEvalSuites($orgId: ID!, $agentTargetId: ID) {
    listEvalSuites(orgId: $orgId, agentTargetId: $agentTargetId) {
      suiteId
      name
      status
      version
      references
    }
  }
`;

const CREATE_EVAL_SUITE = /* GraphQL */ `
  mutation CreateEvalSuite($input: EvalSuiteInput!) {
    createEvalSuite(input: $input) {
      suiteId
      status
      version
    }
  }
`;

const LIST_EVAL_CASES = /* GraphQL */ `
  query ListEvalCases($suiteId: ID!) {
    listEvalCases(suiteId: $suiteId) {
      caseId
      name
    }
  }
`;

const ADD_EVAL_CASE = /* GraphQL */ `
  mutation AddEvalCase($suiteId: ID!, $input: EvalCaseInput!) {
    addEvalCase(suiteId: $suiteId, input: $input) {
      caseId
      name
    }
  }
`;

const FREEZE_EVAL_SUITE = /* GraphQL */ `
  mutation FreezeEvalSuite($suiteId: ID!) {
    freezeEvalSuite(suiteId: $suiteId) {
      suiteId
      status
      version
      references
    }
  }
`;

const GET_EVAL_RUN = /* GraphQL */ `
  query GetEvalRun($evalRunId: ID!) {
    getEvalRun(evalRunId: $evalRunId) {
      evalRunId
      status
      suiteId
      suiteVersion
      orgId
    }
  }
`;

// ---------------------------------------------------------------------------
// Arrange result shape
// ---------------------------------------------------------------------------

export interface ArrangeResult {
  callerOrgId: string;
  projectId: string;
  registryRecordId: string;
  execSpecId: string;
  execSpecVersion: number;
  evalSuiteId: string;
  evalSuiteVersion: number;
  evalRunId: string;
}

// ---------------------------------------------------------------------------
// Direct-DynamoDB seed for the ONE row that AppSync cannot produce:
// a COMPLETED EvalRun. This is the sole write in this file that bypasses
// AppSync; it targets EvalRunsTable only, never AgentReleasesTable or
// EnvironmentReleasePointersTable (the two choke-point-guarded tables),
// so it does not touch — let alone weaken — either write boundary.
// ---------------------------------------------------------------------------

async function seedCompletedEvalRunIfAbsent(
  evalRunId: string,
  orgId: string,
  suiteId: string,
  suiteVersion: number,
): Promise<void> {
  const {
    DynamoDBClient,
  } = require("@aws-sdk/client-dynamodb") as typeof import("@aws-sdk/client-dynamodb");
  const {
    DynamoDBDocumentClient,
    PutCommand,
  } = require("@aws-sdk/lib-dynamodb") as typeof import("@aws-sdk/lib-dynamodb");

  const tableName = readRequiredEnv("EVAL_RUNS_TABLE");
  const doc = DynamoDBDocumentClient.from(
    new DynamoDBClient({ region: readRequiredEnv("AWS_REGION") }),
  );

  const now = new Date().toISOString();
  const run = {
    evalRunId,
    orgId,
    suiteId,
    suiteVersion,
    agentTargetId: SENTINEL_AGENT_TARGET_ID,
    agentTargetVersion: SENTINEL_AGENT_TARGET_VERSION,
    status: "COMPLETED",
    caseCount: 1,
    pendingCases: 0,
    startedAt: now,
    startedBy: "smoke-release-fixture",
    completedAt: now,
    idempotencyKey: SENTINEL_EVAL_IDEMPOTENCY_KEY,
  };

  try {
    await doc.send(
      new PutCommand({
        TableName: tableName,
        Item: run,
        // create-if-absent — reruns converge on the same row rather than
        // clobbering completedAt/startedAt on every invocation.
        ConditionExpression: "attribute_not_exists(evalRunId)",
      }),
    );
  } catch (err: unknown) {
    const isConditionalCheckFailed =
      !!err &&
      typeof err === "object" &&
      (err as { name?: string }).name === "ConditionalCheckFailedException";
    if (!isConditionalCheckFailed) {
      throw err;
    }
    // Already seeded by a previous run — idempotent no-op.
  }
}

// ---------------------------------------------------------------------------
// Arrange
// ---------------------------------------------------------------------------

/**
 * Idempotently creates every prerequisite row cutAgentRelease /
 * promoteEnvironmentReleasePointer read, then asserts (via GetItem-through-
 * the-API reads, never a raw table read) that each predicate the resolvers
 * actually check holds. Never cuts a release — that is run-smoke.ts's job.
 */
export async function arrange(): Promise<ArrangeResult> {
  const token = await cognitoAuth();
  const callerOrgId = SENTINEL_ORG;

  // ---- Project (owner = fixture user; owner's Cognito profile carries
  // custom:organization = SENTINEL_ORG, so resolveExecSpecOrgId's
  // Project.owner -> lookupUserOrganization path resolves correctly) ----
  const existingProjects = await appsyncRequest<{
    listProjects: { items: { id: string; name: string; owner: string }[] };
  }>(token, LIST_PROJECTS);
  let projectId = existingProjects.listProjects.items.find(
    (p) => p.name === SENTINEL_PROJECT_NAME,
  )?.id;
  if (!projectId) {
    const created = await appsyncRequest<{
      createProject: { id: string };
    }>(token, CREATE_PROJECT, {
      input: {
        name: SENTINEL_PROJECT_NAME,
        description:
          "Throwaway project owned by the release-path smoke fixture harness. Never used by any shipped seed data.",
      },
    });
    projectId = created.createProject.id;
  }

  // ---- APPROVED agent registry record ----
  // createAgentConfig -> createAgentConfigRegistry derives orgId from the
  // caller's own org claim (never trusts client input), and passing
  // state: active drives RegistryService.updateResourceStatus straight to
  // APPROVED (toRegistryStatus("active") === APPROVED) with no
  // currentStatus supplied, so no lifecycle-transition gate blocks the
  // DRAFT -> APPROVED jump on first create. Re-running targets the SAME
  // agentId, so createResource's registry-side upsert-by-id keeps this a
  // single record.
  const registryRecordId = SENTINEL_AGENT_TARGET_ID;
  await appsyncRequest(token, CREATE_AGENT_CONFIG, {
    input: {
      agentId: registryRecordId,
      config: JSON.stringify({
        name: registryRecordId,
        marker: "SMOKE-RELEASE-FIXTURE-AGENT-CONFIG",
      }),
      state: "active",
      categories: ["smoke-release-fixture"],
    },
  });

  // ---- APPROVED ExecutionSpecification ----
  const existingSpecs = await appsyncRequest<{
    listExecutionSpecifications: {
      specId: string;
      status: string;
      version: number;
      structuredPayload: string;
    }[];
  }>(token, LIST_EXEC_SPECS, { projectId });
  let execSpec = existingSpecs.listExecutionSpecifications.find((s) =>
    s.structuredPayload.includes("SMOKE-RELEASE-FIXTURE-EXEC-SPEC"),
  );
  if (!execSpec) {
    const bucketName = readRequiredEnv(
      "SMOKE_GOVERNANCE_TRANSCRIPTS_BUCKET_NAME",
    );
    const created = await appsyncRequest<{
      createExecutionSpecification: {
        specId: string;
        status: string;
        version: number;
      };
    }>(token, CREATE_EXEC_SPEC, {
      input: {
        projectId,
        sourceAdrIds: ["SMOKE-RELEASE-FIXTURE-ADR"],
        structuredPayload: JSON.stringify({
          marker: "SMOKE-RELEASE-FIXTURE-EXEC-SPEC",
        }),
        narrativeS3Uri: `s3://${bucketName}/projects/${projectId}/smoke-release-fixture-narrative.md`,
      },
    });
    execSpec = { ...created.createExecutionSpecification, structuredPayload: "" };
  }
  if (execSpec.status !== "APPROVED") {
    const approved = await appsyncRequest<{
      approveExecutionSpecification: { specId: string; status: string; version: number };
    }>(token, APPROVE_EXEC_SPEC, { specId: execSpec.specId });
    execSpec = { ...execSpec, ...approved.approveExecutionSpecification };
  }

  // ---- Throwaway EvalSuite (FROZEN) + one EvalCase ----
  // C1: this suite is authored under SENTINEL_ORG with a name that only
  // this harness ever uses. The freeze below appends to THIS suite's
  // references[] and no other — no shipped seed suite is ever touched.
  const existingSuites = await appsyncRequest<{
    listEvalSuites: {
      suiteId: string;
      name: string;
      status: string;
      version: number;
      references: string[];
    }[];
  }>(token, LIST_EVAL_SUITES, {
    orgId: callerOrgId,
    agentTargetId: SENTINEL_AGENT_TARGET_ID,
  });
  let suite = existingSuites.listEvalSuites.find(
    (s) => s.name === SENTINEL_SUITE_NAME,
  );
  if (!suite) {
    const created = await appsyncRequest<{
      createEvalSuite: { suiteId: string; status: string; version: number };
    }>(token, CREATE_EVAL_SUITE, {
      input: {
        orgId: callerOrgId,
        agentTargetId: SENTINEL_AGENT_TARGET_ID,
        name: SENTINEL_SUITE_NAME,
        description:
          "Throwaway eval suite owned by the release-path smoke fixture harness. Never a shipped/seed suite — safe to freeze permanently.",
        semver: SENTINEL_SEMVER,
      },
    });
    suite = { ...created.createEvalSuite, name: SENTINEL_SUITE_NAME, references: [] };
  }

  const existingCases = await appsyncRequest<{
    listEvalCases: { caseId: string; name: string }[];
  }>(token, LIST_EVAL_CASES, { suiteId: suite.suiteId });
  if (!existingCases.listEvalCases.some((c) => c.name === SENTINEL_CASE_NAME)) {
    await appsyncRequest(token, ADD_EVAL_CASE, {
      suiteId: suite.suiteId,
      input: {
        name: SENTINEL_CASE_NAME,
        description: "Throwaway case for the release-path smoke fixture.",
        kind: "CONVERSATION",
        input: { prompt: "smoke-release-fixture-prompt" },
        expectedOutcome: {
          mode: "CONTAINS",
          target: JSON.stringify("smoke"),
        },
      },
    });
  }

  if (suite.status !== "FROZEN") {
    const frozen = await appsyncRequest<{
      freezeEvalSuite: {
        suiteId: string;
        status: string;
        version: number;
        references: string[];
      };
    }>(token, FREEZE_EVAL_SUITE, { suiteId: suite.suiteId });
    suite = { ...suite, ...frozen.freezeEvalSuite };
  }

  // ---- COMPLETED EvalRun (suiteVersion pinned to the FROZEN suite's
  // current version) — the one direct-DynamoDB seed, see module doc. ----
  const evalRunId = deriveSentinelEvalRunId(suite.suiteId, suite.version);
  await seedCompletedEvalRunIfAbsent(
    evalRunId,
    callerOrgId,
    suite.suiteId,
    suite.version,
  );

  return {
    callerOrgId,
    projectId,
    registryRecordId,
    execSpecId: execSpec.specId,
    execSpecVersion: execSpec.version,
    evalSuiteId: suite.suiteId,
    evalSuiteVersion: suite.version,
    evalRunId,
  };
}

/**
 * Post-arrange assertions — reads every row back THROUGH THE API (never
 * the raw table) and checks the exact predicates release-resolver.ts /
 * environment-release-pointer-resolver.ts will themselves check at cut
 * time, so a broken arrange fails loudly here instead of surfacing as a
 * confusing rejection from run-smoke.ts.
 */
export async function assertArrangeInvariants(
  result: ArrangeResult,
): Promise<void> {
  const token = await cognitoAuth();

  const runCheck = await appsyncRequest<{
    getEvalRun: {
      evalRunId: string;
      status: string;
      suiteId: string;
      suiteVersion: number;
      orgId: string;
    } | null;
  }>(token, GET_EVAL_RUN, { evalRunId: result.evalRunId });
  const run = runCheck.getEvalRun;
  if (!run) {
    throw new Error(
      `arrange invariant failed: eval run ${result.evalRunId} not found after seeding`,
    );
  }
  if (run.status !== "COMPLETED") {
    throw new Error(
      `arrange invariant failed: eval run ${result.evalRunId} status is ${run.status}, expected COMPLETED`,
    );
  }
  if (run.suiteVersion !== result.evalSuiteVersion) {
    throw new Error(
      `arrange invariant failed: eval run suiteVersion (${run.suiteVersion}) does not match frozen suite version (${result.evalSuiteVersion})`,
    );
  }
  if (run.orgId !== result.callerOrgId) {
    throw new Error(
      `arrange invariant failed: eval run orgId (${run.orgId}) does not match caller org (${result.callerOrgId})`,
    );
  }

  const suitesCheck = await appsyncRequest<{
    listEvalSuites: { suiteId: string; status: string; version: number }[];
  }>(token, LIST_EVAL_SUITES, {
    orgId: result.callerOrgId,
    agentTargetId: SENTINEL_AGENT_TARGET_ID,
  });
  const suite = suitesCheck.listEvalSuites.find(
    (s) => s.suiteId === result.evalSuiteId,
  );
  if (!suite || suite.status !== "FROZEN") {
    throw new Error(
      `arrange invariant failed: eval suite ${result.evalSuiteId} is not FROZEN`,
    );
  }

  console.log(
    "[fixtures] arrange invariants verified: suite FROZEN, run COMPLETED, suiteVersion match, org match.",
  );
}

export { REQUIRED_ENV };
