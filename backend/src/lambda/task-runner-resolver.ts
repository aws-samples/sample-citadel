import {
  EventBridgeClient,
  PutEventsCommand,
} from "@aws-sdk/client-eventbridge";
import { randomUUID } from "crypto";
import type { AppSyncResolverEvent } from "aws-lambda";
import { mintRunId, buildDispatchContext } from "../utils/run-id";
import { extractOrgFromEvent } from "../utils/auth-event";

const eventBridgeClient = new EventBridgeClient({});
const EVENT_BUS_NAME = process.env.AGENT_EVENT_BUS_NAME!;

interface TaskCallback {
  type: string;
  eventBusName?: string;
  source?: string;
  detailType?: string;
  queueUrl?: string;
  endpoint?: string;
  serverId?: string;
  metadata?: unknown;
}

interface SubmitTaskInput {
  taskDetails: string;
  callback?: TaskCallback;
}
// NOTE: SubmitTaskInput intentionally never gains a `runId` field — runId is
// server-minted only (mirrors orchestrationId below), so there is no client
// input to strip; any `runId` a caller sends in a wider payload is simply
// never read. The same discipline applies to `orgId` (finding 87a171ad):
// the schema declares no such field on SubmitTaskInput, and even if a
// caller smuggled one into a wider payload shape, submitTask below never
// reads `input.orgId` — the organisation is derived exclusively from
// `event.identity` via `requireOrgId`.

type TaskRunnerEvent = AppSyncResolverEvent<{ input: SubmitTaskInput }>;

/**
 * Fail-closed server-side organisation derivation (finding 87a171ad, high).
 *
 * Chosen pattern: `extractOrgFromEvent` (the same primitive
 * `requireEffectiveOrgId` in datastore-resolver.ts / integration-resolver.ts
 * wraps for their non-admin branch), NOT `resolveOrgId` from
 * intake-orchestration-resolver.ts. `resolveOrgId` derives org via a
 * sessionId -> conversations -> project -> project.organization linkage
 * that only exists for the 4 IAM-only intake mutations; `submitTask` is a
 * plain Cognito-user-pool-authed mutation with no sessionId/project
 * linkage at all, so that chain has nothing to walk. `extractOrgFromEvent`
 * reads directly off `event.identity` (JWT `custom:organization` claim,
 * falling back to an AdminGetUser lookup) — the correct primitive for a
 * caller-identity-only resolver, and the one every other Cognito-authed
 * resolver in this codebase already standardises on.
 *
 * `requireEffectiveOrgId`'s admin-argument-override branch is intentionally
 * NOT reused here: `SubmitTaskInput` has no `orgId` argument for an admin
 * to override, so there is nothing to branch on — every caller (admin or
 * not) is scoped to their own resolved organisation.
 *
 * Throws (fails closed) when no organisation resolves, mirroring
 * `requireEffectiveOrgId`'s `PermissionError` — never falls back to
 * `RELEASE_DEFAULT_ORG_ID` or any other deployment-wide default, since
 * that default is explicitly NOT caller identity.
 */
async function requireOrgId(event: TaskRunnerEvent): Promise<string> {
  const orgId = await extractOrgFromEvent(event);
  if (!orgId) {
    throw new Error(
      "Access denied: no organization is provisioned for your account. Contact an administrator.",
    );
  }
  return orgId;
}

export const handler = async (event: TaskRunnerEvent) => {
  console.log("Event:", JSON.stringify(event, null, 2));

  const fieldName = event.info.fieldName;

  try {
    if (fieldName === "submitTask") {
      return await submitTask(event.arguments.input, event);
    }

    throw new Error(`Unknown field: ${fieldName}`);
  } catch (error) {
    console.error("Error:", error);
    throw error;
  }
};

async function submitTask(input: SubmitTaskInput, event: TaskRunnerEvent) {
  // Fail closed BEFORE minting any ids or touching EventBridge — an
  // unresolved organisation must never reach the bus (finding 87a171ad).
  const orgId = await requireOrgId(event);

  const orchestrationId = randomUUID();
  // Server-minted only — never read from `input` (SubmitTaskInput has no
  // runId field to begin with; this mint is the sole source, same
  // discipline as orchestrationId above).
  const runId = mintRunId();

  console.log("Submitting task to Supervisor:", {
    orchestrationId,
    runId,
    orgId,
    taskDetails: input.taskDetails,
    callback: input.callback,
  });

  try {
    // Send event to EventBridge for the Supervisor agent
    // The supervisor expects the detail to contain the task information
    // which it will pass to orchestrate() as initial_message
    //
    // Build-time durability guard (Pass 1, decision f1cbd5ef, design §3
    // layer 1): route the outbound envelope through buildDispatchContext,
    // whose `runId` parameter is REQUIRED — a future refactor that drops
    // `runId` here fails `tsc`, not just a runtime check.
    const dispatchContext = buildDispatchContext({
      runId,
      orchestrationId,
      timestamp: new Date().toISOString(),
    });
    const detail: {
      task: string;
      orchestrationId: string;
      runId: string;
      orgId: string;
      timestamp: string;
      callback?: TaskCallback;
    } = {
      task: input.taskDetails,
      orchestrationId: dispatchContext.orchestrationId as string,
      runId: dispatchContext.runId,
      // Server-derived only (finding 87a171ad) — never read from `input`.
      orgId,
      timestamp: dispatchContext.timestamp as string,
    };

    // Include callback if provided
    if (input.callback) {
      detail.callback = input.callback;
    }

    await eventBridgeClient.send(
      new PutEventsCommand({
        Entries: [
          {
            Source: "task.request",
            DetailType: "task.request",
            EventBusName: EVENT_BUS_NAME,
            Detail: JSON.stringify(detail),
          },
        ],
      }),
    );

    console.log("Task submitted successfully to EventBridge");

    return {
      success: true,
      orchestrationId,
      message: "Task submitted to Supervisor successfully",
    };
  } catch (error) {
    console.error("Error submitting task to EventBridge:", error);
    throw new Error(`Failed to submit task: ${error}`);
  }
}
