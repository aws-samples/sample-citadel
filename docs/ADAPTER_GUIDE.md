# Adapter Development Guide

This guide walks through adding a new datastore adapter or integration type to Citadel. The platform uses a unified adapter pattern — all 27 datastore types and 13 integration types implement the same `ConnectorAdapter` interface.

## Architecture

```text
ConnectorAdapter (interface)          backend/src/adapters/base.ts
  ├── Datastore Adapters (27)         backend/src/lambda/adapters/*.ts
  │     S3, DynamoDB, RDS, Aurora, Redshift, OpenSearch, Neptune,
  │     Timestream, ElastiCache, Keyspaces, DocumentDB, LakeFormation,
  │     S3Tables, SageMakerLakehouse, SageMakerFeatureStore, KnowledgeBase,
  │     Snowflake, Databricks, QLDB, External (PostgreSQL, MySQL, MongoDB,
  │     Elasticsearch, Redis, API)
  │
  └── Integration Adapters (13)       via BaseIntegrationAdapter
        Confluence, Jira, ServiceNow, Slack, Microsoft, Zendesk, PagerDuty,
        SharePoint, Salesforce, GitHub, AWS Lambda, AWS Smithy, MCP Server

UnifiedRegistry (singleton)           backend/src/adapters/registry.ts
  └── Maps type strings → adapter instances
      getAdapter('S3') → S3Adapter
      getAdapter('CONFLUENCE') → BaseIntegrationAdapter(confluenceSpec)
```

## The ConnectorAdapter Interface

Defined in `backend/src/adapters/base.ts`:

```typescript
export interface ConnectorAdapter {
  readonly category: ConnectorCategory;  // 'datastore' or 'integration'
  readonly spec: ConnectorSpec;          // Type metadata, auth config, test endpoint

  // Required: declare IAM permissions needed for provision and connect
  requiredPolicies(config: Record<string, any>, accountId: string, region: string): RequiredPolicies;

  // Required: test connectivity without modifying state
  testConnection(config: Record<string, any>, credentials?: Record<string, any>): Promise<ConnectionTestResult>;

  // Required: establish connection (may create scoped IAM role)
  connect(config: Record<string, any>, credentials?: Record<string, any>): Promise<void>;

  // Required: tear down connection
  disconnect(config: Record<string, any>): Promise<void>;

  // Optional (datastore-only): create the underlying resource
  provision?(config: Record<string, any>, credentials?: Record<string, any>): Promise<ProvisionResult>;

  // Optional (datastore-only): tear down the underlying resource
  deprovision?(config: Record<string, any>, credentials?: Record<string, any>): Promise<void>;

  // Optional (datastore-only): get size/record metrics
  getMetrics?(config: Record<string, any>, credentials?: Record<string, any>): Promise<MetricsResult>;

  // Optional: validate config before any operation
  validate?(config: Record<string, any>): ValidationResult;
}
```

### Key Types

```typescript
// What IAM permissions the adapter needs
interface RequiredPolicies {
  provision: PolicyStatement[];  // Permissions for creating resources (e.g., s3:CreateBucket)
  connect: PolicyStatement[];    // Permissions for using resources (e.g., s3:GetObject)
}

interface PolicyStatement {
  actions: string[];    // e.g., ['s3:GetObject', 's3:PutObject']
  resources: string[];  // e.g., ['arn:aws:s3:::my-bucket/*']
}

// Adapter metadata
interface ConnectorSpec {
  type: string;                          // e.g., 'S3', 'CONFLUENCE'
  provider: string;                      // e.g., 'Amazon Web Services', 'Atlassian'
  category: ConnectorCategory;           // 'datastore' or 'integration'
  authentication: AuthenticationConfig;  // Auth method + required fields
  configuration: ConfigurationSchema;    // Required/optional config fields
  testEndpoint?: string;                 // URL path for connection testing
  gatewayTargetType?: string;            // For AgentCore integrations
}
```

## Adding a New Datastore Adapter

### Step 1: Create the Adapter File

Create `backend/src/lambda/adapters/my-new-adapter.ts`:

```typescript
import {
  ConnectorAdapter,
  ConnectorSpec,
  RequiredPolicies,
  ConnectionTestResult,
  ProvisionResult,
  MetricsResult,
} from '../../adapters/base';

export class MyNewAdapter implements ConnectorAdapter {
  readonly category = 'datastore' as const;

  readonly spec: ConnectorSpec = {
    type: 'MY_NEW_TYPE',
    provider: 'Amazon Web Services',
    category: 'datastore',
    authentication: {
      method: 'IAM_ROLE' as any,
      fields: [],
      secretStructure: {},
    },
    configuration: {
      required: ['resourceName', 'region'],
      optional: [],
      ssmParameters: ['resource-name', 'region'],
    },
  };

  requiredPolicies(
    config: Record<string, any>,
    accountId: string,
    region: string
  ): RequiredPolicies {
    const resourceArn = `arn:aws:myservice:${region}:${accountId}:resource/${config.resourceName}`;

    return {
      provision: [
        {
          actions: ['myservice:CreateResource', 'myservice:TagResource'],
          resources: ['*'],
        },
      ],
      connect: [
        {
          actions: ['myservice:ReadData', 'myservice:WriteData', 'myservice:DescribeResource'],
          resources: [resourceArn],
        },
      ],
    };
  }

  async testConnection(
    config: Record<string, any>,
    credentials?: Record<string, any>
  ): Promise<ConnectionTestResult> {
    try {
      // Use scoped credentials to test connectivity
      // const client = new MyServiceClient({ credentials: { ... } });
      // await client.describeResource({ name: config.resourceName });
      return { success: true, message: 'Connection successful' };
    } catch (error: any) {
      return { success: false, message: `Connection failed: ${error.message}` };
    }
  }

  async connect(config: Record<string, any>, credentials?: Record<string, any>): Promise<void> {
    // Verify the resource exists and is accessible
    const result = await this.testConnection(config, credentials);
    if (!result.success) {
      throw new Error(result.message);
    }
  }

  async disconnect(config: Record<string, any>): Promise<void> {
    // Clean up any connection state (usually a no-op for AWS services)
  }

  async provision(
    config: Record<string, any>,
    credentials?: Record<string, any>
  ): Promise<ProvisionResult> {
    // Create the underlying resource
    // const client = new MyServiceClient({ credentials: { ... } });
    // const result = await client.createResource({ name: config.resourceName });
    return {
      resourceArn: `arn:aws:myservice:${config.region}:*:resource/${config.resourceName}`,
    };
  }

  async getMetrics(
    config: Record<string, any>,
    credentials?: Record<string, any>
  ): Promise<MetricsResult> {
    return { size: '0 bytes', records: 0 };
  }
}
```

### Step 2: Register in the UnifiedRegistry

Edit `backend/src/adapters/registry.ts`:

```typescript
import { MyNewAdapter } from '../lambda/adapters/my-new-adapter';

function buildDataStoreAdapters(): Record<string, ConnectorAdapter> {
  return {
    // ... existing adapters
    MY_NEW_TYPE: new MyNewAdapter(),
  };
}
```

### Step 3: Add the GraphQL Enum Value

Edit `backend/src/schema/schema.graphql` — add the new type to the `DataStoreType` enum:

```graphql
enum DataStoreType {
  # ... existing types
  MY_NEW_TYPE
}
```

### Step 4: Add Operations to the Registry

If the datastore has specific operations (for the tool wizard), add them to `backend/src/utils/operations-registry.ts`:

```typescript
MY_NEW_TYPE: [
  {
    operationId: 'read_data',
    name: 'Read Data',
    description: 'Read data from the resource',
    method: 'GET',
    parameters: [
      { name: 'key', type: 'string', required: true, description: 'Data key' },
    ],
  },
  {
    operationId: 'write_data',
    name: 'Write Data',
    description: 'Write data to the resource',
    method: 'POST',
    parameters: [
      { name: 'key', type: 'string', required: true, description: 'Data key' },
      { name: 'value', type: 'string', required: true, description: 'Data value' },
    ],
  },
],
```

### Step 5: Add Read-Only Operations (for KNOWLEDGE usage)

If the datastore supports the `KNOWLEDGE` usage tag, define which operations are read-only in the operations registry. When a knowledge store is selected, only read-only operations are shown in the tool wizard.

### Step 6: Write Tests

Create `backend/src/lambda/adapters/__tests__/my-new-adapter.test.ts`:

```typescript
import { MyNewAdapter } from '../my-new-adapter';

describe('MyNewAdapter', () => {
  const adapter = new MyNewAdapter();

  it('has correct category and type', () => {
    expect(adapter.category).toBe('datastore');
    expect(adapter.spec.type).toBe('MY_NEW_TYPE');
  });

  it('returns scoped connect policies', () => {
    const policies = adapter.requiredPolicies(
      { resourceName: 'test-resource', region: 'us-east-1' },
      '123456789012',
      'us-east-1'
    );

    expect(policies.connect).toHaveLength(1);
    expect(policies.connect[0].actions).toContain('myservice:ReadData');
    expect(policies.connect[0].resources[0]).toContain('test-resource');
  });

  it('returns broader provision policies', () => {
    const policies = adapter.requiredPolicies(
      { resourceName: 'test-resource', region: 'us-east-1' },
      '123456789012',
      'us-east-1'
    );

    expect(policies.provision).toHaveLength(1);
    expect(policies.provision[0].resources).toContain('*');
  });
});
```

### Step 7: Update the Frontend

Add the new type to the frontend connector registry in `frontend/src/config/connectorRegistry.ts` if it should appear in the integration/datastore creation UI.

### Step 8: Grant CDK Permissions

If the health monitor needs to check this datastore type, ensure the health monitor Lambda has the necessary IAM permissions in `backend/lib/services-stack.ts`.

## Adding a New Integration Type

Integration adapters are simpler — they use the `BaseIntegrationAdapter` class which delegates policy computation to `computeIntegrationPolicies()`.

### Step 1: Add the Connector Spec

Edit `backend/src/utils/connector-registry.ts`:

```typescript
export const BACKEND_CONNECTOR_REGISTRY: Record<string, ConnectorSpec> = {
  // ... existing specs
  MY_INTEGRATION: {
    type: 'MY_INTEGRATION',
    provider: 'My Provider',
    authentication: {
      method: AuthenticationMethod.API_KEY,
      fields: ['email', 'apiToken'],
      secretStructure: {
        email: 'string',
        apiToken: 'string',
        baseUrl: 'string',
      },
    },
    configuration: {
      required: ['baseUrl'],
      optional: ['projectKeys'],
      ssmParameters: ['base-url', 'project-keys'],
    },
    testEndpoint: '/api/v1/me',  // Used by connection tester
  },
};
```

### Step 2: Add the GraphQL Enum Value

Edit `backend/src/schema/schema.graphql`:

```graphql
enum IntegrationType {
  # ... existing types
  MY_INTEGRATION
}
```

### Step 3: Add the Frontend Connector Definition

Edit `frontend/src/config/connectorRegistry.ts`:

```typescript
MY_INTEGRATION: {
  type: 'MY_INTEGRATION',
  name: 'My Integration',
  description: 'Connect to My Service for ...',
  icon: SomeIcon,  // from lucide-react
  authMethod: 'API_KEY',
  provider: 'My Provider',
  category: 'productivity',
  isPopular: false,
  formConfig: {
    connectorType: 'MY_INTEGRATION',
    authFields: [
      {
        name: 'email',
        label: 'Email',
        type: 'text',
        placeholder: 'user@company.com',
        required: true,
        helpText: 'Your account email',
        sensitive: false,
      },
      {
        name: 'apiToken',
        label: 'API Token',
        type: 'password',
        placeholder: 'Your API token',
        required: true,
        helpText: 'Generate from account settings',
        sensitive: true,
      },
    ],
    configFields: [
      {
        name: 'baseUrl',
        label: 'Base URL',
        type: 'url',
        placeholder: 'https://your-instance.example.com',
        required: true,
        helpText: 'Your instance URL',
        sensitive: false,
      },
    ],
  },
},
```

### Step 4: Add Operations (for SaaS types)

Edit `backend/src/utils/operations-registry.ts` to define available operations. AgentCore types (Lambda, Smithy, MCP Server) return empty arrays since they discover operations dynamically.

### Step 5: Add Setup Documentation

Add a section to `docs/INTEGRATION_SETUP.md` with setup instructions, required permissions, and troubleshooting tips.

## Error Hierarchy

All adapter errors extend `ConnectorError` from `backend/src/adapters/errors.ts`:

```text
ConnectorError (base)
  ├── ProvisioningError    — Resource creation failed (not retryable)
  ├── ConnectionError      — Connection failed (retryable by default)
  ├── PermissionError      — IAM/STS failure (not retryable)
  ├── ResourceNotFoundError — Resource doesn't exist (not retryable)
  ├── ConflictError        — Optimistic lock conflict (retryable)
  ├── ValidationError      — Invalid input (not retryable)
  └── IntegrationError     — External service failure (retryable)
```

Each error has a `code` string, a `retryable` boolean, and an optional `cause` for error chaining.

## Lifecycle State Machine

Datastores and integrations follow different state machines defined in `backend/src/adapters/lifecycle.ts`:

### Datastore States

```text
CREATED → PROVISIONING → PROVISIONED → CONNECTING → CONNECTED
                                                        ↓
CREATED → CONNECTING → CONNECTED ←→ DISCONNECTED → DELETING
                          ↓
                        ERROR → CONNECTING (retry)
```

### Integration States

```text
CREATED → CONFIGURING → CONFIGURED → TESTED → CONNECTING → CONNECTED
                                                               ↓
                                                          DISCONNECTED
                                                               ↓
                                                          CONFIGURED (reconfigure)
```

The `LifecycleManager` class validates transitions and checks which actions are allowed in each state:

```typescript
import { LifecycleManager, DATASTORE_TRANSITIONS } from '../adapters/lifecycle';

const lifecycle = new LifecycleManager(DATASTORE_TRANSITIONS);

// Check if a transition is valid
lifecycle.isValidTransition('CREATED', 'CONNECTING'); // true
lifecycle.isValidTransition('CREATED', 'CONNECTED');  // false

// Check if an action is allowed
lifecycle.canPerform('connect', 'DISCONNECTED'); // true
lifecycle.canPerform('connect', 'CONNECTED');    // false

// Validate (throws on invalid)
lifecycle.validateTransition('CREATED', 'CONNECTED');
// Error: Invalid status transition: CREATED → CONNECTED.
//        Valid transitions from CREATED: CONNECTING, PROVISIONING, ERROR
```

## Checklist for New Adapters

- [ ] Implement `ConnectorAdapter` interface (or add spec to `BACKEND_CONNECTOR_REGISTRY` for integrations)
- [ ] Register in `UnifiedRegistry` (`backend/src/adapters/registry.ts`)
- [ ] Add GraphQL enum value (`backend/src/schema/schema.graphql`)
- [ ] Add operations to registry (`backend/src/utils/operations-registry.ts`)
- [ ] Add frontend connector definition (`frontend/src/config/connectorRegistry.ts`)
- [ ] Write unit tests with `aws-sdk-client-mock`
- [ ] Write property-based tests with `fast-check` for policy generation
- [ ] Add setup documentation to `docs/INTEGRATION_SETUP.md`
- [ ] Grant CDK permissions if health monitor needs access
- [ ] Verify `requiredPolicies()` returns resource-scoped ARNs (not wildcards) for connect policies
