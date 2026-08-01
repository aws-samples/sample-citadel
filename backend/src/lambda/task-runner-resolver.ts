import {
  EventBridgeClient,
  PutEventsCommand,
} from "@aws-sdk/client-eventbridge";
import { randomUUID } from "crypto";
import { mintRunId, buildDispatchContext } from "../utils/run-id";

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
// never read.

export const handler = async (event: {
  info: { fieldName: string };
  arguments: { input: SubmitTaskInput };
}) => {
  console.log("Event:", JSON.stringify(event, null, 2));

  const fieldName = event.info.fieldName;

  try {
    if (fieldName === "submitTask") {
      return await submitTask(event.arguments.input);
    }

    throw new Error(`Unknown field: ${fieldName}`);
  } catch (error) {
    console.error("Error:", error);
    throw error;
  }
};

async function submitTask(input: SubmitTaskInput) {
  const orchestrationId = randomUUID();
  // Server-minted only — never read from `input` (SubmitTaskInput has no
  // runId field to begin with; this mint is the sole source, same
  // discipline as orchestrationId above).
  const runId = mintRunId();

  console.log("Submitting task to Supervisor:", {
    orchestrationId,
    runId,
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
      timestamp: string;
      callback?: TaskCallback;
    } = {
      task: input.taskDetails,
      orchestrationId: dispatchContext.orchestrationId as string,
      runId: dispatchContext.runId,
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
