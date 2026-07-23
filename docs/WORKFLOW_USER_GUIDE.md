# Workflow User Guide

A task-oriented, end-to-end walkthrough of building, publishing, running, and inspecting multi-agent workflows in Citadel. It covers the full journey: start from a blueprint, edit on the canvas, save your own blueprint, bind workflows to an Agent App, publish, run with live progress, and inspect results — plus operator notes and troubleshooting.

For the engine internals (DAG execution, retries, conditional branching, data model), see [BLUEPRINTS_WORKFLOWS.md](./BLUEPRINTS_WORKFLOWS.md).

## Table of Contents

- [Concepts](#concepts)
- [Start From a Blueprint](#start-from-a-blueprint)
- [Build and Edit on the Canvas](#build-and-edit-on-the-canvas)
- [Save Your Own Blueprint](#save-your-own-blueprint)
- [Bind Workflows to an App and Publish](#bind-workflows-to-an-app-and-publish)
- [Run a Workflow and Watch Live Progress](#run-a-workflow-and-watch-live-progress)
- [Invoke a Workflow via the Published App API](#invoke-a-workflow-via-the-published-app-api)
- [Inspect Results](#inspect-results)
- [Operator Notes](#operator-notes)
- [Troubleshooting](#troubleshooting)
- [Related Documentation](#related-documentation)

## Concepts

| Concept | What it is | Lifecycle |
|---------|-----------|-----------|
| Blueprint | A reusable workflow template in the shared catalog (`isBlueprint: true`). Read-only once published; importing it clones it into an editable workflow. | `DRAFT` → `PUBLISHED`. The catalog lists blueprints regardless of status, but only `PUBLISHED` blueprints can be imported (server-enforced) |
| Workflow | An editable DAG of agent nodes and edges, owned by your organisation and optionally bound to an Agent App. | `DRAFT` → `PUBLISHED`. Only `PUBLISHED` workflows can run |
| Agent App | The runtime container that groups agents and workflows behind a single application, with its own publish lifecycle and API endpoint. | App statuses include a `PUBLISHED` filter tab on the Agent Apps page |
| Execution | A single run of a published workflow, with per-node results. | `pending` → `running` → `completed` \| `failed` \| `cancelled` |
| Node result | The status of one node within an execution. | `pending`, `running`, `completed`, `failed`, `skipped` (plus `cancelled` when the execution is cancelled) |

## Start From a Blueprint

The blueprint catalog lists the available blueprints. Every deployment seeds five:

| Seed blueprint | Category | Runnable as-is? |
|----------------|----------|-----------------|
| Echo Demo Workflow | demo | Yes — two echo nodes referencing the real seeded `demo-echo-agent`, which returns its input unchanged |
| Sequential Agent Pipeline | pipeline | No — placeholder agents only |
| Parallel Fan-Out | parallel | No — placeholder agents only |
| Conditional Router | conditional | No — placeholder agents only |
| Data Processing Pipeline | data-processing | No — placeholder agents only |

Operator note: seeding runs through CloudFormation custom resources that re-fire when their `Version` property changes (bumped to `v1.1.0` to deliver the Echo demo to pre-existing environments; the demo agent seeds via `v1.3.0`).

To import a blueprint into an app:

1. Browse the catalog and pick a blueprint. Importing requires the blueprint to be `PUBLISHED` — the server rejects the import of a `DRAFT` blueprint with "Only published blueprints can be imported".
2. Click "Use in App" and select (or create) the target Agent App in the import dialog.
3. Remap placeholder agents. Any agent slot whose ID carries the `placeholder-` prefix must be remapped to a real agent in the import dialog. The four template blueprints contain only placeholders; the Echo Demo Workflow contains none, so it needs no remapping.
4. The imported copy is a new `DRAFT` workflow named `<blueprint> (Copy)` with `isBlueprint: false`, bound to the chosen app. The original blueprint is unchanged.

Publish validation later rejects any node whose `agentId` does not exist — including leftover `placeholder-` references — so remap before you attempt to publish.

### Arriving from the intake conversation

The intake conversation is a second way a workflow lands on an app's
Workflows tab — no catalog browsing or import dialog involved. After a
fabrication completes, the intake agent (with your consent at each step)
activates the fabricated agents, creates the Agent App, generates a process
blueprint from your technical design, and imports it into the app. Because
the blueprint's steps reference the real fabricated agents, there are no
placeholder slots to remap.

The workflow's nodes are named after the step names in your design
documents — human-readable labels such as "Invoice Intake Classifier
Agent", not internal agent identifiers — so the canvas reads like the
process you designed.

The imported workflow arrives as a `DRAFT` named `<app name> Process` on the
app's Workflows tab, exactly like a catalog import. From there the standard
flow in the rest of this guide applies: publish the workflow to enable Run,
then publish the app itself when you want the endpoint. The conversation
walks you through those same steps — including that the app's Publish button
appears only after you Activate the app, and that the API key is shown only
once — but the agent never publishes on your behalf; you publish from the
app's pages.

If you later ask the intake conversation for the blueprint again, it offers
a "Regenerate the blueprint" action rather than silently rebuilding: a
fresh blueprint is published, and importing it adds a fresh workflow
alongside the existing one — the earlier workflow stays on the app's
Workflows tab until you remove it there.

### Worked example: Echo Demo Workflow

The Echo Demo Workflow is the fastest way to see a run end to end, because it references a real seeded agent and needs no remapping:

1. In the blueprint catalog, find Echo Demo Workflow (category `demo`) and click "Use in App".
2. Select or create a target app in the import dialog. There are no placeholder slots to remap.
3. The app's Workflows tab now shows a `DRAFT` workflow named "Echo Demo Workflow (Copy)". Click Publish on its card — it passes validation because both nodes reference `demo-echo-agent`.
4. Click Run. The two echo nodes execute in sequence, each returning its input unchanged, and the live indicator walks through Pending → Running → Completed.
5. Open the Executions tab and click the run to see the echoed payload in the result output.

## Build and Edit on the Canvas

Open the canvas at Agentic Studio → Create Agent Blueprints. Drag agents onto the canvas and connect them into a DAG.

### Toolbar actions

| Action | What it does |
|--------|--------------|
| Save | Saves the canvas to the blueprint catalog. A dialog prompts for a name and optional category; the blueprint is created and published in one step, so it is immediately loadable and importable |
| Load | Picks a published blueprint from the catalog, with search. Loading replaces the current canvas after a confirmation |
| Import | Loads a workflow from a local JSON file |
| Export | Downloads the current workflow as formatted JSON |
| Validate | Checks the workflow for errors and warnings |
| Clear | Removes all nodes and edges from the canvas |

Autosave persists the canvas to the server continuously — you do not need to press Save to keep your edits. Save is specifically the save-to-catalog action.

The run-controls bar carries Publish, which moves the workflow `DRAFT` → `PUBLISHED` and unlocks Run, and History, which shows past executions of the workflow.

### Node configuration

Double-click a node (or use its configure action) to open the node configuration drawer. From here you can:

- Rename the node.
- Set execution overrides:
  - Model override — a catalog-driven select that pins the node to a specific Bedrock model.
  - System prompt addition — free text appended to the agent's system prompt, up to 4,000 characters with a live character counter.
- Fill in agent-declared schema parameters, when the agent's configuration declares a parameter schema.

### How overrides apply at runtime

- Node configuration merges over workflow configuration per key — a key set on the node wins over the same key set at workflow level.
- The worker honours exactly two override keys: `modelOverride` (capped at 256 characters) and `systemPromptAddition` (capped at `WORKER_MAX_PROMPT_ADDITION_CHARS`, default 4,000).
- An oversized value is skipped entirely with a warning — it is never truncated, and the node still runs without the override.

## Save Your Own Blueprint

Once your canvas holds a design worth reusing:

1. Click Save on the canvas toolbar.
2. Enter a name and, optionally, a category in the dialog.
3. The blueprint is created and published immediately — it appears in the catalog straight away, ready for Load on any canvas or "Use in App" from the catalog.

## Bind Workflows to an App and Publish

Open an app from the Agent Apps page to reach its detail view.

### The Workflows tab

- Bind and unbind workflows to the app.
- Each workflow card offers:
  - Run — gated on the workflow being `PUBLISHED`.
  - Publish — shown for `DRAFT` workflows; server-side validation errors (disconnected nodes, cycles, missing or `placeholder-` agent references) are surfaced as a toast if publishing fails (the canvas shows the same errors inline).
  - Open — a deep link to the canvas at `/agentic-studio/workflows/:id`.
- A live run indicator (Pending / Running / Completed / Failed) updates via the `onWorkflowProgress` subscription while a run is in flight.

You can publish a workflow either from its app card here or from the canvas run-controls bar — both paths run the same server validation.

### Publishing the app

The app publish dialog lists preconditions. Unpublished workflows raise a non-blocking warning that points you at the Workflows tab — you can still publish the app, but those workflows will not be runnable until published themselves.

### App cards on the Agent Apps page

- A Run quick-action appears on cards for apps with at least one workflow, deep-linking to `/agent-apps/:id?tab=workflows`.
- An API dashboard quick-action appears once the app is `PUBLISHED`.
- The status filter tabs include `PUBLISHED`.

## Run a Workflow and Watch Live Progress

Three entry points start a run:

1. The per-card Run button on the app's Workflows tab.
2. The Run quick-action on an app card, which deep-links to the Workflows tab.
3. Run on the canvas run-controls bar.

All paths call `startExecution(workflowId, input)`, which requires the workflow to be `PUBLISHED` and returns an execution in `pending`. The optional `input` is an `AWSJSON` payload recorded on the execution and shown in the execution detail sheet; root nodes currently receive no payload.

### Live progress

Seven progress event types stream to the UI while a run is in flight:

| Event | Meaning |
|-------|---------|
| `workflow.started` | The execution began |
| `workflow.node.started` | A node began running |
| `workflow.node.completed` | A node finished successfully |
| `workflow.node.failed` | A node failed |
| `workflow.node.retrying` | A failed node is being retried |
| `workflow.completed` | The execution finished successfully |
| `workflow.failed` | The execution failed (including cancellation and timeout) |

Delivery chain: the fan-out Lambda (`backend/src/lambda/workflow-progress-fanout.ts`) receives each EventBridge event and calls the `publishWorkflowProgress` mutation, which triggers the `onWorkflowProgress(executionId)` GraphQL subscription. Each event carries `executionId`, `workflowId`, `eventType`, `nodeId`, `status`, `output`, `error`, and `timestamp`. The EventBridge `correlationId` is the `executionId`, so a run is traceable end to end.

### Cancelling a run

`cancelExecution` marks the execution `cancelled` and every `pending` or `running` node `cancelled`. A `workflow.failed` event carrying the cancellation reason notifies subscribers.

## Invoke a Workflow via the Published App API

Publishing an app (Confirm Publish) returns an endpoint URL and an API key, giving external callers an HTTP path to start runs — no console session required. The full contract (request-body rules, denial behaviour, key management, and the note for apps published before stage-variable support) lives in [AGENT_APPS.md — Invoking a Published App](./AGENT_APPS.md#invoking-a-published-app); this section is the task-oriented quick path.

### Call the endpoint

```bash
curl -X POST "https://<apiId>.execute-api.<region>.amazonaws.com/invoke" \
  -H "x-api-key: <api-key>" \
  -H "Content-Type: application/json" \
  -d '{"workflowId": "<workflowId>", "input": {"message": "hello"}}'
```

The call is asynchronous: a `200` means the invoke event was accepted, not that the workflow ran or completed, and the response carries no execution id. Results land in the app's Executions tab like any other run.

### Finding the workflowId

On the app's Workflows tab, each workflow card's Open action deep-links to the canvas at `/agentic-studio/workflows/:id` — the `:id` segment is the workflowId. Programmatically, the `listAppWorkflows(appId)` query returns the app's bound workflows with their `workflowId`s.

### When workflowId is required in the body

- More than one workflow bound to the app — `workflowId` is required and must be one of the bound workflows.
- Exactly one workflow bound — `workflowId` may be omitted; the bound workflow runs. If supplied anyway, it must match that workflow or the invoke is silently dropped.
- No workflows bound — every invoke is dropped; bind and publish a workflow first.

### The authenticated GraphQL alternative

From the console or an org-authenticated service, call the `startExecution` mutation directly with a Cognito JWT (the API's default auth mode). Unlike the App API path it returns the execution record — including the `executionId` — immediately, and it requires only a `PUBLISHED` workflow in your organisation; the app itself need not be published.

```graphql
mutation {
  startExecution(
    workflowId: "<workflowId>"
    input: "{\"message\": \"hello\"}"
  ) {
    executionId
    status
    startedAt
  }
}
```

`input` is the same optional `AWSJSON` payload described under [Run a Workflow and Watch Live Progress](#run-a-workflow-and-watch-live-progress) — note that as `AWSJSON` it is passed as a JSON-encoded string.

For status, poll `getExecution` with the returned id:

```graphql
query {
  getExecution(executionId: "<executionId>") {
    status
    output
    error
    completedAt
  }
}
```

Or subscribe to `onWorkflowProgress(executionId: "<executionId>")` for the live event stream described under [Live progress](#live-progress).

## Inspect Results

### The Executions tab

The app detail view's Executions tab lists executions. Click a row to open the execution detail sheet:

- Result output — pretty-printed JSON with a copy button.
- Error block — shown for failed executions.
- Per-node step timeline — status, agent, duration, and retry count per node, with expandable output and error per step.
- Collapsible input — the payload the run started with.

The sheet refreshes live while the execution is still running.

### Canvas History

The History control on the canvas run-controls bar shows past executions of the workflow you are editing.

## Operator Notes

### Timeout watchdog

A scheduled Lambda (`arbiter/stepRunner/timeout_watchdog.py`) sweeps the executions table and fails any execution that has been `running` longer than `WORKFLOW_TIMEOUT_SECONDS` (default 3600). The sweep is idempotent — a conditional update guarding `status == 'running'` means concurrent sweeps, redelivered schedule ticks, or races with the executor resolve to a no-op. Each sweep emits the `WorkflowTimedOut` CloudWatch metric, and the alarm `citadel-workflow-timeout-watchdog-errors-<env>` fires on watchdog errors. Timed-out executions emit a normal `workflow.failed` event, so the UI and metrics react as they would to any terminal failure.

### Cancellation semantics

Cancellation is terminal: the execution moves to `cancelled`, in-flight and queued nodes are marked `cancelled`, and the cancellation reason travels on the `workflow.failed` event.

### Override caps

The worker enforces size caps on per-node execution overrides: `systemPromptAddition` up to `WORKER_MAX_PROMPT_ADDITION_CHARS` (default 4,000; falls back to the default when the variable is missing or invalid) and `modelOverride` at a fixed 256 characters. Oversized values are skipped with a warning — never truncated — and the node runs without the override.

### IAM posture

The workflow execution path follows least privilege:

- The worker's `bedrock:InvokeModel` grant is scoped to the shared model ARNs.
- The watchdog's DynamoDB access is exactly `dynamodb:Scan` and `dynamodb:UpdateItem` on the executions table; beyond that it holds only `events:PutEvents` and namespace-narrowed `cloudwatch:PutMetricData`.
- The seed Lambda's S3 put permission is narrowed to the `agents/*` prefix of the agent code bucket.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Run is disabled on a workflow card or the canvas | The workflow is `DRAFT` — `startExecution` requires `PUBLISHED` | Publish from the app card or the canvas run-controls bar |
| Publish fails citing an agent reference | A node's `agentId` does not exist — commonly a leftover `placeholder-` agent from a template blueprint | Remap the placeholder slots to real agents (the import dialog does this at import time; otherwise edit the nodes on the canvas) |
| Importing a blueprint fails with "Only published blueprints can be imported" | The blueprint is `DRAFT` — the server enforces `PUBLISHED` at import time (the catalog itself lists blueprints regardless of status) | Publish the blueprint (canvas Save publishes automatically) |
| A model or prompt override did not take effect | The value exceeded its cap (256 characters for `modelOverride`; `WORKER_MAX_PROMPT_ADDITION_CHARS`, default 4,000, for `systemPromptAddition`), so the worker skipped it with a warning | Shorten the value, or raise `WORKER_MAX_PROMPT_ADDITION_CHARS` for prompt additions |
| An execution failed after roughly an hour with no node error | The timeout watchdog failed a stuck execution past `WORKFLOW_TIMEOUT_SECONDS` (default 3600) | Investigate the stuck node (lost completion event, crashed worker); raise the timeout only if runs legitimately exceed it |

## Related Documentation

- [BLUEPRINTS_WORKFLOWS.md](./BLUEPRINTS_WORKFLOWS.md) — engine architecture, data model, retries, conditional branching, testing strategy
- [AGENT_APPS.md](./AGENT_APPS.md) — Agent Apps platform, including the app detail Workflows and Executions tabs
- [EVENTBRIDGE_CATALOG.md](./EVENTBRIDGE_CATALOG.md) — event envelope contracts for `workflow.*` events
- [QUICK_START.md](./QUICK_START.md) — 5-minute deployment, including running the demo workflow
