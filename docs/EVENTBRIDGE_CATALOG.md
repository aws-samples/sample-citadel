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
| `citadel.telemetry` | Backend (TelemetryStack) | Cost budget threshold/breach notifications — the one publisher exception in an otherwise consume-only stack |
| `agent_intake.<phase>` | Service (intake runtime), Arbiter (Fabricator), Backend (app publish handler) | Intake project-progress milestones — one source per phase: `agent_intake.assessment`, `agent_intake.design`, `agent_intake.planning`, `agent_intake.implementation` |
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
    "correlationId": "string (optional)",
    "traceContext": { } ,
    "runId": "string (optional, server-minted)"
  }
}
```

`traceContext` (optional, additive — see [TRACING_RUNBOOK.md](./TRACING_RUNBOOK.md#carried-context-format)
for the field-by-field shape) and `runId` (optional, server-minted, see
"Trace context & run identity fields" below) were added by `publishEvent()`
in `backend/src/utils/events.ts` without changing any existing field; both
are omitted entirely (not null) when no active trace context / `runId`
exists for the call, so pre-feature callers see a byte-identical Detail
body.

### Trace context & run identity fields

Two additive, optional fields ride the shared envelope above and the
`workflow.*` schemas below:

- **`traceContext`** — populated by `getActiveTraceContext()`
  (`backend/src/utils/trace-context.ts`) only when an active X-Ray segment
  exists at emit time; shape: `{ xrayTraceHeader?, traceId?, parentId?,
  traceparent?, correlationId?, runId? }` (all fields optional). See
  [TRACING_RUNBOOK.md](./TRACING_RUNBOOK.md#carried-context-format) for the
  authoritative format and the annotation-key contract it feeds.
- **`runId`** — the server-minted shared correlation id (Pass 1, decision
  `f1cbd5ef`, `backend/src/utils/run-id.ts`). Carried when the producer's
  dispatch context supplied one; absent on pre-`runId` hops — never
  fabricated by a consumer. See
  [TRACING_RUNBOOK.md](./TRACING_RUNBOOK.md#run-identity-runid-minting-contract)
  for the minting contract (server-minted only, client values stripped,
  `UnstampedDispatch` backstop metric).

Absence of either field must never fail a consumer — both are
property-tested no-op-safe in `backend/src/utils/__tests__/trace-context.test.ts`
and `backend/src/utils/__tests__/events.test.ts`.

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

These events are published by the Step Runner via `arbiter/stepRunner/events.py`. All workflow events include a `correlationId` set to the `executionId` for cross-service traceability. As of `db0e88a`/`8ebef1d`, every `detail` below may additionally carry the same additive, optional `traceContext` and `runId` fields described in "Trace context & run identity fields" above (Python producer: `arbiter/common/tracing.py` + `arbiter/common/workflow_contract.py`) — omitted from the individual schemas below for brevity, but present on the wire whenever an active trace context / `runId` exists at emit time.

### Event Types

| DetailType | Producer | Consumer | Description |
|------------|----------|----------|-------------|
| `workflow.started` | executor.start_execution | Fan-out Lambda | Execution transitioned pending → running |
| `workflow.node.started` | executor.invoke_node | Fan-out Lambda | Node began execution |
| `workflow.node.completed` | Worker Wrapper | Step Runner, Fan-out Lambda | Node completed successfully. **Write-then-signal (decision O2):** the Worker persists the node's `completed` status + output to `EXECUTIONS_TABLE.nodeResults[nodeId]` (conditional first-write-wins) BEFORE emitting this event, so the event is now purely a DAG-advance *signal*. A lost event leaves a durable, reconcilable checkpoint (the watchdog reconciles it within one sweep), never a signaled-but-unpersisted black hole. No wire-schema change. |
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
| `governance.eval.run.started` | eval-runner driver Lambda (CIT-102) | SIEM / audit; CIT-105 reporting (future) | Eval run created + fan-out begun — payload: `{evalRunId, suiteId, suiteVersion, agentTargetId, agentTargetVersion, orgId, caseCount, startedAt, startedBy}` |
| `governance.eval.run.completed` | eval-runner driver Lambda (CIT-102) | SIEM / audit; CIT-105 reporting (future); `eval-run-aggregator` (CIT-103) | Atomic pendingCases counter reached zero — execution-outcome counts only, no scores (CIT-103 owns verdicts) — payload: `{evalRunId, suiteId, orgId, caseCounts: {total, completed, failed, timeout}, completedAt, durationMs}` |
| `governance.eval.case.completed` | `recordCaseCompletion` (eval-run-completion.ts, CIT-103 Pass A) | `eval-case-scorer` (CIT-103) | Additive — emitted AFTER artifact materialization, inside the exactly-once `completionRecorded` guard region, for EVERY terminal case (COMPLETED/FAILED/TIMEOUT alike). Computes NO scores (CIT-103 owns verdicts is preserved) — payload: `{evalRunId, caseId, orgId, caseKind, artifactRef?}` (`artifactRef` absent when materialization was skipped/failed) |
| `governance.eval.case.judge.requested` | `eval-case-scorer` (CIT-103 Pass A) | Arbiter judge handler (CIT-103 Pass B) | **FROZEN cross-language contract (TS → Py).** Emitted when a case opts into one or more judge-basis dimensions (`task_success` via `expectedOutcome.judge`, and/or `groundedness_faithfulness` via `groundingRequirements[].mustNotHallucinate`) — payload: `{evalRunId, caseId, orgId, artifactRef?, judgeDimensions: [{dimension: "task_success"\|"groundedness_faithfulness", rubric: string}], judgeSlot: "judge"}`. `rubric` is derived deterministically from the case's own definition (never free-form user text). |
| `governance.eval.case.judged` | Arbiter judge handler (CIT-103 Pass B) | `eval-case-scorer` (CIT-103 Pass A) — **single writer of eval tables** | **FROZEN cross-language contract (Py → TS).** Emitted after a judge invocation completes — payload: `{evalRunId, caseId, orgId, dimension: "task_success"\|"groundedness_faithfulness", status: "SCORED"\|"UNKNOWN", verdict?: {kind:"score", score: number}, judgeModelId, judgeModelVersion, judgePromptHash}`. `judgeModelId`/`judgeModelVersion`/`judgePromptHash` are REQUIRED on every event of this type — the TS consumer validates their presence and DROPS (logs + never partially writes) an event missing any of the three. `verdict` is present iff `status==='SCORED'`. The judge handler NEVER writes DynamoDB directly — TS is the single writer of eval tables (design invariant). |
| `governance.eval.sample.captured` | `eval-sampling-selector` (Phase 2, production sampling) | `eval-sample-scorer` (Phase 2) — **single writer of `EvalProdSamples`** | Emitted after a sanitized production-sample artifact (built via the UNCHANGED `assembleReplayPackage`, same fail-closed sanitisation gate as the eval-suite path) is durably written to `prod-samples/{orgId}/{runId}.json`. NEVER emitted when the sanitisation gate throws — that sample is dropped instead (fail-closed: no un-redacted content path can exist). Payload: `{sampleId, orgId, agentId, runId, kind: "execution"\|"conversation", artifactRef, dimensions: string[]}`. `dimensions` is the FIXED allowlist (`eval-prod-scoring.ts`'s `PROD_DIMENSION_ORDER`: `policy_compliance`, `groundedness_citation`, `groundedness_faithfulness`, `trajectory`, `latency`, `cost`) — deliberately EXCLUDES `task_success`/`tool_accuracy` (no per-case expectation exists for a production sample; `scoreProdSample`'s signature makes matching one structurally impossible). Sampling itself is gated by org opt-in (`EvalSamplingConfig.optIn===true`) and a deterministic/idempotent decision `shouldSample(runId, rate) = hash(runId) < rate`. |
| `governance.eval.drift.detected` | `eval-drift-detector` (Phase 3, scheduled hourly) | `eval-drift-finding-writer` (Phase 3) | Emitted when a current-vs-baseline comparison for one `(agentId, dimension)` pair (queried from `EvalProdSamples.AgentDimTimeIndex`) breaches its configured threshold (`eval-drift.ts::computeDrift` — a regression strictly greater than the threshold; never an improvement; never below the `DEFAULT_MIN_SAMPLE_COUNT` noise floor). Payload: `{agentId, dimension, baseline: {passRate?, meanScore?, sampleCount}, current: {passRate?, meanScore?, sampleCount}, delta: number\|null, window: {from, to}}`. Best-effort: the cycle's `Citadel/EvalDrift` EMF flush has already durably landed in CloudWatch Logs regardless of this event's delivery outcome. |
| `governance.eval.baseline.designated` | `eval-comparison-resolver.designateEvalBaseline` (CIT-105) | SIEM / audit; future auto-comparison consumer (deferred) | Emitted after a successful baseline designation/re-designation for one `(orgId, agentTargetId, suiteId)` triple — audit trail for a governance act. Best-effort — emit failure never rolls back the durable EvalBaselines row. Payload: `{orgId, agentTargetId, suiteId, baselineEvalRunId, previousBaselineEvalRunId?, designatedBy, at}`. |
| `governance.eval.comparison.completed` | `eval-comparison-resolver.computeEvalComparison` (CIT-105) | SIEM / audit; **future promotion gate (the machine-readable hand-off this event exists for)** | Emitted AFTER the `EvalComparisonsTable` verdict row is durably written (best-effort — emit failure never rolls back that write). Carries only per-dimension-derived booleans/arrays/enum, deliberately no dimension-collapsing number (NEVER a composite — same invariant as the run/case events above; see `eval-no-composite.guard.test.ts`). Payload: `{orgId, suiteId, comparisonId, baselineEvalRunId, candidateEvalRunIds, anyMaterialRegression, materiallyRegressedDimensions, unstableDimensions, verdictStatus, at}`. |
| `governance.release.auto_rollback` | `agent-release-rollback-evaluator` (auto-rollback, decision D6) | `governance-notifier` → admin `onGovernanceEvent` subscription; SIEM / audit | Emitted best-effort POST-commit after an automated `AUTO_ABORT_CANARY` pointer move is durably committed and its write-once GovernanceFinding written. Best-effort — the ledger finding is the durable record; delivery failure never rolls back the committed move. Payload: `{orgId, agentTargetId, environment, action, metric, observedValue, threshold, sampleCount, fromReleaseId, toReleaseId, candidateReleaseId, fromVersion}`. |

Schemas are populated in individual emitter PRs per QT4-1 (same-PR catalog invariant). The list above is the reserved allocation; new types MUST NOT be added without updating this catalog in the same PR.

**Dual-consumer note (Phase 2):** `governance.eval.case.judged` is consumed by BOTH `eval-case-scorer` (its original CIT-103 Pass A consumer) AND `eval-sample-scorer` (Phase 2, production sampling) — the frozen judge.requested/judged contract is reused verbatim for a production sample by setting `evalRunId`/`caseId` to the sample's own `runId`/`sampleId` (the "prod-sample carrier convention"). Both consumers subscribe via a rule targeting them; `eval-sample-scorer` locates its row via a `Query` on the `EvalProdSamplesTable`'s sparse `SampleIdIndex` GSI (partition key `sampleId`, matched against the judged event's `caseId`) and independently no-ops on a zero-result Query when an event does not correlate to a row it wrote — there is no dispatch/routing logic inside the judge handler itself. (A prior revision attempted a direct `GetItem` on `{orgId, runId}`, which does not match this table's real `(PK, SK)` key schema and threw `ValidationException` on every eval-suite judged event; fixed via the GSI Query.)

**Honest gap (Phase 2, CONVERSATION-kind production sampling):** `eval-sampling-selector.ts`'s handler already discriminates on a `conversation.completed` detail-type (Source `citadel.conversations`) for CONVERSATION-kind sampling candidates, but **no producer Lambda in this codebase currently emits that event** for a real (non-eval-suite) conversation turn — `agent-message-handler.ts`'s `storeAgentResponse` path writes the transcript row but emits no completion event, and instrumenting that 30K-line, multi-call-site production handler was out of Phase 2's file plan (it is not among the files this phase modifies; see the architect design's file-list). Consequently, **only EXECUTION-kind production sampling (via `workflow.completed`/`workflow.failed`) is reachable in this pass** — the `EvalSamplingWorkflowCompletionRule` EventBridge rule is fully wired (`TelemetryStack`). Wiring a `ConversationCompletedRule` is deferred to whenever that producer lands; no code change is needed in `eval-sampling-selector.ts` itself when it does.

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

## App Invoke Events (source: `citadel.app.invoke`)

These events carry per-app invoke requests from a published app's API
Gateway HTTP API to the backend. The API Gateway EventBridge-PutEvents
integration (`provisionApiGateway` in `app-publish-handler.ts`) is the sole
producer; `app-invoke-handler` is the sole consumer.

### app.invoke.requested

Emitted by the per-app API Gateway's `POST /invoke` route via its
`AWS_PROXY` / `EventBridge-PutEvents` integration — never emitted directly
by a client. The integration's `RequestParameters` set:

- `Source`: `citadel.app.invoke` (fixed)
- `DetailType`: `app.invoke.requested` (fixed)
- `Detail`: `$request.body` (the raw, UNTRUSTED client JSON body)
- `Resources`: `$context.authorizer.appId` — the TRUSTED appId resolved by
  the Lambda authorizer from the `$default` stage's `StageVariables.appId`
  (set at publish time; backfilled for pre-existing apps by
  `backend/scripts/backfill-app-stage-vars.ts`). This lands in
  `event.resources[0]`.

```json
{
  "source": "citadel.app.invoke",
  "detail-type": "app.invoke.requested",
  "resources": ["<appId> (TRUSTED — from $context.authorizer.appId)"],
  "detail": {
    "workflowId": "string (optional; UNTRUSTED — required only when >1 workflow is bound to the app)",
    "input": "object (optional; UNTRUSTED client payload, sanitized + size-capped by the consumer)"
  }
}
```

**Consumer: `app-invoke-handler`**

- Reads the authoritative `appId` from `event.resources[0]` ONLY — the
  request body's `appId` (if any) is ignored.
- Dedupes on `event.id` via `IdempotencyGuard` (the shared
  `citadel-idempotency-{env}` table) — a duplicate delivery is a no-op.
- Rejects (fail-closed, no write) when: `resources` is empty; the app is not
  found or not `PUBLISHED`; the app has 0 bound workflows; the app has >1
  bound workflows and no/ambiguous `workflowId` was supplied; the resolved
  workflow is not `PUBLISHED`, is in a different org than the app, or is
  bound to a different app; or the body exceeds the 64KiB size cap.
- On success, writes an execution row to `EXECUTIONS_TABLE` (same shape as
  `execution-resolver.ts` `startExecution`: `nodeResults` initialized from
  the workflow definition, `orgId` from the app's own METADATA, `appId`,
  `status: 'pending'`, `triggeredBy: 'app-invoke:<appId>'`) and emits
  `execution.start.requested` on source `citadel.workflows` with
  `correlationId` set to `event.id`.

## Execution Control Events

These events control workflow execution lifecycle. They are published by the Execution Resolver and the App Invoke Handler, and consumed by the Step Runner.

| DetailType | Producer | Consumer | Description |
|------------|----------|----------|-------------|
| `execution.start.requested` | execution-resolver, app-invoke-handler | Step Runner | Start a new workflow execution |
| `execution.cancel.requested` | execution-resolver | Step Runner | Cancel a running execution |
| `execution.resume.requested` | execution-resolver | Step Runner (`StepRunnerResumeRule`) | Advance-only resume of a stuck execution — re-derive the frontier from persisted state and dispatch pending-ready nodes |

#### execution.resume.requested

Emitted by the `resumeExecution` GraphQL mutation after an org-scoped IDOR
check and terminal-state rejection (completed/cancelled/failed are not
resumable, decision O5). The Step Runner re-derives the entire frontier from
the persisted `EXECUTIONS_TABLE` row; the payload carries ONLY locating ids +
the server-validated `orgId` (the consumer re-checks org ownership,
defense-in-depth) — never a caller-supplied node list or status override.
Resume is advance-only: it dispatches `pending`-ready nodes and NEVER
re-dispatches a `running` node (decision O1 — re-driving a possibly-live worker
is the watchdog stall-detector's job).

```json
{
  "source": "citadel.workflows",
  "detail-type": "execution.resume.requested",
  "detail": {
    "executionId": "string",
    "workflowId": "string",
    "orgId": "string",
    "runId": "string (optional)"
  }
}
```

### Exactly-once guarantee and its agent-side limit (decision O7)

The durable-execution machinery guarantees exactly-once at the **recorded-state**
level only: exactly one `completed` result is recorded per node (worker
first-write-wins), exactly one dispatch per node (conditional `pending→running`
guard), and exactly one finalize per execution (conditional `running→completed`
guard). It does **NOT** provide agent-side exactly-once: if the watchdog
re-dispatches a node whose original worker was merely slow (not dead), the agent
**body runs twice** and only the first recorded completion survives. Downstream
agent bodies must therefore be designed idempotent. A dispatch-generation/lease
token would be required for true agent-side once and is deferred (see
docs/TRACING_RUNBOOK.md).

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

## Intake Progress Events (sources: `agent_intake.*`)

The intake progress family drives the per-phase `progress` map on the project record (the project header's Assessment / Design / Planning / Build segments). A single detail-type, `intake.progress.updated`, is published on the agent bus by three emitters; the `source` encodes the phase as `agent_intake.<phase>` (`agent_intake.assessment`, `agent_intake.design`, `agent_intake.planning`, `agent_intake.implementation`).

### Event Types

| DetailType | Source | Producer | Description |
|------------|--------|----------|-------------|
| `intake.progress.updated` | `agent_intake.<phase>` (all four) | Intake runtime — `service/agent_intake_single/tools/state.py` `_publish_event` (via `update_intake_progress` / `_internal_update_progress`) | Conversational milestone updates in any phase (after extraction, go/no-go, each design section, completion). The post-fabrication Build milestones — agents activated 70, app created 80, blueprint published 85, workflow imported 90 — also flow through this emitter with `phase: implementation` |
| `intake.progress.updated` | `agent_intake.implementation` | Fabricator — `arbiter/fabricator/index.py` `publish_intake_progress` | Per-agent fabrication build progress, scaled into the Build segment's 10–60 window (`10 + ((agent_index + 1) / total_agents) × 50`, capped at 60). A failed agent build emits `completionPercentage: -1` — a failure signal, not progress. Skipped entirely when `COMPLETION_BUS_NAME` or the session id is absent |
| `intake.progress.updated` | `agent_intake.implementation` | Backend — `backend/src/lambda/app-publish-handler.ts` `publishApp` | Build-segment completion (`completionPercentage: 100`, `changeSummary: "App published"`) when the published app carries the intake linkage (`sourceProjectId` stamped by `intakeCreateApp`; absent for UI-created apps). Best-effort — the publish never fails on progress telemetry — and a duplicate publish cannot re-emit, because the already-PUBLISHED idempotency check returns before this step |

### Event Schema

```json
{
  "source": "agent_intake.<phase>",
  "detail-type": "intake.progress.updated",
  "detail": {
    "sessionId": "string (intake session id — the projects-table row id the consumer updates)",
    "phase": "assessment | design | planning | implementation",
    "completionPercentage": "number (0-100; -1 = fabrication-failure signal)",
    "changeSummary": "string (plain-language milestone description)",
    "timestamp": "ISO 8601 (optional — the Fabricator emitter omits it)"
  }
}
```

### Routing and Consumer

`ProgressUpdateRule` (BackendStack, `citadel-progress-update-{env}`) matches detail-type `intake.progress.updated` from the four `agent_intake.*` sources and targets the Project Progress Updater Lambda (`backend/src/lambda/project-progress-updater.ts`; retryAttempts 2, maxEventAge 2 hours).

The consumer's write semantics make the family safe under duplicates, retries, and out-of-order delivery:

- **Idempotent** — `IdempotencyGuard` keyed on the EventBridge event id; a redelivered event is a no-op.
- **Monotonic** — the nested `progress.<phase>` write is guarded by a DynamoDB condition (`attribute_not_exists(progress.<phase>) OR progress.<phase> < :pct`), so a phase's progress only ever advances; a stale or lower concurrent value is a conditional no-op. (The intake runtime's own direct project write in `state.py` applies the same monotonic floor.)
- **Failure signals ignored** — a negative `completionPercentage` (the Fabricator's failed-build convention) is skipped entirely: it can neither regress the segment nor write a negative value; the last real progress value stands.
- **Clamped and validated** — values are capped at 100; an unknown `phase` is skipped.
- **No skeleton rows** — when the `progress` map is missing, it is initialized only on an existing project row; events for sessions with no project record are skipped, never materialized into new rows.
- **Derived fields** — each accepted write recomputes `progress.overall` (the rounded mean of the four phase values) and sets `progress.currentPhase` from the phase and whether it reached 100.

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

### BackendStack Rules

| Rule | Event Pattern | Target |
|------|--------------|--------|
| `ProgressUpdateRule` | detailType: `intake.progress.updated`; source: `agent_intake.assessment`, `agent_intake.design`, `agent_intake.planning`, `agent_intake.implementation` | Project Progress Updater Lambda |
| `AppInvokeRule` | source: `citadel.app.invoke`; detailType: `app.invoke.requested` | App Invoke Handler Lambda |

### TelemetryStack Rules (CIT-103 Pass A)

Homed in `TelemetryStack` (not `GovernanceStack`, where the eval-run driver lives) because `eval-case-scorer`/`eval-run-aggregator` need `costLedgerTable` (owned by this stack) and `governanceLedgerTable` (from `ArbiterStack`) for scoring — `GovernanceStack` instantiates before both in `bin/app.ts`. No new SQS queue/DLQ — direct Lambda EventBridge targets, safe because every write is idempotent `SET`, never `ADD`.

| Rule | Event Pattern | Target |
|------|--------------|--------|
| `EvalCaseCompletedRule` | source: `citadel.backend`; detailType: `governance.eval.case.completed` | `eval-case-scorer` Lambda |
| `EvalCaseJudgedRule` | source: `citadel.backend`; detailType: `governance.eval.case.judged` | `eval-case-scorer` Lambda (single writer of eval tables) |
| `EvalRunCompletedAggregationRule` | source: `citadel.backend`; detailType: `governance.eval.run.completed` | `eval-run-aggregator` Lambda |

### TelemetryStack Rules (Phase 2 — production sampling)

Homed here for the same DECISION d36fbbf7 rationale as the CIT-103 Pass A rules above — `eval-sampling-selector`/`eval-sample-scorer` need tables owned by `BackendStack` (`EvalSamplingConfigTable`, `EvalProdSamplesTable`) and `this.costLedgerTable`/`this.replayPackageBucket` (owned by `TelemetryStack` itself). No new SQS queue/DLQ — every write is idempotent `SET` or a fail-closed drop.

| Rule | Event Pattern | Target |
|------|--------------|--------|
| `EvalSamplingWorkflowCompletionRule` | source: `citadel.workflows`; detailType: `workflow.completed`, `workflow.failed` | `eval-sampling-selector` Lambda (EXECUTION-kind candidates; org-opt-in gated internally) |
| `EvalSampleCapturedRule` | source: `citadel.backend`; detailType: `governance.eval.sample.captured` | `eval-sample-scorer` Lambda (single writer of `EvalProdSamples`) |
| `EvalSampleJudgedRule` | source: `citadel.backend`; detailType: `governance.eval.case.judged` | `eval-sample-scorer` Lambda (2nd target on the same detail-type as `EvalCaseJudgedRule` above — see the "Dual-consumer note" in the Governance Events section) |
| `EvalUsageCapturedRule` | source: `citadel.eval.usage`; detailType: `eval.usage.captured` | `cost-ledger-writer` Lambda (tags the row `costContext:"eval"` + sparse GSI6 `EvalContextIndex`) |

A `ConversationCompletedRule` (source `citadel.conversations`, detailType `conversation.completed`) is NOT yet declared — see the "Honest gap" note in the Governance Events section above; no producer exists yet.

### TelemetryStack Rules (Phase 3 — drift detection)

Homed here for the same DECISION d36fbbf7 rationale as Phase 2 above — `eval-drift-detector` reads `EvalProdSamples.AgentDimTimeIndex` (BackendStack) and `eval-drift-finding-writer` writes `governanceLedgerTable` (ArbiterStack). No new SQS queue/DLQ: the detector's EMF flush is durably written to CloudWatch Logs on every cycle regardless of downstream event delivery, and the finding writer's write is idempotent (write-once `ConditionExpression`), so at-least-once EventBridge delivery is safe without a dispatch queue.

| Rule | Event Pattern | Target |
|------|--------------|--------|
| `EvalDriftDetectorScheduleRule` | Schedule: every 1 hour | `eval-drift-detector` Lambda (queries `EvalProdSamples.AgentDimTimeIndex` for current-vs-baseline per `(agentId, dimension)`, emits `Citadel/EvalDrift` EMF, emits `governance.eval.drift.detected` on a threshold breach) |
| `EvalDriftDetectedRule` | source: `citadel.backend`; detailType: `governance.eval.drift.detected` | `eval-drift-finding-writer` Lambda (writes a write-once `GovernanceFinding` row into `GOVERNANCE_LEDGER_TABLE`) |

CIT-105's `governance.eval.baseline.designated` / `governance.eval.comparison.completed` are emitted best-effort (no dedicated EventBridge rule/target in this pass — no consumer exists yet beyond SIEM/audit log ingestion of the raw event; the future promotion gate is the intended consumer of `governance.eval.comparison.completed` and will register its own rule when built, per design §9's explicit note that auto-trigger event-driven comparison is deferred).

`eval-drift-detector` enumerates agents to check from the `EVAL_DRIFT_AGENT_IDS` env var (comma-separated, operator-supplied) rather than discovering them via a Scan of `EvalProdSamples` — an empty/unset value means the cycle is a no-op, never a fabricated agent list. The `Citadel/EvalDrift` EMF namespace carries dimensions `{Environment, AgentId, Dimension}` (bounded cardinality: finite agents x the fixed Phase 2 dimension allowlist); `runId`/`sampleId` are never dimensions. A `DriftDelta` CloudWatch alarm (`EvalDriftAlarm`, `backend/lib/telemetry-stack.ts`) watches the same namespace/metric and pages via the existing shared `props.alarmTopic` (no new SNS topic).

`eval-drift-finding-writer`'s `GovernanceFinding` row is a schema adaptation, not a native fit: `GovernanceFinding` (`arbiter/governance/models.py`) is an arbitration-decision legibility record (`workflow_id`, `decision: PERMIT|DENY|ESCALATE|HALT`, `requesting_agent`, `target_agent`, `reason` — no `category`/`severity` field exists on the dataclass). A drift breach is mapped onto it as: `decision="escalate"`, `requesting_agent="eval-drift-detector"`, `target_agent=<agentId>`, `workflow_id="EVAL_DRIFT#<agentId>#<dimension>"` (a stable synthetic id, not a real workflow), `reason=<legible sentence with baseline/current/delta>`. An additive `category:"eval-drift"` attribute rides alongside for a future governance-UI filter — it is not read by the existing `governance-ui-resolver.ts::projectFinding` today and does not change that resolver's output for any other finding. `findingId` is a deterministic hash of `{agentId}#{dimension}#{window.from}#{window.to}` (not a fresh UUID) so the SAME breach re-detected for the SAME cycle collides on the write-once `ConditionExpression: attribute_not_exists(findingId)` and produces exactly one finding per breach per cycle — the write is idempotent per cycle, not merely per Lambda invocation.

## Idempotency

All EventBridge-triggered handlers use the `IdempotencyGuard` class (`backend/src/utils/idempotency.ts`):

1. Before processing, performs a conditional DynamoDB put: `attribute_not_exists(eventId)`
2. If the event was already processed, the handler is silently skipped
3. Items expire via TTL after 24 hours
4. The idempotency table is `citadel-idempotency-{env}`

This ensures safe retries — EventBridge may deliver the same event multiple times, and the system produces the same result without duplicate side effects.

## Cost Ledger Events (consumer: `cost-ledger-writer`)

The invocation cost ledger (`citadel-cost-ledger-{env}`, `TelemetryStack`) is populated by a single writer Lambda, `backend/src/lambda/cost-ledger-writer.ts`, subscribed to four separate EventBridge rules that all target the **same** function. The writer branches on `source`/`detail-type` and applies its own idempotency (`PutCommand` + `ConditionExpression: attribute_not_exists(PK)`, keyed on `<eventId>:<callIndex>`) rather than the shared `IdempotencyGuard` table.

| Source | DetailType | Meaning |
|--------|------------|---------|
| `task.completion` | `task.completion` | Standalone (non-workflow) worker task usage |
| `agent_intake.usage` | `intake.usage.captured` | Intake-runtime model usage |
| `citadel.workflows` | `workflow.node.completed` | Per-node workflow usage |
| `citadel.eval.usage` | `eval.usage.captured` | Phase 2: judge-invocation token usage (`arbiter/eval_judge/index.py`, emitted after every Bedrock `converse()` call). ALWAYS tagged `costContext:"eval"` — a judge's own usage is never customer-billable spend, whether it judged an eval-suite case or a production sample. Distinct attribute from Phase 1's `evalContext` (dispatch-time tagging of eval-RUN spend, e.g. a CONVERSATION-kind eval case's own agent invocation) — both are excluded from customer-facing `cost-aggregate.ts` rollups by the same rule, but are separate, independently-set attributes with separate producers. Sparse GSI6 `EvalContextIndex` (`GSI6PK=EVALCTX#<orgId>`, `GSI6SK=<capturedAt>#<ledgerId>`) is written ONLY on these rows, enabling an independent "all judge spend for org X" Query. |

### Dedupe rule (cross-source, enforced in the writer)

`task.completion` and `workflow.node.completed` can describe the **same** model calls for a workflow node (the worker task ran inside a StepRunner node). EventBridge patterns cannot correlate across sources, so the writer enforces this stateless rule itself:

- `workflow.node.completed` is **authoritative for all workflow-node model calls** — always written.
- `task.completion` is authoritative **only** for standalone tasks. If its detail carries workflow correlation (`workflowExecutionId` **and** `nodeId`), the event is **dropped** — those calls are already owned by the corresponding `node.completed` event.
- `intake.usage.captured` never overlaps the other two sources and is always authoritative.

This prevents double-billing without any cross-event lookup.

### Pricing resolution (per row)

For each usage record, the writer resolves the raw `modelId` to a catalog `modelKey` (same slug logic as `model-catalog-sync.ts`'s `modelKeyFromId`) and reads pricing via `GetItem` on the model-catalog table. A catalog-read failure, a missing row, or a row without usable pricing (`inputPer1kTokens`/`outputPer1kTokens`/`currency`) never drops the ledger row — it is written with `priced:false`, null cost fields, and an `unpricedReason` (`model_not_in_catalog` | `pricing_absent`), logged via `console.warn`/`console.error`. See [MODEL_SELECTION.md](./MODEL_SELECTION.md#pricing-metadata) for the pricing field contract.

## Cost Budget Events (producer: `cost-budget-evaluator` / `cost-notifier`, source: `citadel.telemetry`)

`TelemetryStack` is a consume-only bus subscriber everywhere else in this catalog (see Cost Ledger Events above). The budget evaluator is the **one exception**: it is a bus **publisher**, emitting threshold-crossing notifications so downstream SNS/notification subscribers can alert users. `agentEventBus.grantPutEventsTo(evaluator)` is granted specifically for this.

| Source | DetailType | Meaning |
|--------|------------|---------|
| `citadel.telemetry` | `cost.budget.threshold.crossed` | A budget's period-to-date spend crossed a configured soft threshold (e.g. 0.8 of `limitMicros`) |
| `citadel.telemetry` | `cost.budget.breached` | A budget's period-to-date spend crossed the 1.0 (hard) threshold |

### Event schema

```json
{
  "source": "citadel.telemetry",
  "detail-type": "cost.budget.threshold.crossed",
  "detail": {
    "orgId": "string",
    "scope": "org | app:<appId>",
    "periodType": "monthly | daily",
    "periodKey": "YYYY-MM | YYYY-MM-DD",
    "threshold": "number (0-1 fraction of limitMicros)",
    "spentMicros": "number",
    "limitMicros": "number",
    "currency": "string"
  }
}
```

### Producer and dedupe

Emitted by `backend/src/lambda/cost-budget-evaluator.ts` (hourly `CostBudgetEvaluatorScheduleRule`) via `backend/src/lambda/cost-notifier.ts`. Each budget row (enumerated via the sparse `BudgetIndex` GSI, never a Scan) is compared against its thresholds using period-to-date spend from a base-table Query (`PK=ORG#<org> AND SK BETWEEN periodStartIso AND nowIso`, summing only `priced===true` rows). Publication is gated by an atomic conditional `UpdateItem` on the budget row's `notified.<periodKey>` map (`ConditionExpression: attribute_not_exists(...) OR notified.<periodKey> < :threshold`) — this guarantees at most one publish per (period, threshold) even under concurrent or retried evaluator runs, and a higher threshold crossed later in the same period (e.g. 0.8 → 1.0) publishes again as a new escalation.

## Adding a New Event Type

1. Add the event type constant to `EventTypes` in `backend/src/utils/events.ts`
2. Publish the event using `publishEvent()` from the same module
3. If the event needs to trigger a Lambda, add an EventBridge rule in the appropriate CDK stack
4. If the event needs to reach the frontend, add it to the Fan-out Lambda's event pattern and create a corresponding AppSync subscription
5. Always include `correlationId` and `timestamp` in the event detail
6. Use the `IdempotencyGuard` in the consuming Lambda handler
7. For registry-backed app events, the emission point is `backend/src/lambda/agent-app-shim-resolver.ts::emitEvent` — do not re-introduce legacy `app-resolver.ts` call sites.
