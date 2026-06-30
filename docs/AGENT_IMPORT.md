# Agent Import

Citadel fabricates agents it owns. Agent Import is the **shipped** capability that lets Citadel absorb foreign agents that already run on heterogeneous AWS substrates (AgentCore Runtime, Bedrock Agents, Lambda, HTTP/MCP endpoints, and ECS/EKS/EC2 container/VM substrates that are discovered then resolved to an HTTP endpoint) without owning or redeploying their infrastructure. Import discovers a candidate agent, determines its capabilities through a four-tier fallback, normalizes it into the existing AgentCore Registry record model, wires a protocol-aware invocation path, and routes the whole thing through the governance engine.

**Status — as-built.** Phase 1 (self-describing substrates, same-account, Tiers 0–1), Phase 2 (ECS/EKS/EC2 discovery substrates, cross-account discovery/analysis/invoke, Tiers 2–3), and the follow-ons (governance attestation + a mode-aware activation gate, pre-activation test-invoke, backend reachability probe, Tier-3 LLM-proposed manifest via the Python Fabricator, and an optional MCP gateway publish) are all merged on `feat/agent-import`. This document is reconciled to the shipped code: every mutation, query, field, event, and adapter named below exists in the codebase. The labels in this document now mean: **"Today"** = pre-existing platform facts Import builds on; **"As-built"** = shipped Agent Import behaviour; **"Deferred"** = genuinely future work (REST/OpenAPI gateway publish, the peered-VPC reachability prober, OAUTH2/SIGV4/COGNITO gateway auth offload, and the `A2A` / `STEP_FUNCTIONS` / `SAGEMAKER_ENDPOINT` / `SQS_ASYNC` protocols, which exist in the invocation type union but have no invoke adapter wired yet). The original design used the word "Proposed"; where that survives below it now describes **as-built** behaviour unless explicitly marked Deferred.

## Table of Contents

- [Agent Import](#agent-import)
  - [Table of Contents](#table-of-contents)
  - [Overview](#overview)
    - [Problem](#problem)
    - [Solution](#solution)
    - [Scope](#scope)
    - [Non-Goals](#non-goals)
  - [Background: How Citadel Represents and Invokes Agents Today](#background-how-citadel-represents-and-invokes-agents-today)
  - [Design Tenets](#design-tenets)
  - [Design Pattern: Agent Source Adapter](#design-pattern-agent-source-adapter)
  - [Architecture](#architecture)
  - [The Import Pipeline](#the-import-pipeline)
    - [Stage 1: Discovery](#stage-1-discovery)
    - [Stage 2: Capability Determination](#stage-2-capability-determination)
    - [Stage 3: Interfacing](#stage-3-interfacing)
    - [Stage 4: Registration](#stage-4-registration)
  - [GraphQL Surface (Resolvers)](#graphql-surface-resolvers)
  - [Data Model](#data-model)
  - [Invocation Dispatch](#invocation-dispatch)
  - [Security and Governance](#security-and-governance)
  - [Substrate Deep-Dives](#substrate-deep-dives)
    - [AgentCore Runtime](#agentcore-runtime)
    - [Bedrock Agents (classic)](#bedrock-agents-classic)
    - [Lambda and variants](#lambda-and-variants)
    - [ECS](#ecs)
    - [EKS](#eks)
    - [EC2](#ec2)
    - [Other substrates](#other-substrates)
  - [End-to-End Walkthroughs](#end-to-end-walkthroughs)
    - [Walkthrough 1: Import a Lambda agent (paste ARN, same account)](#walkthrough-1-import-a-lambda-agent-paste-arn-same-account)
    - [Walkthrough 2: Import a Bedrock Agent (alias)](#walkthrough-2-import-a-bedrock-agent-alias)
    - [Walkthrough 3: Account-wide sweep](#walkthrough-3-account-wide-sweep)
  - [Failure Modes and Edge Cases](#failure-modes-and-edge-cases)
  - [User Experience: The Import Wizard](#user-experience-the-import-wizard)
  - [Eventing](#eventing)
  - [Phased Delivery and Roadmap](#phased-delivery-and-roadmap)
  - [Resolved Decisions](#resolved-decisions)
  - [References](#references)

## Overview

### Problem

Before Agent Import, Citadel only created agents it owns. The Fabricator generates an agent, registers it, and points invocation at infrastructure Citadel controls — an AgentCore Runtime ARN or the SQS worker queue. Enterprises already operate agents elsewhere: a Bedrock Agent in another account, a Lambda behind a Function URL, a containerized service on ECS, an MCP server, a partner A2A endpoint. Citadel could not orchestrate any of them. Agent Import closes that gap: the Import Agent flow is now a shipped 5-step React wizard (`frontend/src/components/ImportAgentWizard.tsx`) backed by the `agent-import-resolver` AppSync surface.

### Solution

One line: introduce an Agent Source Adapter abstraction (mirroring the proven `ConnectorAdapter`) that discovers, describes, health-checks, credential-vends, and invokes foreign agents, and generalize the invocation pointer from a single AgentCore ARN to a protocol-discriminated `invocation` block so the existing `agent-message-handler` becomes a protocol dispatcher.

### Scope

In scope (as-built):

- Discover candidate agents by account-wide tag scan, by pasted ARN/endpoint reference, or by uploaded manifest — same-account or **cross-account** via an operator-supplied read-only discovery role + STS external id.
- Determine capabilities through a four-tier fallback (Tier‑0 manifest, Tier‑1 heuristic, Tier‑2 live probe, Tier‑3 LLM-proposed manifest) that always ends in human review.
- Normalize foreign agents into the existing AgentCore Registry record model (a CUSTOM descriptor carrying `invocation` + `origin` blocks).
- Invoke imported agents through a single protocol dispatcher. Five protocols have invoke adapters today (`AGENTCORE_RUNTIME`, `BEDROCK_AGENT`, `LAMBDA_INVOKE`, `HTTP_ENDPOINT`, `MCP`); the dispatcher is gated by the `IMPORT_ENABLED` flag (see [Invocation Dispatch](#invocation-dispatch)).
- Route every import through governance: a system-generated ADR on import, an authority-unit grant, an explicit `attestAgentImport` step, a mode-aware activation gate, and lazy IAM trust-path attestation (cross-account via the analysis role).

### Non-Goals

- Citadel never owns imported infrastructure. It does not deploy, redeploy, scale, or delete a customer's Lambda, cluster, or agent. The strongest lifecycle action Import can take is to deprecate the catalog record.
- Import does not re-fabricate a foreign agent's tools. Imported agents reference existing Citadel tools/integrations or carry their own (described in their manifest).
- Import is not a migration tool. It does not copy agent code into Citadel.
- This document does not change the Fabricator's own create path.

## Background: How Citadel Represents and Invokes Agents Today

Citadel's agent storage is already substrate-neutral. An agent is a record in the AWS Bedrock AgentCore Registry, stored as a CUSTOM descriptor and wrapped by `RegistryService` (`backend/src/services/registry-service.ts`). An agent is distinguished from a tool purely by the presence of a `manifest` object inside `customDescriptorContent`. This neutrality is the foundation Import builds on: a foreign agent becomes just another descriptor record.

Today the descriptor JSON has this shape:

```json
{
  "categories": ["assessment"],
  "icon": "robot",
  "state": "active",
  "manifest": { "name": "...", "description": "...", "version": "1.0.0", "tools": [] },
  "config": { "name": "...", "filename": "...", "schema": {}, "version": "1.0.0", "action": {} },
  "createdBy": "user-id",
  "orgId": "org-id",
  "appId": "optional",
  "sourceProjectId": "optional"
}
```

`RegistryService` wraps `BedrockAgentCoreControlClient`: `CreateRegistryRecord`, `GetRegistryRecord`, `UpdateRegistryRecord`, `UpdateRegistryRecordStatus`, `DeleteRegistryRecord`, `ListRegistryRecords`, `SubmitRegistryRecordForApproval`. Record status maps to internal state via `toInternalState`/`toRegistryStatus`: `APPROVED` = active, `DEPRECATED` = inactive, `DRAFT` = maintenance.

The manifest today is minimal: `{ name, description, version, tools[] }`. `validateManifest()` (`backend/src/lambda/agent-config-resolver.ts`) requires non-empty `name`, `description`, and `version`. A richer `AgentAppManifest` interface already exists in `backend/src/lambda/registry-agent-record-resolver.ts` (`orgId`, `version`, `status`, `workflowIds`, `agentBindings`, `permissions`, `configSchema`, `configValues`, `authConfig`, `access`, `routingConfig`, `sourceProjectId`).

Invocation is already indirected, but only two paths are wired. `agent-message-handler` (`backend/src/lambda/agent-message-handler.ts`) is triggered by the EventBridge `message.sent_to_agent` event. It resolves an agent by reading SSM parameter `/citadel/agents/{agentId}-{env}` into `{ agentRuntimeArn, region }`, then calls `InvokeAgentRuntimeCommand` (`@aws-sdk/client-bedrock-agentcore`). It stores the response in the Conversations table and fans out via AppSync subscription. The handler already imports `SignatureV4` (`@aws-sdk/signature-v4`) for signed HTTP. Fabricator-built workers take the other path: their `config.action = { type: 'sqs', target: WORKER_QUEUE_URL }`.

The Fabricator registration path (`arbiter/fabricator/index.py`, `store_agent_config_registry()`) builds `config = { name, filename, schema, version, description, action: { type: 'sqs', target: WORKER_QUEUE_URL } }` and `manifest = { name, description, version, tools: [] }`, writes a CUSTOM Registry record (idempotent by name via `_find_existing_record_id`), mirrors a `#META` row to `AppsTable`, and publishes EventBridge events. Records are left in DRAFT (inactive) pending activation.

```
TODAY — Record creation and invocation (owned agents only)
┌──────────────────────────────────────────────────────────────────────────────┐
│ CREATE / REGISTER                                                            │
│                                                                              │
│  AgentCatalog.tsx ──listAgentConfigs()──▶ AppSync ──▶ agent-config-resolver  │
│  Fabricator (index.py) ─store_agent_config_registry()─┐                      │
│                                                       ▼                      │
│                                              RegistryService                 │
│                                       (BedrockAgentCoreControlClient)        │
│                                                       │ CreateRegistryRecord │
│                                                       ▼                      │
│                                    ┌──────────────────────────────────────┐  │
│                                    │  AgentCore Registry — CUSTOM record  │  │
│                                    │  customDescriptorContent:            │  │
│                                    │    { manifest{}, config{action} }    │  │
│                                    │  status: DRAFT → APPROVED            │  │
│                                    └──────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────────┘
┌──────────────────────────────────────────────────────────────────────────────┐
│ INVOKE                                                                       │
│                                                                              │
│  EventBridge: message.sent_to_agent                                          │
│        │                                                                     │
│        ▼                                                                     │
│  agent-message-handler.ts                                                    │
│        │ read SSM /citadel/agents/{agentId}-{env}                            │
│        ▼                                                                     │
│  { agentRuntimeArn, region }                                                 │
│        │ InvokeAgentRuntimeCommand                                           │
│        ▼                                                                     │
│  AgentCore Runtime ──response──▶ Conversations table ──▶ AppSync subscription│
└──────────────────────────────────────────────────────────────────────────────┘
```

The takeaway: the storage model is already generic, and invocation is already event-driven and indirected. Import does not rebuild these; it generalizes the two narrow assumptions baked into them — that an agent's runtime is an AgentCore ARN, and that Citadel owns it.

## Design Tenets

- Orchestrate, never own. Citadel coordinates imported agents but does not control their infrastructure. It may deprecate a catalog record. It never deletes, redeploys, or scales a customer's Lambda, cluster, or agent. `origin.ownership = 'external'` makes this a hard invariant the lifecycle layer enforces.
- Least privilege by default. Discovery runs under a read-only describe/list role. Invocation runs under a per-agent role scoped to exactly one target ARN, vended by PolicyManager. Cross-account access uses `AssumeRole` plus an external ID. Secrets live in Secrets Manager, never in the record.
- Human-in-the-loop before activation. Capability inference is fallible. Every imported descriptor field carries a confidence score. Activation always requires a human review gate plus a passing sandbox test. Citadel never silently trusts a foreign contract.
- Treat foreign output as untrusted. An imported agent's response is an external input. It crosses a prompt-injection boundary and is sanitized before it re-enters orchestration.
- Graceful degradation. Discovery, capability determination, and invocation degrade independently. A self-describing agent imports in seconds; an opaque EC2 agent falls back through tiers to LLM-assisted inference and still lands in human review rather than failing outright.
- Reuse proven patterns. Import mirrors `ConnectorAdapter`, reuses `RegistryService`, PolicyManager scoped roles, scoped STS credential vending, the governance engine, the health monitor, and `ToolTestingSandbox`. It introduces one new abstraction (the Agent Source Adapter) and one generalization (the invocation block).
- Idempotent everywhere. Discovery, registration, and eventing are safe to retry. Registration dedupes by `origin.sourceArn` then name, reusing the same idempotency guard the Fabricator's `_find_existing_record_id` implements.

## Design Pattern: Agent Source Adapter

Import introduces one new abstraction (as-built): the Agent Source Adapter. It mirrors the `ConnectorAdapter` family (`backend/src/adapters/base.ts`) that already sits behind 27 datastore and 13 integration adapters, each with a scoped IAM role and a config-driven `DynamicConnectorForm`. One Agent Source Adapter implements the pattern per substrate.

```
DIAGRAM 2 — Agent Source Adapter pattern (as-built)

                         ┌──────────────────────────────────┐
                         │   interface AgentSourceAdapter   │
                         │                                  │
                         │   discover()                     │
                         │   describe(ref)                  │
                         │   healthCheck(ref)               │
                         │   vendCredentials()              │
                         │   invoke(req)                    │
                         └─────────────────┬────────────────┘
                                           │ implemented by
        ┌──────────────┬──────────────┬────┴─────┬──────────────┬───────────────┐
        ▼              ▼              ▼          ▼              ▼               ▼
┌──────────────┐┌─────────────┐┌────────────┐┌──────────┐┌──────────────┐┌──────────────┐
│ AgentCore    ││ BedrockAgent││  Lambda    ││ Http/Mcp ││ Ecs/Eks/Ec2  ││ StepFunctions│
│ Runtime      ││  Adapter    ││  Adapter   ││ Adapter  ││  Adapter(s)  ││ /SageMaker   │
│ Adapter      ││             ││            ││          ││              ││  Adapter     │
└──────────────┘└─────────────┘└────────────┘└──────────┘└──────────────┘└──────────────┘
```

Each adapter carries five responsibilities:

| Method | Responsibility | Analogous `ConnectorAdapter` method |
|--------|----------------|-------------------------------------|
| `discover()` | Enumerate candidate agents in an account/region/scope | (new — no datastore analogue) |
| `describe(ref)` | Produce a normalized Agent Capability Descriptor | `spec` + `validate` |
| `healthCheck(ref)` | Confirm reachability and liveness | `testConnection` |
| `vendCredentials()` | Obtain scoped, short-lived creds via PolicyManager | `requiredPolicies` |
| `invoke(req)` | Normalized request to normalized response | `connect` / runtime call |

The as-built interface (`backend/src/adapters/agent-source/base.ts` + `types.ts`):

```typescript
// As-built — backend/src/adapters/agent-source/base.ts + types.ts
export type Confidence = 'high' | 'medium' | 'low'; // self-described=high, probe=medium, LLM=low

export interface AgentCandidate {       // discovered-but-not-yet-described agent
  origin: AgentOrigin;                  // provenance (substrate, sourceArn?, ownership:'external', …)
  displayName: string;
  reference: string;                    // opaque handle describe()/invoke() resolves (ARN | endpoint | id)
}

export type AgentRef = AgentCandidate | string;

export interface AgentSourceAdapter {
  readonly protocol: AgentInvocationProtocol;          // the adapter's key in the registry

  discover(scope: unknown): Promise<AgentCandidate[]>;          // enumerate candidates
  describe(ref: AgentRef): Promise<AgentCapabilityDescriptor>;  // normalize one candidate
  healthCheck(ref: AgentRef): Promise<HealthCheckResult>;       // reachability without invoking
  vendCredentials(invocation: AgentInvocationBlock): Promise<VendedCredentials>; // scoped creds
  invoke(
    req: InvokeRequest,
    descriptor: AgentCapabilityDescriptor,
  ): Promise<InvokeResponse>;            // normalized request -> normalized response
}

// The SINGLE protocol -> adapter dispatch point. resolve() throws
// UnknownProtocolError for a protocol with no registered adapter.
export class AgentSourceAdapterRegistry {
  register(adapter: AgentSourceAdapter): void;
  resolve(protocol: AgentInvocationProtocol): AgentSourceAdapter;
  has(protocol: AgentInvocationProtocol): boolean;
}
```

Two as-built corrections to the original design: the adapter keys on the **`protocol`** discriminator (`AgentInvocationProtocol`, the single source of truth in `registry-service.ts`), not a `substrate` enum; and inferred-field confidence is the three-value `Confidence` union (`'high' | 'medium' | 'low'`), surfaced on the descriptor as `fieldConfidence?: Record<string, Confidence>` — not a `0..1` float. `buildDefaultAgentSourceRegistry()` (`registry-factory.ts`) registers the five dispatchable protocol adapters; `discover`/`describe`/`healthCheck`/`vendCredentials` are implemented per the import stories (the invocation-dispatcher increment shipped `invoke()` first, with `NotImplementedError` as the placeholder for the rest on adapters that have not yet filled them in).

How it mirrors `ConnectorAdapter`: the connector pattern exposes `category`, `spec`, `requiredPolicies`, `testConnection`, `connect`, `disconnect`, and optional `provision`/`deprovision`/`getMetrics`/`validate`. The Agent Source Adapter keeps the same shape — a typed discriminator (`protocol` vs `category`), a capability/spec description, a policy declaration, a reachability test, and a runtime call — and adds `discover()` because foreign agents must be found before they can be described. `vendCredentials()` plays the role `requiredPolicies()` plays for connectors: it is the single choke point where short-lived, least-privilege credentials are obtained (via PolicyManager scoped-role assume for a cross-account invoke). ECS/EKS/EC2 are **discovery substrates**: their candidates invoke over `HTTP_ENDPOINT`, but discover/describe are substrate-specific (resolving the service's HTTP endpoint), so they ship as dedicated `Ecs/Eks/Ec2SourceAdapter`s dispatched by `getDiscoveryAdapterForSubstrate()` (`agent-discovery.ts`) rather than through the protocol-keyed registry.

## Architecture

```
DIAGRAM 1 — Where Import sits (Import components marked *; all shipped)

┌─────────────────────────────────────────────────────────────────────────────┐
│  Frontend — Import Wizard in AgentCatalog.tsx *                             │
└─────────────────────────────────┬───────────────────────────────────────────┘
                                  │ GraphQL mutation
┌─────────────────────────────────▼───────────────────────────────────────────┐
│  AppSync ──▶ agent-import-resolver *  (orchestrates the import pipeline)    │
└─────────────────────────────────┬───────────────────────────────────────────┘
                                  │ dispatch by substrate
┌─────────────────────────────────▼───────────────────────────────────────────┐
│  AgentSourceAdapter registry *                                              │
│     ┌──────────────┐  ┌──────────────┐  ┌──────────────┐                    │
│     │  Discovery   │  │  Capability  │  │  Invocation  │                    │
│     └──────────────┘  └──────────────┘  └──────────────┘                    │
└──────┬──────────────────┬────────────────────┬──────────────────┬───────────┘
       │ write record     │ store creds        │ scoped roles     │ governance
       ▼                  ▼                    ▼                  ▼
┌──────────────┐ ┌───────────────────┐ ┌──────────────┐ ┌──────────────────────┐
│ AgentCore    │ │ SSM Parameter +   │ │ PolicyManager│ │ Governance engine    │
│ Registry     │ │ Secrets Manager   │ │ (scoped      │ │ (ADR, authority unit,│
│ (Registry    │ │ (invocation       │ │  invoke role)│ │  interrogation,      │
│  Service)    │ │  creds, secretRef)│ │              │ │  trust-path/drift)   │
└──────────────┘ └───────────────────┘ └──────────────┘ └──────────────────────┘
       ▲
       │ read-only describe/list (AssumeRole + external ID)
┌──────┴─────────────────────────────────────────────────────────────────────┐
│  Target AWS account(s) — foreign agents on heterogeneous substrates        │
└────────────────────────────────────────────────────────────────────────────┘
```

Component responsibilities:

| Component | Status | Responsibility |
|-----------|--------|----------------|
| Import Wizard (`ImportAgentWizard.tsx`) | As-built | 5-step UI: source, candidates, descriptor review, invocation+test, governance+register (+ Tier-3 panel) |
| `agent-import-resolver` | As-built | AppSync resolver driving discovery, import, attest, test, probe, Tier-3, reachability, and gateway publish |
| AgentSourceAdapter registry | As-built | Routes `discover/describe/healthCheck/vendCredentials/invoke` to the protocol/substrate adapter |
| `RegistryService` | Today | Persists the CUSTOM descriptor record; reused for the import sub-blocks |
| `agent-message-handler` | As-built (generalized) | Protocol dispatcher keyed on `invocation.protocol`, `IMPORT_ENABLED`-gated, with the unchanged legacy AgentCore fallback |
| PolicyManager | Today | Vends the cross-account scoped invoke role (`vendImportCredentials`) |
| Secrets Manager / SSM | Today | Stores invocation secrets (`secretRef`) and runtime pointers |
| Governance engine | Today (extended) | System import ADR, authority unit, attestation, mode-aware activation gate, IAM trust-path |
| Reachability probe (import Lambda) | As-built | `probeImportReachability` — public-only classification; VPC-attached prober is Deferred |
| Test-invoke (`testImportedAgent`) | As-built | Pre-activation dry-run through the real adapters; sanitized; persists nothing |
| Health monitor — drift/auto-deprecation of imports | Deferred | Drift detection + auto-deprecation of imported records is future work |

## The Import Pipeline

Import is a four-stage pipeline with a mandatory human review gate between capability determination and activation.

```
DIAGRAM 3 — Import pipeline (as-built)

 ┌───────────┐    ┌────────────────────────┐    ┌────────────────────┐
 │ Discover  │───▶│ Determine Capability   │───▶│  HUMAN REVIEW GATE │
 │ (Stage 1) │    │ Tier 0 ─▶ 1 ─▶ 2 ─▶ 3  │    │  (always required) │
 └───────────┘    └────────────────────────┘    └──────────┬─────────┘
                                                           │ approve / edit
                                                           ▼
 ┌────────────┐   ┌──────────────────────────┐   ┌───────────────────────┐
 │  Activate  │◀──│ Governance attest        │◀──│ Configure Invocation  │
 │ (APPROVED) │   │ (ADR, authority unit,    │   │ + Test (sandbox)      │
 │            │   │  trust-path/drift)       │   │ Register (DRAFT)      │
 └────────────┘   └──────────────────────────┘   └───────────────────────┘
```

### Stage 1: Discovery

Discovery runs under a read-only describe/list-only STS role. Cross-account discovery uses `AssumeRole` plus an external ID. Discovery offers three modes, in increasing friction:

- Manifest upload (lowest friction). The operator uploads a manifest file. No account access is required.
- Targeted paste. The operator pastes an ARN or endpoint. Discovery describes exactly that one reference.
- Account-wide sweep. Discovery enumerates candidates via `resourcegroupstaggingapi` `GetResources` or AWS Resource Explorer, filtered by a tag convention (for example `citadel:agent=true`), then per-substrate list APIs.

Per-substrate discovery APIs:

| Substrate | Discovery APIs | Notes |
|-----------|----------------|-------|
| AgentCore Runtime | `bedrock-agentcore-control` `ListAgentRuntimes`, `ListAgentRuntimeEndpoints`; Registry `ListRegistryRecords` | May already carry a manifest |
| Bedrock Agents (classic) | `bedrock-agent` `ListAgents`, `ListAgentAliases`, `ListAgentActionGroups`, `ListAgentKnowledgeBases` | Import the ALIAS, not the draft; workflow-like (orchestration + action groups + KBs) |
| Lambda (all variants) | `lambda` `ListFunctions`, `GetFunctionConfiguration`, `ListTags`, `GetPolicy`, `ListFunctionUrlConfigs`, `ListEventSourceMappings` | One API surface for every Lambda flavor |
| ECS | `ecs` `ListClusters`, `ListServices`, `DescribeServices`, `DescribeTaskDefinition`; ELBv2 + Cloud Map/Service Connect for the endpoint | Endpoint resolution is the hard part |
| EKS | `eks` `ListClusters`, `DescribeCluster`, then k8s API (Services/Ingress) via an access entry, or ALB-Ingress/Cloud Map | Highest friction; Phase 2 |
| EC2 | `ec2` `DescribeInstances` by tag; endpoint via ALB or private IP | Reachability is the hard part |
| API Gateway | `apigateway` `GetRestApis` / `apigatewayv2` `GetApis` + `GetExport` for OpenAPI | OpenAPI export yields schemas for free |
| Step Functions | `stepfunctions` `ListStateMachines` | Standard vs Express selects async vs sync |
| SageMaker | `sagemaker` `ListEndpoints` | |
| App Runner | `apprunner` `ListServices` | |
| External MCP | (endpoint paste / existing MCP integration type) | Citadel already has this integration type |
| A2A | (endpoint paste; agent card discovery) | Self-describing via agent card |

As-built note: `resolveSourceRef` (`backend/src/services/agent-discovery.ts`) recognizes exactly the shipped substrates — `bedrock-agentcore` runtime → `AGENTCORE_RUNTIME`; `lambda` function → `LAMBDA_INVOKE`; `bedrock` agent/agent-alias → `BEDROCK_AGENT`; `ecs` service / `eks` cluster / `ec2` instance → `HTTP_ENDPOINT` (discovery substrates); `mcp://` / `mcp+http(s)://` → `MCP`; `http(s)://` → `HTTP_ENDPOINT`. API Gateway, Step Functions, SageMaker, App Runner, and A2A references raise `UnsupportedSourceError` (Deferred) — and tag-scan skips them rather than failing the whole scan.

Discovery emits `agent.import.discovered` on the `citadel.backend` source (see [Eventing](#eventing)).

### Stage 2: Capability Determination

Capability determination produces a normalized Agent Capability Descriptor through a four-tier fallback. Higher tiers are tried first; the pipeline falls to the next tier only when the current one cannot supply a field. Every field carries a confidence score. The stage always ends in a human review gate. Citadel never silently trusts a foreign contract.

| Tier | Name | Sources | Yields |
|------|------|---------|--------|
| 0 | Self-describing (best) | AgentCore Registry manifest; A2A Agent Card at `/.well-known/agent.json`; MCP `initialize` + `tools/list`; Bedrock Agent action-group OpenAPI/function schemas + instructions; API Gateway OpenAPI export | input/output schemas for free |
| 1 | Structural introspection | Lambda env vars, tags, description, resource policy, event-source mappings, Function URL; ECS/EKS task def (image, ports, env) | name, hints, rough I/O |
| 2 | Probe/handshake (sandboxed) | `probeAgentCandidate`: a static `describe()` plus, only when the descriptor has gaps (empty `outputSchema`/`skills` or low/absent confidence), ONE guarded dry-run `invoke`; the sanitized output is merged back conservatively at `confidence:'medium'` (records an `outputSample`; never fabricates a full schema) | observed request/response shapes at medium confidence |
| 3 | LLM-proposed manifest | `proposeAgentManifestTier3` enqueues **secret-free** signals to the Python Fabricator (`propose_agent_manifest`), which proposes a capability descriptor with **no code generation**, forces every `fieldConfidence` to `'low'`, and returns it asynchronously as `agent.import.manifest.proposed`; the result handler parks it on the DRAFT record as `proposedManifest` (`reviewState:'pending_review'`) | a low-confidence proposed contract for opaque agents |

Tier 3 is the bridge for opaque EC2/ECS agents where no contract is published. It proposes; it never decides — `acceptProposedManifestTier3` (admin/architect, human-gated) is the **only** path that promotes a `pending_review` proposal into the trusted manifest, and even acceptance leaves the record DRAFT (activation is still a separate, explicit step). Low-confidence fields surface as badges in the wizard, and the Tier-3 propose/review/accept flow lives in `Tier3ProposalPanel.tsx`.

### Stage 3: Interfacing

Interfacing wires a normalized invocation path. The substrate adapter's `vendCredentials()` obtains a scoped invoke role from PolicyManager, restricted to exactly the one target ARN. `invoke(req)` maps a normalized request to the substrate's protocol and normalizes the response. The protocol dispatch table:

| Protocol | API / mechanism | Auth |
|----------|-----------------|------|
| `AGENTCORE_RUNTIME` | `bedrock-agentcore` `InvokeAgentRuntime` (already wired) | SigV4 |
| `BEDROCK_AGENT` | `bedrock-agent-runtime` `InvokeAgent` / `InvokeFlow` | SigV4 |
| `LAMBDA_INVOKE` | `lambda` `Invoke` (RequestResponse = sync / Event = async) | SigV4 + resource policy |
| `HTTP_ENDPOINT` | signed HTTPS (handler already imports `SignatureV4`) | SigV4 / API key / OAuth2 / Cognito |
| `MCP` | JSON-RPC `tools/call` | bearer / OAuth |
| `A2A` | `tasks/send` | per agent card |
| `STEP_FUNCTIONS` | `StartSyncExecution` (Express) / `StartExecution` (Standard = async) | SigV4 |
| `SAGEMAKER_ENDPOINT` | `sagemaker-runtime` `InvokeEndpoint` | SigV4 |
| `SQS_ASYNC` | enqueue to a target queue (existing worker pattern) | SigV4 |

On Lambda variants: standard, managed, durable/long-running, and Firecracker microVM Lambdas all collapse to "invoke a function ARN" at the API level. The difference is timeout and statefulness, which selects `mode: sync` vs `mode: async_callback`. Durable/long-running agents use `async_callback`, reusing Citadel's existing async pattern — `message.sent_to_agent` to stored response to AppSync subscription.

### Stage 4: Registration

Registration reuses `RegistryService.createResource('agent', ...)`, `validateManifest`, org scoping, and idempotent-by-name behavior. It makes three additions:

- Stamp `origin.ownership = 'external'`. The lifecycle layer reads this and refuses to delete foreign infrastructure.
- Store the `invocation` block in `customDescriptorContent`.
- Start in `state = inactive` (DRAFT) until a sandbox test and governance attestation pass.

Conflict policy (blocker #2): dedupe on `origin.sourceArn` first, then name. On collision, offer three choices — link (attach to the existing record), replace (update in place), or import-as-copy (name suffix). This reuses the same idempotency guard the Fabricator's `_find_existing_record_id` implements. Registration emits `agent.import.registered` (or `agent.import.failed`) on `citadel.backend`.

## GraphQL Surface (Resolvers)

The import surface is served by `backend/src/lambda/agent-import-resolver.ts`, which dispatches on the AppSync field name. All names below are verified against `backend/src/schema/schema.graphql`. The discovery queries and every mutation enforce the `admin` or `architect` role inside the resolver (account-level operations); `importAgent` additionally derives tenancy from the caller identity and is org-scoped.

| Operation | Kind | Signature (schema) | Behaviour |
|-----------|------|--------------------|-----------|
| `discoverAgents` | Query | `(input: DiscoverAgentsInput!): [AgentCandidate!]!` | Enumerate candidates by `SCAN` (Resource Groups Tagging API), `PASTE` (one ARN/URL), or `MANIFEST`; cross-account via `discoveryRoleArn` + `discoveryExternalId` |
| `describeAgentCandidate` | Query | `(ref, discoveryRoleArn?, discoveryExternalId?): AWSJSON!` | Resolve a ref to a capability descriptor; substrate-keyed describe dispatch for ECS/EKS/EC2; cross-account read-only assume |
| `importAgent` | Mutation | `(input: ImportAgentInput!): ImportAgentResult!` | Register a DRAFT/inactive record, `origin.ownership='external'`; conflict `LINK`/`REPLACE`/`COPY`; raw secret → Secrets Manager (`secretRef` only on the record); system import ADR + authority grant + `pending` attestation |
| `attestAgentImport` | Mutation | `(agentId: ID!): AgentConfig!` | Advance `governanceAttestation.status` `pending` → `attested` (idempotent) |
| `testImportedAgent` | Mutation | `(input: TestImportedAgentInput!): ImportTestResult!` | Pre-activation test-invoke through the real adapters; transient secret; sanitized output; persists nothing; a failed invoke is a normal `{ ok:false, error }` |
| `probeAgentCandidate` | Mutation | `(input: TestImportedAgentInput!): AWSJSON!` | Tier-2 sandboxed probe: static `describe()` + one guarded dry-run on gaps, merged conservatively at `confidence:'medium'` |
| `proposeAgentManifestTier3` | Mutation | `(ref, discoveryRoleArn?, discoveryExternalId?): Tier3ProposalResult!` | Enqueue **secret-free** signals to the Fabricator; returns `{ requestId, status:'PENDING' }`; the LLM manifest returns async |
| `acceptProposedManifestTier3` | Mutation | `(importId: String!): AgentConfig!` | Human-gated promotion of a `pending_review` proposed manifest into the trusted manifest; record STAYS DRAFT |
| `probeImportReachability` | Mutation | `(importId: String!): ImportReachabilityResult!` | Backend best-effort probe; persists `customMetadata.reachability` only |
| `publishImportToGateway` | Mutation | `(importId: String!): GatewayPublicationResult!` | MCP-only; gated on `attested` + `reachable`; creates an `mcpServer` gateway target; record STAYS DRAFT |
| `unpublishImportFromGateway` | Mutation | `(importId: String!): GatewayPublicationResult!` | Remove the gateway target (+ credential provider when offloaded); idempotent |

The mode-aware **activation gate** is not a dedicated resolver: it is enforced in `backend/src/lambda/agent-config-resolver.ts` (`enforceImportActivationGate`) on the APPROVED transition of an imported, not-yet-attested record (`updateAgentConfig` / `activateProjectAgents`). In `strict` it throws before the APPROVED write; in `shadow`/`permissive` it emits `agent.import.activation_gate` and proceeds. The same path performs the lazy IAM trust-path attestation (`computeTrustPath`; cross-account via `assumeAnalysisRoleClient` when `invocation.analysisRoleArn` is set).

## Data Model

The import payload (blocker #1) is the extended descriptor: manifest + invocation block + origin block. It is stored in the Registry record's `customDescriptorContent`, consistent with Today. Secrets go to Secrets Manager (`secretRef`), never the record. The scoped invoke role goes in `roleArn`.

```
DIAGRAM 5 — Extended descriptor data model (additive blocks marked *; all shipped)

  AgentCore Registry record
  └─ customDescriptorContent (JSON)
     ├─ manifest {}            ── Today: name, description, version, tools[]
     │                            * extended: skills[], categories[],
     │                              inputSchema, outputSchema, constraints{}
     ├─ invocation {} *        ── protocol discriminator + target + auth
     │     ├─ protocol         ── AGENTCORE_RUNTIME | BEDROCK_AGENT | ...
     │     ├─ target           ── arn | url | functionName | stateMachineArn
     │     ├─ auth { mode, secretRef ─▶ Secrets Manager }
     │     ├─ mode             ── sync | async_callback
     │     ├─ region, account
     │     ├─ roleArn ─────────── scoped invoke role (PolicyManager)
     │     └─ externalId
     └─ origin {} *            ── provenance + ownership invariant
           ├─ sourceArn        ── dedupe key (conflict policy)
           ├─ account, region, substrate
           ├─ discoveredAt
           └─ ownership: 'external'  ── lifecycle never deletes foreign infra
```

The normalized Agent Capability Descriptor (as-built, `backend/src/adapters/agent-source/types.ts`):

```typescript
// As-built — Agent Capability Descriptor (types.ts)
interface AgentCapabilityDescriptor {
  name: string;
  description: string;
  version: string;
  skills: string[];
  categories: string[];
  inputSchema: JsonSchema;   // open JSON Schema document
  outputSchema: JsonSchema;
  invocation: AgentInvocationBlock;
  origin: AgentOrigin;
  constraints?: {
    maxLatencyMs?: number;
    costHint?: string;
    dataSensitivity?: string;
    piiHandling?: string;
  };
  fieldConfidence?: Record<string, Confidence>; // per-field 'high' | 'medium' | 'low'
}
```

The invocation + origin blocks are the single source of truth in `backend/src/services/registry-service.ts` (imported by the adapter types to avoid a circular dependency):

```typescript
// As-built — backend/src/services/registry-service.ts
type AgentInvocationProtocol =
  | 'AGENTCORE_RUNTIME' | 'BEDROCK_AGENT' | 'LAMBDA_INVOKE'
  | 'HTTP_ENDPOINT' | 'MCP'
  | 'A2A' | 'STEP_FUNCTIONS' | 'SAGEMAKER_ENDPOINT' | 'SQS_ASYNC';
  // 9 values in the union; the first 5 have invoke adapters today. The last 4
  // are reserved — resolving them throws UnknownProtocolError (Deferred).

type AgentInvocationAuthMode =
  | 'SIGV4' | 'API_KEY' | 'OAUTH2' | 'COGNITO' | 'NONE' | 'BEARER';

type AgentInvocationMode = 'sync' | 'async_callback';

interface AgentInvocationBlock {
  protocol: AgentInvocationProtocol;
  target: string;                       // arn | url | functionName | …
  auth: {
    mode: AgentInvocationAuthMode;
    secretRef?: string;                 // Secrets Manager ARN — never an inline secret
    header?: string;                    // custom API_KEY header name (e.g. 'x-api-key')
  };
  mode: AgentInvocationMode;
  region?: string;
  account?: string;
  roleArn?: string;                     // cross-account INVOKE role (externalId-gated)
  externalId?: string;                  // STS ExternalId (confused-deputy guard)
  analysisRoleArn?: string;             // cross-account read-only role for activation trust-path
}

interface AgentOrigin {
  sourceArn?: string;                   // dedupe key (conflict policy)
  account?: string;
  region?: string;
  substrate: string;
  discoveredAt: string;                 // ISO 8601
  ownership: 'external';                // hard invariant — lifecycle never deletes foreign infra
}
```

A record with no `invocation` block is treated as `protocol = AGENTCORE_RUNTIME` (`getInvocationProtocol()`), so every pre-import record keeps its exact prior behaviour (back-compat invariant).

These blocks plus four additive metadata sub-blocks live inside the serialized `AgentCustomMetadata` (the record's `customDescriptorContent` JSON). Each sub-block is written by exactly one resolver path, is surfaced READ-only, and **never** promotes itself into the trusted `manifest` / `invocation` / `state` — an imported record STAYS DRAFT until an explicit, separate activation:

```typescript
// As-built — AgentCustomMetadata import sub-blocks (registry-service.ts;
// governanceAttestation.trustPath is stamped by agent-config-resolver.ts)
governanceAttestation?: {
  status: 'pending' | 'attested';
  enforcementMode: string;              // governance rollout mode at import time
  authorityRequested: boolean;
  requestedAt: string;
  adrId?: string;                       // system-generated import ADR
  attestedBy?: string;                  // set on attest (Cognito sub | username)
  attestedAt?: string;
  trustPath?: {                         // stamped lazily at activation (local augmentation)
    checkedAt: string;
    clean: boolean;
    findings: string[];
    crossAccount?: boolean;             // true when introspected via the analysis role
  };
};
proposedManifest?: {                    // Tier-3 LLM proposal — UNTRUSTED, human-accept-gated
  manifest?: Record<string, unknown>;   // sanitized proposed body
  confidence?: 'high' | 'medium' | 'low'; // always 'low' for an LLM proposal
  reviewState: 'pending_review' | 'failed' | 'accepted';
  source: 'llm_tier3';
  fieldConfidence?: Record<string, 'high' | 'medium' | 'low'>;
  proposedAt: string;
  correlationId?: string;
  sanitized?: boolean;
  truncated?: boolean;
  error?: string;                       // failure marker only
  reviewedBy?: string;                  // set on accept
  reviewedAt?: string;
};
reachability?: {                        // backend best-effort probe (US-IMP-017b)
  reachable: boolean;
  classification: 'reachable' | 'unreachable' | 'unverifiable_private' | 'no_endpoint';
  detail?: string;
  checkedAt: string;
};
gatewayPublication?: {                  // optional MCP gateway publish (US-IMP-031)
  status: 'published' | 'unpublished';
  targetType: 'mcpServer';
  gatewayId: string;
  gatewayTargetId: string;
  credentialProviderArn?: string;       // present only when auth was offloaded (API_KEY/BEARER)
  publishedAt: string;
  publishedBy: string;
};
```

Example — an imported Lambda agent (`customDescriptorContent`):

```json
{
  "categories": ["enrichment"],
  "icon": "robot",
  "state": "inactive",
  "manifest": {
    "name": "invoice-classifier",
    "description": "Classifies uploaded invoices into GL categories",
    "version": "1.0.0",
    "tools": [],
    "skills": ["classification", "ocr-postprocess"],
    "inputSchema": { "type": "object", "properties": { "documentUri": { "type": "string" } }, "required": ["documentUri"] },
    "outputSchema": { "type": "object", "properties": { "category": { "type": "string" }, "confidence": { "type": "number" } } }
  },
  "invocation": {
    "protocol": "LAMBDA_INVOKE",
    "target": "arn:aws:lambda:us-west-2:111122223333:function:invoice-classifier",
    "auth": { "mode": "SIGV4" },
    "mode": "sync",
    "region": "us-west-2",
    "account": "111122223333",
    "roleArn": "arn:aws:iam::257192363080:role/citadel-agent-invoke-invoice-classifier",
    "externalId": "citadel-import-7f3a"
  },
  "origin": {
    "sourceArn": "arn:aws:lambda:us-west-2:111122223333:function:invoice-classifier",
    "account": "111122223333",
    "region": "us-west-2",
    "substrate": "lambda",
    "discoveredAt": "2026-06-25T10:42:00Z",
    "ownership": "external"
  },
  "createdBy": "user-abc",
  "orgId": "org-xyz"
}
```

Example — an imported Bedrock Agent (import the alias, not the draft):

```json
{
  "categories": ["support"],
  "icon": "robot",
  "state": "inactive",
  "manifest": {
    "name": "tier1-support-agent",
    "description": "Answers tier-1 support questions over the product KB",
    "version": "3",
    "tools": [],
    "skills": ["qa", "kb-retrieval"],
    "inputSchema": { "type": "object", "properties": { "inputText": { "type": "string" } }, "required": ["inputText"] },
    "outputSchema": { "type": "object", "properties": { "completion": { "type": "string" } } }
  },
  "invocation": {
    "protocol": "BEDROCK_AGENT",
    "target": "arn:aws:bedrock:us-west-2:111122223333:agent-alias/AGENT123/ALIAS456",
    "auth": { "mode": "SIGV4" },
    "mode": "sync",
    "region": "us-west-2",
    "account": "111122223333",
    "roleArn": "arn:aws:iam::257192363080:role/citadel-agent-invoke-tier1-support",
    "externalId": "citadel-import-9b2c"
  },
  "origin": {
    "sourceArn": "arn:aws:bedrock:us-west-2:111122223333:agent-alias/AGENT123/ALIAS456",
    "account": "111122223333",
    "region": "us-west-2",
    "substrate": "bedrock_agent",
    "discoveredAt": "2026-06-25T10:55:00Z",
    "ownership": "external"
  },
  "createdBy": "user-abc",
  "orgId": "org-xyz"
}
```

## Invocation Dispatch

The generalization is small but load-bearing, and it shipped: `agent-message-handler` (`backend/src/lambda/agent-message-handler.ts`) no longer assumes the runtime pointer is `{ agentRuntimeArn }`. When the `IMPORT_ENABLED` flag is on, `REGISTRY_ID` is configured, and the resolved Registry record carries an `invocation` block, it routes through `dispatchImportedInvocation`: it reads `invocation.protocol`, resolves the per-protocol adapter from `buildDefaultAgentSourceRegistry()`, invokes, **sanitizes the untrusted response** (`sanitizeUntrustedAgentOutput`), and stores + publishes exactly as the legacy path does. A record with no `invocation` block (or the flag off / no `REGISTRY_ID` / a Registry read error) falls back to the **unchanged** SSM → `InvokeAgentRuntimeCommand` path. An explicit but unregistered protocol throws `UnknownProtocolError` rather than silently falling back — so only the five adapters wired in `registry-factory.ts` (`AGENTCORE_RUNTIME`, `BEDROCK_AGENT`, `LAMBDA_INVOKE`, `HTTP_ENDPOINT`, `MCP`) can be dispatched; `A2A` / `STEP_FUNCTIONS` / `SAGEMAKER_ENDPOINT` / `SQS_ASYNC` resolve to `UnknownProtocolError` (Deferred).

Cross-account invoke is wired (`resolveImportRegistry`): when `invocation.roleArn` resolves to a different account than `ACCOUNT_ID` (`isCrossAccountRoleArn`), the handler assumes that operator-supplied invoke role via `vendImportCredentials` (PolicyManager scoped-role assume, `externalId`-gated) and builds the AWS-native adapters with the assumed credentials. A failed cross-account assume **throws** — it never silently falls back to the handler's own identity (which would invoke with the wrong account's credentials).

```
DIAGRAM 4 — Invocation dispatch (generalized agent-message-handler, as-built)

 EventBridge: message.sent_to_agent
        │
        ▼
 resolve Registry record ──▶ read invocation.protocol
        │
        ▼
 switch (invocation.protocol) {
   ┌───────────────────────┬──────────────────────────────────────────────┐
   │ AGENTCORE_RUNTIME ──▶ │ InvokeAgentRuntime          (Today path)     │
   │ BEDROCK_AGENT     ──▶ │ InvokeAgent / InvokeFlow                     │
   │ LAMBDA_INVOKE     ──▶ │ Invoke (RequestResponse | Event)             │
   │ HTTP_ENDPOINT     ──▶ │ signed HTTPS (SignatureV4)                   │
   │ MCP               ──▶ │ tools/call (JSON-RPC)                        │
   │ A2A / STEP_FUNCTIONS / SAGEMAKER_ENDPOINT / SQS_ASYNC:               │
   │   (no adapter)    ──▶ │ UnknownProtocolError              (Deferred) │
   └───────────────────────┴──────────────────────────────────────────────┘
 }
        │
        ▼
 normalize response ──▶ store in Conversations table ──▶ AppSync subscription

 ASYNC PATH (mode = async_callback):
   dispatch ──▶ (no inline response) ... later ...
   EventBridge / SQS / WebSocket completion ──▶ store ──▶ AppSync subscription
```

Sync vs async. `mode: sync` returns a response inline: the dispatcher invokes, normalizes, stores, and fans out in one pass. `mode: async_callback` invokes and returns immediately; completion arrives later over EventBridge, SQS, or a WebSocket callback, at which point the handler stores the response and fans out. The async path is not new — it is the same flow Citadel already uses for worker completions. Express Step Functions and synchronous Lambda use `sync`; Standard Step Functions, Event-mode Lambda, and durable/long-running agents use `async_callback`.

Response normalization is also a trust boundary. Every protocol returns a different envelope. The dispatcher normalizes to `NormalizedAgentResponse`, and because the payload originates outside Citadel, it is sanitized for prompt-injection content before it re-enters orchestration (see [Security and Governance](#security-and-governance)).

## Security and Governance

Import widens Citadel's trust surface to infrastructure it does not own. Security is layered accordingly.

Identity and credentials:

- Discovery role: read-only describe/list, the minimum to enumerate and introspect. Never write, never invoke.
- Per-agent invoke role: vended by PolicyManager, scoped to exactly one target ARN. Imported agents do not share an invoke role.
- Cross-account: `AssumeRole` plus an external ID to defeat the confused-deputy problem.
- Secrets: API keys, OAuth client secrets, and bearer tokens live in Secrets Manager and are referenced by `secretRef`. They never enter the descriptor record.

Governance (as-built). Every import is recorded and gated through the existing governance engine:

- ADR: a **system-generated** ADR (author `system:agent-import`, keyed to the synthetic global project `citadel-imports-global`) is recorded on every record-creating import; its id is stamped into `governanceAttestation.adrId`. Best-effort — an ADR-write failure never fails the import.
- Authority unit: `grantFabricatorAuthority` grants one authority unit per imported record (best-effort, idempotent).
- Attestation: import stamps `governanceAttestation = { status:'pending', enforcementMode, authorityRequested, requestedAt }`; the admin/architect `attestAgentImport` mutation advances it to `attested` (recording `attestedBy`/`attestedAt`).
- Mode-aware activation gate: at the DRAFT→APPROVED transition of an imported, not-yet-attested record, `enforceImportActivationGate` runs. `strict` throws before the APPROVED write; `shadow`/`permissive` emit an `agent.import.activation_gate` "would-block" event and proceed. The governance flag fails open to `permissive`.
- Lazy IAM trust-path attestation: when an imported, pending record with an `invocation.roleArn` is activated, `computeTrustPath` introspects that role; a clean path auto-attests (`attestedBy:'system:trust-path'`) so activation proceeds in the same request, and the summary is persisted to `governanceAttestation.trustPath`. A **cross-account** role is introspected via the operator-supplied read-only `analysisRoleArn` (externalId-gated, `assumeAnalysisRoleClient`); without one, a manual-attestation finding is recorded and the record stays `pending`.

(Interrogation rounds and composition contracts remain project-keyed governance artefacts and are not part of the import path; an import is governed via the ADR + authority unit + attestation + activation gate above.)

Enforcement posture. Imported agents are external and less trusted. They start in permissive or shadow enforcement and graduate to strict only after attestation. Progressive enforcement (permissive to shadow to strict) and grandfathering already exist in the governance engine.

Untrusted output. A foreign agent's response is an external input. It crosses a prompt-injection boundary. The dispatcher sanitizes the normalized response before it re-enters orchestration. Instructions embedded in a foreign agent's output are data, not commands.

Network reachability is the largest hidden cost, and it is handled honestly. The `probeImportReachability` mutation (backed by `backend/src/utils/reachability-probe.ts`) issues a bounded (AbortController, 5s default), unauthenticated `GET` from the non-VPC import Lambda and classifies the endpoint as `reachable` (any HTTP response from a public host), `unreachable` (network error/timeout on a public host), `unverifiable_private` (an RFC1918 / loopback / link-local / `internal-*.elb.amazonaws.com` / `.internal`/`.local` host — **not** a false `unreachable`), or `no_endpoint`. The probe never reads the response body and persists only `customMetadata.reachability`, leaving the record DRAFT. A VPC-attached prober Lambda (PrivateLink / security-group aware) for private and cross-account targets is **Deferred**.

## Substrate Deep-Dives

### AgentCore Runtime

- Discovery: `bedrock-agentcore-control` `ListAgentRuntimes`, `ListAgentRuntimeEndpoints`; Registry `ListRegistryRecords`.
- Capability source: Tier 0 — the Registry manifest may already be present.
- Invocation: `AGENTCORE_RUNTIME` via `bedrock-agentcore` `InvokeAgentRuntime`. This is the path already wired in `agent-message-handler`.
- Gotchas: an AgentCore agent imported from another account is still external — `ownership = 'external'` applies even though the substrate is the same one Citadel uses natively.

### Bedrock Agents (classic)

- Discovery: `bedrock-agent` `ListAgents`, `ListAgentAliases`, `ListAgentActionGroups`, `ListAgentKnowledgeBases`.
- Capability source: Tier 0 — action-group OpenAPI/function schemas plus the agent's instructions.
- Invocation: `BEDROCK_AGENT` via `bedrock-agent-runtime` `InvokeAgent` (or `InvokeFlow`).
- Gotchas: import the ALIAS, not the draft — the draft is mutable and unversioned. Bedrock Agents are workflow-like: they orchestrate action groups and knowledge bases. Citadel imports the agent as a unit; it does not re-fabricate the action groups.

### Lambda and variants

- Discovery: `lambda` `ListFunctions`, `GetFunctionConfiguration`, `ListTags`, `GetPolicy`, `ListFunctionUrlConfigs`, `ListEventSourceMappings`.
- Capability source: Tier 1 — env vars, tags, description, resource policy, event-source mappings, Function URL. Tier 3 when the contract is opaque.
- Invocation: `LAMBDA_INVOKE` via `lambda` `Invoke` (RequestResponse = sync, Event = async), gated by SigV4 plus the function's resource policy.
- Gotchas: standard, managed, durable/long-running, and Firecracker microVM Lambdas all collapse to "invoke a function ARN". The only modeling difference is timeout and statefulness, which selects `sync` vs `async_callback`. A long-running Lambda must be imported as `async_callback` or invocations will time out.

### ECS

- Discovery: `ecs` `ListClusters`, `ListServices`, `DescribeServices`, `DescribeTaskDefinition`; ELBv2 plus Cloud Map/Service Connect to resolve the endpoint.
- Capability source: Tier 1 (task def: image, ports, env) then Tier 2/3.
- Invocation: `HTTP_ENDPOINT` to the resolved load-balancer or service-discovery endpoint.
- Gotchas: endpoint resolution is non-trivial and reachability is frequently private. Phase 2.

### EKS

- Discovery: `eks` `ListClusters`, `DescribeCluster`, then the k8s API (Services/Ingress) via an access entry, or ALB-Ingress/Cloud Map.
- Capability source: Tier 1 (pod/service spec) then Tier 2/3.
- Invocation: `HTTP_ENDPOINT` to the ingress or service endpoint.
- Gotchas: highest friction. Requires k8s API access in addition to AWS APIs. Phase 2.

### EC2

- Discovery: `ec2` `DescribeInstances` by tag; endpoint via an ALB or the private IP.
- Capability source: Tier 3 dominates — EC2 agents rarely publish a contract.
- Invocation: `HTTP_ENDPOINT`.
- Gotchas: reachability is the hard part. A private instance needs the VPC-attached prober. Treat EC2 as the canonical opaque case.

### Other substrates

| Substrate | Discovery API | Capability source | Invocation protocol | Gotchas |
|-----------|---------------|-------------------|---------------------|---------|
| API Gateway | `apigateway` `GetRestApis` / `apigatewayv2` `GetApis` + `GetExport` | Tier 0 (OpenAPI export) | `HTTP_ENDPOINT` | Stage and authorizer config affect auth mode |
| Step Functions | `stepfunctions` `ListStateMachines` | Tier 1 (definition) | `STEP_FUNCTIONS` — `StartSyncExecution` (Express) / `StartExecution` (Standard) | Standard is async; model as `async_callback` |
| SageMaker | `sagemaker` `ListEndpoints` | Tier 2 (probe) | `SAGEMAKER_ENDPOINT` via `sagemaker-runtime` `InvokeEndpoint` | Payload contract is model-specific; lean on dry-run |
| App Runner | `apprunner` `ListServices` | Tier 1/2 | `HTTP_ENDPOINT` | Public or VPC-connector; reachability varies |
| External MCP | endpoint paste (existing integration type) | Tier 0 (`initialize` + `tools/list`) | `MCP` — JSON-RPC `tools/call` | Citadel already integrates MCP servers |
| A2A | endpoint paste; agent card | Tier 0 (`/.well-known/agent.json`) | `A2A` — `tasks/send` | Phase 3 federation target |

## End-to-End Walkthroughs

### Walkthrough 1: Import a Lambda agent (paste ARN, same account)

1. Operator opens the Import Wizard and pastes the function ARN.
2. The Lambda adapter `discover()` confirms the ARN, then `describe()` runs Tier 1: `GetFunctionConfiguration`, `ListTags`, `GetPolicy`, `ListFunctionUrlConfigs`. Env keys and tags hint at the contract.
3. The contract is opaque, so Tier 3 proposes an `inputSchema`/`outputSchema` from the description and a sample payload. Fields carry confidence scores.
4. Human review gate: the operator edits the proposed schema and accepts. Low-confidence fields are badged.
5. Configure invocation: protocol `LAMBDA_INVOKE`, `mode: sync`. PolicyManager vends a role scoped to the one function ARN. The operator runs a dry-run in `ToolTestingSandbox`; real I/O confirms the schema.
6. Register: `RegistryService.createResource('agent', ...)` writes a DRAFT record with `origin.ownership = 'external'`. `agent.import.registered` fires.
7. Governance attests (ADR, trust-path analysis). The operator activates; status moves to APPROVED (active).

### Walkthrough 2: Import a Bedrock Agent (alias)

1. Operator selects "scan account", choosing a role and region.
2. The Bedrock Agent adapter `discover()` runs `ListAgents` then `ListAgentAliases`. The wizard lists aliases, not drafts.
3. `describe()` runs Tier 0: `ListAgentActionGroups` and `ListAgentKnowledgeBases` yield action-group OpenAPI schemas and the agent's instructions — input/output schemas come for free, at high confidence.
4. Human review gate: minimal editing because Tier 0 is authoritative.
5. Configure invocation: protocol `BEDROCK_AGENT`, `mode: sync`. Scoped role targets the alias ARN. Dry-run via the sandbox.
6. Register DRAFT with `origin.sourceArn` set to the alias ARN. Conflict check dedupes on that ARN.
7. Governance attests; operator activates.

### Walkthrough 3: Account-wide sweep

1. Operator selects "scan account", supplies a cross-account role and external ID.
2. Discovery assumes the read-only role and calls `resourcegroupstaggingapi` `GetResources` filtered by `citadel:agent=true`, then per-substrate list APIs for tagged resources.
3. The wizard presents a multi-select list of discovered candidates across substrates.
4. The operator selects several. Each runs its substrate's capability determination in parallel. Confidence badges flag the opaque ones.
5. The operator reviews each descriptor, configures invocation, and dry-run tests each.
6. Registration is idempotent: re-running the sweep dedupes on `sourceArn` and offers link/replace/copy for any already-imported agent.

## Failure Modes and Edge Cases

| Failure mode | Detection | Response |
|--------------|-----------|----------|
| Source deleted | Health monitor: `sourceArn` no longer resolves | Auto-deprecate the record (DEPRECATED = inactive); never delete foreign infra |
| Contract drift | Health monitor: API shape changed vs stored schema; contract validation fails | Flag for re-review; downgrade enforcement; optionally auto-deprecate |
| Unreachable VPC | Reachability probe fails from standard Lambda | Require VPC-attached prober; if still unreachable, block activation with a clear reason |
| Duplicate import | Dedupe on `sourceArn` then name | Offer link / replace / import-as-copy |
| Partial capability | Some descriptor fields below confidence threshold | Land in human review with badges; activation blocked until a human resolves them |
| Credential expiry mid-invoke | Invoke returns auth error | Re-vend short-lived creds; bounded retry; surface `agent.import.failed` if persistent |
| Foreign output injection | Sanitizer flags instruction-like content | Strip/escape before re-entry; log the event |
| Cross-account trust broken | Trust-path/drift analysis | Block activation; raise a governance finding |

Drift detection and contract validation reuse the api-contract-agent/OpenAPI tooling and the Services-stack health monitor. Auto-deprecation honors the orchestrate-never-own tenet: the catalog record is deactivated; the customer's infrastructure is untouched.

## User Experience: The Import Wizard

The wizard ships as `frontend/src/components/ImportAgentWizard.tsx` (mirroring `CreateAgentWizard`, `DynamicConnectorForm`, and the integration picker; calls go through `services/agentImportService.ts`). Five steps (the literal step ids/labels are `source` → `candidates` → `review` → `configure` "Configure & Test" → `register` "Governance & Register"):

```
 Step 1            Step 2            Step 3            Step 4            Step 5
┌──────────┐     ┌──────────┐     ┌──────────┐     ┌──────────┐     ┌──────────┐
│ Choose   │ ──▶ │ Select   │ ──▶ │ Review / │ ──▶ │ Configure│ ──▶ │Governance│
│ Source   │     │Candidates│     │ Edit     │     │Invocation│     │+ Register│
│          │     │          │     │Descriptor│     │+ TEST    │     │          │
│ scan /   │     │ multi-   │     │confidence│     │ auth +   │     │ permis-  │
│ paste /  │     │ select   │     │ badges   │     │ dry-run  │     │ sions    │
│ upload   │     │          │     │          │     │ sandbox  │     │          │
└──────────┘     └──────────┘     └──────────┘     └──────────┘     └──────────┘
```

1. Choose source: account tag scan (`SCAN`, with optional region/tagKey/tagValue and an optional cross-account read-only `discoveryRoleArn` + `discoveryExternalId`), paste an ARN/endpoint (`PASTE`), or upload a manifest (`MANIFEST`).
2. Select candidates: multi-select from the discovered list (scan mode) or confirm the single pasted reference. Selecting several drives a batch DRAFT import.
3. Review/edit the inferred descriptor: name, categories, schemas, skills — annotated with `high`/`medium`/`low` confidence badges; low-confidence/thin descriptors surface the Tier-3 propose option.
4. Configure invocation + test: protocol, target, auth mode (`NONE`/`SIGV4`/`API_KEY`/`BEARER`/`OAUTH2`/`COGNITO`), optional custom API-key header, a transient secret, sync/async mode, and optional cross-account `invocationRoleArn`/`invocationExternalId`/`analysisRoleArn`, then a pre-activation **test-invoke** (`testImportedAgent`) that actually reaches the target and returns a sanitized result without persisting anything.
5. Governance & register: register (DRAFT) via `importAgent`; on a conflict the wizard surfaces `LINK`/`REPLACE`/`COPY`. The success screen exposes the Tier-3 `Tier3ProposalPanel`, reachability probe, and attest actions. Activation (DRAFT→APPROVED) is a separate, explicit action gated on attestation.

## Eventing

Import emits **best-effort** lifecycle events on the existing **`citadel.backend`** source (via `backend/src/utils/events.ts` `publishEvent`), on the shared `citadel-agents-{env}` bus — not on a new `citadel.agents` source. A publish failure is logged and swallowed and never fails (or alters the result of) the underlying mutation/query. Each event carries a `correlationId` (UUID, generated per call) and an ISO 8601 `timestamp`; import-specific fields live under `detail.payload`, with `projectId` emitted as `""`. The `EventTypes` constants are defined in `events.ts`.

| DetailType | Producer | Description |
|------------|----------|-------------|
| `agent.import.discovered` | `agent-import-resolver.discoverAgents` | One summary event per discovery call (SCAN / PASTE / MANIFEST) — `payload: { source, candidateCount, substrates }` |
| `agent.import.registered` | `agent-import-resolver.importAgent` | An external agent was written as a DRAFT record (CREATE / REPLACE / COPY; never on a no-op link or unresolved conflict) |
| `agent.import.failed` | `agent-import-resolver` (import / discover / describe catch) | An import/discover/describe operation threw; emitted before the original error is rethrown |
| `agent.import.attested` | `agent-import-resolver.attestAgentImport` | `governanceAttestation.status` advanced `pending` → `attested` (once per real transition) |
| `agent.import.activation_gate` | `agent-config-resolver` (APPROVED transition) | The activation gate evaluated an imported, not-yet-attested agent in `shadow`/`permissive` mode (a "would-block" telemetry event; `strict` throws instead) |

The Tier-3 manifest-proposal path uses two **separate** events produced by the Python Fabricator (`arbiter/fabricator/index.py` `publish_manifest_event`) on the agent bus (`COMPLETION_BUS_NAME`), following the Fabrication-event convention where `Source == DetailType`:

| DetailType (== Source) | Producer | Consumer | Description |
|------------------------|----------|----------|-------------|
| `agent.import.manifest.proposed` | Fabricator `_process_manifest_proposal` | `agent-import-manifest-result-handler` | LLM-proposed descriptor ready — `detail: { requestId, correlationId, importId, proposedManifest, status:'proposed' }` |
| `agent.import.manifest.failed` | Fabricator `_process_manifest_proposal` | `agent-import-manifest-result-handler` | Proposal could not be produced — `detail: { requestId, correlationId, importId, error, status:'failed' }` |

The result handler (B1) is idempotent (on `correlationId`), recursively sanitizes the untrusted proposed manifest, and parks it on the DRAFT record as `customMetadata.proposedManifest` (`reviewState:'pending_review'`) for human review. See [docs/EVENTBRIDGE_CATALOG.md](EVENTBRIDGE_CATALOG.md) for the full schemas.

Observability and cost: imported agents reuse the per-app observability pattern (the `AppApiDashboard` approach) and X-Ray tracing. Each imported agent gets per-agent invocation counts, latency, error rates, and cost attribution, so an external dependency's behavior is visible and billable to the right owner.

## Phased Delivery and Roadmap

| Phase | Substrates | Access | Capability tiers | Status |
|-------|------------|--------|------------------|--------|
| Phase 1 | AgentCore Runtime, Bedrock Agent, Lambda, HTTP/MCP | Same-account | Tiers 0–1 | ✅ Shipped — invocation block, protocol dispatcher (`IMPORT_ENABLED`-gated), import resolver, 5-step wizard, DRAFT registration, conflict link/replace/copy |
| Phase 2 | ECS, EKS, EC2 discovery substrates | Cross-account | + Tiers 2–3 | ✅ Shipped — substrate discovery adapters, cross-account discovery/analysis/invoke roles (AssumeRole + externalId), Tier-2 sandboxed probe, Tier-3 LLM-proposed manifest |
| Follow-ons | (all of the above) | — | — | ✅ Shipped — governance attestation + mode-aware activation gate, lazy IAM trust-path attestation, test-invoke, backend reachability probe, optional MCP gateway publish |

**Deferred (documented, not built):**

- **REST/OpenAPI gateway publish.** `publishImportToGateway` is MCP-only; an `HTTP_ENDPOINT` import returns a "REST/OpenAPI gateway publish not yet supported" error.
- **Peered-VPC reachability prober.** `probeImportReachability` runs from the non-VPC import Lambda, so a private/cross-account target is honestly `unverifiable_private` rather than reachable. A VPC-attached prober (peering/PrivateLink-aware) is the deferred add-on.
- **Gateway auth offload beyond NONE/API_KEY/BEARER.** OAUTH2 / SIGV4 / COGNITO offload is rejected (deferred).
- **`A2A` / `STEP_FUNCTIONS` / `SAGEMAKER_ENDPOINT` / `SQS_ASYNC` invoke + discovery.** These protocols exist in the invocation union but have no invoke adapter, and `resolveSourceRef` does not recognize Step Functions / SageMaker / API Gateway / App Runner / A2A references (they raise `UnsupportedSourceError`).
- **Drift/health reconciliation and A2A federation** (the original Phase 3 vision).

## Resolved Decisions

These four decisions answer the blockers recorded verbatim in `frontend/src/pages/AgentCatalog.tsx` ("import payload format, duplicate-agentId conflict policy, file-vs-paste source, and downstream resource (tools/integrations) handling").

| # | Blocker | Resolution |
|---|---------|------------|
| 1 | Import payload format | The extended descriptor: `manifest` + `invocation` block + `origin` block, stored in `customDescriptorContent`. Secrets in Secrets Manager via `secretRef`; invoke role in `roleArn`. |
| 2 | Duplicate-agentId conflict policy | Dedupe on `origin.sourceArn` first, then name. On collision: link, replace, or import-as-copy (name suffix). Reuses the Fabricator's `_find_existing_record_id` idempotency guard. |
| 3 | File-vs-paste source | All three: account-wide scan (role + region), paste an ARN/endpoint, or upload a manifest. Manifest upload is lowest friction; sweep is highest coverage. |
| 4 | Downstream resource handling | Imported agents reference (not duplicate) existing Citadel tools/integrations. External agents bring their own action groups/tools, described in their manifest, and are not re-fabricated. |

## References

Source files (real, current code):

- `backend/src/lambda/agent-import-resolver.ts` — the import surface: `importAgent`, `discoverAgents`, `describeAgentCandidate`, `attestAgentImport`, `testImportedAgent`, `probeAgentCandidate`, `proposeAgentManifestTier3`, `acceptProposedManifestTier3`, `probeImportReachability`, `publishImportToGateway`, `unpublishImportFromGateway`.
- `backend/src/adapters/agent-source/` — `base.ts` (`AgentSourceAdapter` + `AgentSourceAdapterRegistry`), `types.ts`, `registry-factory.ts` (`buildDefaultAgentSourceRegistry`), `invoke-support.ts` (`vendImportCredentials`, `toInvokeCredentials`, `authHeaderScheme`, `collectOpenApi`), and the `agentcore-runtime` / `bedrock-agent` / `lambda-invoke` / `http-endpoint` / `mcp` / `ecs` / `eks` / `ec2` adapters.
- `backend/src/services/agent-discovery.ts` — `resolveSourceRef`, `tagScanDiscover`, `candidateFromManifest`, `getDiscoveryAdapterForSubstrate`.
- `backend/src/services/registry-service.ts` — `RegistryService`, `RegistryRecord`, `AgentInvocationBlock`, `AgentOrigin`, `AgentCustomMetadata` (incl. `governanceAttestation` / `proposedManifest` / `reachability` / `gatewayPublication`), `getInvocationProtocol`, status mapping, CUSTOM descriptor persistence.
- `backend/src/lambda/agent-config-resolver.ts` — `validateManifest()`, `validateImportDescriptor()`, the import activation gate (`enforceImportActivationGate`), and the lazy trust-path attestation.
- `backend/src/lambda/agent-message-handler.ts` — `message.sent_to_agent` handler; `dispatchImportedInvocation` / `resolveImportRegistry` (the generalized, `IMPORT_ENABLED`-gated protocol dispatcher) alongside the unchanged legacy AgentCore path.
- `backend/src/lambda/agent-import-manifest-result-handler.ts` — the B1 EventBridge consumer that parks the Tier-3 proposal on the DRAFT record.
- `backend/src/utils/trust-path.ts` — `computeTrustPath`, `isCrossAccountRoleArn`, `assumeRoleCredentials`, `assumeAnalysisRoleClient`.
- `backend/src/utils/reachability-probe.ts` — `probeReachability` + classification.
- `backend/src/schema/schema.graphql` — the import mutations/queries and the `ImportAgentInput` / `ImportAgentResult` / `TestImportedAgentInput` / `ImportTestResult` / `ImportReachabilityResult` / `GatewayPublicationResult` / `Tier3ProposalResult` / `ProposedManifest` / `AgentCandidate` / `DiscoverAgentsInput` types.
- `arbiter/fabricator/manifest_proposal.py` + `arbiter/fabricator/index.py` — `propose_agent_manifest` (Tier-3, descriptor-only, all-low confidence, secret-redacted) and `publish_manifest_event` (the `agent.import.manifest.{proposed,failed}` producer); `store_agent_config_registry` + `_find_existing_record_id` (idempotency guard).
- `backend/src/adapters/base.ts` — `ConnectorAdapter` interface (the pattern the Agent Source Adapter mirrors).
- `frontend/src/components/ImportAgentWizard.tsx` + `frontend/src/components/Tier3ProposalPanel.tsx` — the 5-step Import Wizard and the Tier-3 proposal panel; `frontend/src/services/agentImportService.ts` + `frontend/src/types/agentImport.ts`.
- `backend/src/utils/events.ts` — `EventTypes` constants (incl. `AGENT_IMPORT_*`) and EventBridge publishing.

Sibling documents:

- [docs/AGENT_RECORDS.md](AGENT_RECORDS.md) — `RegistryAgentRecord`, status lifecycle, governance linkage.
- [docs/ADAPTER_GUIDE.md](ADAPTER_GUIDE.md) — adapter development guide (the connector pattern this design mirrors).
- [docs/AGENT_PERMISSIONS.md](AGENT_PERMISSIONS.md) — scoped STS credential vending for agents.
- [docs/POLICY_MANAGER.md](POLICY_MANAGER.md) — least-privilege scoped role vending (`citadel-ds-{id}` and the proposed `citadel-agent-invoke-{id}`).
- [docs/EVENTBRIDGE_CATALOG.md](EVENTBRIDGE_CATALOG.md) — event bus, sources, schema, and the `citadel.backend` events Import builds on.
- [docs/ARCHITECTURE.md](ARCHITECTURE.md) — layer architecture and end-to-end data flows.
