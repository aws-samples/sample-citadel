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

## Governance Events (source: `citadel.backend`)

Design-time governance events emitted by the AI-Accelerated Modernization Governance track. All events use `Source: citadel.backend`, carry a `correlationId`, and are emitted via the shared helper `backend/src/utils/notifier-base.ts`.

Implements requirement §3.4 of the governance spec. The naming distinction from `ARBITER_GOVERNANCE_BYPASS` (Arbiter-track env var) is intentional: the two flags control different subsystems and must not be conflated.

### Event Types

| DetailType | Producer | Consumer | Description |
|------------|----------|----------|-------------|
| `governance.adr.locked` | adr-resolver.createADR | SIEM / audit | An ADR transitioned PROPOSED → LOCKED |
| `governance.adr.reopen.attempted` | adr-resolver.reopenADR | SIEM / audit | ADR re-open attempted (audit-logged BEFORE auth check per QT3-3) |
| `governance.specification.created` | execspec-resolver.createExecutionSpecification | SIEM / audit | New ExecutionSpecification in DRAFT state |
| `governance.specification.approved` | execspec-resolver.approveExecutionSpecification | SIEM / audit, fabricator | ExecutionSpecification approved by architect |
| `governance.specification.rejected` | execspec-resolver.rejectExecutionSpecification | SIEM / audit | ExecutionSpecification rejected (audit-logged BEFORE auth check per QT3-3) |
| `governance.round.started` | round-resolver.startInterrogationRound | SIEM / audit | InterrogationRound opened |
| `governance.round.completed` | round-resolver.stabiliseRound | SIEM / audit | InterrogationRound stabilised; S3 transcript persisted |
| `governance.round.transcript.overflow` | round-resolver.stabiliseRound | SIEM / audit | Transcript exceeded 5MB soft cap (QD-3) |
| `governance.archetype.classified` | agent-design-assessment-resolver.submitAgentDesignAssessment | Fabricator | Project archetype classified — payload: `{projectId, archetype, confidence}` |
| `governance.offfrontier.escalated` | arbiter/workerWrapper/tools/escalate.py | SIEM / audit, PagerDuty | Agent invoked the explicit escalate tool (C12) |
| `governance.grandfathered.bypass` | project-resolver phase-transition gates via `isGrandfathered(project)` | SIEM / audit, telemetry | A governance gate (C3/C7/C10) was bypassed for a pre-`effective_at` project — payload: `{projectId, bypassedGate, projectCreatedAt, effectiveAt}` where `bypassedGate ∈ {C3_assessment_required, C7_adr_required, C10_spec_required}` |

Schemas are populated in individual emitter PRs per QT4-1 (same-PR catalog invariant). The list above is the reserved allocation; new types MUST NOT be added without updating this catalog in the same PR.

### Non-emitting governance operations

Not every governance mutation emits an EventBridge event. The following are deliberate no-event operations — they mutate DynamoDB but do NOT publish to `citadel-agents-{env}`:

| Operation | Producer | Rationale |
|-----------|----------|-----------|
| `runProgramReview` | `program-review-resolver` | Read-only evaluation of existing governance evidence (ADRs, ExecutionSpecifications, InterrogationRounds, AgentDesignAssessments) against the 20-question checklist. Persists a `ProgramReview` row for audit traceability but does not change governance state, so no consumer needs to react. |

### Event Schema

All governance events share this envelope:

```json
{
  "source": "citadel.backend",
  "detail-type": "governance.<domain>.<action>",
  "detail": {
    "correlationId": "string (required, UUID)",
    "timestamp": "ISO 8601 (required)",
    "projectId": "string (required for most events)",
    ... domain-specific fields...
  }
}
```

Details are sanitised (HTML/script tags stripped) by `backend/src/utils/notifier-base.ts` before emission.

### Event Schemas

#### `governance.offfrontier.escalated`

**Source:** `citadel.backend`
**Emitted by:** `arbiter/workerWrapper/tools/escalate.py`
**Consumers:** SIEM / audit, PagerDuty
**Meaning:** An agent invoked the explicit `escalate` tool to hand off a task outside AI-analytical scope (C12 Jagged-Frontier principle). Explicit-only telemetry per QT2A-10 — no NLP heuristic detection.

Each invocation also emits exactly one `CitadelGovernance/OffFrontierEscalations` CloudWatch metric (Value=1, dimension `ProjectId`).

```json
{
  "source": "citadel.backend",
  "detail-type": "governance.offfrontier.escalated",
  "detail": {
    "correlationId": "string (UUID, required)",
    "timestamp": "ISO 8601 UTC (required)",
    "projectId": "string (required)",
    "agentId": "string (required)",
    "reason": "string (0..500 chars, required; truncated if longer)"
  }
}
```

### Authorisation signal events

`governance.adr.reopen.attempted` and `governance.specification.rejected` follow the **audit-before-auth** ordering (QT3-3). The EventBridge emission happens regardless of auth outcome. The `detail.authResult` field carries `"ALLOWED"` or `"DENIED"` so auditors can reconstruct rejected attempts.

## Agent Import Events (source: `citadel.backend`)

Best-effort lifecycle events emitted by `backend/src/lambda/agent-import-resolver.ts` via the shared `backend/src/utils/events.ts` `publishEvent` helper. Emission is **best-effort**: a publish failure is logged and swallowed and NEVER fails (or alters the result of) the underlying `importAgent` mutation or the `discoverAgents` / `describeAgentCandidate` queries. Every event carries a `correlationId` (UUID, generated per call — no request id is exposed on the AppSync event) and an ISO 8601 `timestamp`. The import-specific fields live under `detail.payload`, consistent with the Backend Events envelope above (`projectId` is unused and emitted as `""`).

### Event Types

| DetailType | Producer | Consumer | Description |
|------------|----------|----------|-------------|
| `agent.import.discovered` | agent-import-resolver.discoverAgents | SIEM / audit, telemetry | Exactly one summary event per discovery call (SCAN / PASTE / MANIFEST) |
| `agent.import.registered` | agent-import-resolver.importAgent | SIEM / audit, telemetry | An external agent was registered into the Registry on a CREATE, REPLACE, or COPY. NOT emitted on a no-op link or an unresolved conflict |
| `agent.import.failed` | agent-import-resolver (import / discover / describe catch) | SIEM / audit | An import / discover / describe operation threw; emitted before the original error is rethrown |
| `agent.import.attested` | agent-import-resolver.attestAgentImport | SIEM / audit, governance | An admin/architect attested an imported agent — `governanceAttestation.status` advanced `pending` → `attested`. Emitted once per real transition; NOT emitted on an idempotent re-attestation of an already-attested record |
| `agent.import.activation_gate` | agent-config-resolver (APPROVED activation transition) | SIEM / audit, governance | The import activation gate evaluated an imported, not-yet-attested agent at activation. In `shadow`/`permissive` modes a best-effort "would-block" event is emitted and activation proceeds; in `strict` the activation throws instead (no event) |

### Event Schemas

#### agent.import.discovered

```json
{
  "source": "citadel.backend",
  "detail-type": "agent.import.discovered",
  "detail": {
    "projectId": "",
    "payload": {
      "source": "string (SCAN | PASTE | MANIFEST | null)",
      "candidateCount": "number",
      "substrates": "string[] (unique substrates in the result)"
    },
    "correlationId": "string (UUID, required)",
    "timestamp": "ISO 8601 (required)"
  }
}
```

#### agent.import.registered

```json
{
  "source": "citadel.backend",
  "detail-type": "agent.import.registered",
  "detail": {
    "projectId": "",
    "payload": {
      "agentId": "string (Registry recordId)",
      "sourceArn": "string | null",
      "substrate": "string | null",
      "orgId": "string (derived from the caller identity, never the input)"
    },
    "correlationId": "string (UUID, required)",
    "timestamp": "ISO 8601 (required)"
  }
}
```

#### agent.import.failed

```json
{
  "source": "citadel.backend",
  "detail-type": "agent.import.failed",
  "detail": {
    "projectId": "",
    "payload": {
      "operation": "import | discover | describe",
      "message": "string (original error message)"
    },
    "correlationId": "string (UUID, required)",
    "timestamp": "ISO 8601 (required)"
  }
}
```

#### agent.import.attested

```json
{
  "source": "citadel.backend",
  "detail-type": "agent.import.attested",
  "detail": {
    "projectId": "",
    "payload": {
      "agentId": "string (Registry recordId)",
      "attestedBy": "string (attesting admin/architect — Cognito sub, or username fallback)",
      "orgId": "string | null (the RECORD's org — the agent being attested, not necessarily the caller's)"
    },
    "correlationId": "string (UUID, required)",
    "timestamp": "ISO 8601 (required)"
  }
}
```

#### agent.import.activation_gate

Emitted by `backend/src/lambda/agent-config-resolver.ts` (NOT the import resolver) from the import activation gate, on the APPROVED transition of an imported, not-yet-attested agent, in `shadow`/`permissive` modes only (`strict` throws instead). Unlike the other import events this envelope carries `agentId` at the `detail` level and does NOT include a `correlationId`.

```json
{
  "source": "citadel.backend",
  "detail-type": "agent.import.activation_gate",
  "detail": {
    "projectId": "",
    "agentId": "string (Registry recordId)",
    "payload": {
      "agentId": "string (Registry recordId)",
      "attestationStatus": "pending",
      "mode": "shadow | permissive",
      "wouldBlock": true
    },
    "timestamp": "ISO 8601 (required)"
  }
}
```

## Agent Import — Tier-3 Manifest Proposal Events

The Tier-3 (AI-assisted) manifest proposal is asynchronous. The `agent-import-resolver.proposeAgentManifestTier3` mutation enqueues a **secret-free** signal envelope to the Fabricator queue (`requestType: manifest-proposal`); the Python Fabricator (`arbiter/fabricator/index.py` `publish_manifest_event`, via `manifest_proposal.propose_agent_manifest`) then emits one of the two events below when the LLM proposal completes. Both are produced on the agent bus (`COMPLETION_BUS_NAME` → `citadel-agents-{env}`) and — following the same `Source == DetailType` convention as the Fabrication Events below — their `Source` equals the detail-type (not `citadel.backend`). They are **not** declared in the `EventTypes` constants (those are TypeScript-side; these are produced by the Python Fabricator).

They are consumed by `backend/src/lambda/agent-import-manifest-result-handler.ts` (the B1 result handler), which recursively sanitizes the untrusted manifest and parks it on the DRAFT import record as `customMetadata.proposedManifest` (`reviewState: 'pending_review'` on a proposal, `'failed'` on the marker). The handler is idempotent on `correlationId || requestId` and never promotes/activates the record.

### Event Types

| DetailType (== Source) | Producer | Consumer | Description |
|------------------------|----------|----------|-------------|
| `agent.import.manifest.proposed` | Fabricator `_process_manifest_proposal` | `agent-import-manifest-result-handler` | An LLM-proposed capability descriptor is ready for human review (always low confidence) |
| `agent.import.manifest.failed` | Fabricator `_process_manifest_proposal` | `agent-import-manifest-result-handler` | The proposal could not be produced (unparseable/invalid model output, or a model/client error) |

### Event Schemas

#### agent.import.manifest.proposed

```json
{
  "source": "agent.import.manifest.proposed",
  "detail-type": "agent.import.manifest.proposed",
  "detail": {
    "requestId": "string (UUID)",
    "correlationId": "string (UUID)",
    "importId": "string (DRAFT import record id)",
    "proposedManifest": { "...": "AgentCapabilityDescriptor-shaped JSON; sanitized by the consumer" },
    "status": "proposed"
  }
}
```

#### agent.import.manifest.failed

```json
{
  "source": "agent.import.manifest.failed",
  "detail-type": "agent.import.manifest.failed",
  "detail": {
    "requestId": "string (UUID)",
    "correlationId": "string (UUID)",
    "importId": "string (DRAFT import record id)",
    "error": "string (short, secret-free)",
    "status": "failed"
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

As of PR 3 of the governance retrofit, all `citadel.apps` events are emitted
by the registry-backed shim `backend/src/lambda/agent-app-shim-resolver.ts`.
The event envelope and detail-type names are preserved from the legacy
`app-resolver.ts` for backward compatibility during the `@deprecated type AgentApp`
grace window. Subscribers need no changes. See
[`AGENT_RECORDS.md`](./AGENT_RECORDS.md) for the underlying data model.

Published by the App Resolver during status transitions and component changes.

| DetailType | Description |
|------------|-------------|
| `app.access.granted` | Access entry granted to user via grantAppAccess shim handler |
| `app.access.revoked` | Access entry revoked from user via revokeAppAccess shim handler |
| `app.agent.binding.updated` | Agent binding fields updated via updateAgentBinding shim handler |
| `app.auth.config.set` | App auth configuration set via setAppAuthConfig shim handler |
| `app.component.added` | Component added to app via addAppComponent shim handler |
| `app.component.removed` | Component removed from app via removeAppComponent shim handler |
| `app.config.schema.set` | App config JSON Schema set via setAppConfigSchema shim handler |
| `app.config.values.set` | App config values set via setAppConfigValues shim handler |
| `app.created` | App created via createApp shim handler (after registry record create and authority grant) |
| `app.deleted` | App deleted via deleteApp shim handler (after authority revoke and registry record delete) |
| `app.published` | App API Gateway provisioned |
| `app.status.active_to_archived` | App archived (ACTIVE → ARCHIVED) via updateApp shim handler |
| `app.status.archived_to_draft` | App reactivated (ARCHIVED → DRAFT) via updateApp shim handler |
| `app.status.draft_to_approved` | App approved (DRAFT → APPROVED) via updateApp shim handler |
| `app.status.published` | App status change published via publishAppStatusEvent shim handler (IAM-authed passthrough) |
| `app.updated` | App metadata updated via updateApp shim handler |
| `app.workflow.bound` | Workflow bound to app via bindWorkflowToApp shim handler |
| `app.workflow.unbound` | Workflow unbound from app via unbindWorkflowFromApp shim handler |

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
7. For registry-backed app events, the emission point is `backend/src/lambda/agent-app-shim-resolver.ts::emitEvent` — do not re-introduce legacy `app-resolver.ts` call sites.
