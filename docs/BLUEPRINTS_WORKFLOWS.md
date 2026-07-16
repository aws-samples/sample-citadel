# Blueprints & Workflows

The Blueprints & Workflows system provides server-side workflow persistence, a reusable blueprint catalog, and an event-driven execution engine for multi-agent DAG workflows. It uses topological sorting to determine execution order, EventBridge for async node invocation, and DynamoDB for durable execution state. The system supports sequential and parallel execution, conditional branching, per-node retry policies with exponential backoff, and real-time execution progress via GraphQL subscriptions. A separate Step Runner Lambda handles workflow execution independently from the existing Supervisor, preserving backward compatibility while adding DAG-based orchestration. For a task-oriented walkthrough aimed at users and operators, see [WORKFLOW_USER_GUIDE.md](./WORKFLOW_USER_GUIDE.md).

## Table of Contents

- [Blueprints \& Workflows](#blueprints--workflows)
  - [Table of Contents](#table-of-contents)
  - [Architecture Overview](#architecture-overview)
  - [Core Concepts](#core-concepts)
    - [Workflow](#workflow)
    - [Blueprint](#blueprint)
    - [Execution](#execution)
    - [Node and Edge](#node-and-edge)
    - [Conditional Edge](#conditional-edge)
    - [Retry Policy](#retry-policy)
    - [Workflow Configuration](#workflow-configuration)
  - [Component Map](#component-map)
    - [Backend](#backend)
    - [Frontend](#frontend)
  - [How It Works](#how-it-works)
    - [Workflow CRUD Lifecycle](#workflow-crud-lifecycle)
    - [Canvas Toolbar and Catalog Round-Trip](#canvas-toolbar-and-catalog-round-trip)
    - [Node Configuration and Execution Overrides](#node-configuration-and-execution-overrides)
    - [Blueprint Import Flow](#blueprint-import-flow)
    - [Execution Flow](#execution-flow)
    - [Real-Time Subscriptions](#real-time-subscriptions)
  - [Data Flows](#data-flows)
    - [Execution State Machine Flow](#execution-state-machine-flow)
    - [Node Invocation Flow](#node-invocation-flow)
    - [Conditional Branching Flow](#conditional-branching-flow)
  - [Naming Conventions](#naming-conventions)
  - [How Access and Permissions Work](#how-access-and-permissions-work)
  - [Retry and Resilience](#retry-and-resilience)
    - [Optimistic Locking](#optimistic-locking)
    - [Per-Node Retry Policies](#per-node-retry-policies)
    - [Execution Idempotency](#execution-idempotency)
    - [Parallel Branch Resilience](#parallel-branch-resilience)
    - [Workflow-Level Timeout](#workflow-level-timeout)
    - [Subscription Fan-out Resilience](#subscription-fan-out-resilience)
  - [Error Handling](#error-handling)
    - [Workflow Resolver](#workflow-resolver)
    - [App Resolver](#app-resolver)
    - [Execution Resolver](#execution-resolver)
    - [Step Runner](#step-runner)
    - [Frontend Error Handling](#frontend-error-handling)
    - [Structured Logging](#structured-logging)
  - [Testing Strategy](#testing-strategy)
    - [Property-Based Tests](#property-based-tests)
    - [Additional Test Coverage](#additional-test-coverage)
    - [Running Tests](#running-tests)
    - [Test Organization](#test-organization)
  - [Architectural Decisions](#architectural-decisions)
  - [Best Practice Alignment](#best-practice-alignment)
    - [AWS Well-Architected Framework](#aws-well-architected-framework)
    - [SOLID Principles](#solid-principles)
  - [Adding a New Workflow Node Type](#adding-a-new-workflow-node-type)
    - [1. Define the Node Type](#1-define-the-node-type)
    - [2. Add a Custom ReactFlow Node Component](#2-add-a-custom-reactflow-node-component)
    - [3. Extend the Step Runner Executor](#3-extend-the-step-runner-executor)
    - [4. Add Property-Based Tests](#4-add-property-based-tests)
    - [5. Update Publish Validation](#5-update-publish-validation)
    - [6. Update the GraphQL Schema](#6-update-the-graphql-schema)
    - [7. Add Seed Blueprints](#7-add-seed-blueprints)

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Frontend (React)                            │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────────────┐  │
│  │ Blueprint    │  │ Workflow     │  │ Execution Controls &      │  │
│  │ Catalog      │  │ Canvas       │  │ History Panel             │  │
│  └──────┬───────┘  └──────┬───────┘  └────────────┬──────────────┘  │
│         │                 │                       │                 │
│         └─────────────────┼───────────────────────┘                 │
│                           │ GraphQL + Subscriptions                 │
└───────────────────────────┼─────────────────────────────────────────┘
                            │
┌───────────────────────────┼─────────────────────────────────────────┐
│                    AWS AppSync API                                  │
│         ┌─────────────────┼───────────────────────┐                 │
│         │                 │                       │                 │
│  ┌──────▼───────┐  ┌──────▼───────┐  ┌────────────▼─────────────┐   │
│  │ Workflow     │  │ App          │  │ Execution                │   │
│  │ Resolver λ   │  │ Resolver λ   │  │ Resolver λ               │   │
│  └──────┬───────┘  └──────┬───────┘  └────────────┬─────────────┘   │
└─────────┼─────────────────┼───────────────────────┼─────────────────┘
          │                 │                       │
┌─────────┼─────────────────┼───────────────────────┼─────────────────┐
│         │           DynamoDB Tables               │                 │
│  ┌──────▼───────┐  ┌──────▼───────┐  ┌────────────▼─────────────┐   │
│  │ citadel-     │  │ citadel-     │  │ citadel-                 │   │
│  │ workflows    │  │ apps         │  │ executions               │   │
│  └──────────────┘  └──────────────┘  └──────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
          │                                         │
┌─────────▼─────────────────────────────────────────▼─────────────────┐
│                    EventBridge (citadel-agents-{env})               │
│                                                                     │
│  workflow.created │ workflow.published │ workflow.node.invoke       │
│  workflow.started │ workflow.node.completed │ workflow.failed       │
│                                                                     │
│  ┌──────────────────────┐    ┌──────────────────────────────────┐   │
│  │ Step Runner Rule     │    │ Subscription Fan-out Rule        │   │
│  └──────────┬───────────┘    └──────────────┬───────────────────┘   │
│             │                               │                       │
│  ┌──────────▼───────────┐    ┌──────────────▼───────────────────┐   │
│  │ Step Runner λ        │    │ Subscription Fan-out λ           │   │
│  │ (Python 3.14)        │    │ (Node.js 24.x)                   │   │
│  └──────────────────────┘    └──────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

## Core Concepts

### Workflow

A DynamoDB item keyed by `workflowId` representing a directed acyclic graph (DAG) of agent nodes and edges. Each workflow has an `orgId` for access scoping, a `status` (`DRAFT` or `PUBLISHED`), a serialized `definition` containing nodes and edges, an optional `configuration` for integration endpoints and agent properties, and a monotonically increasing `version` for optimistic locking. Workflows can be bound to Agent Apps via the `appId` field.

### Blueprint

A Workflow item with `isBlueprint: true` — a reusable, org-agnostic template that can be imported into an App as a customizable Workflow. Blueprints are read-only once published. The system ships with five seed blueprints loaded via a CDK Custom Resource during deployment: four placeholder-agent templates ("Sequential Agent Pipeline", "Parallel Fan-Out", "Conditional Router", "Data Processing Pipeline") whose `placeholder-` agent IDs must be remapped to real agents before publishing, and one runnable demo ("Echo Demo Workflow", category `demo`) — two nodes referencing the real seeded `demo-echo-agent`, which echoes its input, so it passes publish validation and executes end to end.

### Execution

A DynamoDB item keyed by `executionId` representing a single run of a Workflow. Tracks overall status (`pending`, `running`, `completed`, `failed`, `cancelled`), per-node results in a `nodeResults` map, the `workflowVersion` snapshot at start time, and input/output payloads. Executions are immutable with respect to the workflow definition — in-flight executions are not affected by concurrent edits.

### Node and Edge

Nodes represent agent invocations within the DAG. Each node has a `nodeId`, `agentId`, optional `retryPolicy`, and optional `constraints` for governance. Edges define directed connections between nodes, determining data flow and execution order. The Step Runner uses Kahn's algorithm for topological sorting to determine execution order.

### Conditional Edge

A WorkflowEdge with an optional `condition` field containing an expression evaluated against the source node's output. Conditions support operators: `equals`, `notEquals`, `contains`, `greaterThan`, `lessThan`, `exists`. When a condition evaluates to `false`, the target node and its downstream subgraph are marked as `skipped`.

### Retry Policy

A per-node configuration specifying `maxRetries`, `backoffBase` (seconds), `backoffMax` (seconds), and `retryableErrors` (array of error type strings). The Step Runner retries failed nodes using exponential backoff with full jitter: `delay = uniform(0, min(backoffBase × 2^attempt, backoffMax))`. When retries are exhausted, the node is marked as `failed`.

### Workflow Configuration

Per-workflow settings stored in the `configuration` field, containing:

| Key | Description |
|-----|-------------|
| `integrations` | Map of integration endpoint configs keyed by `integrationId` |
| `credentials` | Map of credential references keyed by resource identifier |
| `agentProperties` | Map of agent-specific config keyed by `agentId` |
| `parameters` | Map of custom key-value parameters |

The Step Runner passes the Workflow Configuration to each agent node as execution context, allowing agents to use workflow-specific integration endpoints and credentials.

Per-node execution overrides are consumed by the Worker Wrapper via exactly two configuration keys: `systemPromptAddition` (appended to the agent's system prompt) and `modelOverride` (Bedrock model ID for the node). At dispatch time, node configuration merges over workflow configuration per key — a key set on the node wins over the same key set at workflow level. Both override keys are size-capped (decision 67caf7b0): `systemPromptAddition` at 4000 characters by default — configurable through the Worker Wrapper's `WORKER_MAX_PROMPT_ADDITION_CHARS` environment variable (falls back to 4000 when missing or invalid) — and `modelOverride` at a fixed 256-character hygiene cap. An over-cap value is skipped entirely with a WARN log carrying the offending length and the effective cap; it is never truncated, and the node still executes without the override. Users set these overrides through the node configuration drawer — see [Node Configuration and Execution Overrides](#node-configuration-and-execution-overrides).

## Component Map

### Backend

| Component | File | Purpose |
|-----------|------|---------|
| Workflow Resolver | `backend/src/lambda/workflow-resolver.ts` | CRUD for workflows and blueprints, publish validation, import/export, version history |
| App Resolver | `backend/src/lambda/app-resolver.ts` | App CRUD, workflow bind/unbind, org-scoped access |
| Execution Resolver | `backend/src/lambda/execution-resolver.ts` | Start/cancel execution, execution queries |
| Subscription Fan-out | `backend/src/lambda/workflow-progress-fanout.ts` | EventBridge → AppSync mutation bridge for real-time subscriptions |
| Seed Blueprints | `backend/src/lambda/seed-blueprints/` | CDK Custom Resource that loads seed blueprint definitions on deployment |
| Workflows Table | `citadel-workflows-{env}` | PK=`workflowId`, GSIs: `OrgStatusIndex` (orgId/status), `BlueprintIndex` (isBlueprint/updatedAt) |
| Apps Table | `citadel-apps-{env}` | PK=`appId`, GSI: `OrgIndex` (orgId/createdAt) |
| Executions Table | `citadel-executions-{env}` | PK=`executionId`, GSI: `WorkflowIndex` (workflowId/startedAt) |
| GraphQL Schema | `backend/src/schema/schema.graphql` | Workflow, AgentApp, Execution types, WorkflowStatus/AppStatus enums, subscriptions |
| CDK — BackendStack | `backend/lib/backend-stack.ts` | DynamoDB tables, Workflow/App/Execution Resolver Lambdas, AppSync data sources |
| CDK — ArbiterStack | `backend/lib/arbiter-stack.ts` | Step Runner Lambda, EventBridge rules |

| Component | File | Purpose |
|-----------|------|---------|
| Step Runner | `arbiter/stepRunner/index.py` | Lambda handler — event routing for execution lifecycle |
| DAG Module | `arbiter/stepRunner/dag.py` | Pure functions: `topological_sort`, `find_root_nodes`, `find_ready_nodes`, `find_convergence_nodes`, `find_downstream_subgraph` |
| Condition Module | `arbiter/stepRunner/condition.py` | Pure functions: `evaluate_condition`, `resolve_field_path` |
| Retry Module | `arbiter/stepRunner/retry.py` | Pure functions: `calculate_backoff`, `should_retry` |
| Executor | `arbiter/stepRunner/executor.py` | Orchestration: `start_execution`, `invoke_node`, `handle_node_completion`, `handle_node_failure`, `cancel_execution` |
| Events Module | `arbiter/stepRunner/events.py` | EventBridge event publishing helpers |

### Frontend

| Component | File | Purpose |
|-----------|------|---------|
| Blueprint Catalog | `frontend/src/components/BlueprintCatalog.tsx` | Blueprint grid with search, category filter tabs, "Use in App" action |
| Workflow Toolbar | `frontend/src/components/WorkflowToolbar.tsx` | Canvas toolbar: save to catalog, load from catalog, import/export JSON, validate, clear |
| Node Configuration Panel | `frontend/src/components/NodeConfigurationPanel.tsx` | Node drawer: rename, model override, system prompt addition, schema parameters |
| Blueprint Card | `frontend/src/components/BlueprintCard.tsx` | Individual blueprint card with name, description, agent count, category tags |
| Blueprint Preview Dialog | `frontend/src/components/BlueprintPreviewDialog.tsx` | Read-only ReactFlow canvas showing blueprint node/edge layout |
| Import Blueprint Dialog | `frontend/src/components/ImportBlueprintDialog.tsx` | App selection dialog for importing a blueprint |
| Execution Overlay | `frontend/src/components/ExecutionOverlay.tsx` | Per-node status overlay on canvas (pending/running/completed/failed/skipped) |
| Execution History Panel | `frontend/src/components/ExecutionHistoryPanel.tsx` | Side panel with past executions, per-node results, error details |
| Workflow Config Panel | `frontend/src/components/WorkflowConfigPanel.tsx` | Workflow-level configuration editor (integrations, credentials, agent properties, parameters) |
| Condition Editor Panel | `frontend/src/components/ConditionEditorPanel.tsx` | Edge condition editor (field, operator, value) |
| Workflow Persistence Hook | `frontend/src/hooks/useWorkflowPersistence.ts` | Auto-save with debounce (3s), conflict resolution, offline fallback to localStorage |
| Execution Subscription Hook | `frontend/src/hooks/useExecutionSubscription.ts` | `onWorkflowProgress` subscription hook for real-time node status updates |
| Workflow API Service | `frontend/src/services/workflowApiService.ts` | GraphQL client for workflow CRUD |
| App API Service | `frontend/src/services/appApiService.ts` | GraphQL client for app CRUD |
| Execution API Service | `frontend/src/services/executionApiService.ts` | GraphQL client for execution operations |

## How It Works

### Workflow CRUD Lifecycle

1. User creates a workflow via `createWorkflow` mutation — the Workflow Resolver generates a UUID, sets `status=DRAFT`, `version=1`, `isBlueprint=false` (unless explicitly set), and persists to DynamoDB
2. The WorkflowCanvas auto-saves edits via `updateWorkflow` with optimistic locking (`version` condition), debounced to one save per 3 seconds
3. On version conflict, the persistence hook reloads the latest version and presents a conflict resolution dialog
4. User publishes via `publishWorkflow` — the resolver validates the definition (no disconnected nodes, no cycles, all nodes have valid `agentId` references) and updates `status=PUBLISHED`
5. Published workflows can be executed; draft workflows cannot be deleted while published
6. Each update stores the previous definition in `versionHistory` for audit and rollback
7. All CRUD operations emit EventBridge events (`workflow.created`, `workflow.updated`, `workflow.deleted`, `workflow.published`) with source `citadel.workflows`

### Canvas Toolbar and Catalog Round-Trip

The canvas (Agentic Studio → Create Agent Blueprints) carries a toolbar implemented in `frontend/src/components/WorkflowToolbar.tsx`:

| Action | Behavior |
|--------|----------|
| Save | Saves the canvas to the blueprint catalog — a dialog collects a name and optional category, then creates the blueprint and publishes it so it is immediately usable (loadable and importable) |
| Load | Picks a published blueprint from the catalog, with search; loading replaces the current canvas after a confirmation |
| Import | Loads a workflow from a local JSON file |
| Export | Downloads the current workflow as formatted JSON |
| Validate | Checks the workflow for errors and warnings |
| Clear | Removes all nodes and edges from the canvas |

Autosave persists the canvas to the server continuously (see [Workflow CRUD Lifecycle](#workflow-crud-lifecycle)); Save is specifically the save-to-catalog action. The run-controls bar carries Publish, which moves the workflow `DRAFT` → `PUBLISHED` and unlocks Run, and History, which shows past executions.

### Node Configuration and Execution Overrides

Double-clicking a node (or using its configure action) opens the node configuration drawer (`frontend/src/components/NodeConfigurationPanel.tsx`):

1. Rename the node
2. Set execution overrides — a Model override (catalog-driven select) and a System prompt addition (up to 4000 characters, with a live character counter)
3. Fill in agent-declared schema parameters, rendered from the agent config's parameter schema when present

At runtime, node configuration merges over workflow configuration per key, and the Worker Wrapper honours only `modelOverride` and `systemPromptAddition`, subject to the size caps described in [Workflow Configuration](#workflow-configuration) — oversized values are skipped with a warning, never truncated, and the node still runs.

### Blueprint Import Flow

1. User browses the Blueprint Catalog, which queries the `BlueprintIndex` GSI for `isBlueprint="true"` items sorted by `updatedAt`
2. User clicks "Use in App" on a blueprint card, opening a dialog to select or create an Agent App. Agent slots whose `agentId` carries the `placeholder-` prefix must be remapped to real agents in this dialog — publish validation rejects `placeholder-` references
3. The `importBlueprint` mutation deep-copies the blueprint's `definition` into a new Workflow named `<blueprint> (Copy)` with `status=DRAFT`, `isBlueprint=false`, a new `workflowId`, and the target `appId`
4. The new workflow's `workflowId` is appended to the target app's `workflowIds` array
5. The imported workflow is fully editable — the blueprint remains unchanged
6. Only published blueprints can be imported; draft blueprints are rejected

### Execution Flow

1. User clicks "Run Workflow" on the canvas toolbar (enabled only for `PUBLISHED` workflows)
2. The `startExecution` mutation creates an Execution item with `status=pending`, initializes all `nodeResults` as `pending`, snapshots the `workflowVersion`, and publishes an `execution.start.requested` EventBridge event
3. The Step Runner picks up the event, performs topological sort on the DAG, and identifies root nodes (in-degree 0)
4. Root nodes are invoked by publishing `workflow.node.invoke` events — the Worker Wrapper picks these up and runs the agent
5. On node completion, the Worker Wrapper publishes `workflow.node.completed` — the Step Runner picks this up, evaluates conditional edges on outgoing connections, and identifies the next ready nodes
6. For convergence nodes (in-degree > 1), the Step Runner waits for all predecessors to reach `completed` or `skipped` status before invoking
7. Independent branches execute concurrently — multiple `workflow.node.invoke` events are published simultaneously
8. When all nodes complete, the Step Runner marks the execution as `completed` and publishes `workflow.completed`
9. If a node fails and retries are exhausted, the execution is marked as `failed` with the error recorded in the `nodeResults` map

### Real-Time Subscriptions

1. The Subscription Fan-out Lambda subscribes to all `workflow.*` EventBridge events
2. On each event, it calls the `publishWorkflowProgress` AppSync mutation (IAM auth) to trigger the `onWorkflowProgress` subscription
3. Frontend clients subscribe via `onWorkflowProgress(executionId)` to receive filtered events for the execution they are monitoring
4. The Execution Overlay updates node status badges in real-time: gray (pending) → blue spinner (running) → green checkmark (completed) or red X (failed)
5. The overlay fades out 10 seconds after execution completes

## Data Flows

### Execution State Machine Flow

```
startExecution mutation
  → Execution Resolver creates Execution item (status=pending)
  → Publishes execution.start.requested to EventBridge
  → Step Runner picks up event
      → Topological sort on DAG
      → Find root nodes (in-degree 0)
      → Invoke root nodes via workflow.node.invoke events
  → Worker Wrapper runs agent, publishes workflow.node.completed
  → Step Runner picks up completion
      → Evaluate conditional edges
      → Find ready downstream nodes
      → Check convergence barriers
      → Invoke ready nodes
  → Cycle repeats until all nodes complete or failure halts execution
  → Step Runner publishes workflow.completed or workflow.failed
```

### Node Invocation Flow

```
Step Runner → workflow.node.invoke (EventBridge)
  → Worker Wrapper picks up event
      → Load agent config from citadel-agents-{env}
      → Resolve tool bindings and scoped credentials
      → Apply workflow configuration as execution context
      → Run agent subprocess
  → On success: publish workflow.node.completed with output
  → On failure: publish workflow.node.failed with error
  → Step Runner picks up result, advances execution
```

### Conditional Branching Flow

```
Node A completes with output: { "result": { "status": "approved" } }
  → Step Runner evaluates outgoing edges from Node A:
      Edge A→B: condition { field: "result.status", operator: "equals", value: "approved" }
        → resolve_field_path(output, "result.status") → "approved"
        → "approved" equals "approved" → true → invoke Node B
      Edge A→C: condition { field: "result.status", operator: "equals", value: "rejected" }
        → "approved" equals "rejected" → false → skip Node C and downstream subgraph
```

## Naming Conventions

| Entity | Pattern | Example |
|--------|---------|---------|
| Workflows DynamoDB table | `citadel-workflows-{env}` | `citadel-workflows-dev` |
| Apps DynamoDB table | `citadel-apps-{env}` | `citadel-apps-dev` |
| Executions DynamoDB table | `citadel-executions-{env}` | `citadel-executions-dev` |
| Workflow Resolver Lambda | `citadel-workflow-resolver-{env}` | `citadel-workflow-resolver-dev` |
| App Resolver Lambda | `citadel-app-resolver-{env}` | `citadel-app-resolver-dev` |
| Execution Resolver Lambda | `citadel-execution-resolver-{env}` | `citadel-execution-resolver-dev` |
| Step Runner Lambda | `citadel-step-runner-{env}` | `citadel-step-runner-dev` |
| EventBridge bus | `citadel-agents-{env}` | `citadel-agents-dev` |
| EventBridge source (workflows) | `citadel.workflows` | `citadel.workflows` |
| EventBridge source (apps) | `citadel.apps` | `citadel.apps` |
| GraphQL enums | PascalCase | `WorkflowStatus`, `AppStatus` |
| GraphQL enum values | UPPER_SNAKE_CASE | `DRAFT`, `PUBLISHED`, `ACTIVE`, `ARCHIVED` |
| Execution statuses | lowercase | `pending`, `running`, `completed`, `failed`, `cancelled` |
| Node result statuses | lowercase | `pending`, `running`, `completed`, `failed`, `skipped` |

## How Access and Permissions Work

Every resolver operation follows the same org-scoped access control pattern:

1. Extract `userId` from AppSync identity (Cognito `sub`)
2. Call `AdminGetUser` to get the `custom:organization` attribute
3. Compare against the resource's `orgId`
4. Throw "Access denied" if mismatch

Exception: `listBlueprints` is org-agnostic — blueprints are shared templates accessible to all organizations.

Optimistic locking prevents concurrent modification conflicts. All state-mutating operations (`updateWorkflow`, `updateApp`) use a DynamoDB conditional expression requiring `version = :currentVersion` and increment `version` on success. On conflict, the resolver throws `"Conflict: workflow was modified concurrently. Please retry."`.

Lambda functions receive least-privilege IAM policies:

| Lambda | Permissions |
|--------|-------------|
| Workflow Resolver | Read/write workflows table, read apps table, read agent config table, PutEvents on event bus, AdminGetUser on user pool |
| App Resolver | Read/write apps table, read/write workflows table (bind/unbind), PutEvents on event bus, AdminGetUser on user pool |
| Execution Resolver | Read/write executions table, read workflows table, PutEvents on event bus, AdminGetUser on user pool |
| Step Runner | Read/write executions table, read workflows table, read agent config table, read tools config table, PutEvents on event bus |
| Fan-out Lambda | AppSync invoke (IAM auth) for `publishWorkflowProgress` mutation |

The `onWorkflowProgress` subscription uses both `@aws_iam` (for the Step Runner fan-out) and `@aws_cognito_user_pools` (for frontend clients). The `publishWorkflowProgress` mutation is `@aws_iam` only — only backend Lambdas can trigger subscription events.

## Retry and Resilience

### Optimistic Locking

All state-mutating operations use version-based optimistic locking. DynamoDB conditional writes check `version = :expectedVersion` and increment on success. The frontend persistence hook retries on conflict by reloading the latest version and presenting a conflict resolution dialog.

### Per-Node Retry Policies

Each workflow node can declare a `retryPolicy` with `maxRetries`, `backoffBase`, `backoffMax`, and `retryableErrors`. The Step Runner uses exponential backoff with full jitter:

```
delay = uniform(0, min(backoffBase × 2^attempt, backoffMax))
```

The backoff result is always bounded: `0 ≤ delay ≤ backoffMax`. When retries are exhausted, the node is marked as `failed` with the final error and `retryCount` recorded in the `nodeResults` map. A `workflow.node.retrying` event is published on each retry attempt.

### Execution Idempotency

The Step Runner is idempotent — re-invoking for the same `executionId` checks DynamoDB state first and resumes from the last incomplete node rather than restarting. Duplicate EventBridge deliveries produce the same execution state without duplicate node invocations.

### Parallel Branch Resilience

Independent branches execute concurrently. If one branch fails, other independent branches continue executing. A convergence node is marked as `failed` only if a required upstream node failed. `Promise.allSettled`-style semantics ensure partial failures don't cascade across independent paths.

### Workflow-Level Timeout

The Workflow item supports an optional `timeout` field (seconds). When total execution time exceeds the timeout, the Step Runner cancels all running nodes, marks the execution as `failed` with a timeout error, and publishes a `workflow.failed` event. Per-node execution timeout defaults to 60 seconds.

### Subscription Fan-out Resilience

The Fan-out Lambda is triggered by EventBridge rules matching `workflow.*` events. If the AppSync mutation call fails, the event is retried by EventBridge's built-in retry policy. The frontend auto-reconnects via Amplify on subscription disconnect, showing stale status badges until reconnected.

## Error Handling

### Workflow Resolver

| Scenario | Behavior |
|----------|----------|
| Workflow not found | `Error('Workflow not found')` |
| Access denied (org mismatch) | `Error('Access denied')` |
| Optimistic lock conflict | `Error('Conflict: workflow was modified concurrently. Please retry.')` |
| Delete published workflow | `Error('Cannot delete a published workflow. Unpublish it first.')` |
| Publish validation fails | Returns validation errors (disconnected nodes, cycles, missing agent refs) without changing status |
| Invalid definition JSON | `ValidationError` with structure errors |
| Blueprint not published | `Error('Only published blueprints can be imported')` |
| Import target app not found | `Error('App not found')` |
| Import target app org mismatch | `Error('Access denied')` |

### App Resolver

| Scenario | Behavior |
|----------|----------|
| App not found | `Error('App not found')` |
| Access denied (org mismatch) | `Error('Access denied')` |
| Optimistic lock conflict | `Error('Conflict: app was modified concurrently. Please retry.')` |
| Workflow already bound to another app | `Error('Workflow is already bound to another app')` |
| Bind already-bound workflow (same app) | Returns app unchanged (idempotent) |
| Org mismatch on bind | `Error('Access denied')` — both app and workflow must share `orgId` |

### Execution Resolver

| Scenario | Behavior |
|----------|----------|
| Workflow not published | `Error('Only published workflows can be executed')` |
| Execution not found | `Error('Execution not found')` |
| Cancel non-running execution | Returns execution unchanged |

### Step Runner

| Scenario | Behavior |
|----------|----------|
| Agent not found in config table | Node marked as `failed` with "agent not found" error |
| Node execution timeout (>60s) | Node marked as `failed` with timeout error |
| Workflow-level timeout exceeded | All running nodes cancelled, execution marked as `failed` |
| Retryable error within policy | Node retried with exponential backoff, `workflow.node.retrying` event published |
| Retries exhausted | Node marked as `failed`, execution marked as `failed` |
| Convergence node — upstream failed | Convergence node marked as `failed` |
| All conditional edges evaluate false | Downstream subgraph marked as `skipped` |
| Lambda timeout mid-execution | Execution remains in `running` with accurate `nodeResults`; manual retry resumes from last incomplete node |
| Duplicate event delivery | Idempotent — checks DynamoDB state before acting |

### Frontend Error Handling

| Component | Error Behavior |
|-----------|---------------|
| Blueprint Catalog | API error → error message with retry button; empty results → empty state message |
| Execution Overlay | Failed node → error tooltip; subscription disconnect → auto-reconnect |
| Execution History Panel | API error → error message with retry; failed node click → expandable error details |
| Workflow Config Panel | Save failure → error toast, form state preserved |
| Workflow Persistence | Network error → fallback to localStorage, retry on reconnect; version conflict → reload + dialog |

### Structured Logging

All backend components emit structured JSON log entries:

```json
{
  "level": "INFO",
  "component": "StepRunner",
  "executionId": "exec-abc123",
  "workflowId": "wf-xyz789",
  "nodeId": "node-001",
  "agentId": "agent-007",
  "action": "invoke_node",
  "timestamp": "2025-01-25T12:15:00Z"
}
```

Retry events include additional fields:

```json
{
  "level": "WARN",
  "component": "StepRunner",
  "executionId": "exec-abc123",
  "nodeId": "node-001",
  "action": "retry_node",
  "retryCount": 2,
  "error": "Bedrock throttling",
  "nextRetryDelay": 4.7,
  "timestamp": "2025-01-25T12:15:30Z"
}
```

## Testing Strategy

All implementation follows strict Test-Driven Development (TDD). Property-based tests use fast-check (TypeScript) and Hypothesis (Python), each with a minimum of 100 iterations per property. Tests are written and verified to fail (red phase) before implementation code is created (green phase).

### Property-Based Tests

| # | Property | Test File | What It Validates |
|---|----------|-----------|-------------------|
| P1 | Workflow Definition Round-Trip | `backend/src/lambda/__tests__/workflow-definition.test.ts` | `JSON.parse(JSON.stringify(JSON.parse(d))) ≡ JSON.parse(d)` for all valid definitions |
| P2 | Topological Sort Ordering Invariant | `arbiter/stepRunner/__tests__/test_dag_properties.py` | For every edge (u, v): `indexOf(u, order) < indexOf(v, order)` |
| P3 | Condition Evaluation Determinism | `arbiter/stepRunner/__tests__/test_condition_properties.py` | Same inputs always produce same boolean result; operator semantics correct |
| P4 | Backoff Bounds | `arbiter/stepRunner/__tests__/test_retry_properties.py` | `0 ≤ calculate_backoff(attempt, base, max_delay) ≤ max_delay` |
| P5 | Optimistic Lock Conflict Detection | `backend/src/lambda/__tests__/workflow-resolver.test.ts` | Update with stale version always fails with ConditionalCheckFailedException |
| P6 | Convergence Node Barrier | `arbiter/stepRunner/__tests__/test_dag_properties.py` | Node ready iff all predecessors are `completed` or `skipped` |
| P7 | Import/Export Round-Trip | `backend/src/lambda/__tests__/workflow-definition.test.ts` | `export(import(export(w)))` ≡ `export(w)` excluding server-generated fields |
| P8 | Idempotent Execution Start | `arbiter/stepRunner/__tests__/test_executor_properties.py` | Calling `start_execution` twice produces same state, no duplicate invocations |

### Additional Test Coverage

| Test File | Covers | Type |
|-----------|--------|------|
| `workflow-resolver.test.ts` | All CRUD operations, org access, optimistic locking, publish validation | Unit + PBT |
| `app-resolver.test.ts` | App CRUD, bind/unbind, org access | Unit + PBT |
| `execution-resolver.test.ts` | Start/cancel execution, state initialization | Unit |
| `workflow-validation.test.ts` | Publish validation (disconnected nodes, cycles, agent refs) | PBT |
| `test_dag_properties.py` | Topological sort, root nodes, ready nodes, convergence, downstream subgraph | PBT |
| `test_condition_properties.py` | Condition evaluation, field path resolution, operator semantics | PBT |
| `test_retry_properties.py` | Backoff calculation, retry decision logic | PBT |
| `test_executor_properties.py` | Execution flow, idempotency, parallel branches | Unit + PBT |
| `test_events_properties.py` | EventBridge event construction and field completeness | PBT |
| `BlueprintCatalog.test.tsx` | Search, filter, empty state, error state, loading | Unit |
| `ExecutionOverlay.test.tsx` | Status rendering, transitions, fade-out | Unit |
| `ExecutionHistoryPanel.test.tsx` | List rendering, expand/collapse, pagination | Unit |
| `useWorkflowPersistence.test.ts` | Debounce, conflict resolution, offline fallback | Unit |
| `useExecutionSubscription.test.ts` | Event accumulation, status tracking | Unit |

### Running Tests

```bash
# Backend unit + property tests
cd backend && npm test

# Backend property tests only
cd backend && npx jest --testPathPattern="workflow-definition|workflow-resolver|workflow-validation" --no-coverage

# Step Runner property tests (Python)
cd arbiter/stepRunner && python -m pytest __tests__/ -v

# Step Runner with reproducible seeds
cd arbiter/stepRunner && python -m pytest __tests__/ -v --hypothesis-seed=0

# Frontend tests
cd frontend && npm test

# All arbiter tests
pytest
```

### Test Organization

```
backend/src/lambda/__tests__/
├── workflow-resolver.test.ts          # CRUD, org access, optimistic locking
├── workflow-definition.test.ts        # Properties P1, P7 — round-trip
├── workflow-validation.test.ts        # Publish validation PBT
├── app-resolver.test.ts              # App CRUD, bind/unbind
└── execution-resolver.test.ts        # Start/cancel execution

arbiter/stepRunner/__tests__/
├── test_dag_properties.py            # Properties P2, P6 — topological sort, convergence
├── test_condition_properties.py      # Property P3 — condition evaluation
├── test_retry_properties.py          # Property P4 — backoff bounds
├── test_executor_properties.py       # Property P8 — idempotent execution
└── test_events_properties.py         # Event construction

frontend/src/
├── components/__tests__/
│   ├── BlueprintCatalog.test.tsx
│   ├── ExecutionOverlay.test.tsx
│   └── ExecutionHistoryPanel.test.tsx
└── hooks/__tests__/
    ├── useWorkflowPersistence.test.ts
    └── useExecutionSubscription.test.ts
```

## Architectural Decisions

| Decision | Rationale |
|----------|-----------|
| Separate Step Runner Lambda vs extending the Supervisor | The Supervisor is a single-turn orchestrator using Bedrock Converse + SQS agent dispatch. The Step Runner is a multi-step DAG executor with different lifecycle, timeout (5 min vs 30s), and state management needs. Keeping them separate preserves backward compatibility and follows Single Responsibility. |
| EventBridge for node invocation | Event-driven architecture means no single Lambda invocation runs for the entire workflow duration. Each step is independently retryable, the execution state in DynamoDB is the source of truth, and the system naturally handles Lambda timeouts without losing progress. |
| DynamoDB for execution state | Execution state needs durable, low-latency reads and writes with per-item conditional updates. DynamoDB's `nodeResults` map allows atomic per-node status updates without read-modify-write cycles. PAY_PER_REQUEST billing matches variable execution workloads. |
| `isBlueprint` stored as String in GSI | DynamoDB GSI partition keys must be String, Number, or Binary — not Boolean. Storing as `"true"`/`"false"` enables the `BlueprintIndex` GSI for efficient blueprint listing. |
| Topological sort via Kahn's algorithm | Deterministic, O(V+E) complexity, naturally detects cycles (raises `ValueError`), and produces a stable ordering for reproducible execution. Pure function with no side effects, enabling thorough property-based testing. |
| Subscription fan-out via separate Lambda | Decouples the Step Runner (Python) from AppSync mutation calls (Node.js). The fan-out Lambda is lightweight (30s timeout) and only bridges EventBridge events to AppSync subscriptions. |
| Workflow version snapshot on execution | In-flight executions must not be affected by concurrent edits. Snapshotting `workflowVersion` at start time ensures the Step Runner executes the definition that was current when the execution began. |
| Seed blueprints via CDK Custom Resource | Follows the existing `seed-organizations` pattern. Blueprints are loaded on deployment, ensuring every environment has the same starting templates without manual setup. |
| Condition evaluation as pure functions | `evaluate_condition` and `resolve_field_path` have no side effects, making them trivially testable with Hypothesis property-based tests. Operators are deterministic and composable. |
| Exponential backoff with full jitter | Full jitter (`uniform(0, calculated_delay)`) provides better spread than equal jitter, reducing thundering herd effects when multiple nodes retry simultaneously. Consistent with the existing `CircuitBreaker` pattern in `arbiter/supervisor/circuit_breaker.py`. |
| Auto-save with server-side persistence + localStorage fallback | Server-side persistence via `updateWorkflow` makes workflows durable and accessible from any device. localStorage fallback handles offline editing gracefully, retrying the server save when connectivity is restored. |

## Best Practice Alignment

### AWS Well-Architected Framework

| Pillar | Implementation |
|--------|---------------|
| Security | Org-scoped access control on all resolver operations, least-privilege IAM policies per Lambda, `@aws_iam` auth on subscription trigger mutations, input validation at resolver layer (defense in depth beyond GraphQL schema) |
| Reliability | Idempotent execution (re-processing same event checks DynamoDB state), optimistic locking for concurrent modifications, partial failure handling in parallel branches, per-node retry with exponential backoff and jitter, workflow-level timeout |
| Operational Excellence | Structured JSON logging with `executionId`/`workflowId`/`nodeId`/`agentId` fields, X-Ray tracing on all Lambdas, correlation IDs (`executionId`) across EventBridge events and DynamoDB writes, CloudWatch Logs Insights queries for execution debugging |
| Performance Efficiency | PAY_PER_REQUEST DynamoDB billing, event-driven execution (no long-running Lambdas), parallel branch execution for independent paths, `BatchGetItem` for agent config lookups |
| Cost Optimization | On-demand DynamoDB, right-sized Lambda memory (1024MB for Step Runner, default for resolvers), no always-on infrastructure, event-driven architecture avoids idle compute |

### SOLID Principles

| Principle | Implementation |
|-----------|---------------|
| Single Responsibility | Workflow Resolver handles CRUD, App Resolver handles app management, Execution Resolver handles execution lifecycle, Step Runner handles DAG execution — no module takes on responsibilities belonging to another |
| Open/Closed | New node types can be added without modifying the Step Runner's core DAG traversal logic; new condition operators can be added to the condition module without changing the evaluation framework |
| Interface Segregation | Step Runner's pure function modules (`dag.py`, `condition.py`, `retry.py`) have minimal interfaces — each function takes only the data it needs |
| Dependency Inversion | The executor depends on abstract event publishing and DynamoDB interfaces, not concrete AWS SDK calls — enabling thorough unit testing with mocks |

## Adding a New Workflow Node Type

To add a new type of node to the workflow system:

### 1. Define the Node Type

Add the new node type to the `WorkflowNodeDefinition` interface in `frontend/src/types/workflow.ts`:

```typescript
interface WorkflowNodeDefinition {
  id: string;
  type: 'agent' | 'condition' | 'your_new_type';  // extend the union
  // ... existing fields ...
  yourNewTypeConfig?: YourNewTypeConfig;
}
```

### 2. Add a Custom ReactFlow Node Component

Create `frontend/src/components/YourNewTypeNode.tsx` following the `AgentNode.tsx` pattern. Register it in the ReactFlow `nodeTypes` map in `WorkflowCanvas.tsx`.

### 3. Extend the Step Runner Executor

In `arbiter/stepRunner/executor.py`, extend `invoke_node` to handle the new type:

```python
def invoke_node(execution_id, node, input_data, configuration):
    if node['type'] == 'your_new_type':
        # Custom invocation logic
        result = execute_your_new_type(node, input_data, configuration)
        publish_node_completed(execution_id, node['id'], result)
    else:
        # Existing agent invocation via EventBridge
        publish_node_invoke_event(execution_id, node, input_data, configuration)
```

### 4. Add Property-Based Tests

Write Hypothesis tests in `arbiter/stepRunner/__tests__/test_your_new_type_properties.py` covering:
- The new node type integrates correctly with topological sort
- Retry policies apply to the new node type
- Conditional edges work with the new node type's output format

### 5. Update Publish Validation

Extend the publish validation logic in `workflow-resolver.ts` to validate the new node type's required fields.

### 6. Update the GraphQL Schema

If the new node type requires additional input/output types, add them to `backend/src/schema/schema.graphql`.

### 7. Add Seed Blueprints

Create a seed blueprint demonstrating the new node type in `backend/src/lambda/seed-blueprints/`.