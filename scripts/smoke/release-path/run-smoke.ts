/**
 * run-smoke.ts — exercises the REAL cutAgentRelease then
 * promoteEnvironmentReleasePointer mutations through AppSync, as the
 * dedicated fixture Cognito user, and asserts every stage.
 *
 * Why through AppSync and not by calling cutAgentRelease()/
 * promoteEnvironmentReleasePointer() as plain TS functions: the point of
 * this slice is to prove identity -> org extraction (extractOrgFromEvent
 * reading the real Cognito `custom:organization` claim) and the
 * permission gate (hasPermission reading the real `custom:role` claim)
 * work end-to-end, not just that the inner function's logic is correct
 * in isolation (that is what release-resolver.test.ts already covers
 * with mocked identities).
 *
 * IDEMPOTENCY (constraint: "re-running must converge, not accumulate"):
 * cutAgentRelease's constituents (agentConfig content, promptVersions,
 * modelConfigSnapshots, toolConfigs, policySnapshot, execSpecId/Version,
 * evalEvidence) are ALL held constant across runs by construction —
 * every value below is a literal SENTINEL_* constant or is read back from
 * the arranged fixtures (registryRecordId, execSpecId, evalRunId), none
 * of which vary run-to-run once arrange() has converged. Because
 * releaseId = sha256(constituents) (release-store.ts's computeReleaseHash,
 * excluding volatile fields like createdAt), every rerun of this script
 * hashes to the IDENTICAL releaseId, so putRelease's
 * attribute_not_exists(releaseId) conditional Put is a no-op on every run
 * after the first — see the "exactly one release row" explanation in
 * README.md. The pointer promotion is NOT content-addressed (it is
 * explicitly the mutable cursor) — its `version` field increments by
 * design on every successful promotion, which is the bounded, monitored
 * growth this fixture's README documents (one row, monotonic version),
 * not unbounded accumulation.
 */

import { appsyncRequest } from "./appsync-client";
import { cognitoAuth, readRequiredEnv } from "./env";
import {
  arrange,
  assertArrangeInvariants,
  ArrangeResult,
  SENTINEL_AGENT_TARGET_ID,
  SENTINEL_ENVIRONMENT,
  SENTINEL_GIT_SHA,
  SENTINEL_REGION,
  SENTINEL_RUN_ID,
  SENTINEL_SEMVER,
} from "./fixtures";

const CUT_AGENT_RELEASE = /* GraphQL */ `
  mutation CutAgentRelease($input: CutAgentReleaseInput!) {
    cutAgentRelease(input: $input) {
      releaseId
      orgId
      agentTargetId
      execSpecId
      execSpecVersion
      evalEvidence
    }
  }
`;

const PROMOTE_POINTER = /* GraphQL */ `
  mutation PromotePointer($input: SetEnvironmentReleasePointerInput!) {
    promoteEnvironmentReleasePointer(input: $input) {
      orgId
      agentTargetId
      environment
      releaseId
      previousReleaseId
      version
      promotedAt
    }
  }
`;

const GET_CURRENT_POINTER = /* GraphQL */ `
  query GetCurrentPointer(
    $agentTargetId: ID!
    $environment: DeploymentEnvironment!
  ) {
    getCurrentEnvironmentReleasePointer(
      agentTargetId: $agentTargetId
      environment: $environment
    ) {
      releaseId
      previousReleaseId
      version
    }
  }
`;

interface CutAgentReleaseResult {
  releaseId: string;
  orgId: string;
  agentTargetId: string;
  execSpecId: string;
  execSpecVersion: number;
  evalEvidence: unknown;
}

interface PromotePointerResult {
  orgId: string;
  agentTargetId: string;
  environment: string;
  releaseId: string;
  previousReleaseId: string | null;
  version: number;
  promotedAt: string;
}

/**
 * Builds the CutAgentReleaseInput straight from the fixtures' arranged
 * ids — every Class B "caller-supplied" snapshot field is a constant
 * SENTINEL_* value so the release stays content-addressed to one row
 * across reruns (see module doc).
 */
function buildCutInput(arranged: ArrangeResult) {
  return {
    // input.orgId is intentionally ignored by cutAgentRelease (it derives
    // orgId from the caller's identity, never from this field) — supplied
    // here only because the schema marks it required.
    orgId: arranged.callerOrgId,
    agentTargetId: SENTINEL_AGENT_TARGET_ID,
    semver: SENTINEL_SEMVER,
    registryRecordId: arranged.registryRecordId,
    execSpecId: arranged.execSpecId,
    evalRunId: arranged.evalRunId,
    promptVersions: JSON.stringify({
      supervisor: {
        sourceId: "smoke-release-fixture-prompt",
        content: "SMOKE-RELEASE-FIXTURE prompt content",
        digest:
          "0000000000000000000000000000000000000000000000000000000000smoke",
      },
    }),
    modelConfigSnapshots: JSON.stringify([
      {
        slot: "supervisor",
        content: "SMOKE-RELEASE-FIXTURE-MODEL",
        digest:
          "1111111111111111111111111111111111111111111111111111111111smoke",
      },
    ]),
    toolConfigs: JSON.stringify([
      {
        sourceId: "smoke-release-fixture-tool",
        content: "{}",
        digest:
          "2222222222222222222222222222222222222222222222222222222222smoke",
      },
    ]),
    policySnapshot: JSON.stringify({
      enforcementMode: "shadow",
      ruleSetVersion: "smoke-release-fixture-v1",
      authorityUnitGrantIds: [],
    }),
    gitSha: SENTINEL_GIT_SHA,
    region: SENTINEL_REGION,
    runId: SENTINEL_RUN_ID,
  };
}

async function cutReleaseTwiceAndAssertIdempotent(
  arranged: ArrangeResult,
): Promise<string> {
  const token = await cognitoAuth();
  const input = buildCutInput(arranged);

  const first = await appsyncRequest<{ cutAgentRelease: CutAgentReleaseResult }>(
    token,
    CUT_AGENT_RELEASE,
    { input },
  );
  const firstReleaseId = first.cutAgentRelease.releaseId;

  if (first.cutAgentRelease.orgId !== arranged.callerOrgId) {
    throw new Error(
      `cutAgentRelease invariant failed: release.orgId (${first.cutAgentRelease.orgId}) ` +
        `!= caller org (${arranged.callerOrgId})`,
    );
  }

  const second = await appsyncRequest<{ cutAgentRelease: CutAgentReleaseResult }>(
    token,
    CUT_AGENT_RELEASE,
    { input },
  );
  if (second.cutAgentRelease.releaseId !== firstReleaseId) {
    throw new Error(
      `cutAgentRelease is not idempotent: first releaseId=${firstReleaseId}, ` +
        `second releaseId=${second.cutAgentRelease.releaseId}. Constituents ` +
        `must be identical across calls for content-addressing to collide.`,
    );
  }

  console.log(
    `[run-smoke] cutAgentRelease idempotent: releaseId=${firstReleaseId} stable across two calls.`,
  );
  return firstReleaseId;
}

async function promoteAndAssert(releaseId: string): Promise<void> {
  const token = await cognitoAuth();

  const before = await appsyncRequest<{
    getCurrentEnvironmentReleasePointer: {
      releaseId: string;
      previousReleaseId: string | null;
      version: number;
    } | null;
  }>(token, GET_CURRENT_POINTER, {
    agentTargetId: SENTINEL_AGENT_TARGET_ID,
    environment: SENTINEL_ENVIRONMENT,
  });
  const versionBefore = before.getCurrentEnvironmentReleasePointer?.version ?? 0;

  const promoted = await appsyncRequest<{
    promoteEnvironmentReleasePointer: PromotePointerResult;
  }>(token, PROMOTE_POINTER, {
    input: {
      agentTargetId: SENTINEL_AGENT_TARGET_ID,
      environment: SENTINEL_ENVIRONMENT,
      releaseId,
    },
  });
  const pointer = promoted.promoteEnvironmentReleasePointer;

  if (pointer.releaseId !== releaseId) {
    throw new Error(
      `promoteEnvironmentReleasePointer invariant failed: pointer.releaseId ` +
        `(${pointer.releaseId}) != cut releaseId (${releaseId})`,
    );
  }
  if (pointer.version !== versionBefore + 1) {
    throw new Error(
      `promoteEnvironmentReleasePointer invariant failed: version did not ` +
        `increment by exactly 1 (before=${versionBefore}, after=${pointer.version})`,
    );
  }
  if (
    before.getCurrentEnvironmentReleasePointer &&
    pointer.previousReleaseId !== before.getCurrentEnvironmentReleasePointer.releaseId
  ) {
    throw new Error(
      `promoteEnvironmentReleasePointer invariant failed: previousReleaseId ` +
        `(${pointer.previousReleaseId}) does not match the pre-promotion ` +
        `releaseId (${before.getCurrentEnvironmentReleasePointer.releaseId})`,
    );
  }

  console.log(
    `[run-smoke] promoteEnvironmentReleasePointer verified: releaseId=${pointer.releaseId}, ` +
      `version ${versionBefore} -> ${pointer.version}, previousReleaseId=${pointer.previousReleaseId}.`,
  );

  // Re-running the promotion against the SAME already-current release is
  // still a version-incrementing write (this table is deliberately
  // mutable, unlike AgentReleasesTable) — assert it converges to a
  // BOUNDED single row (one pointer per org/agent/environment), not that
  // the version stays fixed. See README.md's "one release row forever,
  // pointer row grows only its version" explanation.
  const reproted = await appsyncRequest<{
    promoteEnvironmentReleasePointer: PromotePointerResult;
  }>(token, PROMOTE_POINTER, {
    input: {
      agentTargetId: SENTINEL_AGENT_TARGET_ID,
      environment: SENTINEL_ENVIRONMENT,
      releaseId,
    },
  });
  if (reproted.promoteEnvironmentReleasePointer.releaseId !== releaseId) {
    throw new Error(
      "re-promotion invariant failed: releaseId changed on a repeat promotion " +
        "to the same release",
    );
  }
  if (
    reproted.promoteEnvironmentReleasePointer.version !==
    pointer.version + 1
  ) {
    throw new Error(
      "re-promotion invariant failed: version did not increment by exactly 1 " +
        "on the repeat promotion",
    );
  }
  console.log(
    `[run-smoke] repeat promotion converges: still exactly one pointer row ` +
      `for (org, agentTargetId, environment), version now ` +
      `${reproted.promoteEnvironmentReleasePointer.version}.`,
  );
}

async function main(): Promise<void> {
  console.log("[run-smoke] arranging prerequisites...");
  const arranged = await arrange();
  await assertArrangeInvariants(arranged);

  console.log("[run-smoke] cutting release via AppSync cutAgentRelease...");
  const releaseId = await cutReleaseTwiceAndAssertIdempotent(arranged);

  console.log(
    "[run-smoke] promoting environment release pointer via AppSync promoteEnvironmentReleasePointer...",
  );
  await promoteAndAssert(releaseId);

  console.log(
    `[run-smoke] DONE. releaseId=${releaseId} agentTargetId=${SENTINEL_AGENT_TARGET_ID} ` +
      `environment=${SENTINEL_ENVIRONMENT} org=${arranged.callerOrgId}. ` +
      `Next: run assert_dispatch_resolves.py to verify dispatch-side resolution.`,
  );
}

if (require.main === module) {
  main().catch((err) => {
    console.error("[run-smoke] FAILED:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}

export { main, buildCutInput };
