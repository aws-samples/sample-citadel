# Architecture Overview

Citadel is a multi-agent AI platform for enterprise application transformation. This document explains how the four layers interact end-to-end, the data flows between them, and the key architectural patterns that hold the system together.

## Layer Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        Frontend (React 18 + Vite)                       │
│  Pages: Dashboard, AgentApps, AgenticStudio, AgentCatalog, Tools,       │
│         Integrations, DataStores, Team, IntakeRequests                  │
│  Real-time: AppSync WebSocket subscriptions + local EventBus            │
└──────────────────────────────┬──────────────────────────────────────────┘
                               │ GraphQL + WebSocket subscriptions
┌──────────────────────────────▼──────────────────────────────────────────┐
│                     Backend (CDK TypeScript — 7 stacks)                 │
│  AppSync API → 40+ Lambda resolvers → DynamoDB (9 tables)               │
│  EventBridge bus (citadel-agents-{env}) for async coordination          │
│  Cognito (auth) · S3 (documents + code) · Secrets Manager (creds)       │
└──────────┬───────────────────┬──────────────────┬───────────────────────┘
           │                   │                  │
           │ EventBridge       │ Lambda invoke    │ EventBridge
           ▼                   ▼                  ▼
┌─────────────────┐  ┌─────────────────┐  ┌──────────────────────────────┐
│  Arbiter Layer  │  │  Gateway Layer  │  │  Services Layer              │
│  (Python 3.14)  │  │  (per-app APIs) │  │  (Bedrock AgentCore)         │
│                 │  │                 │  │                              │
│  Supervisor     │  │  Publish Handler│  │  AgentCore Runtime           │
│  Fabricator     │  │  Authorizer     │  │  (agent_intake_single)       │
│  Worker Wrapper │  │  Metrics        │  │  Knowledge Base (OpenSearch) │
│  Step Runner    │  │                 │  │  AgentCore Gateway (MCP)     │
└─────────────────┘  └─────────────────┘  └──────────────────────────────┘
```

## How the Layers Interact

### Frontend → Backend

The React SPA communicates exclusively through AWS AppSync (GraphQL). Amplify 6.x handles Cognito authentication and WebSocket subscription management.

- Queries and mutations go to AppSync, which routes to Lambda resolvers
- Subscriptions use AppSync WebSocket for real-time updates (agent status, conversation messages, workflow progress, fabrication events, app status changes)
- The frontend `subscriptionManager` singleton handles auto-reconnect on disconnect
- A local `EventBus` (type-safe pub/sub) coordinates between frontend components without prop drilling

### Backend → Arbiter

The backend communicates with the arbiter layer through two mechanisms:

1. EventBridge events — The `task.request` source triggers the Supervisor Lambda. The `task.completion` source returns results from workers back to the Supervisor.
2. SQS queues — The Supervisor sends messages to `citadel-worker-agent-queue-{env}` (for worker tasks) and `citadel-fabricator-queue-{env}` (for agent/tool creation requests).

### Backend → Services

- The `agent-message-handler` Lambda invokes the AgentCore Runtime (`agent_intake_single`) for assessment, design, and planning conversations
- The `document-upload-resolver` ingests documents into the Bedrock Knowledge Base via the inline data source
- The `integration-resolver` creates gateway targets on the AgentCore Gateway for MCP-protocol integrations

### Backend → Gateway

- The `app-resolver` calls the `app-publish-handler` Lambda to provision per-app API Gateway HTTP APIs
- Each published app gets its own API Gateway endpoint with a shared Lambda authorizer (`app-api-authorizer`)
- API Gateway routes requests to EventBridge via an IAM role, which triggers the Supervisor with the app's `appId`

### Arbiter Internal Flow

```
User request (via EventBridge or SQS)
  → Supervisor (index.py)
      → Loads agent configs from DynamoDB
      → Calls Bedrock Claude Sonnet 4 to plan and select agents
      → Sends tasks to Worker queue or Fabricator queue via SQS
  → Worker Wrapper (workerWrapper/index.py)
      → Loads agent config + tool configs from DynamoDB
      → Calls Credential Vender Lambda for scoped IAM credentials
      → Spawns isolated subprocess (agent_runner.py) with scoped creds
      → Publishes completion event to EventBridge
  → Fabricator (fabricator/index.py)
      → Uses Bedrock to generate Python tool/agent code
      → Uploads code to S3, stores config in DynamoDB
      → Publishes fabrication event to EventBridge
  → Step Runner (stepRunner/)
      → Receives workflow execution events from EventBridge
      → Advances DAG execution: topological sort → invoke ready nodes → handle completions
      → Publishes node lifecycle events for real-time subscription fan-out
```

## Data Flow Diagrams

### Request Lifecycle (Agent App Execution)

```
Client → API Gateway (per-app) → Lambda Authorizer (validates API key)
  → EventBridge (task.request with appId)
  → Supervisor Lambda
      → load_app_scoped_agents(appId) — queries GroupIndex for READY agent bindings
      → Bedrock Converse API (with circuit breaker)
      → SQS → Worker Wrapper
          → Credential Vender → PolicyManager.assumeScopedRole()
          → Subprocess execution with scoped credentials
      → EventBridge (task.completion)
  → Supervisor (continues orchestration or returns final response)
  → EventBridge (task.response) or callback (SQS/EventBridge/MCP webhook)
```

### Workflow Execution Lifecycle

```
Frontend: "Run Workflow" button
  → startExecution mutation → Execution Resolver
      → Creates Execution item (status=pending) in DynamoDB
      → Publishes execution.start.requested to EventBridge
  → Step Runner Lambda picks up event
      → start_execution(): topological sort, find root nodes, invoke them
      → Publishes workflow.node.invoke events
  → Worker Wrapper executes agent nodes
      → Publishes workflow.node.completed or workflow.node.failed
  → Step Runner picks up completion
      → handle_node_completion(): evaluate conditional edges, find ready nodes
      → Invoke next batch (parallel branches execute concurrently)
      → Convergence nodes wait for all predecessors
  → When all nodes complete:
      → Step Runner marks execution as completed
      → Publishes workflow.completed
  → Subscription Fan-out Lambda
      → Receives workflow.* events from EventBridge
      → Calls publishWorkflowProgress AppSync mutation (IAM auth)
      → Frontend receives onWorkflowProgress subscription updates
      → Execution Overlay updates node status badges in real-time
```

### Credential Vending Flow

```
Worker Wrapper receives task from SQS
  → Loads agent config from DynamoDB
  → Loads tool configs via BatchGetItem
  → aggregate_tool_bindings() → collects integration/datastore IDs
  → _merge_required_permissions() → combines agent + tool permissions
  → Invokes Credential Vender Lambda (TypeScript)
      → computeAgentPolicies() → generates PolicyStatement[]
      → PolicyManager.ensureRole(agentId, policies, accountId, 'agent')
          → Creates IAM role: citadel-agent-{agentId}
          → Attaches inline policy with declared permissions
      → PolicyManager.assumeScopedRole(agentId, accountId, 'agent')
          → STS AssumeRole with retry + exponential backoff
          → Returns temporary credentials (1-hour session)
  → Worker Wrapper spawns subprocess with scoped creds in child env
  → Parent process retains original Lambda IAM role (never modified)
```

## DynamoDB Tables

| Table | Primary Key | GSIs | Purpose |
|-------|-------------|------|---------|
| `citadel-projects-{env}` | `id` | `OrganizationIndex` (orgId/createdAt) | Project metadata |
| `citadel-conversations-{env}` | `projectId` + `timestamp` | — | Conversation history |
| `citadel-agents-{env}` | `agentId` | — | Agent configurations |
| `citadel-tools-{env}` | `toolId` | — | Tool configurations |
| `citadel-apps-{env}` | `appId` | `OrgIndex`, `GroupIndex` (groupId/sortId) | App metadata + components |
| `citadel-workflows-{env}` | `workflowId` | `OrgStatusIndex`, `BlueprintIndex` | Workflow definitions |
| `citadel-executions-{env}` | `executionId` | `WorkflowIndex` (workflowId/startedAt) | Execution state |
| `citadel-agent-orchestration-{env}` | `orchestrationId` | — | Supervisor conversation state |
| `citadel-worker-state-{env}` | `requestId` | — | Parallel worker tracking |
| `citadel-idempotency-{env}` | `eventId` | — | EventBridge dedup (TTL: 24h) |
| `citadel-session-memory-{env}` | `p_key` + `s_key` | — | AgentCore session memory |
| `citadel-datastores-{env}` | `dataStoreId` | — | Datastore configurations |
| `citadel-integrations-{env}` | `integrationId` | — | Integration configurations |

## CDK Stack Dependencies

```
BackendStack (core infra — no dependencies)
  ├── ServicesStack (depends on: BackendStack.eventBus, BackendStack.documentBucket)
  ├── ArbiterStack (depends on: BackendStack.eventBus, BackendStack.agentConfigTable,
  │                              BackendStack.codeBucket, BackendStack.appsTable,
  │                              BackendStack.workflowsTable, BackendStack.executionsTable)
  ├── GatewayStack (depends on: BackendStack.appsTable, BackendStack.eventBus,
  │                              BackendStack.idempotencyTable)
  └── FrontendStack (depends on: BackendStack.appSyncApi, BackendStack.userPool)

KnowledgeBaseStack — standalone (Bedrock Knowledge Base for document ingestion)
PipelineStack — standalone (CI/CD CodePipeline, self-mutating, multi-env)
```

## Key Architectural Patterns

### Unified Adapter Pattern

All 27 datastore types and 13 integration types implement the same `ConnectorAdapter` interface from `backend/src/adapters/base.ts`. This provides a consistent lifecycle (provision → connect → test → disconnect → deprovision) and policy declaration (`requiredPolicies()`) across every connector type. The `UnifiedRegistry` singleton maps type strings to adapter instances.

### Subprocess Isolation

Worker agents run user-uploaded Python code in an isolated subprocess (`subprocess.run(env=child_env)`). Scoped credentials are passed only to the child process environment — the parent Lambda's `os.environ` is never modified. This prevents credential exfiltration, cross-agent leakage, and cleanup fragility.

### Circuit Breaker

The Supervisor uses a circuit breaker for Bedrock API calls with three states: CLOSED (normal), OPEN (rejecting — after 3 failures), HALF_OPEN (probe after 30s recovery timeout). Retries use exponential backoff with full jitter. This prevents cascading failures when Bedrock is throttled or unavailable.

### Idempotent Event Processing

All EventBridge-triggered Lambda handlers use the `IdempotencyGuard` class, which performs a conditional DynamoDB put (`attribute_not_exists(eventId)`) before processing. Duplicate events are silently skipped. Items expire via TTL after 24 hours.

### Component Table Pattern

The `citadel-apps-{env}` table uses a single-table design with a `GroupIndex` GSI (partition key: `groupId`, sort key: `sortId`). App metadata uses `groupId = APP#{appId}`, `sortId = METADATA`. Child components (agent bindings, permissions, config) use the same `groupId` with type-prefixed `sortId` values (e.g., `AGENT#{agentId}`, `PERMISSION#{permissionId}`). A single query on the GSI returns the app and all its components.

### Lifecycle State Machine

Datastores and integrations use the `LifecycleManager` class with parameterized `TransitionMap` definitions. Valid status transitions and allowed actions per status are declared as data, not code. Invalid transitions throw descriptive errors. Same-status transitions are always valid (idempotent).

### Optimistic Locking

All state-mutating operations on workflows, apps, and config use version-based optimistic locking. DynamoDB conditional writes check `version = :expectedVersion` and increment on success. On conflict, resolvers return a descriptive error and the frontend reloads the latest version.

### Configurable Model Resolution

The Bedrock model each arbiter role uses is resolved at runtime rather than hardcoded. At cold start the Supervisor, Fabricator, and the intake/extraction agents read a platform config row and a model catalog from DynamoDB (`citadel-model-config-{env}` and `citadel-model-catalog-{env}`) and run a pure, dependency-free resolver. The resolver walks a precedence chain (agent override → org default → slot default → global default), validates the candidate against the slot's requirements (modality, tool use, Converse), and maps it to a cross-region Bedrock inference profile for the deployment region. Every failure mode — missing config, malformed row, disabled model, or read error — falls back to a caller-supplied default, so model configuration can never break dispatch. The catalog is kept current by a daily EventBridge-scheduled sync against the live Bedrock inventory (also triggerable on demand) and curated through an admin-only Model Configuration UI. See [MODEL_SELECTION.md](./MODEL_SELECTION.md).

## Authentication and Authorization

### User Authentication

- Cognito User Pools handle email/password authentication
- Four RBAC groups: `admin`, `project_manager`, `architect`, `developer`
- AppSync uses `@aws_cognito_user_pools` directive for user-facing operations
- AppSync uses `@aws_iam` directive for service-to-service operations (fan-out, progress publishing)

### Organization-Scoped Access

Every resolver operation follows the same pattern:
1. Extract `userId` from AppSync identity (Cognito `sub`)
2. Call `AdminGetUser` to get the `custom:organization` attribute
3. Compare against the resource's `orgId`
4. Throw "Access denied" if mismatch

Admins see all organizations; non-admins see only their own.

### App-Level RBAC

Published apps support owner/editor/viewer roles via the `grantAppAccess` / `revokeAppAccess` mutations. The `app-access-control` Lambda enforces these roles on app-specific operations.

### API Key Authentication (Published Apps)

Each published app gets a per-app API Gateway HTTP API. A shared Lambda authorizer (`app-api-authorizer`) validates API keys stored in the `citadel-apps-{env}` table. Keys support expiry, revocation, and rotation via the `createAppApiKey`, `revokeAppApiKey`, and `rotateAppApiKey` mutations.

### Scoped IAM Roles

The `PolicyManager` creates dedicated IAM roles per resource:

| Scope | Role Pattern | Created By |
|-------|-------------|------------|
| Datastore | `citadel-ds-{dataStoreId}` | Datastore resolver on connect/provision |
| Integration | `citadel-int-{integrationId}` | Integration resolver on connect |
| Agent | `citadel-agent-{agentId}` | Credential vender on agent execution |
| App | `citadel-agent-{appId}` | App resolver on publish |

Each role gets a trust policy allowing only the creating Lambda's execution role to assume it, and an inline policy with exactly the declared permissions.
