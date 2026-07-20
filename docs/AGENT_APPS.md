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
| Create the app | `intakeCreateApp(sessionId, name, description)` | Creates the Agent App as a registry record in `DRAFT`. The agent proposes a name from the project and the user confirms or renames before this runs |
| Generate the blueprint | `intakeCreateBlueprint(sessionId, name, definition)` | Composes a process blueprint from the technical design and fabrication plan, with real fabricated agents as steps, and creates + publishes it in one call. An `AGENTS_SYNCING` result is the retryable registry-sync race, surfaced to the user as "Try again" |
| Import the workflow | `intakeImportBlueprintToApp(sessionId, blueprintId, appId, name)` | Imports the published blueprint into the app as a `DRAFT` workflow on the app's Workflows tab |

All four mutations are declared `@aws_iam` only — they are called
exclusively by the intake AgentCore runtime over SigV4 and are unreachable
from user-pool clients.

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
