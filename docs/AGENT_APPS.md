# Agent Apps Platform (Superseded)

> **STATUS: Superseded.** The Agent Apps Platform has been migrated to the
> AgentCore Registry as of PR 3 of the governance retrofit. Authoritative
> reference: [Agent Records](./AGENT_RECORDS.md).

## Migration Summary

- The legacy DynamoDB `AppsTable` has been replaced as the authoritative
  catalogue by the AWS Bedrock AgentCore Registry, accessed via
  `BedrockAgentCoreControlClient`. `AppsTable` itself is retained only for
  per-app agent bindings during the deprecation window — see
  [What Moved Where](#what-moved-where) for the boundary.
- The primary identifier `appId` has been replaced by the Registry-native
  `recordId` (12-alphanumeric, allocated by the Registry).
- The `AgentApp.status` enum (`DRAFT` / `ACTIVE` / `ARCHIVED`) has been
  replaced by `RegistryRecordStatus` (`DRAFT` / `PENDING_APPROVAL` /
  `APPROVED` / `REJECTED` / `DEPRECATED`). The new status domain aligns with
  governance Decision #3.
- The shim resolver `backend/src/lambda/agent-app-shim-resolver.ts`
  preserves the `type AgentApp` GraphQL surface and every original
  `citadel.apps` EventBridge detail-type during the `@deprecated` grace
  window (Decision #5, SPLIT verdict). Subscribers and clients require no
  code changes for the duration of the window.

## What Moved Where

| Legacy concept                                     | Registry equivalent                                                                      |
|----------------------------------------------------|------------------------------------------------------------------------------------------|
| `AppsTable` row (catalogue side)                   | `RegistryAgentRecord` in the AgentCore Registry (see [AGENT_RECORDS.md](./AGENT_RECORDS.md)) |
| Component table GSI (`AGENT#`, `PERMISSION#`, `CONFIG#`) | `customDescriptorContent.manifest` JSON on the registry record                     |
| `backend/src/lambda/app-resolver.ts`               | `backend/src/lambda/agent-app-shim-resolver.ts`                                          |
| `citadel-agent-{appId}` per-app IAM role           | Per-record workload-identity attribute on the registry record (Decision #6)              |
| `AuthorityUnit.appId`                              | `AuthorityUnit.registryId` (Decision #9)                                                 |

## Sunset Timeline

- PR 3 of the governance retrofit landed the registry-backed implementation
  and the `agent-app-shim-resolver.ts` shim. `type AgentApp` carries the
  `@deprecated` directive in the GraphQL schema from PR 3 onward.
- The `@deprecated type AgentApp` GraphQL surface remains callable through
  PR 6 (post-MVP) to give downstream clients a migration window.
- PR 6 removes the `@deprecated` type and retires the shim. Gate conditions
  for PR 6: registry MVP stable for at least one release cycle, explicit
  frontend sign-off, and zero `@deprecated` `AgentApp` reads observed in
  client telemetry for a full rolling observation window.

## Workflows

> Unlike the superseded catalogue content above, this section and
> [Executions](#executions) describe **current** functionality on the app
> detail view. For the end-to-end journey (blueprint → canvas → publish →
> run → inspect), see [WORKFLOW_USER_GUIDE.md](./WORKFLOW_USER_GUIDE.md).

The app detail view (Agent Apps → select an app) includes a **Workflows**
tab for managing the workflows bound to the app:

- Bind and unbind workflows to the app.
- Each workflow card carries per-card actions:
  - **Run** — gated on the workflow being `PUBLISHED`.
  - **Publish** — shown for `DRAFT` workflows; server-side validation
    errors are surfaced as a toast when publishing fails (the canvas
    shows the same errors inline).
  - **Open** — a deep link to the canvas at
    `/agentic-studio/workflows/:id`.
- A live run indicator (Pending / Running / Completed / Failed) updates via
  the `onWorkflowProgress` GraphQL subscription while a run is in flight.

Related app-level behaviour:

- The app publish dialog's preconditions include a **non-blocking** warning
  for unpublished workflows, pointing at the Workflows tab.
- App cards on the Agent Apps page show a **Run** quick-action when the app
  has at least one workflow, deep-linking to
  `/agent-apps/:id?tab=workflows`, and an **API dashboard** quick-action
  once the app is `PUBLISHED`. The status filter tabs include `PUBLISHED`.

## Executions

The app detail view's **Executions** tab lists executions of the app's
workflows. Clicking a row opens the execution detail sheet:

- Result output as pretty-printed JSON, with a copy button.
- An error block for failed executions.
- A per-node step timeline — status, agent, duration, and retry count per
  node, with expandable output and error per step.
- The execution's input, collapsible.

The sheet refreshes live while the execution is still running.

## Invoking a Published App

> Like [Workflows](#workflows) and [Executions](#executions), this section
> describes **current** functionality: the HTTP invoke path a `PUBLISHED`
> app exposes to external callers.

### Prerequisites

- The app is `PUBLISHED`. Publishing provisions a per-app API Gateway
  HTTP API (`provisionApiGateway` in
  `backend/src/lambda/app-publish-handler.ts`) and returns the endpoint
  URL and the default API key.
- The workflow to run is `PUBLISHED` and bound to the app on its
  [Workflows](#workflows) tab. Anything else fails closed — see
  [Denial behaviour](#denial-behaviour).

### Endpoint and authentication

The endpoint is `https://<apiId>.execute-api.<region>.amazonaws.com` with
a single route, `POST /invoke`, served from the `$default` stage — there
is no stage segment in the URL. The URL is returned at **Confirm
Publish** and stored on the app as `endpointUrl`.

Auth is an `x-api-key` header validated by a Lambda authorizer against
the app's key records (`backend/src/lambda/app-api-authorizer.ts`):

- The default key's plaintext is shown exactly once, at **Confirm
  Publish**; only its SHA-256 hash is stored, so it can never be
  retrieved again.
- Create, rotate, revoke, and list keys via the `createAppApiKey`,
  `rotateAppApiKey`, `revokeAppApiKey`, and `listAppApiKeys` GraphQL
  operations (`backend/src/lambda/app-api-key-management.ts`). Rotation
  atomically creates the replacement and revokes the old key, returning
  the new plaintext once; up to 10 keys may be `ACTIVE` per app.
- A missing key is rejected with `401`; an unknown, revoked, or expired
  key with `403`. Authorizer results are cached for 300 seconds, so a
  rotated or revoked key may keep authorizing for up to 5 minutes.

### Calling the endpoint

```bash
curl -X POST "https://<apiId>.execute-api.<region>.amazonaws.com/invoke" \
  -H "x-api-key: <api-key>" \
  -H "Content-Type: application/json" \
  -d '{"workflowId": "<workflowId>", "input": {"message": "hello"}}'
```

The JSON body (64 KiB max, sanitized on receipt):

- `workflowId` — optional. Selects among the app's bound workflows:
  required (and must be one of the bound IDs) when more than one workflow
  is bound; optional with exactly one bound workflow, but if supplied it
  must match that workflow.
- Every other field is recorded as the execution's input — `workflowId`
  is stripped before storage, and an otherwise-empty body stores a `null`
  input. There is no fixed input schema; the `input` wrapper above is a
  convention, not a requirement.

### Async semantics

The route is an API Gateway → EventBridge integration: a `200` means the
invoke event was accepted onto the bus, NOT that the workflow ran or
completed — the response carries no execution id. The consumer
(`backend/src/lambda/app-invoke-handler.ts`) then creates the execution
(`status: pending`, `triggeredBy: app-invoke:<appId>`, `orgId` taken from
the app itself) and hands off to the Step Runner exactly as a UI-started
run. Consumption is idempotent on the EventBridge event id — a
redelivered event cannot create a duplicate execution.

Results appear in the [Executions](#executions) tab alongside UI-started
runs, or via `getExecution(executionId)` once the execution id is known.

### Denial behaviour

After the `200`, every consumer-side validation failure fails closed: the
event is dropped with a CloudWatch warning and no execution is created —
the caller sees nothing beyond the original `200`. Dropped cases: app not
found or not `PUBLISHED`; zero bound workflows; more than one bound
workflow with a missing or non-bound `workflowId`; a `workflowId` that
does not match the single bound workflow; workflow not `PUBLISHED`, in a
different org than the app, or bound to a different app; body over
64 KiB. If invokes silently produce no executions, check the
app-invoke-handler logs.

### Apps published before stage-variable support

The invoke path reads its trusted appId from a stage variable stamped
onto the `$default` stage at publish time. Apps published before this
existed lack the variable, so their invoke events are dropped. Fix with
the idempotent backfill script —
`ts-node backend/scripts/backfill-app-stage-vars.ts --apply` (dry-run by
default without `--apply`; no key rotation, no downtime) — or by
re-publishing the app, which also works but rotates the default API key
and changes the endpoint URL.

The event contract behind this path is cataloged under App Invoke Events
in [EVENTBRIDGE_CATALOG.md](./EVENTBRIDGE_CATALOG.md).

## Intake Post-Fabrication Path

> Like [Workflows](#workflows) and [Executions](#executions), this section
> describes **current** functionality. It is how an Agent App comes into
> existence when the intake conversation drives the process end to end.

After a fabrication completes, the intake agent
(`service/agent_intake_single`) closes the loop conversationally. While a
fabrication is in flight the agent polls build status at the start of every
turn (it cannot receive push notifications), and offers activation once all
agents are terminal — a partial success still offers to activate the agents
that built. The flow
is consent-gated — the agent never skips a step or auto-proceeds; each step
runs only on the user's explicit confirmation, "Not now" defers, and a
decline stops the flow. It is also resumable: each tool reports what is
already done, and re-running a completed step is safe.

The conversational steps map onto four IAM-only AppSync mutations served by
a dedicated resolver Lambda
(`backend/src/lambda/intake-orchestration-resolver.ts` — see the
intake-orchestration pattern in [RESOLVER_GUIDE.md](./RESOLVER_GUIDE.md)):

| Conversational step | Mutation | What it does |
|---------------------|----------|--------------|
| Activate agents | `intakeActivateProjectAgents(sessionId)` | Activates the fabricated agents. Matches the fabricator-stamped `sourceProjectId` by session id first, falling back to the conversations-linked project id; the result's `matchedBy` field reports which key matched (`null` when neither did) |
| Create the app | `intakeCreateApp(sessionId, name, description)` | Creates the Agent App as a registry record in `DRAFT`. The agent proposes a name from the project — pre-sanitized to the registry-safe form, so it matches what gets created — and the user confirms or renames before this runs. Idempotent: a retry returns the session's existing app |
| Generate the blueprint | `intakeCreateBlueprint(sessionId, name, definition)` | Composes a process blueprint from the technical design and fabrication plan, with real fabricated agents as steps, and creates + publishes it in one call. An `AGENTS_SYNCING` result is the retryable registry-sync race, surfaced to the user as "Try again" |
| Import the workflow | `intakeImportBlueprintToApp(sessionId, blueprintId, appId, name)` | Imports the published blueprint into the app as a `DRAFT` workflow on the app's Workflows tab, and ensures the app's agent bindings. Re-running returns the existing workflow instead of duplicating it |

All four mutations are declared `@aws_iam` only — they are called
exclusively by the intake AgentCore runtime over SigV4 and are unreachable
from user-pool clients.

### App naming and idempotent creation

The app is a registry record, and the AgentCore Registry constrains record
names to `^[a-zA-Z0-9][a-zA-Z0-9_\-./]*$` — spaces are illegal. The shared
service layer sanitizes every name to that form at creation
(`backend/src/utils/registry-name.ts`: illegal characters map to hyphens,
hyphen runs collapse, the result is never empty), and the intake agent
applies the identical rules to its proposal
(`service/agent_intake_single/tools/registry_name.py`), so the consent gate
shows exactly the name that will be created — a project called "Test -
Ingest" is proposed as "Test-Ingest" up front, never silently renamed after
the fact.

App creation is idempotent by session. `intakeCreateApp` stamps the app
with a server-derived `sourceProjectId` (the session id) and looks the app
up by that same key before creating anything, so a consented retry — for
example after a client timeout on a call that had in fact persisted the
app — returns the session's existing app instead of minting a duplicate.

By design, creation performs no agent binding pass (an inline binding pass
previously consumed the creation call's timeout budget, and the resulting
retries are what produced duplicate apps). The import step is the binding
point: `intakeImportBlueprintToApp` ensures every agent the workflow
references is bound to the app with a `READY` binding — on the first import
and again on any conversational re-trigger, which also heals apps whose
workflow predates app-level bindings. The practical effect is that the
app's Agents tab populates at import time rather than at creation.

### Build-phase progress

The flow reports progress into the project header's Build segment as it
goes. Confirming the fabrication plan marks the segment at 10; per-agent
fabrication events scale within 10–60 while the builds run; and each
completed step then lands a fixed milestone — agents activated 70, app
created 80, blueprint published 85, workflow imported 90. Publishing the
app completes the segment at 100 (emitted by the backend publish handler
for intake-created apps). All of these writes are monotonic — progress only
ever advances, so an idempotent re-run, a stale event, or out-of-order
delivery can never move the segment backwards — and a failed agent build is
a signal the updater ignores, not a regression. The event contract is
cataloged under Intake Progress Events in
[EVENTBRIDGE_CATALOG.md](./EVENTBRIDGE_CATALOG.md).

### The living fabrication plan document

The fabrication plan written at plan confirmation does not go stale — the
flow keeps it a living document
(`service/agent_intake_single/tools/plan_doc.py`). Whenever the agent
checks build status and finds the builds terminal, and again at every
post-fabrication milestone, it refreshes the plan document in place. The
refresh regenerates only the sections it owns: the per-agent status table,
recomputed from live build-job and registry state in plain phrases
("Built", "Active — ready to use"), and a Delivered Artifacts section
listing the activated agents, the app, the published blueprint with its
step count, and the imported workflow, each entry keeping its
first-recorded timestamp. Everything else in the document — including the
authored agent specifications — is preserved byte for byte, an unchanged
document is not rewritten, and a failed refresh never fails the step that
triggered it.

### Regenerating the blueprint

Once the blueprint is published, asking the agent to generate it again does
not silently rebuild it — the agent offers an explicit "Regenerate the
blueprint" action instead. On consent, it composes and publishes a fresh
blueprint and re-opens the import gate; importing then adds a fresh
workflow to the app (a fresh blueprint means the already-imported detection
treats the import as new rather than returning the earlier workflow). The
workflow imported from the prior blueprint stays on the app until the user
removes it there.

Starting states after the flow completes: the app is a `DRAFT` registry
record and the imported workflow is a `DRAFT` on the app's **Workflows**
tab. Neither is auto-published — the agent has no tool that publishes a
workflow or an app. Instead, the conversation relays the real click-path as
guidance:

1. Open the app and go to its **Workflows** tab.
2. **Publish** the workflow (from its card or the canvas) — publishing the
   workflow is what enables **Run**.
3. **Activate** the app — the app-level **Publish** button only appears once
   the app is `APPROVED`.
4. **Publish**, then **Confirm Publish** — this returns the endpoint URL and
   the API key, which is shown only once.
5. After publishing, the **API Dashboard** appears in the app.
6. The app is now callable over HTTP with the endpoint URL and API key
   from step 4 — see [Invoking a Published App](#invoking-a-published-app).

Note the workflow-publish step gates **Run** only; the app publish dialog
treats unpublished workflows as a non-blocking warning, as described under
[Workflows](#workflows).

## Where To Go Next

- [docs/WORKFLOW_USER_GUIDE.md](./WORKFLOW_USER_GUIDE.md) — task-oriented
  walkthrough of building, publishing, running, and inspecting workflows,
  including the app detail Workflows and Executions tabs.
- [docs/AGENT_RECORDS.md](./AGENT_RECORDS.md) — authoritative data model for
  the AgentCore Registry, lifecycle, governance integration, and adapter APIs.
- [docs/GOVERNANCE_ROLLOUT_RUNBOOK.md](./GOVERNANCE_ROLLOUT_RUNBOOK.md) —
  operational procedure for rolling the governance gate from permissive
  through shadow to strict in production.
- [docs/EVENTBRIDGE_CATALOG.md](./EVENTBRIDGE_CATALOG.md) — specifically the
  `App Lifecycle Events (source: citadel.apps)` section for the registry-
  backed event envelope contract.

## Historical Note

The original 52 KB architecture, component-management, and test-strategy
documentation for the Agent Apps platform is preserved in git history at
commit `1748d9b` for archaeological reference. Use `git show 1748d9b:docs/AGENT_APPS.md`
to retrieve the pre-retrofit content.
