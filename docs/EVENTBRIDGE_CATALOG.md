# EventBridge Event Catalog

All async coordination in Citadel flows through a single EventBridge bus: `citadel-agents-{env}`. This document catalogs every event type, its schema, and which components produce and consume it.

## Event Bus

- Bus name: `citadel-agents-{env}` (e.g., `citadel-agents-dev`)
- Created by: `BackendStack`
- Shared across all stacks via CDK props

## Event Sources

| Source | Layer | Description |
|--------|-------|-------------|
| `citadel.backend` | Backend | Lambda resolver events (project, agent, document lifecycle) |
| `citadel.workflows` | Arbiter (StepRunner) | Workflow execution lifecycle events |
| `citadel.apps` | Backend | App status transitions and component changes |
| `task.request` | Backend | New task submissions for the Supervisor |
| `task.completion` | Arbiter (Worker) | Worker agent task completion signals |
| `supervisor` | Arbiter (Supervisor) | Supervisor chatter and direct responses |

## Backend Events (source: `citadel.backend`)

These events are published by Lambda resolvers via `backend/src/utils/events.ts`.

### Event Types

| DetailType | Producer | Description |
|------------|----------|-------------|
| `project.created` | project-resolver | New project created |
| `project.updated` | project-resolver | Project metadata updated |
| `project.deleted` | project-resolver | Project deleted |
| `document.uploaded` | document-upload-resolver | Document uploaded to S3 |
| `message.sent_to_agent` | agent-message-handler | User message sent to an agent |
| `message.created` | conversation-resolver | Conversation message persisted |
| `agent.status_updated` | agent-resolver | Agent status changed |
| `agent.task_started` | agent-resolver | Agent task execution started |
| `agent.task_completed` | agent-resolver | Agent task execution completed |
| `agent.error` | agent-resolver | Agent encountered an error |
| `project.progress_updated` | project-progress-updater | Project progress metrics updated |

### Event Schema

```json
{
  "source": "citadel.backend",
  "detail-type": "<event_type>",
  "detail": {
    "projectId": "string",
    "agentId": "string (optional)",
    "payload": { },
    "timestamp": "ISO 8601",
    "correlationId": "string (optional)"
  }
}
```

### Event Type Constants

Defined in `backend/src/utils/events.ts` as the `EventTypes` object:

```typescript
export const EventTypes = {
  PROJECT_CREATED: 'project.created',
  PROJECT_UPDATED: 'project.updated',
  PROJECT_DELETED: 'project.deleted',
  DOCUMENT_UPLOADED: 'document.uploaded',
  MESSAGE_SENT_TO_AGENT: 'message.sent_to_agent',
  MESSAGE_CREATED: 'message.created',
  AGENT_STATUS_UPDATED: 'agent.status_updated',
  AGENT_TASK_STARTED: 'agent.task_started',
  AGENT_TASK_COMPLETED: 'agent.task_completed',
  AGENT_ERROR: 'agent.error',
  PROJECT_PROGRESS_UPDATED: 'project.progress_updated',
} as const;
```

## Workflow Events (source: `citadel.workflows`)

These events are published by the Step Runner via `arbiter/stepRunner/events.py`. All workflow events include a `correlationId` set to the `executionId` for cross-service traceability.

### Event Types

| DetailType | Producer | Consumer | Description |
|------------|----------|----------|-------------|
| `workflow.started` | executor.start_execution | Fan-out Lambda | Execution transitioned pending → running |
| `workflow.node.started` | executor.invoke_node | Fan-out Lambda | Node began execution |
| `workflow.node.completed` | Worker Wrapper | Step Runner, Fan-out Lambda | Node completed successfully |
| `workflow.node.failed` | Worker Wrapper | Step Runner, Fan-out Lambda | Node execution failed |
| `workflow.node.retrying` | executor.handle_node_failure | Fan-out Lambda | Node scheduled for retry |
| `workflow.completed` | executor.handle_node_completion | Fan-out Lambda | All nodes completed |
| `workflow.failed` | executor.handle_node_failure | Fan-out Lambda | Execution failed (retries exhausted or cancelled) |

### Event Schemas

#### workflow.started

```json
{
  "source": "citadel.workflows",
  "detail-type": "workflow.started",
  "detail": {
    "executionId": "string",
    "workflowId": "string",
    "appId": "string",
    "startedAt": "ISO 8601",
    "correlationId": "string (= executionId)",
    "timestamp": "ISO 8601"
  }
}
```

#### workflow.node.started

```json
{
  "source": "citadel.workflows",
  "detail-type": "workflow.node.started",
  "detail": {
    "executionId": "string",
    "workflowId": "string",
    "nodeId": "string",
    "agentId": "string",
    "startedAt": "ISO 8601",
    "correlationId": "string",
    "timestamp": "ISO 8601"
  }
}
```

#### workflow.node.completed

```json
{
  "source": "citadel.workflows",
  "detail-type": "workflow.node.completed",
  "detail": {
    "executionId": "string",
    "workflowId": "string",
    "nodeId": "string",
    "agentId": "string",
    "completedAt": "ISO 8601",
    "output": { },
    "correlationId": "string",
    "timestamp": "ISO 8601"
  }
}
```

#### workflow.node.failed

```json
{
  "source": "citadel.workflows",
  "detail-type": "workflow.node.failed",
  "detail": {
    "executionId": "string",
    "workflowId": "string",
    "nodeId": "string",
    "agentId": "string",
    "error": "string",
    "retryCount": "number",
    "correlationId": "string",
    "timestamp": "ISO 8601"
  }
}
```

#### workflow.node.retrying

```json
{
  "source": "citadel.workflows",
  "detail-type": "workflow.node.retrying",
  "detail": {
    "executionId": "string",
    "workflowId": "string",
    "nodeId": "string",
    "agentId": "string",
    "retryCount": "number",
    "backoff": "number (seconds)",
    "correlationId": "string",
    "timestamp": "ISO 8601"
  }
}
```

#### workflow.completed

```json
{
  "source": "citadel.workflows",
  "detail-type": "workflow.completed",
  "detail": {
    "executionId": "string",
    "workflowId": "string",
    "completedAt": "ISO 8601",
    "output": { },
    "correlationId": "string",
    "timestamp": "ISO 8601"
  }
}
```

#### workflow.failed

```json
{
  "source": "citadel.workflows",
  "detail-type": "workflow.failed",
  "detail": {
    "executionId": "string",
    "workflowId": "string",
    "failedNodeId": "string",
    "error": "string",
    "failedAt": "ISO 8601",
    "correlationId": "string",
    "timestamp": "ISO 8601"
  }
}
```

## Execution Control Events

These events control workflow execution lifecycle. They are published by the Execution Resolver and consumed by the Step Runner.

| DetailType | Producer | Consumer | Description |
|------------|----------|----------|-------------|
| `execution.start.requested` | execution-resolver | Step Runner | Start a new workflow execution |
| `execution.cancel.requested` | execution-resolver | Step Runner | Cancel a running execution |

## Task Orchestration Events

These events coordinate the Supervisor ↔ Worker communication loop.

### task.request (source: `task.request`)

Published by the backend (task-runner-resolver) or by per-app API Gateways. Consumed by the Supervisor Lambda.

```json
{
  "source": "task.request",
  "detail-type": "System-Task",
  "detail": {
    "task": "string (user request text)",
    "appId": "string (optional — scopes agent resolution)",
    "callback": {
      "type": "eventbridge | sqs | mcp",
      "eventBusName": "string (optional)",
      "queueUrl": "string (optional)",
      "endpoint": "string (optional)"
    }
  }
}
```

### task.completion (source: `task.completion`)

Published by the Worker Wrapper after agent execution. Consumed by the Supervisor Lambda.

```json
{
  "source": "task.completion",
  "detail": {
    "orchestration_id": "string",
    "agent_use_id": "string",
    "node": "string (agent name)",
    "data": { }
  }
}
```

## Supervisor Events (source: `supervisor`)

Published by the Supervisor for real-time visibility into agent coordination.

| DetailType | Description |
|------------|-------------|
| `chatter` | Agent call dispatched (includes agent_name, input, target queue) |
| `supervisor.feedback` | Supervisor direct text response (no agents invoked) |
| `task.response` | Final response to the original requester |

## App Lifecycle Events (source: `citadel.apps`)

Published by the App Resolver during status transitions and component changes.

| DetailType | Description |
|------------|-------------|
| `app.status.draft_to_active` | App published (DRAFT → ACTIVE) |
| `app.status.active_to_archived` | App archived (ACTIVE → ARCHIVED) |
| `app.status.archived_to_draft` | App reactivated (ARCHIVED → DRAFT) |
| `app.component.added` | Component added to app |
| `app.component.removed` | Component removed from app |
| `app.published` | App API Gateway provisioned |

## Fabrication Events

Published by the Fabricator and consumed by the frontend via subscription fan-out.

| DetailType | Source | Description |
|------------|--------|-------------|
| `agent.fabricated` | Fabricator | Agent creation completed |
| `tool.fabricated` | Fabricator | Tool creation completed |
| `fabrication.completed` | Fabricator | Generic fabrication success |
| `fabrication.failed` | Fabricator | Fabrication error |

## EventBridge Rules (defined in CDK)

### ArbiterStack Rules

| Rule | Event Pattern | Target |
|------|--------------|--------|
| `TaskRequestRule` | source: `task.request` | Supervisor Lambda |
| `TaskCompletionRule` | source: `task.completion` | Supervisor Lambda |
| `StepRunnerStartRule` | detailType: `execution.start.requested` | Step Runner Lambda |
| `StepRunnerNodeCompletedRule` | detailType: `workflow.node.completed` | Step Runner Lambda |
| `StepRunnerNodeFailedRule` | detailType: `workflow.node.failed` | Step Runner Lambda |
| `StepRunnerCancelRule` | detailType: `execution.cancel.requested` | Step Runner Lambda |
| `WorkflowProgressFanoutRule` | source: `citadel.workflows`, 7 detail types | Fan-out Lambda |

### ServicesStack Rules

| Rule | Event Pattern | Target |
|------|--------------|--------|
| `HealthCheckScheduleRule` | Schedule: every 15 minutes | Health Monitor Lambda |

## Idempotency

All EventBridge-triggered handlers use the `IdempotencyGuard` class (`backend/src/utils/idempotency.ts`):

1. Before processing, performs a conditional DynamoDB put: `attribute_not_exists(eventId)`
2. If the event was already processed, the handler is silently skipped
3. Items expire via TTL after 24 hours
4. The idempotency table is `citadel-idempotency-{env}`

This ensures safe retries — EventBridge may deliver the same event multiple times, and the system produces the same result without duplicate side effects.

## Adding a New Event Type

1. Add the event type constant to `EventTypes` in `backend/src/utils/events.ts`
2. Publish the event using `publishEvent()` from the same module
3. If the event needs to trigger a Lambda, add an EventBridge rule in the appropriate CDK stack
4. If the event needs to reach the frontend, add it to the Fan-out Lambda's event pattern and create a corresponding AppSync subscription
5. Always include `correlationId` and `timestamp` in the event detail
6. Use the `IdempotencyGuard` in the consuming Lambda handler
