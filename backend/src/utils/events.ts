import {
  EventBridgeClient,
  PutEventsCommand,
} from "@aws-sdk/client-eventbridge";
import * as AWSXRay from "aws-xray-sdk-core";
import { AgentEvent } from "../types";
import { getActiveTraceContext } from "./trace-context";
import { logger } from "./logger";

// Tracing foundation (architect task 5459301e-1e7b-4bfd-bccb-b106aba2748c,
// design §1(a)/§6 item 3): this is the acceptance-critical PutEvents
// subsegment — EventBridge does not natively continue the trace to the
// arbiter, but the emit itself becomes visible on the resolver's own trace.
// Pin the context-missing strategy to LOG_ERROR — see utils/dynamodb.ts for
// the identical pattern + rationale (no-op-safe under Jest, where no X-Ray
// segment/daemon context exists).
AWSXRay.setContextMissingStrategy("LOG_ERROR");
const eventBridgeClient = AWSXRay.captureAWSv3Client(new EventBridgeClient({}));
const EVENT_BUS_NAME = process.env.EVENT_BUS_NAME || "agentic-ai-agents";

export async function publishEvent(event: AgentEvent): Promise<void> {
  try {
    // Additive, optional traceContext (design §"Carried-context format
    // decision"): spread only when an active X-Ray segment exists, so the
    // Detail body is byte-identical to pre-feature callers when there is no
    // segment (property-tested in events.test.ts).
    const traceContext = getActiveTraceContext();
    const command = new PutEventsCommand({
      Entries: [
        {
          Source: "citadel.backend",
          DetailType: event.eventType,
          Detail: JSON.stringify({
            projectId: event.projectId,
            agentId: event.agentId,
            payload: event.payload,
            timestamp: event.timestamp,
            correlationId: event.correlationId,
            ...(traceContext ? { traceContext } : {}),
          }),
          EventBusName: EVENT_BUS_NAME,
        },
      ],
    });

    await eventBridgeClient.send(command);
    logger.info("Event published", {
      eventType: event.eventType,
      projectId: event.projectId,
      agentId: event.agentId,
      timestamp: event.timestamp,
    });
  } catch (error) {
    console.error("Failed to publish event:", error);
    throw error;
  }
}

export function createProjectEvent(
  eventType: string,
  projectId: string,
  payload: unknown,
  correlationId?: string,
): AgentEvent {
  return {
    eventType,
    projectId,
    payload,
    timestamp: new Date().toISOString(),
    correlationId,
  };
}

export function createAgentEvent(
  eventType: string,
  projectId: string,
  agentId: string,
  payload: unknown,
  correlationId?: string,
): AgentEvent {
  return {
    eventType,
    projectId,
    agentId,
    payload,
    timestamp: new Date().toISOString(),
    correlationId,
  };
}

// Event type constants
export const EventTypes = {
  PROJECT_CREATED: "project.created",
  PROJECT_UPDATED: "project.updated",
  PROJECT_DELETED: "project.deleted",
  DOCUMENT_UPLOADED: "document.uploaded",
  MESSAGE_SENT_TO_AGENT: "message.sent_to_agent",
  MESSAGE_CREATED: "message.created",
  AGENT_STATUS_UPDATED: "agent.status_updated",
  AGENT_TASK_STARTED: "agent.task_started",
  AGENT_TASK_COMPLETED: "agent.task_completed",
  AGENT_ERROR: "agent.error",
  PROJECT_PROGRESS_UPDATED: "project.progress_updated",
  AGENT_IMPORT_DISCOVERED: "agent.import.discovered",
  AGENT_IMPORT_REGISTERED: "agent.import.registered",
  AGENT_IMPORT_FAILED: "agent.import.failed",
  AGENT_IMPORT_ATTESTED: "agent.import.attested",
  AGENT_IMPORT_ACTIVATION_GATE: "agent.import.activation_gate",
  MODEL_CONFIG_CHANGED: "model.config.changed",
  MODEL_CATALOG_SYNCED: "model.catalog.synced",
  MODEL_CATALOG_SYNC_REQUESTED: "model.catalog.sync_requested",
} as const;

export type EventType = (typeof EventTypes)[keyof typeof EventTypes];
