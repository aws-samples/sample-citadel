# Agent Import

Citadel fabricates agents it owns. This document specifies a proposed capability — Agent Import — that lets Citadel absorb foreign agents that already run on heterogeneous AWS substrates (AgentCore Runtime, Bedrock Agents, Lambda, ECS, EKS, EC2, HTTP/MCP endpoints, Step Functions, SageMaker) without owning or redeploying their infrastructure. Import discovers a candidate agent, determines its capabilities, normalizes it into the existing AgentCore Registry record model, wires a protocol-aware invocation path, and routes the whole thing through the governance engine. Current-state facts are labeled "Today". Everything new is labeled "Proposed". Nothing in the Proposed sections is implemented yet.

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

Today Citadel only creates agents it owns. The Fabricator generates an agent, registers it, and points invocation at infrastructure Citadel controls — an AgentCore Runtime ARN or the SQS worker queue. Enterprises already operate agents elsewhere: a Bedrock Agent in another account, a Lambda behind a Function URL, a containerized service on ECS, an MCP server, a partner A2A endpoint. Citadel cannot orchestrate any of them. The frontend exposes the intent — an Import Agent button in `frontend/src/pages/AgentCatalog.tsx` — but the button is deliberately disabled pending a product spec.

### Solution

One line: introduce an Agent Source Adapter abstraction (mirroring the proven `ConnectorAdapter`) that discovers, describes, health-checks, credential-vends, and invokes foreign agents, and generalize the invocation pointer from a single AgentCore ARN to a protocol-discriminated `invocation` block so the existing `agent-message-handler` becomes a protocol dispatcher.

### Scope

In scope (Proposed):

- Discover candidate agents in an AWS account/region/scope, by sweep, by pasted reference, or by uploaded manifest.
- Determine capabilities through a four-tier fallback that always ends in human review.
- Normalize foreign agents into the existing AgentCore Registry record model.
- Invoke imported agents across nine protocols through a single dispatcher.
- Route every import through governance: ADR, interrogation, IAM trust-path/drift analysis, authority-unit assignment.

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

Import introduces one new abstraction (Proposed): the Agent Source Adapter. It mirrors the `ConnectorAdapter` family (`backend/src/adapters/base.ts`) that already sits behind 27 datastore and 13 integration adapters, each with a scoped IAM role and a config-driven `DynamicConnectorForm`. One Agent Source Adapter implements the pattern per substrate.

```
DIAGRAM 2 — Agent Source Adapter pattern (Proposed)

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

The proposed interface:

```typescript
// Proposed — backend/src/adapters/agent-source/base.ts
export type AgentSubstrate =
  | 'AGENTCORE_RUNTIME' | 'BEDROCK_AGENT' | 'LAMBDA'
  | 'ECS' | 'EKS' | 'EC2'
  | 'HTTP' | 'MCP' | 'A2A'
  | 'STEP_FUNCTIONS' | 'SAGEMAKER' | 'API_GATEWAY' | 'APP_RUNNER';

export interface AgentRef {
  substrate: AgentSubstrate;
  sourceArn?: string;      // ARN when the substrate is ARN-addressable
  endpoint?: string;       // URL for HTTP / MCP / A2A
  account: string;
  region: string;
  externalId?: string;     // cross-account AssumeRole correlation
}

export interface DiscoveredAgent {
  ref: AgentRef;
  displayName: string;
  hints: Record<string, unknown>;   // tags, description, env keys
}

export interface CapabilityField<T> {
  value: T;
  confidence: number;      // 0..1 — drives review badges
  source: 'tier0' | 'tier1' | 'tier2' | 'tier3';
}

export interface AgentSourceAdapter {
  readonly substrate: AgentSubstrate;

  // Stage 1 — enumerate candidates under a read-only role
  discover(scope: DiscoveryScope): Promise<DiscoveredAgent[]>;

  // Stage 2 — normalize one candidate into a Capability Descriptor
  describe(ref: AgentRef): Promise<AgentCapabilityDescriptor>;

  // confirm reachability + liveness (mirrors testConnection)
  healthCheck(ref: AgentRef): Promise<ConnectionTestResult>;

  // Stage 3 prerequisite — scoped, short-lived creds via PolicyManager
  vendCredentials(ref: AgentRef): Promise<ScopedCredentials>;

  // Stage 3 — normalized request -> normalized response
  invoke(req: NormalizedAgentRequest): Promise<NormalizedAgentResponse>;
}
```

How it mirrors `ConnectorAdapter`: the connector pattern exposes `category`, `spec`, `requiredPolicies`, `testConnection`, `connect`, `disconnect`, and optional `provision`/`deprovision`/`getMetrics`/`validate`. The Agent Source Adapter keeps the same shape — a typed discriminator (`substrate` vs `category`), a capability/spec description, a policy declaration, a reachability test, and a runtime call — and adds `discover()` because foreign agents must be found before they can be described. `vendCredentials()` plays the role `requiredPolicies()` plays for connectors: it is the single choke point where PolicyManager issues a least-privilege role.

## Architecture

```
DIAGRAM 1 — Where Import sits (Proposed components marked *)

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

| Component | Today / Proposed | Responsibility |
|-----------|------------------|----------------|
| Import Wizard (`AgentCatalog.tsx`) | Proposed | 5-step UI: source, candidates, descriptor review, invocation+test, governance+register |
| `agent-import-resolver` | Proposed | AppSync resolver that drives the import pipeline and writes the record |
| AgentSourceAdapter registry | Proposed | Routes `discover/describe/healthCheck/vendCredentials/invoke` to the substrate adapter |
| `RegistryService` | Today | Persists the CUSTOM descriptor record; reused unchanged |
| `agent-message-handler` | Today (generalized) | Becomes a protocol dispatcher keyed on `invocation.protocol` |
| PolicyManager | Today | Vends scoped discovery role and per-agent invoke role |
| Secrets Manager / SSM | Today | Stores invocation secrets (`secretRef`) and runtime pointers |
| Governance engine | Today | ADR, interrogation, IAM trust-path/drift, authority units, enforcement mode |
| Health monitor (Services stack) | Today (extended) | Drift detection and auto-deprecation of imported records |
| `ToolTestingSandbox` | Today (extended) | Mandatory dry-run before activation |

## The Import Pipeline

Import is a four-stage pipeline with a mandatory human review gate between capability determination and activation.

```
DIAGRAM 3 — Import pipeline (Proposed)

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

Discovery emits `agent.import.discovered` on the `citadel.agents` source (Proposed; see [Eventing](#eventing)).

### Stage 2: Capability Determination

Capability determination produces a normalized Agent Capability Descriptor through a four-tier fallback. Higher tiers are tried first; the pipeline falls to the next tier only when the current one cannot supply a field. Every field carries a confidence score. The stage always ends in a human review gate. Citadel never silently trusts a foreign contract.

| Tier | Name | Sources | Yields |
|------|------|---------|--------|
| 0 | Self-describing (best) | AgentCore Registry manifest; A2A Agent Card at `/.well-known/agent.json`; MCP `initialize` + `tools/list`; Bedrock Agent action-group OpenAPI/function schemas + instructions; API Gateway OpenAPI export | input/output schemas for free |
| 1 | Structural introspection | Lambda env vars, tags, description, resource policy, event-source mappings, Function URL; ECS/EKS task def (image, ports, env) | name, hints, rough I/O |
| 2 | Probe/handshake (sandboxed) | describe probe (MCP `tools/list`, A2A capabilities, or Citadel convention `{"op":"describe"}`); dry-run invoke in `ToolTestingSandbox` to observe real I/O | observed request/response shapes |
| 3 | LLM-assisted inference | reuse the Fabricator's Bedrock codegen to read README/OpenAPI/source/sample payloads and propose a manifest + JSON schema; human reviews/edits | a proposed contract for opaque agents |

Tier 3 is the bridge for opaque EC2/ECS agents where no contract is published. It proposes; it never decides. The human review gate confirms or edits every Tier 2 and Tier 3 field, and low-confidence fields surface as badges in the wizard.

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

Conflict policy (blocker #2): dedupe on `origin.sourceArn` first, then name. On collision, offer three choices — link (attach to the existing record), replace (update in place), or import-as-copy (name suffix). This reuses the same idempotency guard the Fabricator's `_find_existing_record_id` implements. Registration emits `agent.import.registered` (or `agent.import.failed`) on `citadel.agents`.

## Data Model

The import payload (blocker #1) is the extended descriptor: manifest + invocation block + origin block. It is stored in the Registry record's `customDescriptorContent`, consistent with Today. Secrets go to Secrets Manager (`secretRef`), never the record. The scoped invoke role goes in `roleArn`.

```
DIAGRAM 5 — Extended descriptor data model (Proposed additions marked *)

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

The normalized Agent Capability Descriptor (Proposed):

```typescript
// Proposed — Agent Capability Descriptor
interface AgentCapabilityDescriptor {
  name: string;
  description: string;
  version: string;
  skills: string[];
  categories: string[];
  inputSchema: object;   // JSON Schema
  outputSchema: object;  // JSON Schema
  invocation: InvocationBlock;
  constraints: {
    maxLatencyMs?: number;
    costHint?: string;
    dataSensitivity?: 'public' | 'internal' | 'confidential' | 'restricted';
    piiHandling?: 'none' | 'transient' | 'stored';
  };
  origin: {
    sourceArn: string;
    account: string;
    region: string;
    substrate: AgentSubstrate;
    discoveredAt: string;     // ISO 8601
    ownership: 'external';
  };
}

interface InvocationBlock {
  protocol:
    | 'AGENTCORE_RUNTIME' | 'BEDROCK_AGENT' | 'LAMBDA_INVOKE'
    | 'HTTP_ENDPOINT' | 'MCP' | 'A2A'
    | 'STEP_FUNCTIONS' | 'SAGEMAKER_ENDPOINT' | 'SQS_ASYNC';
  target: string;            // arn | url | functionName | stateMachineArn
  auth: {
    mode: 'SIGV4' | 'API_KEY' | 'OAUTH2' | 'COGNITO' | 'NONE';
    secretRef?: string;      // /citadel/agents/<id>/secret (Secrets Manager)
  };
  mode: 'sync' | 'async_callback';
  region: string;
  account: string;
  roleArn: string;           // scoped invoke role
  externalId?: string;
}
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
    "substrate": "LAMBDA",
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
    "substrate": "BEDROCK_AGENT",
    "discoveredAt": "2026-06-25T10:55:00Z",
    "ownership": "external"
  },
  "createdBy": "user-abc",
  "orgId": "org-xyz"
}
```

## Invocation Dispatch

The generalization is small but load-bearing: `agent-message-handler` stops assuming the runtime pointer is `{ agentRuntimeArn }` and instead reads `invocation.protocol` from the resolved record, then dispatches. The existing AgentCore path becomes simply `protocol = AGENTCORE_RUNTIME` with unchanged behavior.

```
DIAGRAM 4 — Invocation dispatch (generalized agent-message-handler, Proposed)

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
   │ STEP_FUNCTIONS    ──▶ │ StartSyncExecution | StartExecution          │
   │ SAGEMAKER_ENDPOINT──▶ │ InvokeEndpoint                               │
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

Governance. Every import routes through the existing governance engine:

- ADR: a decision record stating "we imported agent X from account Y", with the discovered descriptor and confidence scores attached.
- Interrogation round: the governance engine challenges the import before activation.
- IAM trust-path and drift analysis: run on the vended invoke role to confirm the trust path is sound and stays sound.
- Authority unit and composition contract: assigned to the imported record, constraining what the agent is permitted to do within an orchestration.

Enforcement posture. Imported agents are external and less trusted. They start in permissive or shadow enforcement and graduate to strict only after attestation. Progressive enforcement (permissive to shadow to strict) and grandfathering already exist in the governance engine.

Untrusted output. A foreign agent's response is an external input. It crosses a prompt-injection boundary. The dispatcher sanitizes the normalized response before it re-enters orchestration. Instructions embedded in a foreign agent's output are data, not commands.

Network reachability is the largest hidden cost. AgentCore Runtime, Bedrock Agents, Lambda, and public HTTP/MCP endpoints are reachable from a standard Lambda. ECS, EKS, EC2, and private endpoints frequently are not — they sit behind security groups in private subnets. Import needs a reachability probe and, for private targets, a VPC-attached prober Lambda that is PrivateLink and security-group aware. Reachability failure is a first-class, expected outcome, not an error to paper over.

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

The wizard (Proposed) mirrors `CreateAgentWizard`, `DynamicConnectorForm`, and the integration picker. Five steps:

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

1. Choose source: scan an account (role + region), paste an ARN/endpoint, or upload a manifest.
2. Select candidates: multi-select from the discovered list (sweep mode) or confirm the single pasted reference.
3. Review/edit the inferred descriptor: schemas, skills, categories, constraints — each annotated with a confidence badge. Low-confidence fields require explicit confirmation.
4. Configure invocation: protocol, target, auth mode, `secretRef`, sync/async mode, then a mandatory TEST through the extended `ToolTestingSandbox`.
5. Governance and permissions: review the scoped invoke role, the ADR, and the authority-unit assignment, then register (DRAFT). Activation is a separate, explicit action after attestation.

## Eventing

Import emits lifecycle events on a Proposed `citadel.agents` source, following the existing EventBridge schema (`detail` carries `agentId`, `payload`, `timestamp`, `correlationId`) on the `citadel-agents-{env}` bus. All events are idempotent and carry a correlation ID.

| DetailType | Producer | Description |
|------------|----------|-------------|
| `agent.import.discovered` | `agent-import-resolver` (Proposed) | A candidate agent was discovered in a scope |
| `agent.import.registered` | `agent-import-resolver` (Proposed) | An imported agent was written as a DRAFT record |
| `agent.import.failed` | `agent-import-resolver` (Proposed) | Discovery, capability determination, or registration failed |

Observability and cost: imported agents reuse the per-app observability pattern (the `AppApiDashboard` approach) and X-Ray tracing. Each imported agent gets per-agent invocation counts, latency, error rates, and cost attribution, so an external dependency's behavior is visible and billable to the right owner.

## Phased Delivery and Roadmap

| Phase | Substrates | Access | Discovery | Capability tiers | Key additions |
|-------|------------|--------|-----------|------------------|---------------|
| Phase 1 (highest leverage) | AgentCore Runtime, Bedrock Agent, Lambda, HTTP/MCP | Same-account | Paste-ARN + tag-scan | Tiers 0-1 | Invocation block, protocol dispatcher, import resolver, wizard, DRAFT registration |
| Phase 2 | ECS, EKS, EC2 | Cross-account | + sweep | + Tiers 2-3 | VPC reachability prober, LLM-assisted inference, cross-account AssumeRole + external ID |
| Phase 3 | A2A, Step Functions, SageMaker | Cross-account | continuous | all | Drift/health reconciliation, A2A federation, marketplace-style sharing |

Phase 1 deliberately targets the self-describing substrates so the first release leans on Tier 0/1 and avoids the reachability and inference complexity that defines Phases 2 and 3.

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

- `backend/src/services/registry-service.ts` — `RegistryService`, `RegistryRecord`, status mapping (`toInternalState`/`toRegistryStatus`), CUSTOM descriptor persistence.
- `backend/src/lambda/agent-config-resolver.ts` — `validateManifest()`.
- `backend/src/lambda/registry-agent-record-resolver.ts` — `AgentAppManifest` interface.
- `backend/src/lambda/agent-message-handler.ts` — `message.sent_to_agent` handler, SSM resolution, `InvokeAgentRuntimeCommand`, `SignatureV4` import (the generalization target).
- `backend/src/adapters/base.ts` — `ConnectorAdapter` interface (the pattern the Agent Source Adapter mirrors).
- `arbiter/fabricator/index.py` — `store_agent_config_registry()`, `_find_existing_record_id` (idempotency guard).
- `frontend/src/pages/AgentCatalog.tsx` — disabled Import Agent button and the four-blocker comment.
- `frontend/src/config/connectorRegistry.ts` — `DynamicConnectorForm` config the wizard mirrors.
- `frontend/src/components/ToolTestingSandbox.tsx` — dry-run sandbox extended for mandatory pre-activation tests.
- `backend/src/utils/events.ts` — `EventTypes` constants and EventBridge publishing.

Sibling documents:

- [docs/AGENT_RECORDS.md](AGENT_RECORDS.md) — `RegistryAgentRecord`, status lifecycle, governance linkage.
- [docs/ADAPTER_GUIDE.md](ADAPTER_GUIDE.md) — adapter development guide (the connector pattern this design mirrors).
- [docs/AGENT_PERMISSIONS.md](AGENT_PERMISSIONS.md) — scoped STS credential vending for agents.
- [docs/POLICY_MANAGER.md](POLICY_MANAGER.md) — least-privilege scoped role vending (`citadel-ds-{id}` and the proposed `citadel-agent-invoke-{id}`).
- [docs/EVENTBRIDGE_CATALOG.md](EVENTBRIDGE_CATALOG.md) — event bus, sources, schema, and the `citadel.backend` events Import builds on.
- [docs/ARCHITECTURE.md](ARCHITECTURE.md) — layer architecture and end-to-end data flows.
