# Agent Apps Platform

The Agent Apps Platform bundles agent configurations, workflows, scoped permissions, and app-specific settings into deployable application units with lifecycle management. It uses a component table pattern (single DynamoDB table with `GroupIndex` GSI) to store app metadata and child components under a shared partition, enabling efficient queries for all app resources. The platform extends the Supervisor with app-scoped agent resolution, adds Decision Advantage Governance to restrict agent autonomy to workflow step boundaries, and provides intent-based request routing for multi-workflow apps. Three frontend pages (Agent Apps list, App Builder Wizard, App Detail View) provide the user interface for creating, configuring, and managing apps through their DRAFT → ACTIVE → ARCHIVED lifecycle.

## Table of Contents

- [Agent Apps Platform](#agent-apps-platform)
  - [Table of Contents](#table-of-contents)
  - [Architecture Overview](#architecture-overview)
  - [Core Concepts](#core-concepts)
    - [Agent App](#agent-app)
    - [App Component](#app-component)
    - [Agent Binding](#agent-binding)
    - [App Permission](#app-permission)
    - [Component Status](#component-status)
    - [App Configuration Schema and Values](#app-configuration-schema-and-values)
    - [Agent Manifest](#agent-manifest)
    - [Intent Matcher](#intent-matcher)
    - [Decision Advantage Governance](#decision-advantage-governance)
  - [Component Map](#component-map)
    - [Backend](#backend)
    - [Frontend](#frontend)
  - [How It Works](#how-it-works)
    - [App Creation](#app-creation)
    - [Component Management](#component-management)
    - [Status Lifecycle](#status-lifecycle)
    - [Fabrication Registration](#fabrication-registration)
  - [Data Flows](#data-flows)
    - [Publish Flow](#publish-flow)
    - [App-Scoped Execution Flow](#app-scoped-execution-flow)
    - [Intent Routing Flow](#intent-routing-flow)
  - [Naming Conventions](#naming-conventions)
  - [How Access and Permissions Work](#how-access-and-permissions-work)
  - [Retry and Resilience](#retry-and-resilience)
    - [Optimistic Locking](#optimistic-locking)
    - [Idempotent Operations](#idempotent-operations)
    - [EventBridge Retry](#eventbridge-retry)
    - [PolicyManager Resilience](#policymanager-resilience)
    - [Frontend Resilience](#frontend-resilience)
  - [Error Handling](#error-handling)
    - [App Resolver](#app-resolver)
    - [Arbiter (Supervisor / Worker Wrapper)](#arbiter-supervisor--worker-wrapper)
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
  - [Adding a New App Component Type](#adding-a-new-app-component-type)
    - [1. Define the sortId Pattern](#1-define-the-sortid-pattern)
    - [2. Extend the App Resolver](#2-extend-the-app-resolver)
    - [3. Extend the GraphQL Schema](#3-extend-the-graphql-schema)
    - [4. Extend the getAppWithComponents Helper](#4-extend-the-getappwithcomponents-helper)
    - [5. Add Publish Preconditions (if applicable)](#5-add-publish-preconditions-if-applicable)
    - [6. Write Property-Based Tests](#6-write-property-based-tests)
    - [7. Update the Frontend](#7-update-the-frontend)
    - [8. Update the App Builder Wizard](#8-update-the-app-builder-wizard)

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                           Frontend (React)                          │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────────────┐  │
│  │ Agent Apps   │  │ App Builder  │  │ App Detail View           │  │
│  │ Page /apps   │  │ Wizard       │  │ /apps/{appId}             │  │
│  │              │  │ /apps/new    │  │                           │  │
│  └──────┬───────┘  └──────┬───────┘  └───────────┬───────────────┘  │
│         │                 │                      │                  │
│         └─────────────────┼──────────────────────┘                  │
│                           │ GraphQL + Subscriptions                 │
└───────────────────────────┼─────────────────────────────────────────┘
                            │
┌───────────────────────────┼─────────────────────────────────────────┐
│                    AWS AppSync API                                  │
│  ┌─────────────────┐  ┌───────────────────┐  ┌──────────────────┐   │
│  │ App Resolver λ  │  │ Agent Config      │  │ Fabricator Req   │   │
│  │ (extended)      │  │ Resolver λ        │  │ Resolver λ       │   │
│  └────────┬────────┘  └────────┬──────────┘  └────────┬─────────┘   │
└───────────┼────────────────────┼──────────────────────┼─────────────┘
            │                    │                      │
┌───────────┼────────────────────┼──────────────────────┼─────────────┐
│           │             DynamoDB Tables               │             │
│  ┌────────▼────────┐  ┌────────▼─────────┐  ┌─────────▼────────┐    │
│  │ citadel-apps    │  │ citadel-agents   │  │ citadel-workflows│    │
│  │ + GroupIndex GSI│  │                  │  │                  │    │
│  └─────────────────┘  └──────────────────┘  └──────────────────┘    │
└───────────┬─────────────────────────────────────────────────────────┘
            │
┌───────────▼─────────────────────────────────────────────────────────┐
│                    EventBridge (citadel-agents-{env})               │
│                                                                     │
│ app.status.* │ app.component.* │ agent.fabricated │ tool.fabricated │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │ Fabrication Registration Rule                                │   │
│  └──────────────────────┬───────────────────────────────────────┘   │
│                         │                                           │
│  ┌──────────────────────▼───────────────────────────────────────┐   │
│  │ App Component Registration Handler λ                         │   │
│  └──────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
            │
┌───────────▼─────────────────────────────────────────────────────────┐
│                    Arbiter (Python)                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐               │
│  │ Supervisor λ │  │ Worker       │  │ Fabricator λ │               │
│  │ (app-scoped  │  │ Wrapper λ    │  │ (app         │               │
│  │  resolution) │  │ (governance  │  │  registration│               │
│  │              │  │ + overrides) │  │  )           │               │
│  └──────────────┘  └──────────────┘  └──────────────┘               │
└─────────────────────────────────────────────────────────────────────┘
            │
┌───────────▼─────────────────────────────────────────────────────────┐
│                    IAM                                              │
│  ┌──────────────────────┐  ┌────────────────────────────────────┐   │
│  │ PolicyManager         │  │ citadel-agent-{appId}             │   │
│  │ ensureRole /          │  │ (scoped IAM role per app)         │   │
│  │ assumeScopedRole      │  │                                   │   │
│  └──────────────────────┘  └────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

## Core Concepts

### Agent App

A DynamoDB item keyed by `appId` representing a deployable application unit. Each app has an `orgId` for access scoping, a `status` (`DRAFT`, `ACTIVE`, `ARCHIVED`), a `workflowIds` array for bound workflows, an optional `routingConfig` for multi-workflow request routing, and a monotonically increasing `version` for optimistic locking. The app metadata item uses the component table pattern with `groupId = APP#{appId}` and `sortId = METADATA`.

### App Component

A child item stored under an Agent App using the `groupId`/`sortId` composite key pattern. Components include agent bindings, permissions, and configuration items — all stored in the same `citadel-apps-{env}` table under the app's `GroupIndex` partition. Querying the `GroupIndex` with `groupId = APP#{appId}` returns the metadata item and all component items for that app.

| Item Type | sortId Pattern | Description |
|-----------|---------------|-------------|
| App Metadata | `METADATA` | Name, description, status, workflowIds, routingConfig, version |
| Agent Binding | `AGENT#{agentId}` | Agent association with overrides and status |
| Permission | `PERMISSION#{permissionId}` | IAM action/resource declarations |
| Config Schema | `CONFIG#schema` | JSON Schema (draft-07) defining required configuration |
| Config Values | `CONFIG#values` | Concrete values satisfying the schema |

### Agent Binding

An App Component that associates an agent with an app. Includes optional overrides for `systemPromptAddition` (appended to the agent's system prompt), `toolRestrictions` (tool IDs to exclude), and `modelOverride` (Bedrock model ID). New bindings default to `DESIGN` status. The Worker Wrapper applies these overrides at execution time without modifying the global agent configuration.

### App Permission

A permission declaration within an app specifying required IAM `actions` and `resources`. On publish, the PolicyManager creates a scoped IAM role `citadel-agent-{appId}` with the aggregated permissions (union of all permission items). Bare wildcard `*` actions are rejected — all permissions must specify at least a service prefix (e.g., `s3:*`).

### Component Status

A status field on agent bindings with values `DESIGN` (in development) and `READY` (validated, available for published workflows). Transitioning to `READY` requires the referenced agent to exist in the agents table with `state = active`. When an app is archived, all bindings revert to `DESIGN`.

### App Configuration Schema and Values

The App Configuration Schema is a JSON Schema (draft-07) document defining required configuration values (API keys, endpoints, feature flags) that must be provided before an app can be published. The App Configuration Values are the concrete values satisfying the schema, validated via JSON Schema validation. At execution time, the Worker Wrapper injects configuration values into the agent subprocess as the `APP_CONFIG` environment variable.

### Agent Manifest

A structured capability declaration stored on each agent's DynamoDB config item under a `manifest` field. Contains `name`, `description`, `version` (semver), optional `inputSchema`/`outputSchema` (JSON Schema), `tools` (tool IDs), and `resourceRequirements` (memory, timeout, permissions). The Fabricator auto-generates manifests when creating agents. The `publishAgentManifest` mutation allows manual updates with schema validation.

### Intent Matcher

A pure-function module (`arbiter/supervisor/intent_matcher.py`) for deterministic keyword-based intent matching. When an app has multiple workflows and `routingConfig.type` is `intent`, the matcher computes a relevance score for each workflow by counting request keyword overlaps against the workflow's `keywords` array, divided by total keywords. The workflow with the highest score above a configurable threshold (default: 0.3) is selected. Matching is case-insensitive with stop word removal.

### Decision Advantage Governance

A constraint mechanism that restricts agent autonomy to workflow step boundaries. When the Step Runner invokes an agent, it includes `stepConstraints` containing `allowedTools` (permitted tool IDs), `allowedActions` (permitted action types), and `maxIterations` (max LLM conversation turns). The Worker Wrapper enforces these constraints by filtering available tools and terminating the subprocess after the iteration limit. Without `stepConstraints`, the agent runs with full access (backward compatibility).

## Component Map

### Backend

| Component | File | Purpose |
|-----------|------|---------|
| App Resolver | `backend/src/lambda/app-resolver.ts` | Extended CRUD for apps, component management (add/remove), status transitions, publish preconditions, config schema/values |
| Agent Config Resolver | `backend/src/lambda/agent-config-resolver.ts` | Extended for agent manifest publishing and validation |
| Registration Handler | `backend/src/lambda/app-component-registration-handler.ts` | EventBridge-triggered Lambda that registers fabricated agents/tools under apps |
| Apps Table | `citadel-apps-{env}` | PK=`appId`, GSIs: `OrgIndex` (orgId/createdAt), `GroupIndex` (groupId/sortId) |
| PolicyManager | `backend/src/utils/policy-manager.ts` | Scoped IAM role creation (`citadel-agent-{appId}`), assumption, and deletion |
| GraphQL Schema | `backend/src/schema/schema.graphql` | AgentBinding, AppPermission, ComponentStatus, AppStatusEvent types; component mutations; subscriptions |
| CDK — BackendStack | `backend/lib/backend-stack.ts` | GroupIndex GSI addition, Registration Handler Lambda, EventBridge rules |

| Component | File | Purpose |
|-----------|------|---------|
| Supervisor | `arbiter/supervisor/index.py` | Extended with app-scoped agent resolution via `load_app_scoped_agents()` |
| Intent Matcher | `arbiter/supervisor/intent_matcher.py` | Pure functions: `tokenize`, `compute_relevance_score`, `match_intent` |
| Worker Wrapper | `arbiter/workerWrapper/index.py` | Extended with governance enforcement (`stepConstraints`), binding overrides, app config injection |
| Fabricator | `arbiter/fabricator/index.py` | Extended with `appId` pass-through and fabrication event publishing |

### Frontend

| Component | File | Purpose |
|-----------|------|---------|
| Agent Apps Page | `frontend/src/pages/AgentApps.tsx` | Card grid with search, status filter tabs (All/Draft/Active/Archived), empty state |
| App Builder Wizard | `frontend/src/pages/AppBuilderWizard.tsx` | 6-step wizard: Name, Agents, Workflows, Permissions, Configuration, Review |
| App Detail View | `frontend/src/pages/AppDetailView.tsx` | Tabbed navigation (Agents, Workflows, Permissions, Configuration, Executions), status transitions, real-time subscription |
| App Sidebar Entry | `frontend/src/components/AppSidebar.tsx` | "Agent Apps" navigation entry between "Agentic Studio" and "Agent Catalog" |

## How It Works

### App Creation

1. User navigates to `/apps` and clicks "Create App", opening the App Builder Wizard at `/apps/new`
2. The wizard collects app name (3–100 characters), description, agent selections, workflow bindings, permission declarations, and optional configuration schema/values across six steps
3. On submit, the wizard calls `createApp` (sets `status=DRAFT`, `version=1`), then `addAppComponent` for each agent and permission, then `bindWorkflowToApp` for each workflow, then `setAppConfigSchema` and `setAppConfigValues` if configuration is defined
4. The App Resolver stores the metadata item with `groupId = APP#{appId}`, `sortId = METADATA`
5. Each component is stored as a separate item under the same `groupId` partition with a type-prefixed `sortId`
6. EventBridge events are emitted for `app.created` and each `app.component.added`

### Component Management

1. `addAppComponent(appId, component)` creates or updates a component item under the app's `GroupIndex` partition — upsert behavior via `PutCommand`
2. `removeAppComponent(appId, componentType, componentId)` deletes the component item — idempotent, returns the app unchanged if the component doesn't exist
3. `updateAgentBinding(input)` updates override fields (system prompt, tool restrictions, model override, status) on an existing agent binding — throws an error if the binding doesn't exist
4. `setAppConfigSchema(appId, schema, version)` validates the JSON as a JSON Schema (draft-07) document via `ajv` and stores it as `CONFIG#schema`
5. `setAppConfigValues(appId, values, version)` validates values against the stored schema and stores them as `CONFIG#values`
6. All mutations verify the caller's `orgId` matches the app's `orgId` and use optimistic locking via the `version` field

### Status Lifecycle

The app status lifecycle follows three transitions with precondition checks:

**DRAFT → ACTIVE (publish):**
1. Query `GroupIndex` for all `AGENT#` bindings
2. For each agent referenced by a published workflow: verify `status == READY`
3. If `configSchema` exists: verify `configValues` exist and validate against schema
4. Call `PolicyManager.ensureRole(appId, aggregatedPermissions, accountId, 'agent')` to create `citadel-agent-{appId}` IAM role
5. If any step fails: return structured error listing all failing preconditions, do NOT update status
6. On success: update status, emit `app.status.draft_to_active`, call `publishAppStatusEvent` for subscription

**ACTIVE → ARCHIVED:**
1. Call `PolicyManager.deleteRole(appId, 'agent')` to clean up the scoped IAM role
2. Update all `AGENT#` bindings to `status=DESIGN`
3. Update status, emit `app.status.active_to_archived`

**ARCHIVED → DRAFT:**
1. Update status, emit `app.status.archived_to_draft`

### Fabrication Registration

1. User creates an agent or tool via the Fabricator with an optional `appId` field
2. The Fabricator stores the `appId` in the agent/tool DynamoDB config item and publishes an EventBridge event (`agent.fabricated` or `tool.fabricated`) with `appId` in the detail
3. An EventBridge rule targets the Registration Handler Lambda
4. The handler creates an App Component item with `groupId = APP#{appId}`, `sortId = AGENT#{agentId}` (or `TOOL#{toolId}`), and `status = DESIGN`
5. The handler is idempotent — `ConditionExpression: 'attribute_not_exists(groupId)'` prevents duplicates
6. Events without an `appId` are skipped (backward-compatible with standalone fabrication)

## Data Flows

### Publish Flow

```
User clicks "Publish" on App Detail View
  → App Resolver checks preconditions:
      → Query GroupIndex for AGENT# bindings
      → Verify all workflow-referenced agents have status=READY
      → Validate configValues against configSchema (if defined)
      → PolicyManager.ensureRole(appId, permissions, accountId, 'agent')
  → On success:
      → Update app status DRAFT → ACTIVE
      → Emit app.status.draft_to_active to EventBridge
      → Call publishAppStatusEvent AppSync mutation
      → Frontend receives onAppStatusChange subscription event
  → On failure:
      → Return structured error: { failedPreconditions: [...] }
      → Status remains DRAFT
```

### App-Scoped Execution Flow

```
Task request with appId arrives
  → Supervisor.load_app_scoped_agents(app_id):
      → Query GroupIndex: groupId=APP#{appId}, sortId begins_with AGENT#
      → Filter bindings where status=READY
      → Load full agent configs from citadel-agents-{env}
      → Apply binding overrides (systemPromptAddition, modelOverride)
  → Supervisor creates agent specs for Bedrock Converse toolConfig
      → Only app-scoped agents included (not all active agents)
  → Worker Wrapper executes agent:
      → Apply toolRestrictions (exclude listed tools)
      → Apply modelOverride as Bedrock model ID
      → PolicyManager.assumeScopedRole('agent', appId) for scoped credentials
      → Inject APP_CONFIG env var with serialized config values
      → Apply stepConstraints if present (governance)
```

### Intent Routing Flow

```
Task request with appId, routingConfig.type=intent
  → Supervisor loads app's workflows
  → Intent Matcher:
      → tokenize(request_text) → lowercase, split, remove stop words
      → For each workflow:
          → compute_relevance_score(tokens, workflow.keywords)
          → score = matching_tokens / total_keywords
      → Select workflow with highest score ≥ threshold (0.3)
  → If match found: route to matched workflow
  → If no match: return error "no matching workflow found"
  → If single workflow: route directly (skip matching)
  → If routingConfig.type=explicit: match by workflowId field in request
```

## Naming Conventions

| Entity | Pattern | Example |
|--------|---------|---------|
| Apps DynamoDB table | `citadel-apps-{env}` | `citadel-apps-dev` |
| GroupIndex GSI | `GroupIndex` on `citadel-apps-{env}` | PK=`groupId`, SK=`sortId` |
| OrgIndex GSI | `OrgIndex` on `citadel-apps-{env}` | PK=`orgId`, SK=`createdAt` |
| App metadata groupId | `APP#{appId}` | `APP#app-abc123` |
| Agent binding sortId | `AGENT#{agentId}` | `AGENT#agent-007` |
| Permission sortId | `PERMISSION#{permissionId}` | `PERMISSION#perm-001` |
| Config schema sortId | `CONFIG#schema` | `CONFIG#schema` |
| Config values sortId | `CONFIG#values` | `CONFIG#values` |
| Scoped IAM role (app) | `citadel-agent-{appId}` | `citadel-agent-app-abc123` |
| EventBridge source (apps) | `citadel.apps` | `citadel.apps` |
| Status transition events | `app.status.{from}_to_{to}` | `app.status.draft_to_active` |
| Component events | `app.component.{action}` | `app.component.added` |
| Fabrication events | `agent.fabricated`, `tool.fabricated` | `agent.fabricated` |
| GraphQL enums | PascalCase | `ComponentStatus`, `AppStatus` |
| GraphQL enum values | UPPER_SNAKE_CASE | `DESIGN`, `READY`, `DRAFT`, `ACTIVE`, `ARCHIVED` |

## How Access and Permissions Work

Every resolver operation follows the same org-scoped access control pattern used across Citadel:

1. Extract `userId` from AppSync identity (Cognito `sub`)
2. Call `AdminGetUser` to get the `custom:organization` attribute
3. Compare against the resource's `orgId`
4. Throw "Access denied" if mismatch

All component mutations (`addAppComponent`, `removeAppComponent`, `updateAgentBinding`, `setAppConfigSchema`, `setAppConfigValues`) verify the caller's `orgId` matches the app's `orgId` before modifying components.

On publish (DRAFT → ACTIVE), the PolicyManager creates a scoped IAM role `citadel-agent-{appId}` with a trust policy allowing the App Resolver Lambda role and the Worker Wrapper Lambda role to assume it. The role's policy is the union of all `AppPermission` items' `actions` and `resources` arrays.

At execution time, the Worker Wrapper calls `PolicyManager.assumeScopedRole('agent', appId)` to obtain temporary credentials scoped to the app's declared permissions. On archive (ACTIVE → ARCHIVED), the PolicyManager deletes the scoped role.

The Supervisor's app-scoped agent resolution queries the `GroupIndex` for `AGENT#` bindings with `status=READY`, ensuring only validated agents participate in execution. Without an `appId` in the task request, the Supervisor falls back to loading all active agents from the config table (backward compatibility).

## Retry and Resilience

### Optimistic Locking

All state-mutating operations use version-based optimistic locking. DynamoDB conditional writes check `version = :expectedVersion` and increment on success. The `setAppConfigSchema` and `setAppConfigValues` mutations also use the app's `version` field for consistency.

### Idempotent Operations

- `addAppComponent` uses `PutCommand` (upsert) — calling twice with the same data produces the same component item without duplication
- `removeAppComponent` returns the app unchanged if the component doesn't exist — no error on missing items
- The Registration Handler uses `ConditionExpression: 'attribute_not_exists(groupId)'` to prevent duplicate registrations from repeated EventBridge deliveries
- `bindWorkflowToApp` with an already-bound workflow (same app) returns the app unchanged

### EventBridge Retry

EventBridge provides built-in retry for failed Lambda invocations. The Registration Handler is designed to be idempotent, so retries produce the same result. Status transition events include a `correlationId` for traceability across retries.

### PolicyManager Resilience

If the PolicyManager fails to create the scoped IAM role during publish, the App Resolver reverts the app status to `DRAFT` and returns an error describing the permission creation failure. On archive, role deletion failures are logged but don't block the status transition — orphaned roles are cleaned up by operational procedures.

### Frontend Resilience

- The App Builder Wizard catches submission errors per step and preserves wizard state for retry without losing previously completed steps
- The Agent Apps page handles API failures with error messages and retry buttons
- The App Detail View auto-reconnects via Amplify on subscription disconnect, showing stale status badges until reconnected
- `Promise.allSettled` loads agents and workflows independently in the wizard — if one API fails, the other's results are still shown

## Error Handling

### App Resolver

| Scenario | Behavior |
|----------|----------|
| App not found | `Error('App not found')` |
| Access denied (org mismatch) | `Error('Access denied')` |
| Optimistic lock conflict | `Error('Conflict: app was modified concurrently. Please retry.')` |
| Invalid IAM action format | `ValidationError` with failing actions list |
| Bare wildcard in permissions | `ValidationError('Bare wildcard (*) not allowed — must specify service prefix')` |
| Invalid JSON Schema (draft-07) | `ValidationError` with schema errors |
| Config values don't match schema | `ValidationError` with per-property errors |
| Agent not active for READY transition | `Error('Agent must be active before marking as ready')` |
| Update non-existent agent binding | `Error('Agent is not a component of the app')` |
| Publish preconditions not met | Structured error: `{ failedPreconditions: [...] }` |
| PolicyManager role creation failure | `PermissionError` — status reverts to DRAFT |
| Unknown component type | `Error('Unknown component type')` — only "agent" and "permission" accepted |
| Config schema defined but no values on publish | `Error('Configuration values are required')` |
| DESIGN agents referenced by published workflows | Rejection with list of agents that must be promoted to READY |

### Arbiter (Supervisor / Worker Wrapper)

| Scenario | Behavior |
|----------|----------|
| App has no READY agents | Return `{'agents': []}`, log warning |
| Agent config not found in DDB | Skip agent, log structured JSON warning |
| Tool not in allowedTools (governance) | Block invocation, return error to agent |
| maxIterations exceeded | Terminate subprocess, return last output |
| No workflow matches intent | Return error with threshold info |
| Invalid manifest JSON | Return validation error with field details |
| Credential vending failure | Log error, continue without scoped credentials |
| Bedrock circuit breaker open | `CircuitBreakerOpen` exception, automatic recovery after timeout |
| Unrecognized tool in toolRestrictions | Silently ignored, log warning |
| No appId in task request | Fall back to loading all active agents (backward compatibility) |

### Frontend Error Handling

| Component | Error Behavior |
|-----------|---------------|
| Agent Apps Page | `listApps` failure → error message with retry button; empty results → empty state with "Create App" CTA |
| App Builder Wizard | Mutation failure → error toast on failed step, retry available, wizard state preserved |
| App Detail View — Status Transition | Failure → dialog shows failing preconditions highlighted |
| App Detail View — Subscription | Disconnect → auto-reconnect via Amplify, stale badge until reconnected |
| App Detail View — Tabs | API error per tab → error message with retry |
| Wizard — Form Validation | Inline error messages, Next button disabled until required fields valid |

### Structured Logging

All backend components emit structured JSON log entries:

```json
{
  "level": "INFO",
  "component": "AppResolver",
  "appId": "app-abc123",
  "orgId": "org-001",
  "action": "publish",
  "previousStatus": "DRAFT",
  "newStatus": "ACTIVE",
  "timestamp": "2025-01-25T12:15:00Z"
}
```

Governance enforcement logs:

```json
{
  "level": "WARN",
  "component": "Governance",
  "executionId": "exec-abc123",
  "agentId": "agent-007",
  "action": "tool_blocked",
  "toolId": "restricted-tool-001",
  "reason": "Tool not in allowedTools for current step",
  "timestamp": "2025-01-25T12:15:30Z"
}
```

## Testing Strategy

All implementation follows strict Test-Driven Development (TDD). Property-based tests use fast-check (TypeScript) and Hypothesis (Python), each with a minimum of 100 iterations per property. Tests are written and verified to fail (red phase) before implementation code is created (green phase). This feature has 32 correctness properties covering the full stack.

### Property-Based Tests

| # | Property | Test File | What It Validates |
|---|----------|-----------|-------------------|
| P1 | Component sortId derivation | `backend/src/lambda/__tests__/test_app_component_properties.ts` | `sortId` follows `{TYPE}#{id}` pattern, `groupId` follows `APP#{appId}`, new bindings default to `DESIGN` |
| P2 | GroupIndex query completeness | `backend/src/lambda/__tests__/test_app_component_properties.ts` | Query returns N+1 items (metadata + all components), metadata has `sortId=METADATA` |
| P3 | JSON round-trip serialization | `backend/src/lambda/__tests__/test_app_component_properties.ts` | `configSchema`, `configValues`, `manifest` survive serialize→deserialize |
| P4 | Component upsert idempotence | `backend/src/lambda/__tests__/test_app_component_properties.ts` | `addAppComponent` twice produces same result as once |
| P5 | Component removal idempotence | `backend/src/lambda/__tests__/test_app_component_properties.ts` | `removeAppComponent` on missing component returns app unchanged |
| P6 | Org-scoped access control | `backend/src/lambda/__tests__/test_app_resolver_properties.ts` | Mismatched orgId rejected on all mutations |
| P7 | Agent binding override application | `arbiter/supervisor/__tests__/test_agent_binding_properties.py` | Overrides applied correctly, unrecognized tool restrictions ignored |
| P8 | IAM permission validation | `backend/src/lambda/__tests__/test_app_permissions_properties.ts` | Bare `*` rejected, service-prefixed actions accepted |
| P9 | Permission aggregation as set union | `backend/src/lambda/__tests__/test_app_permissions_properties.ts` | Aggregated permissions = union of all permission items |
| P10 | Agent READY status precondition | `backend/src/lambda/__tests__/test_app_status_properties.ts` | READY only if agent exists with `state=active` |
| P11 | Publish precondition validation | `backend/src/lambda/__tests__/test_app_status_properties.ts` | All preconditions checked, structured error on failure |
| P12 | Fabrication registration idempotence | `backend/src/lambda/__tests__/test_app_registration_properties.ts` | N events produce exactly one component item |
| P13 | JSON Schema validation correctness | `backend/src/lambda/__tests__/test_app_config_properties.ts` | Valid draft-07 schemas accepted, invalid rejected |
| P14 | Config values validation against schema | `backend/src/lambda/__tests__/test_app_config_properties.ts` | Conforming values accepted, non-conforming rejected with errors |
| P15 | App config injection into subprocess | `arbiter/workerWrapper/__tests__/test_app_config_properties.py` | `APP_CONFIG` env var contains serialized JSON |
| P16 | Status transition event construction | `backend/src/lambda/__tests__/test_app_events_properties.ts` | Correct detail type, all required fields present |
| P17 | Archive resets agent binding statuses | `backend/src/lambda/__tests__/test_app_status_properties.ts` | All bindings set to `DESIGN` after ACTIVE→ARCHIVED |
| P18 | App search filter | `frontend/src/utils/__tests__/test_app_filter_properties.ts` | Case-insensitive substring match on name/description |
| P19 | App status filter | `frontend/src/utils/__tests__/test_app_filter_properties.ts` | Correct filtering by status, "All" returns everything |
| P20 | Wizard name validation | `frontend/src/components/__tests__/test_wizard_validation_properties.ts` | Accept 3–100 chars, reject outside range |
| P21 | Wizard step navigation validation | `frontend/src/components/__tests__/test_wizard_validation_properties.ts` | Next disabled when required fields missing |
| P22 | App-scoped agent filtering | `arbiter/supervisor/__tests__/test_app_scoped_resolution_properties.py` | Only READY bindings with active agents returned |
| P23 | Backward-compatible agent loading | `arbiter/supervisor/__tests__/test_app_scoped_resolution_properties.py` | No appId → same behavior as before |
| P24 | Step constraints tool filtering | `arbiter/workerWrapper/__tests__/test_governance_properties.py` | Available tools = intersection of agent tools and allowedTools |
| P25 | Max iterations enforcement | `arbiter/workerWrapper/__tests__/test_governance_properties.py` | Subprocess terminated after maxIterations turns |
| P26 | No constraints backward compatibility | `arbiter/workerWrapper/__tests__/test_governance_properties.py` | No stepConstraints → all tools, default iteration limit |
| P27 | Keyword overlap scoring | `arbiter/supervisor/__tests__/test_intent_matcher_properties.py` | Score = matching tokens / total keywords |
| P28 | Intent matcher selects highest score | `arbiter/supervisor/__tests__/test_intent_matcher_properties.py` | Highest score ≥ threshold selected, None if below |
| P29 | Explicit routing selects by workflowId | `arbiter/supervisor/__tests__/test_intent_matcher_properties.py` | Direct match by workflowId field |
| P30 | Single-workflow app routing | `arbiter/supervisor/__tests__/test_intent_matcher_properties.py` | Always routes to the single workflow |
| P31 | Tokenizer normalization | `arbiter/supervisor/__tests__/test_intent_matcher_properties.py` | Lowercase, split, stop words removed |
| P32 | Agent manifest validation | `backend/src/lambda/__tests__/test_agent_manifest_properties.ts` | Required fields validated, missing fields rejected |

### Additional Test Coverage

| Area | Test Focus | File |
|------|-----------|------|
| App Resolver | EventBridge event emission, status transition examples | `backend/src/lambda/__tests__/app-resolver.test.ts` |
| Registration Handler | Skip when no appId, event payload structure | `backend/src/lambda/__tests__/app-component-registration-handler.test.ts` |
| Publish preconditions | PolicyManager failure reverts to DRAFT, missing config values | `backend/src/lambda/__tests__/app-resolver-publish-preconditions.test.ts` |
| Agent binding | Update non-existent binding error, unrecognized tool restriction | `backend/src/lambda/__tests__/app-resolver-updateagentbinding.test.ts` |
| Status flags | Inactive agent can't be READY, DESIGN agents block publish | `backend/src/lambda/__tests__/app-resolver-status-events.test.ts` |
| Config | Invalid schema rejection, missing values on publish | `backend/src/lambda/__tests__/app-resolver-setappconfigvalues.test.ts` |
| Permission validation | IAM action format, bare wildcard rejection | `backend/src/lambda/__tests__/app-resolver-permission-validation.test.ts` |
| Archive transition | Role cleanup, binding status reset | `backend/src/lambda/__tests__/app-resolver-archive-transition.test.ts` |
| Add component | Upsert behavior, org check, event emission | `backend/src/lambda/__tests__/app-resolver-addcomponent.test.ts` |
| Intent matcher | No match below threshold | `arbiter/supervisor/__tests__/test_intent_matcher_properties.py` |
| Governance | Tool block logging, no constraints fallback | `arbiter/workerWrapper/__tests__/test_governance_properties.py` |
| Supervisor app ID | App-scoped resolution, backward compat | `arbiter/supervisor/__tests__/test_supervisor_app_id.py` |
| Load app-scoped agents | READY filtering, override application | `arbiter/supervisor/__tests__/test_load_app_scoped_agents.py` |
| Fabricator app ID | appId pass-through in fabrication | `arbiter/fabricator/__tests__/test_fabricator_app_id_properties.py` |
| Fabricator manifest | Auto-generated manifest structure | `arbiter/fabricator/__tests__/test_fabricator_manifest_properties.py` |
| Agent config manifest | Manifest publishing and validation | `backend/src/lambda/__tests__/agent-config-resolver-manifest.test.ts` |
| Frontend — Apps page | Empty state, error state, navigation | `frontend/src/pages/__tests__/AgentApps.test.tsx` |
| Frontend — Wizard | Step navigation, creation sequence, error retry | `frontend/src/pages/__tests__/AppBuilderWizard.test.tsx` |
| Frontend — Detail View | Tab rendering, status actions, subscription | `frontend/src/pages/__tests__/AppDetailView.test.tsx` |

### Running Tests

```bash
# Backend property tests (app platform)
cd backend && npx jest --testPathPattern="test_app_|test_agent_manifest" --no-coverage

# Backend unit tests (app resolver)
cd backend && npx jest --testPathPattern="app-resolver" --no-coverage

# Python — Intent matcher + governance + app-scoped resolution
pytest arbiter/supervisor/__tests__/ -v
pytest arbiter/workerWrapper/__tests__/ -v

# Python — Fabricator app ID + manifest
pytest arbiter/fabricator/__tests__/ -v

# Python — All arbiter tests with reproducible seeds
pytest -v --hypothesis-seed=0

# Frontend tests
cd frontend && npm test

# All backend tests
cd backend && npm test
```

### Test Organization

```
backend/src/lambda/__tests__/
├── test_app_component_properties.ts           # Properties P1–P5
├── test_app_resolver_properties.ts            # Property P6
├── test_app_permissions_properties.ts         # Properties P8, P9
├── test_app_status_properties.ts              # Properties P10, P11, P17
├── test_app_registration_properties.ts        # Property P12
├── test_app_config_properties.ts              # Properties P13, P14
├── test_app_events_properties.ts              # Property P16
├── test_agent_manifest_properties.ts          # Property P32
├── app-resolver.test.ts                       # Unit tests — CRUD, events
├── app-resolver-publish-preconditions.test.ts # Unit tests — publish flow
├── app-resolver-updateagentbinding.test.ts    # Unit tests — binding updates
├── app-resolver-status-events.test.ts         # Unit tests — status flags
├── app-resolver-setappconfigvalues.test.ts    # Unit tests — config values
├── app-resolver-permission-validation.test.ts # Unit tests — permission validation
├── app-resolver-archive-transition.test.ts    # Unit tests — archive flow
├── app-resolver-addcomponent.test.ts          # Unit tests — add component
├── app-component-registration-handler.test.ts # Unit tests — fabrication registration
└── agent-config-resolver-manifest.test.ts     # Unit tests — manifest publishing

arbiter/supervisor/__tests__/
├── test_intent_matcher_properties.py          # Properties P27–P31
├── test_agent_binding_properties.py           # Property P7
├── test_app_scoped_resolution_properties.py   # Properties P22, P23
├── test_supervisor_app_id.py                  # Unit tests — app ID handling
└── test_load_app_scoped_agents.py             # Unit tests — agent loading

arbiter/workerWrapper/__tests__/
├── test_governance_properties.py              # Properties P24–P26
└── test_app_config_properties.py              # Property P15

arbiter/fabricator/__tests__/
├── test_fabricator_app_id_properties.py       # Fabricator app ID pass-through
└── test_fabricator_manifest_properties.py     # Manifest auto-generation

frontend/src/
├── utils/__tests__/
│   └── test_app_filter_properties.ts          # Properties P18, P19
├── components/__tests__/
│   └── test_wizard_validation_properties.ts   # Properties P20, P21
└── pages/__tests__/
    ├── AgentApps.test.tsx                     # Unit tests — list page
    ├── AppBuilderWizard.test.tsx              # Unit tests — wizard
    └── AppDetailView.test.tsx                 # Unit tests — detail view
```

## Architectural Decisions

| Decision | Rationale |
|----------|-----------|
| Component table pattern (single table with GroupIndex) | Storing app metadata and components in the same table under a shared `groupId` partition enables a single `Query` to retrieve an app with all its components. Avoids cross-table joins and reduces DynamoDB round-trips. The existing `appId` PK and `OrgIndex` GSI remain unchanged for backward compatibility. |
| Composite appId for component items | Component items use `groupId = APP#{appId}` and `sortId = {TYPE}#{id}` to colocate all app resources under one partition key. This enables efficient range queries (e.g., all `AGENT#` bindings) and atomic batch operations within a single partition. |
| Pre-filtering tools via toolRestrictions vs runtime blocking | Agent binding `toolRestrictions` are applied at the Worker Wrapper level before agent execution, not at runtime when the agent attempts to use a tool. This prevents the agent from even seeing restricted tools, reducing wasted LLM turns and providing a cleaner execution context. |
| Separate Registration Handler Lambda | Fabrication events are async (EventBridge), so registration must be handled by a dedicated Lambda rather than inline in the App Resolver. This decouples the fabrication pipeline from the app management pipeline and follows the event-driven coordination pattern. |
| PolicyManager scoped IAM roles per app | Each app gets a dedicated `citadel-agent-{appId}` IAM role with the union of its declared permissions. This follows the existing `citadel-ds-{id}` and `citadel-int-{id}` patterns, providing least-privilege access at the app boundary. |
| Intent matcher as pure functions | `tokenize`, `compute_relevance_score`, and `match_intent` are stateless pure functions with no side effects, enabling thorough property-based testing with Hypothesis. Keyword overlap scoring is deterministic and testable, unlike embedding-based similarity. |
| Keyword overlap scoring vs semantic similarity | Keyword overlap provides deterministic, reproducible matching that can be formally verified via property-based tests. Semantic similarity (embeddings) would introduce non-determinism and external API dependencies. The keyword approach is sufficient for the current routing needs and can be extended later. |
| Config schema validation via ajv | The `ajv` library provides standards-compliant JSON Schema (draft-07) validation with detailed error messages per failing property. This is the same validation approach used across the Node.js ecosystem and integrates naturally with the TypeScript resolver. |
| Status lifecycle with precondition checks | The DRAFT → ACTIVE transition requires explicit precondition validation (READY agents, valid config, IAM role creation) rather than allowing partial publishes. This ensures apps are fully configured before going live, preventing runtime failures from missing components. |
| Archive resets all bindings to DESIGN | When an app is archived, all agent bindings revert to `DESIGN` status. This ensures that reactivating an app (ARCHIVED → DRAFT) requires re-validation of all components, preventing stale READY statuses from persisting across lifecycle transitions. |
| Backward-compatible Supervisor | When no `appId` is present in the task request, the Supervisor falls back to `load_config_from_dynamodb()` — the existing behavior of loading all active agents. This ensures zero disruption to existing workflows that don't use the app platform. |

## Best Practice Alignment

### AWS Well-Architected Framework

| Pillar | Implementation |
|--------|---------------|
| Security | Org-scoped access control on all mutations, least-privilege IAM roles per app (`citadel-agent-{appId}`), scoped STS credentials via PolicyManager, IAM action validation (no bare wildcards), `@aws_iam` auth on subscription triggers, input validation at resolver layer (defense in depth) |
| Reliability | Idempotent component operations (upsert, idempotent removal, idempotent registration), optimistic locking for concurrent modifications, PolicyManager failure reverts status to DRAFT, EventBridge built-in retry for async operations, backward-compatible Supervisor fallback |
| Operational Excellence | Structured JSON logging with `appId`/`orgId`/`action` fields, X-Ray tracing on all Lambdas, correlation IDs across EventBridge events, governance enforcement logging, CloudWatch Logs Insights queries for app lifecycle debugging |
| Performance Efficiency | GroupIndex GSI enables single-query app+component retrieval, PAY_PER_REQUEST DynamoDB billing, app-scoped agent resolution avoids full table scan, static keyword matching (no external API calls for intent routing) |
| Cost Optimization | On-demand DynamoDB, right-sized Lambda memory, scoped IAM roles cleaned up on archive, event-driven registration (no polling), single-table design reduces DynamoDB costs |

### SOLID Principles

| Principle | Implementation |
|-----------|---------------|
| Single Responsibility | App Resolver handles app CRUD and component management, Registration Handler handles fabrication events, Intent Matcher handles routing logic, PolicyManager handles IAM roles — each module has one job |
| Open/Closed | New component types can be added by extending the `sortId` prefix pattern without modifying existing component handling; new routing strategies can be added alongside `explicit` and `intent` without changing the Supervisor's core logic |
| Interface Segregation | Intent Matcher exposes only `tokenize`, `compute_relevance_score`, `match_intent` — consumers don't depend on internal implementation; Worker Wrapper governance depends only on `stepConstraints` interface, not on workflow internals |
| Dependency Inversion | Supervisor depends on abstract DynamoDB query interface for app-scoped resolution, not on concrete table structure; Worker Wrapper depends on abstract `stepConstraints` interface, not on Step Runner internals |

## Adding a New App Component Type

To add a new component type to the app platform (e.g., "webhook", "schedule"):

### 1. Define the sortId Pattern

Choose a type prefix for the new component's `sortId`:

```
WEBHOOK#{webhookId}
SCHEDULE#{scheduleId}
```

### 2. Extend the App Resolver

In `backend/src/lambda/app-resolver.ts`, extend the `addAppComponent` handler to accept the new type:

```typescript
case 'addAppComponent': {
  const { type, data } = args.component;
  const payload = JSON.parse(data);

  let sortId: string;
  switch (type) {
    case 'agent':
      sortId = `AGENT#${payload.agentId}`;
      break;
    case 'permission':
      sortId = `PERMISSION#${payload.permissionId}`;
      break;
    case 'webhook':  // NEW
      sortId = `WEBHOOK#${payload.webhookId}`;
      break;
    default:
      throw new Error(`Unknown component type: ${type}`);
  }
  // ... PutCommand with groupId, sortId ...
}
```

### 3. Extend the GraphQL Schema

Add the new component type to the `AgentApp` type and define any new input/output types in `backend/src/schema/schema.graphql`.

### 4. Extend the getAppWithComponents Helper

In the App Resolver, add filtering for the new `sortId` prefix in the `getAppWithComponents` function:

```typescript
const webhooks = items.filter(i => i.sortId?.startsWith('WEBHOOK#'));
```

### 5. Add Publish Preconditions (if applicable)

If the new component type has validation requirements for the DRAFT → ACTIVE transition, add them to the publish precondition checks.

### 6. Write Property-Based Tests

Add fast-check properties in `backend/src/lambda/__tests__/` covering:
- `sortId` derivation follows the `{TYPE}#{id}` pattern
- GroupIndex query returns the new component type
- Upsert and removal idempotence

### 7. Update the Frontend

Add a new tab to the App Detail View in `frontend/src/pages/AppDetailView.tsx` and extend the App Builder Wizard with a step for the new component type.

### 8. Update the App Builder Wizard

Add a new step to `frontend/src/pages/AppBuilderWizard.tsx` for configuring the new component type, following the existing step pattern (form validation, back/next navigation, state preservation on error).