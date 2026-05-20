# Data Stores and Integrations

The data store and integration subsystem provides a unified interface for registering, provisioning, connecting, and managing diverse storage backends and third-party services. It uses an adapter pattern to abstract away service-specific details behind a common lifecycle, and extends this with usage tagging, binding direction, health monitoring, tool testing, and a pipeline wizard for building input→process→output data flow tools. The integration subsystem connects the Citadel platform to third-party SaaS services and AWS-native resources, shares a unified adapter architecture with data stores, extends tool creation with integration bindings and directional data flow, and provides reusable frontend components for integration selection and operation configuration.

## Table of Contents

- [Data Stores and Integrations](#data-stores-and-integrations)
  - [Table of Contents](#table-of-contents)
  - [Architecture Overview](#architecture-overview)
    - [Data Stores Architecture](#data-stores-architecture)
    - [Integrations Architecture](#integrations-architecture)
  - [Core Concepts](#core-concepts)
    - [Usage Tagging](#usage-tagging)
    - [Integration Types](#integration-types)
    - [Operations Registry](#operations-registry)
    - [Read-Only Operations by Data Store Type](#read-only-operations-by-data-store-type)
    - [Integration Bindings](#integration-bindings)
    - [Binding Direction](#binding-direction)
    - [Scoped IAM Roles](#scoped-iam-roles)
  - [Component Map](#component-map)
    - [Backend](#backend)
    - [Frontend](#frontend)
  - [How It Works](#how-it-works)
    - [Creating a Data Store](#creating-a-data-store)
    - [Creating a Tool from an Integration](#creating-a-tool-from-an-integration)
    - [Creating a Tool with the Build Agent Tool Wizard](#creating-a-tool-with-the-build-agent-tool-wizard)
    - [Using an Integration in a Build Agent Tool Wizard](#using-an-integration-in-a-build-agent-tool-wizard)
    - [Health Monitoring](#health-monitoring)
    - [Testing a Tool in the Sandbox](#testing-a-tool-in-the-sandbox)
    - [Runtime Credential Resolution](#runtime-credential-resolution)
  - [Data Flows](#data-flows)
    - [Health Monitoring Flow](#health-monitoring-flow)
    - [Tool Testing Sandbox Flow](#tool-testing-sandbox-flow)
    - [Build Agent Tool Creation Flow](#build-agent-tool-creation-flow)
    - [Integration Tool Creation](#integration-tool-creation)
    - [Runtime Credential Flow](#runtime-credential-flow)
  - [Naming Conventions](#naming-conventions)
  - [Retry and Resilience](#retry-and-resilience)
    - [Optimistic Locking](#optimistic-locking)
    - [Idempotent Creation](#idempotent-creation)
    - [Health Monitor Resilience](#health-monitor-resilience)
    - [Tool Sandbox Resilience](#tool-sandbox-resilience)
    - [Build Tool Wizard Resilience](#build-tool-wizard-resilience)
    - [Credential Resolution](#credential-resolution)
    - [Operations Registry Resilience](#operations-registry-resilience)
    - [Worker\_Wrapper Binding Aggregation](#worker_wrapper-binding-aggregation)
    - [Frontend Components](#frontend-components)
  - [Error Handling](#error-handling)
    - [DataStore Resolver](#datastore-resolver)
    - [Tool Config Resolver](#tool-config-resolver)
    - [Health Monitor](#health-monitor)
    - [Tool Testing Sandbox](#tool-testing-sandbox)
    - [Integration Resolver](#integration-resolver)
    - [ToolConfig Resolver (Integration Bindings)](#toolconfig-resolver-integration-bindings)
    - [Operations Registry Errors](#operations-registry-errors)
    - [Credential Vender](#credential-vender)
    - [Frontend Error Handling](#frontend-error-handling)
    - [Structured Logging](#structured-logging)
  - [Testing Strategy](#testing-strategy)
    - [Property-Based Tests](#property-based-tests)
    - [Additional Test Coverage](#additional-test-coverage)
    - [Running Tests](#running-tests)
    - [Test Organization](#test-organization)
  - [Architectural Decisions](#architectural-decisions)
  - [Design Principles](#design-principles)
    - [Security](#security)
    - [Reliability](#reliability)
    - [Operational Excellence](#operational-excellence)
    - [Performance Efficiency](#performance-efficiency)
    - [Cost Optimization](#cost-optimization)
  - [Best Practice Alignment](#best-practice-alignment)
    - [AWS Well-Architected Framework](#aws-well-architected-framework)
    - [SOLID Principles](#solid-principles)
  - [Adding Data Stores and Integrations to a New Component](#adding-data-stores-and-integrations-to-a-new-component)
    - [1. Reuse the Integration Picker](#1-reuse-the-integration-picker)
    - [2. Reuse the Operation Config Form](#2-reuse-the-operation-config-form)
    - [3. Use the Usage Filter Utility](#3-use-the-usage-filter-utility)
    - [4. Use the Operation Filtering Utility](#4-use-the-operation-filtering-utility)
    - [5. Filter Integrations Programmatically](#5-filter-integrations-programmatically)
    - [6. Build Directional Bindings](#6-build-directional-bindings)
    - [7. Build Integration Bindings for a Tool](#7-build-integration-bindings-for-a-tool)
    - [8. Query the Discovery API](#8-query-the-discovery-api)
    - [9. Query Available Operations](#9-query-available-operations)
    - [10. Add a New Data Store Adapter](#10-add-a-new-data-store-adapter)
    - [11. Add a New Integration Type to the Operations Registry](#11-add-a-new-integration-type-to-the-operations-registry)

## Architecture Overview

### Data Stores Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                           Frontend                                  │
│  ┌─────────────┐ ┌──────────────┐ ┌──────────────┐ ┌─────────────┐  │
│  │ DataStores  │ │ DataStore    │ │ Integration  │ │ Data        │  │
│  │ Page +      │ │ Tool Wizard  │ │ Tool Wizard  │ │ Pipeline    │  │
│  │ Usage Tabs  │ │ (Usage-Aware)│ │ (Direction)  │ │ Wizard      │  │
│  └──────┬──────┘ └──────┬───────┘ └──────┬───────┘ └──────┬──────┘  │
│         │               │                │                │         │
│  ┌──────┴──────┐ ┌──────┴───────┐ ┌──────┴───────┐ ┌──────┴─────┐   │
│  │ Integration │ │ Operation    │ │ ToolCard +   │ │ Tool       │   │
│  │ Picker      │ │ Config Form  │ │ Dir Badges   │ │ Testing    │   │
│  │ (Reusable)  │ │ (Reusable)   │ │              │ │ Sandbox    │   │
│  └─────────────┘ └──────────────┘ └──────────────┘ └────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
                              │
                    ┌─────────┴──────────┐
                    ▼                    ▼
┌───────────────────────────┐  ┌──────────────────────────┐
│      GraphQL API          │  │      Backend Lambdas     │
│  ┌─────────────────────┐  │  │  ┌────────────────────┐  │
│  │ datastore-resolver  │  │  │  │ Health Monitor     │  │
│  │ + usage field       │  │  │  │ (EventBridge 15m)  │  │
│  │ + discovery API     │  │  │  └────────────────────┘  │
│  ├─────────────────────┤  │  │  ┌────────────────────┐  │
│  │ tool-config-resolver│  │  │  │ Tool Sandbox       │  │
│  │ + direction field   │  │  │  │ (30s timeout)      │  │
│  ├─────────────────────┤  │  │  └────────────────────┘  │
│  │ testTool mutation   │  │  │  ┌────────────────────┐  │
│  └─────────────────────┘  │  │  │ Fabricator         │  │
└───────────────────────────┘  │  │ + directional code │  │
                               │  └────────────────────┘  │
                               └──────────────────────────┘
                                            │
                            ┌───────────────┼───────────────┐
                            ▼               ▼               ▼
                       ┌──────────┐   ┌──────────┐   ┌──────────┐
                       │ DynamoDB │   │ S3       │   │ AWS STS  │
                       │ (state)  │   │ (code)   │   │ (creds)  │
                       └──────────┘   └──────────┘   └──────────┘
```

### Integrations Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                           Frontend                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────┐              │
│  │ Integration  │  │ Integration  │  │ Data Pipeline │              │
│  │ Tool Wizard  │  │ Picker       │  │ Wizard        │              │
│  │ (Direction)  │  │ (Reusable)   │  │ (Input/Output)│              │
│  └──────┬───────┘  └──────┬───────┘  └──────┬────────┘              │
│         │                 │                 │                       │
│  ┌──────┴───────┐  ┌──────┴───────┐  ┌──────┴────────┐              │
│  │ Operation    │  │ ToolCard +   │  │ Tool Testing  │              │
│  │ Config Form  │  │ Dir Badges   │  │ Sandbox       │              │
│  │ (Reusable)   │  │              │  │               │              │
│  └──────────────┘  └──────────────┘  └───────────────┘              │
└─────────────────────────────────────────────────────────────────────┘
                              │
                    ┌─────────┴──────────┐
                    ▼                    ▼
┌───────────────────────────┐  ┌──────────────────────────┐
│      GraphQL API          │  │      Backend             │
│  ┌─────────────────────┐  │  │  ┌────────────────────┐  │
│  │ tool-config-resolver│  │  │  │ Operations         │  │
│  │ + direction field   │  │  │  │ Registry           │  │
│  ├─────────────────────┤  │  │  ├────────────────────┤  │
│  │ listIntegration     │  │  │  │ Credential Vender  │  │
│  │ Operations query    │  │  │  │ + directional      │  │
│  ├─────────────────────┤  │  │  │   scoping          │  │
│  │ integration-resolver│  │  │  ├────────────────────┤  │
│  │ (CRUD)              │  │  │  │ PolicyManager      │  │
│  └─────────────────────┘  │  │  │ (scoped IAM roles) │  │
└───────────────────────────┘  │  └────────────────────┘  │
                               │  ┌────────────────────┐  │
                               │  │ Fabricator         │  │
                               │  │ + directional code │  │
                               │  │   generation       │  │
                               │  └────────────────────┘  │
                               └──────────────────────────┘
                                            │
                            ┌───────────────┼───────────────┐
                            ▼               ▼               ▼
                       ┌──────────┐   ┌──────────┐   ┌──────────┐
                       │ DynamoDB │   │ Secrets  │   │ AWS STS  │
                       │ (state)  │   │ Manager  │   │ (creds)  │
                       └──────────┘   └──────────┘   └──────────┘
```

## Core Concepts

### Usage Tagging

Every data store has a `usage` field classifying its intended purpose:

| Usage | Description | Default Operations |
|-------|-------------|-------------------|
| `KNOWLEDGE` | Read-only reference data (e.g., knowledge bases, document stores) | Read-only subset per type |
| `OPERATIONAL` | Read-write transactional data (e.g., application databases) | Full CRUD |
| `BOTH` | Serves both purposes (default for new and legacy stores) | Full CRUD |

The usage field lives on the DataStore item, not on bindings. Legacy items without a `usage` field default to `BOTH`.

### Integration Types

The platform supports three categories of integrations:

| Category | Types | Operation Discovery |
|----------|-------|-------------------|
| SaaS | CONFLUENCE, JIRA, SLACK, SERVICENOW, ZENDESK, PAGERDUTY, MICROSOFT | Static Operations Registry |
| AgentCore | AWS_LAMBDA, AWS_SMITHY, MCP_SERVER | Dynamic (runtime discovery) |
| External | Custom API endpoints | Manual configuration |

### Operations Registry

A static backend registry maps data store types and integration types to operation descriptors. Each operation has an ID, name, description, method, and parameter list. The registry is used by:

- The DataStore Tool Wizard to show available operations
- The Discovery API to populate `capabilities`
- The Fabricator to understand what operations a tool can perform

```typescript
interface OperationDescriptor {
  operationId: string;    // e.g., "search_pages"
  name: string;           // e.g., "Search Pages"
  description: string;    // Human-readable description
  method: string;         // "GET" | "POST" | "PUT" | "DELETE"
  parameters: OperationParameter[];
}
```

AgentCore types (`AWS_LAMBDA`, `AWS_SMITHY`, `MCP_SERVER`) return empty arrays from the registry since they discover operations dynamically at runtime. Unknown types also return empty arrays without throwing errors.

### Read-Only Operations by Data Store Type

When a knowledge store is selected, only these operations are available by default:

| Data Store Type | Read-Only Operations | Excluded Write Operations |
|---|---|---|
| S3 | `read_object`, `list_objects` | `write_object`, `delete_object` |
| DYNAMODB | `get_item`, `query`, `scan` | `put_item`, `delete_item` |
| RDS_*, AURORA_* | `execute_query`, `list_tables` | (none) |
| KNOWLEDGE_BASE | `query_knowledge_base`, `retrieve_documents` | (none) |
| REDSHIFT | `execute_query`, `list_tables` | (none) |
| OPENSEARCH | `search` | `index_document`, `delete_document` |
| NEPTUNE | `execute_query`, `list_graphs` | (none) |
| TIMESTREAM | `query` | `write_records` |
| DOCUMENTDB | `find` | `insert`, `update`, `delete` |
| ELASTICACHE_REDIS | `get`, `scan` | `set`, `delete` |
| Other | `read` | `write` |

### Integration Bindings

When a tool is created that uses an integration, the tool's `ToolConfig` includes an `integrationBindings` array:

```json
{
  "integrationBindings": [
    {
      "integrationId": "int-abc123",
      "integrationType": "CONFLUENCE",
      "operations": ["search_pages", "get_page"],
      "direction": "INPUT"
    }
  ]
}
```

Each binding declares:

- Which integration the tool uses (`integrationId`)
- The integration type for adapter lookup (`integrationType`)
- Which operations the tool performs (`operations`)
- The data flow direction (`direction`: `INPUT`, `OUTPUT`, or `BIDIRECTIONAL`)

### Binding Direction

Every tool binding declares how the tool uses a resource:

| Direction | Description | Code Generation | Credential Scope |
|-----------|-------------|-----------------|-------------------|
| `INPUT` | Tool reads from the resource | Read-only code | Read permissions only |
| `OUTPUT` | Tool writes to the resource | Write-only code | Write permissions only |
| `BIDIRECTIONAL` | Tool reads and writes (default) | Read+write code | Full permissions |

The direction field lives on bindings, not on DataStore or Integration items. The same S3 bucket can be an input for one tool and an output for another. Legacy bindings without a `direction` field default to `BIDIRECTIONAL`.

### Scoped IAM Roles

Each integration gets a dedicated IAM role: `citadel-int-{integrationId}`. When an agent runs a tool with integration bindings, the Worker_Wrapper aggregates all binding IDs and passes them to the Credential Vender, which assumes the scoped roles via STS to provide least-privilege temporary credentials.

## Component Map

### Backend

| Component | File | Purpose |
|-----------|------|---------|
| DataStore Resolver | `backend/src/lambda/datastore-resolver.ts` | CRUD for data stores, usage field, discovery API |
| Integration Resolver | `backend/src/lambda/integration-resolver.ts` | CRUD for integrations (create, connect, disconnect, test) |
| ToolConfig Resolver | `backend/src/lambda/tool-config-resolver.ts` | CRUD for tool configs with direction field and integration bindings |
| Health Monitor | `backend/src/lambda/health-monitor.ts` | Scheduled health checks on CONNECTED/ERROR stores |
| Tool Sandbox | `backend/src/lambda/tool-sandbox.ts` | Isolated tool execution with scoped credentials |
| Operations Registry | `backend/src/utils/operations-registry.ts` | Static mapping of types to operation descriptors |
| Adapter Registry | `backend/src/lambda/adapters/registry.ts` | Type → adapter instance mapping (27 data store adapters + 13 integration adapters) |
| PolicyManager | `backend/src/utils/policy-manager.ts` | Scoped IAM role creation and assumption; creates `citadel-int-{id}` IAM roles |
| policy-helpers | `backend/src/utils/policy-helpers.ts` | `computeIntegrationPolicies()` for per-integration scoped policies |
| Credential Vender | `arbiter/workerWrapper/` | Scoped credential resolution for integration bindings |
| Fabricator | `arbiter/fabricator/tools_config.py` | Directional code generation instructions for integration bindings |
| GraphQL Schema | `backend/src/schema/schema.graphql` | DataStoreUsage, IntegrationType, BindingDirection enums, binding types |
| CDK Stack | `backend/lib/services-stack.ts` | Health Monitor + Tool Sandbox Lambda definitions |

### Frontend

| Component | File | Purpose |
|-----------|------|---------|
| DataStores Page | `frontend/src/pages/DataStores.tsx` | Usage filter tabs (All/Knowledge/Writable) |
| Usage Filter Utils | `frontend/src/pages/datastoreFilterUtils.ts` | Pure filter function for usage tabs |
| DataStore Tool Wizard | `frontend/src/components/DataStoreToolWizard.tsx` | Usage-aware operation filtering, direction selector |
| Wizard Usage Utils | `frontend/src/components/datastore-wizard-usage-utils.ts` | Operation filtering by usage type |
| Integration Picker | `frontend/src/components/IntegrationPicker.tsx` | Reusable integration selection with status badges and type filtering |
| Picker Utils | `frontend/src/components/integration-picker-utils.ts` | Pure `filterIntegrationsByType()` function |
| Operation Config Form | `frontend/src/components/OperationConfigForm.tsx` | Dynamic parameter form from Operations Registry |
| Integration Tool Wizard | `frontend/src/components/IntegrationToolWizard.tsx` | Guided tool creation with integration binding + direction |
| Data Pipeline Wizard | `frontend/src/components/DataPipelineWizard.tsx` | Input→process→output tool builder (reuses IntegrationPicker) |
| Pipeline Utils | `frontend/src/components/pipeline-wizard-utils.ts` | Directional binding construction |
| Tool Testing Sandbox | `frontend/src/components/ToolTestingSandbox.tsx` | Test tool with sample inputs, view results |
| ToolCard | `frontend/src/components/ToolCard.tsx` | Direction badges (← → ↔) on integration bindings, test button with error boundary |
| Badge Helpers | `frontend/src/components/tool-card-badge-helpers.ts` | Direction arrow rendering for binding badges |
| DataStore Card | `frontend/src/components/DataStoreCard.tsx` | Usage badge, error warning icon |
| DataStore Service | `frontend/src/services/datastoreService.ts` | DataStoreUsage enum, usage in GraphQL fragments |
| ToolConfig Service | `frontend/src/services/toolConfigService.ts` | `BindingDirection` type, `IntegrationBinding` interface, direction in fragments |
| Integration Service | `frontend/src/services/integrationService.ts` | Integration listing, connection management |
| AgentTools Page | `frontend/src/pages/AgentTools.tsx` | "Wrap an Integration" and "Build a Tool" entry points in Create Tool menu |

## How It Works

### Creating a Data Store

1. User opens the DataStores page and clicks "Create Data Store"
2. The wizard collects name, type, category, provision mode, config, credentials, and usage
3. `createDataStore` mutation persists the item to DynamoDB with `usage` defaulting to `BOTH`
4. The resolver validates usage at the enum layer (GraphQL) and resolver layer (defense in depth)
5. The adapter provisions or connects the resource, creates a scoped IAM role, stores credentials in Secrets Manager
6. The store appears on the DataStores page with a usage badge

### Creating a Tool from an Integration

1. User opens Tools → Create Tool → "Wrap an Integration"
2. The wizard lists connected integrations with status badges (green=CONNECTED, yellow=CONNECTING, red=ERROR, gray=DISCONNECTED)
3. User selects an integration (e.g., Confluence)
4. For SaaS types, the wizard fetches operations from `listIntegrationOperations` and displays them as selectable cards
5. For AgentCore types (AWS_LAMBDA, AWS_SMITHY, MCP_SERVER), the operation step is skipped
6. User selects a binding direction (Input, Output, or Bidirectional — defaults to Bidirectional)
7. User configures tool name and description
8. On submit, the wizard calls the Fabricator with `integrationBindings` containing the selected integration ID, type, operations, and direction
9. The Fabricator generates Python code with directional instructions and persists the ToolConfig

### Creating a Tool with the Build Agent Tool Wizard

1. User opens Tools → Create Tool → "Build a Tool"
2. Step 1: Select an input source (data store or integration), choose read operations → direction auto-set to `INPUT`
3. Step 2: Describe the processing logic in natural language
4. Step 3: Select an output destination, choose write operations → direction auto-set to `OUTPUT`
5. Step 4: Configure tool name and description
6. Step 5: Review the visual flow summary (Input → Processing → Output)
7. On submit, the wizard calls the Fabricator with directional bindings
8. The Fabricator generates Python code respecting direction (read-only for input, write-only for output)
9. The ToolConfig is persisted with `dataStoreBindings` / `integrationBindings` containing `direction` fields

### Using an Integration in a Build Agent Tool Wizard

1. User opens Tools → Create Tool → "Build a Tool"
2. In the input source step, user switches to the "Integration" tab
3. The IntegrationPicker component displays connected integrations
4. User selects an integration as input → direction auto-set to `INPUT`
5. In the output destination step, user can select another integration as output → direction auto-set to `OUTPUT`
6. The pipeline wizard constructs bindings with correct directions and submits to the Fabricator

### Health Monitoring

1. EventBridge triggers the Health Monitor Lambda every 15 minutes
2. The Lambda scans DynamoDB for stores with status `CONNECTED` or `ERROR`
3. Stores are processed in parallel batches of 10 using `Promise.allSettled`
4. For each store, the adapter's `testConnection` method is called
5. On success: if previously `ERROR`, status updates to `CONNECTED` and `errorMessage` is cleared
6. On failure: status updates to `ERROR` with the error message
7. Each store is independent — one failure doesn't block others

### Testing a Tool in the Sandbox

1. User clicks the test button on a ToolCard
2. The ToolTestingSandbox renders input fields from the tool's JSON schema
3. User enters sample inputs and clicks "Run Test"
4. The `testTool` mutation invokes the Tool Sandbox Lambda
5. The Lambda loads tool code from S3, resolves scoped credentials, executes with a 30-second timeout
6. Results display with green/red indicator, formatted output, and execution time
7. History retains the last 5 test runs per session

### Runtime Credential Resolution

1. An agent task arrives via SQS
2. The Worker_Wrapper loads the agent's tool configs from DynamoDB (using `BatchGetItem` for efficiency)
3. It aggregates all `integrationBindings` from all tools, collecting unique `integrationId` values
4. These are merged with agent-level `requiredPermissions.integrations`
5. The Credential Vender generates `sts:AssumeRole` statements for each `citadel-int-{id}` role
6. The agent subprocess receives scoped temporary credentials

## Data Flows

### Health Monitoring Flow

```
EventBridge (15 min) → Health Monitor Lambda
  → DynamoDB Scan (CONNECTED + ERROR stores)
  → For each batch of 10 (parallel):
      → getAdapter(store.type).testConnection(config, credentials)
      → Success: Update status=CONNECTED, clear errorMessage
      → Failure: Update status=ERROR, set errorMessage
  → Log structured results
```

### Tool Testing Sandbox Flow

```
User → ToolTestingSandbox UI → testTool GraphQL mutation
  → Tool Sandbox Lambda
      → Load tool config from DynamoDB
      → Load tool code from S3
      → Resolve scoped credentials via Credential Vender
      → Execute tool in isolated VM context (30s timeout)
  → Return ToolTestResult (success, output, error, executionTimeMs)
  → Display result in UI
```

### Build Agent Tool Creation Flow

```
User → DataPipelineWizard
  → Select input source (direction=INPUT)
  → Describe processing logic
  → Select output destination (direction=OUTPUT)
  → Configure tool name/description
  → Review & Submit
      → buildPipelineToolPayload() constructs directional bindings
      → fabricatorService.requestToolCreation(payload)
      → Fabricator generates code with directional instructions
      → ToolConfig persisted with INPUT + OUTPUT bindings
```

### Integration Tool Creation

```
User → IntegrationToolWizard
  → Select integration (e.g., Confluence)
  → Fetch operations via listIntegrationOperations("CONFLUENCE")
  → Select operations (e.g., search_pages, get_page)
  → Select direction (e.g., INPUT)
  → Configure tool name/description
  → Review & Submit
      → fabricatorService.requestToolCreation({
          integrationBindings: [{
            integrationId: "int-abc123",
            integrationType: "CONFLUENCE",
            operations: ["search_pages", "get_page"],
            direction: "INPUT"
          }]
        })
      → Fabricator generates read-only code
      → ToolConfig persisted with binding
```

### Runtime Credential Flow

```
SQS → Worker_Wrapper
  → Load agent config from DynamoDB
  → Load tool configs via BatchGetItem
  → aggregate_tool_bindings() → { integrations: ["int-abc123"] }
  → Merge with agent-level requiredPermissions
  → Credential Vender → computeAgentPolicies()
      → sts:AssumeRole on arn:aws:iam::{account}:role/citadel-int-int-abc123
  → Agent subprocess runs with scoped credentials
```

## Naming Conventions

| Entity | Pattern | Example |
|--------|---------|---------|
| DataStore DynamoDB table | `citadel-datastores-{env}` | `citadel-datastores-dev` |
| Integration DynamoDB table | `citadel-integrations-{env}` | `citadel-integrations-dev` |
| DataStore Secrets Manager | `/citadel/datastores/{orgId}/{type}-{id}` | `/citadel/datastores/org-001/s3-ds-abc123` |
| Integration Secrets Manager | `/citadel/integrations/{orgId}/{type}-{id}` | `/citadel/integrations/org-001/confluence-int-abc123` |
| Scoped IAM role (datastore) | `citadel-ds-{dataStoreId}` | `citadel-ds-ds-abc123` |
| Scoped IAM role (integration) | `citadel-int-{integrationId}` | `citadel-int-int-abc123` |
| Scoped IAM role (agent) | `citadel-agent-{agentId}` | `citadel-agent-agent-001` |
| Health Monitor Lambda | `citadel-health-monitor-{env}` | `citadel-health-monitor-dev` |
| Tool Sandbox Lambda | `citadel-tool-sandbox-{env}` | `citadel-tool-sandbox-dev` |
| EventBridge rule | `citadel-health-check-{env}` | `citadel-health-check-dev` |
| GraphQL enums | PascalCase | `DataStoreUsage`, `BindingDirection` |
| GraphQL enum values | UPPER_SNAKE_CASE | `KNOWLEDGE`, `OPERATIONAL`, `BOTH`, `INPUT`, `OUTPUT`, `BIDIRECTIONAL` |
| Operation IDs | snake_case | `search_pages`, `get_page`, `create_page` |
| Integration types | UPPER_SNAKE_CASE | `CONFLUENCE`, `JIRA`, `AWS_LAMBDA`, `MCP_SERVER` |

## Retry and Resilience

### Optimistic Locking

All state-mutating operations use version-based optimistic locking. DynamoDB conditional writes check `version = :expectedVersion` and increment on success. A `retryOptimisticLock` wrapper retries up to 3 times with exponential backoff (100ms base delay).

### Idempotent Creation

`createDataStore` supports a `clientRequestToken` field. If a request with the same token already exists for the org, the existing item is returned without creating a duplicate.

### Health Monitor Resilience

- Each store is processed independently — one failure doesn't block others
- `Promise.allSettled` ensures all stores in a batch are attempted even if some throw
- If the Lambda times out, already-processed stores retain their updated status
- DynamoDB throttling causes the store to retain its previous status; the next run retries

### Tool Sandbox Resilience

- 30-second execution timeout prevents runaway tools
- 512MB memory limit prevents excessive resource consumption
- Tool not found, code not found, and credential failures return structured error responses
- Runtime errors in tool code are caught and returned as `ToolTestResult` with `success: false`

### Build Tool Wizard Resilience

- `Promise.allSettled` loads data stores and integrations independently
- If one API fails, the other's results are still shown
- Error is only displayed when both fail
- Fabricator submission failures preserve wizard state for retry

### Credential Resolution

- Each integration role assumption is independent — failure to assume one role doesn't block others
- If an integration was disconnected between tool creation and runtime, the Credential Vender skips the missing role with a warning
- The agent still runs with credentials for remaining valid bindings

### Operations Registry Resilience

- Returns empty arrays for unknown or AgentCore types — no errors thrown
- Frontend wizards handle empty operations by skipping the operation selection step
- A new integration type without registry entries doesn't block tool creation

### Worker_Wrapper Binding Aggregation

- Missing tool configs are skipped with a warning log
- Malformed bindings are caught and skipped — the agent still runs
- When no tools have bindings, the aggregation short-circuits entirely (cost optimization)
- `BatchGetItem` is used for tool config loading — single DynamoDB round-trip

### Frontend Components

- IntegrationPicker shows error message with retry on API failure
- OperationConfigForm shows fallback message when operations unavailable
- IntegrationToolWizard catches submission errors and preserves wizard state for retry
- ErrorBoundary wraps the Tool Testing Sandbox to prevent ToolCard crashes

## Error Handling

### DataStore Resolver

| Scenario | Behavior |
|----------|----------|
| Invalid usage value | GraphQL enum rejects at API layer; resolver validates as defense in depth |
| Legacy item without usage | Returns `BOTH` (uppercase) as default |
| Update version conflict | `ConditionalCheckFailedException` → client retries with optimistic locking |
| Adapter error during create | `persistErrorState` deletes the failed record, re-throws the error |

### Tool Config Resolver

| Scenario | Behavior |
|----------|----------|
| Invalid direction value | GraphQL enum rejects at API layer |
| Legacy binding without direction | Returns `BIDIRECTIONAL` (uppercase) as default |
| Missing binding fields | `ValidationError` thrown before persistence |

### Health Monitor

| Scenario | Behavior |
|----------|----------|
| Individual store connection failure | Status updated to ERROR, other stores unaffected |
| Adapter not found for type | Store skipped with warning log, status unchanged |
| Credentials unavailable | Store skipped, status updated to ERROR |
| Lambda timeout | Already-processed stores keep updated status |
| DynamoDB throttling | Store retains previous status, next run retries |

### Tool Testing Sandbox

| Scenario | Behavior |
|----------|----------|
| Tool not found | `success: false`, `error: "Tool not found"` |
| Tool code not found in S3 | `success: false`, `error: "Tool code not found"` |
| Credential resolution failure | `success: false` with credential error message |
| Execution timeout (>30s) | `success: false`, `error: "Execution timed out after 30 seconds"` |
| Runtime error in tool code | `success: false` with error message |
| Invalid inputs JSON | `success: false` with validation error |

### Integration Resolver

| Scenario | Behavior |
|----------|----------|
| Invalid integration type | GraphQL `IntegrationType` enum rejects at API layer |
| Connection test failure | Returns `IntegrationTestResult` with `success: false` and error message |
| Duplicate integration | Conditional write prevents duplicates |
| Credentials expired | Connection test fails, status updated to ERROR |

### ToolConfig Resolver (Integration Bindings)

| Scenario | Behavior |
|----------|----------|
| Missing `integrationId` | `ValidationError` thrown before persistence |
| Missing `integrationType` | `ValidationError` thrown before persistence |
| Invalid direction value | GraphQL `BindingDirection` enum rejects at API layer |
| Legacy binding without direction | Returns `BIDIRECTIONAL` (uppercase) as default |
| Non-existent integration reference | Accepted at creation time; validated at runtime by Credential Vender |

### Operations Registry Errors

| Scenario | Behavior |
|----------|----------|
| Unknown integration type | `getOperations()` returns `[]` |
| AgentCore type | Returns `[]` (operations discovered dynamically) |
| Unknown operation ID | `getOperation()` returns `undefined` |

### Credential Vender

| Scenario | Behavior |
|----------|----------|
| Non-existent IAM role | Role skipped with warning, other bindings unaffected |
| Empty permissions | Returns `{ credentials: null }`, agent uses Lambda default role |
| STS throttling | Retried with exponential backoff |

### Frontend Error Handling

| Component | Error Behavior |
|-----------|---------------|
| DataStores Page | Usage filter errors don't crash the page |
| ToolCard | Test sandbox errors caught by ErrorBoundary |
| Build Agent Tool Wizard | Fabricator failures show error with retry, wizard state preserved |
| IntegrationPicker | API error → error message with retry button |
| OperationConfigForm | Load failure → "No operation details available" fallback |
| IntegrationToolWizard | Submission failure → error displayed, wizard state preserved |
| Pipeline Wizard | `Promise.allSettled` loads integrations independently of data stores |
| Operation Config Form | Missing operations show fallback message |

### Structured Logging

All backend components emit structured JSON log entries:

```json
{
  "level": "WARN",
  "component": "HealthMonitor",
  "dataStoreId": "ds-xyz789",
  "orgId": "org-001",
  "previousStatus": "CONNECTED",
  "newStatus": "ERROR",
  "errorMessage": "Connection refused: timeout after 5000ms",
  "timestamp": "2025-01-25T12:15:00Z"
}
```

Integration-related errors also use structured JSON:

```json
{
  "level": "WARN",
  "component": "CredentialVender",
  "agentId": "agent-001",
  "toolId": "search_confluence",
  "integrationId": "int-abc123",
  "error": "Role citadel-int-int-abc123 does not exist",
  "action": "skipped"
}
```

## Testing Strategy

All implementation follows strict Test-Driven Development (TDD). Property-based tests use fast-check (TypeScript) and Hypothesis (Python), each with a minimum of 100 iterations per property. Tests are written and verified to fail (red phase) before implementation code is created (green phase).

### Property-Based Tests

| # | Property | Test File | What It Validates |
|---|----------|-----------|-------------------|
| 1 | Usage Field Round-Trip | `backend/src/lambda/__tests__/datastore-resolver.property.test.ts` | Create/read/update usage preserves value |
| 2 | Usage Backward Compatibility | Same file | Legacy items without usage default to BOTH |
| 3 | Direction Field Round-Trip | `backend/src/lambda/__tests__/tool-config-resolver.property.test.ts` | Create/read direction preserves value |
| 4 | Direction Backward Compatibility | Same file | Legacy bindings default to BIDIRECTIONAL |
| 5 | Discovery API Correctness | `backend/src/lambda/__tests__/datastore-resolver.property.test.ts` | Only CONNECTED stores, correct capabilities |
| 6 | Usage Filter Correctness | `frontend/src/pages/__tests__/datastores-filter.property.test.ts` | Knowledge/Writable/All tabs filter correctly |
| 7 | Operation Filtering by Usage | `frontend/src/components/__tests__/datastore-wizard-usage.property.test.ts` | Knowledge stores get read-only ops |
| 8 | Pipeline Directional Bindings | `frontend/src/components/__tests__/pipeline-wizard.property.test.ts` | Input=INPUT, Output=OUTPUT bindings; integration input/output bindings constructed correctly |
| 9 | Health Monitor Idempotency | `backend/src/lambda/__tests__/health-monitor.property.test.ts` | Running twice produces same status |
| 10 | Integration Picker Filtering | `frontend/src/components/__tests__/integration-picker.property.test.ts` | `filterTypes` filters integrations correctly |
| 11 | Sandbox Execution Isolation | `backend/src/lambda/__tests__/tool-sandbox.property.test.ts` | Timeout enforcement, credential scoping, history eviction |

### Additional Test Coverage

- ToolConfig Binding Round-Trip: `backend/src/lambda/__tests__/tool-config-resolver.property.test.ts` — Create/read integration bindings preserves values
- Partial Update Preserves Bindings: Same file — Updating integration bindings doesn't affect data store bindings
- Direction Field Round-Trip (Integrations): Same file — Direction on integration bindings round-trips correctly
- Direction Backward Compatibility (Integrations): Same file — Legacy integration bindings default to BIDIRECTIONAL
- Operations Registry: Coverage for all SaaS types, lookup consistency, empty for unknown types (`backend/src/utils/__tests__/operations-registry.property.test.ts`)
- Binding Aggregation: Worker_Wrapper collects all unique integration IDs (`arbiter/workerWrapper/__tests__/test_binding_aggregation_properties.py`)
- Agent Policies: `computeAgentPolicies` includes `sts:AssumeRole` for all `citadel-int-{id}` roles (`backend/src/utils/__tests__/policy-helpers.property.test.ts`)
- Fabricator Persistence: `store_tool_config_dynamo` persists integration bindings correctly (`arbiter/fabricator/__tests__/test_tools_config_binding_properties.py`)

### Running Tests

```bash
# Backend property tests
cd backend && npx jest --testPathPattern="\.property\.test" --no-coverage

# Frontend property tests
cd frontend && npx jest --testPathPattern="\.property\.test" --no-coverage

# Backend integration-related property tests
cd backend && npx jest --testPathPattern="tool-config-resolver\.property" --no-coverage

# Frontend integration picker tests
cd frontend && npx jest --testPathPattern="integration-picker\.property" --no-coverage

# Python binding aggregation tests
cd arbiter/workerWrapper && python -m pytest __tests__/test_binding_aggregation_properties.py -v

# All backend tests
cd backend && npm test

# All frontend tests
cd frontend && npm test
```

### Test Organization

```
backend/src/lambda/__tests__/
├── datastore-resolver.property.test.ts    # Properties 1, 2, 5 + adapter tests
├── tool-config-resolver.property.test.ts  # Properties 3, 4 + binding tests
├── health-monitor.property.test.ts        # Property 9
└── tool-sandbox.property.test.ts          # Property 11

backend/src/utils/__tests__/
├── operations-registry.property.test.ts   # Operations registry coverage
└── policy-helpers.property.test.ts        # Agent policy coverage

frontend/src/
├── pages/__tests__/
│   └── datastores-filter.property.test.ts # Property 6
└── components/__tests__/
    ├── datastore-wizard-usage.property.test.ts  # Property 7
    ├── pipeline-wizard.property.test.ts          # Property 8
    └── integration-picker.property.test.ts       # Property 10

arbiter/
├── workerWrapper/__tests__/
│   └── test_binding_aggregation_properties.py    # Binding aggregation
└── fabricator/__tests__/
    └── test_tools_config_binding_properties.py   # Fabricator persistence
```

## Architectural Decisions

| Decision | Rationale |
|----------|-----------|
| Usage field on DataStore, not on bindings | Usage is a property of the store itself (how the org classifies it), not how a tool uses it |
| Direction field on bindings, not on DataStore/Integration | Direction is per-tool — the same S3 bucket can be input for one tool and output for another |
| Bindings live on ToolConfig, not AgentConfig | Tools are reusable across agents; binding metadata belongs to the tool so any agent using it gets the right permissions |
| Operations Registry is static, not dynamic | SaaS API operations change infrequently; static registry avoids external API calls and is importable by both resolvers and Fabricator |
| AgentCore types excluded from registry | AWS_LAMBDA, AWS_SMITHY, MCP_SERVER discover operations dynamically at runtime |
| Health Monitor as separate Lambda | Health checks are long-running and should not block API requests |
| Tool Sandbox uses isolated Lambda execution | Tests exercise the real data path including credential resolution |
| Worker_Wrapper aggregates bindings | It already loads agent config and invokes the Credential Vender — natural place to merge tool bindings |
| Non-existent references accepted at creation | Tool creation doesn't validate integration existence; validation happens at runtime by the Credential Vender |
| IntegrationPicker and Operation Config Form as standalone components | Designed for reuse across IntegrationToolWizard, DataPipelineWizard, and future UIs |
| Backward compatibility via defaults | No migration required — missing `usage` defaults to BOTH, missing `direction` defaults to BIDIRECTIONAL |
| Discovery API filters server-side | Avoids over-fetching to the client |
| Enum values stored as uppercase | GraphQL enums use UPPER_SNAKE_CASE; resolvers normalize to uppercase on read and write |

## Design Principles

### Security

- **Least Privilege**: Scoped IAM roles per integration (`citadel-int-{id}`) and per data store (`citadel-ds-{id}`) grant only the permissions for declared operations. INPUT bindings get read-only permissions, OUTPUT get write-only, BIDIRECTIONAL gets both.
- **Defense in Depth**: Usage and direction validated at GraphQL enum layer, resolver layer, and frontend TypeScript type. Binding fields validated at GraphQL enum layer, resolver layer, and frontend TypeScript type.

### Reliability

- **Graceful Degradation**: Health Monitor processes stores independently; Tool Sandbox enforces timeouts; Discovery API returns empty arrays instead of errors. Missing tool configs skipped, unresolvable roles skipped, empty operations handled gracefully.
- **Failure Isolation**: Each binding resolution is independent; one failure doesn't cascade.
- **Idempotency**: Create/update operations with usage/direction are idempotent; Health Monitor produces same results on repeated runs. `createToolConfig` with bindings is idempotent via DynamoDB `PutItem`.
- **Eventual Consistency**: Binding changes picked up on next agent invocation; no distributed locking needed.

### Operational Excellence

- **Observability**: All components emit structured JSON logs with entity IDs (`integrationId`, `toolId`, `agentId`, `dataStoreId`), status transitions, and error details for CloudWatch Logs Insights queries.

### Performance Efficiency

- **BatchGetItem**: Worker_Wrapper loads all tool configs in a single DynamoDB round-trip.
- **Static Registry**: O(1) operation lookup per integration type, no external API calls.
- **Short-Circuit**: When no tools have bindings, aggregation is skipped entirely.
- **Parallel Batch Processing**: Health Monitor processes stores in batches of 10 using `Promise.allSettled`.

### Cost Optimization

- **Bounded Execution**: Tool Sandbox enforces 30-second timeout and 512MB memory; Health Monitor skips PROVISIONING/DELETING/CREATED stores.
- **Short-Circuit**: When no bindings, aggregation is skipped entirely. Skip non-applicable stores in health checks.

## Best Practice Alignment

### AWS Well-Architected Framework

| Pillar | Implementation |
|--------|---------------|
| Security | Least-privilege directional scoping, defense-in-depth validation, scoped IAM roles per data store and integration, directional credential narrowing |
| Reliability | Independent store processing, idempotent operations, graceful degradation, independent binding resolution, skip-and-continue pattern |
| Operational Excellence | Structured logging, CloudWatch Logs Insights queries, version-based locking, CloudWatch integration |
| Performance Efficiency | Parallel batch processing, server-side filtering, BatchGetItem for tool configs, static in-memory Operations Registry |
| Cost Optimization | Bounded sandbox execution, selective health checking, short-circuit when no bindings, skip non-applicable stores in health checks |

### SOLID Principles

| Principle | Implementation |
|-----------|---------------|
| Single Responsibility | Each module has one job: Health Monitor, Sandbox, Discovery API, Picker, Form, Operations Registry handles lookups, Credential Vender handles IAM, Wizards handle UI |
| Open/Closed | IntegrationPicker and OperationConfigForm extensible via props, not modification. New integration types added as new registry keys without modifying existing entries |
| Interface Segregation | Components depend only on services they need. IntegrationToolWizard uses only `fabricatorService` + `listIntegrationOperations` |
| Dependency Inversion | Build Agent Tool Wizard depends on abstract picker interfaces. Consumers import `getOperations`/`getOperation` — never access registry internals directly |

## Adding Data Stores and Integrations to a New Component

To build a new component that uses data stores or integrations:

### 1. Reuse the Integration Picker

```tsx
import { IntegrationPicker } from '../components/IntegrationPicker';

<IntegrationPicker
  onSelect={(integration) => setSelected(integration)}
  selectedId={selected?.id}
  filterTypes={['CONFLUENCE', 'JIRA']}  // optional type filter
/>
```

The picker handles loading, filtering, status badges, and empty states. It accepts three props:

- `onSelect`: callback when user clicks an integration card
- `selectedId`: highlights the currently selected card
- `filterTypes`: restricts which integration types are shown

### 2. Reuse the Operation Config Form

```tsx
import { OperationConfigForm } from '../components/OperationConfigForm';

<OperationConfigForm
  integrationType="CONFLUENCE"
  operationId="search_pages"
  onSubmit={(values) => handleSubmit(values)}
  onChange={(values) => trackFormState(values)}
/>
```

The form fetches the operation descriptor, renders typed fields (string→text, number→numeric, boolean→toggle, object→JSON), validates required parameters, and shows a fallback when operations are unavailable.

### 3. Use the Usage Filter Utility

```tsx
import { filterDataStoresByUsage } from '../pages/datastoreFilterUtils';

const knowledgeStores = filterDataStoresByUsage(allStores, 'knowledge');
const writableStores = filterDataStoresByUsage(allStores, 'operational');
```

### 4. Use the Operation Filtering Utility

```tsx
import {
  getAvailableOperationsForUsage,
  isWriteOperationForKnowledgeStore,
} from '../components/datastore-wizard-usage-utils';

const ops = getAvailableOperationsForUsage('S3', 'knowledge');
// → ['read_object', 'list_objects']

const isWrite = isWriteOperationForKnowledgeStore('S3', 'write_object');
// → true
```

### 5. Filter Integrations Programmatically

```tsx
import { filterIntegrationsByType } from '../components/integration-picker-utils';

const confluenceOnly = filterIntegrationsByType(allIntegrations, ['CONFLUENCE']);
const allIntegrations = filterIntegrationsByType(allIntegrations, undefined); // no filter
```

### 6. Build Directional Bindings

```tsx
import { buildPipelineBindings } from '../components/pipeline-wizard-utils';

const { dataStoreBindings, integrationBindings } = buildPipelineBindings(
  { kind: 'dataStore', id: 'ds-input', type: 'S3', operations: ['read_object'] },
  { kind: 'dataStore', id: 'ds-output', type: 'DYNAMODB', operations: ['put_item'] },
);
// dataStoreBindings[0].direction === 'INPUT'
// dataStoreBindings[1].direction === 'OUTPUT'
```

### 7. Build Integration Bindings for a Tool

```tsx
import { IntegrationBinding, BindingDirection } from '../services/toolConfigService';

const binding: IntegrationBinding = {
  integrationId: selectedIntegration.id,
  integrationType: 'CONFLUENCE',
  operations: ['search_pages', 'get_page'],
  direction: 'INPUT' as BindingDirection,
};
```

### 8. Query the Discovery API

```graphql
query ListAvailableDataSources($orgId: String!, $usage: DataStoreUsage) {
  listAvailableDataSources(orgId: $orgId, usage: $usage) {
    dataStoreId
    name
    type
    capabilities
    scopedRoleArn
  }
}
```

### 9. Query Available Operations

```graphql
query ListIntegrationOperations($integrationType: String!) {
  listIntegrationOperations(integrationType: $integrationType) {
    operationId
    name
    description
    method
    parameters {
      name
      type
      required
      description
    }
  }
}
```

### 10. Add a New Data Store Adapter

1. Create `backend/src/lambda/adapters/my-adapter.ts` implementing `ConnectorAdapter`
2. Register it in `backend/src/lambda/adapters/registry.ts`
3. Add the type to `DataStoreType` enum in `backend/src/schema/schema.graphql`
4. Add operations to the Operations Registry in `backend/src/utils/operations-registry.ts`
5. Add read-only operations to `frontend/src/components/datastore-wizard-usage-utils.ts`

### 11. Add a New Integration Type to the Operations Registry

1. Add the type to `IntegrationType` enum in `backend/src/schema/schema.graphql`
2. Add operation descriptors to `OPERATIONS_REGISTRY` in `backend/src/utils/operations-registry.ts`:

```typescript
OPERATIONS_REGISTRY['MY_SERVICE'] = [
  {
    operationId: 'list_items',
    name: 'List Items',
    description: 'List all items',
    method: 'GET',
    parameters: [
      { name: 'limit', type: 'number', required: false, description: 'Max results' }
    ]
  }
];
```

3. Create an adapter in `backend/src/lambda/adapters/` implementing `ConnectorAdapter`
4. Register it in `backend/src/lambda/adapters/registry.ts`
5. The IntegrationPicker and OperationConfigForm will automatically pick up the new type
