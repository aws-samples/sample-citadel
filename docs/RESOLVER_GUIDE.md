# Lambda Resolver Development Guide

This guide explains how to write new AppSync Lambda resolvers for Citadel. All 40+ resolvers follow the same structural pattern — understanding it once lets you contribute to any resolver.

## Resolver Architecture

```
AppSync GraphQL API
  → Routes field to Lambda data source (configured in BackendStack)
  → Lambda receives AppSyncEvent with:
      - info.fieldName (which query/mutation was called)
      - arguments (input parameters)
      - identity (Cognito user info)
  → Lambda handler routes to the correct function
  → Function executes business logic
  → Returns domain object (AppSync handles serialization)
```

## File Structure

Resolvers live in `backend/src/lambda/`. Each resolver file handles a group of related operations:

```
backend/src/lambda/
├── project-resolver.ts          # Project CRUD
├── agent-config-resolver.ts     # Agent config CRUD + manifest
├── tool-config-resolver.ts      # Tool config CRUD + bindings
├── workflow-resolver.ts         # Workflow CRUD + publish + import
├── app-resolver.ts              # App CRUD + components + status
├── execution-resolver.ts        # Execution start/cancel/query
├── datastore-resolver.ts        # Datastore CRUD + connect/disconnect
├── integration-resolver.ts      # Integration CRUD + connect/test
├── user-management-resolver.ts  # User CRUD + roles
├── ...
└── __tests__/                   # Colocated test files
    ├── project-resolver.test.ts
    ├── workflow-resolver.test.ts
    └── ...
```

## Standard Resolver Pattern

Every resolver follows this structure:

```typescript
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';

const ddbClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE_NAME = process.env.TABLE_NAME!;

// Sensitive fields to redact before logging
const SENSITIVE_FIELDS = ['apitoken', 'password', 'clientsecret', 'secret', 'apikey'];

function sanitizeForLogging(obj: any): any {
  if (!obj || typeof obj !== 'object') return obj;
  const sanitized = { ...obj };
  for (const key of Object.keys(sanitized)) {
    if (SENSITIVE_FIELDS.includes(key.toLowerCase())) {
      sanitized[key] = '[REDACTED]';
    } else if (typeof sanitized[key] === 'object') {
      sanitized[key] = sanitizeForLogging(sanitized[key]);
    }
  }
  return sanitized;
}

export async function handler(event: any) {
  // 1. Sanitize before logging
  console.log('Event:', JSON.stringify(sanitizeForLogging(event.arguments)));

  // 2. Route by field name
  const fieldName = event.info.fieldName;

  try {
    switch (fieldName) {
      case 'getWidget':
        return await getWidget(event);
      case 'createWidget':
        return await createWidget(event);
      case 'updateWidget':
        return await updateWidget(event);
      case 'deleteWidget':
        return await deleteWidget(event);
      default:
        throw new Error(`Unknown field: ${fieldName}`);
    }
  } catch (error: any) {
    console.error(`Error in ${fieldName}:`, error);
    throw error; // AppSync returns this as a GraphQL error
  }
}
```

## Key Patterns

### 1. Organization-Scoped Access Control

Every resolver that accesses org-scoped resources must verify the caller's organization:

```typescript
import { CognitoIdentityProviderClient, AdminGetUserCommand } from '@aws-sdk/client-cognito-identity-provider';

const cognitoClient = new CognitoIdentityProviderClient({});
const USER_POOL_ID = process.env.USER_POOL_ID!;

async function getCallerOrgId(event: any): Promise<string> {
  const userId = event.identity?.sub;
  if (!userId) throw new Error('Unauthorized');

  const response = await cognitoClient.send(new AdminGetUserCommand({
    UserPoolId: USER_POOL_ID,
    Username: userId,
  }));

  const orgAttr = response.UserAttributes?.find(a => a.Name === 'custom:organization');
  if (!orgAttr?.Value) throw new Error('User has no organization');
  return orgAttr.Value;
}

// Usage in a handler function:
async function getWidget(event: any) {
  const callerOrgId = await getCallerOrgId(event);
  const widget = await loadWidget(event.arguments.id);

  if (widget.orgId !== callerOrgId) {
    throw new Error('Access denied');
  }

  return widget;
}
```

### 2. Optimistic Locking

State-mutating operations use version-based concurrency control:

```typescript
async function updateWidget(event: any) {
  const { id, version, ...updates } = event.arguments.input;

  try {
    const result = await ddbClient.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { id },
      UpdateExpression: 'SET #name = :name, #version = :newVersion, #updatedAt = :now',
      ConditionExpression: '#version = :expectedVersion',
      ExpressionAttributeNames: {
        '#name': 'name',
        '#version': 'version',
        '#updatedAt': 'updatedAt',
      },
      ExpressionAttributeValues: {
        ':name': updates.name,
        ':expectedVersion': version,
        ':newVersion': version + 1,
        ':now': new Date().toISOString(),
      },
      ReturnValues: 'ALL_NEW',
    }));

    return result.Attributes;
  } catch (error: any) {
    if (error.name === 'ConditionalCheckFailedException') {
      throw new Error('Conflict: resource was modified concurrently. Please retry.');
    }
    throw error;
  }
}
```

### 3. Credential Sanitization

Always redact sensitive fields before logging. The sanitization function should be called at the resolver entry point, before any `console.log`:

```typescript
// List of sensitive field names (case-insensitive matching)
const SENSITIVE_FIELDS = [
  'apitoken', 'password', 'clientsecret', 'token',
  'secret', 'apikey', 'executionrolearn', 'rolearn'
];

// Recursive sanitization for nested objects
function sanitizeForLogging(obj: any): any {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(sanitizeForLogging);

  const sanitized: any = {};
  for (const [key, value] of Object.entries(obj)) {
    if (SENSITIVE_FIELDS.includes(key.toLowerCase())) {
      sanitized[key] = '[REDACTED]';
    } else if (typeof value === 'object') {
      sanitized[key] = sanitizeForLogging(value);
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}
```

### 4. Input Validation

Validate all inputs at the resolver boundary using utilities from `backend/src/utils/validation.ts`:

```typescript
import { validateUUID, sanitizeString, validatePaginationInput, ValidationError } from '../utils/validation';

async function createWidget(event: any) {
  const input = event.arguments.input;

  // Validate required fields
  if (!input.name || typeof input.name !== 'string') {
    throw new ValidationError('Widget name is required', 'name');
  }

  // Sanitize strings (strip HTML/script tags, enforce max length)
  const name = sanitizeString(input.name, 100);

  // Validate UUIDs
  if (input.parentId && !validateUUID(input.parentId)) {
    throw new ValidationError('Invalid parent ID format', 'parentId');
  }

  // Validate ARNs (for AWS resource references)
  if (input.lambdaArn) {
    validateARN(input.lambdaArn, 'lambda');
  }

  // Validate HTTPS URLs (for MCP servers)
  if (input.serverUrl) {
    validateHTTPSUrl(input.serverUrl);
  }

  // ... proceed with business logic
}
```

Available validation functions in `validation.ts`:

| Function | Purpose |
|----------|---------|
| `validateProjectInput(input)` | Validates project name (1-100 chars), description (<1000), requirements (<5000) |
| `validateUUID(uuid)` | Validates UUID v1-v5 format |
| `sanitizeString(input, maxLength)` | Strips HTML/script tags, trims, truncates |
| `validatePaginationInput(input)` | Validates limit (1-100) and nextToken |
| `validateS3Object(s3Object)` | Validates bucket, key, region |
| `validateARN(arn, type)` | Validates Lambda or IAM Role ARN format |
| `validateToolSchemaJSON(json)` | Validates MCP tool schema (name, description, inputSchema) |
| `validateAWSRegion(region)` | Validates against known AWS region codes |
| `validateHTTPSUrl(url)` | Validates HTTPS URL format |

### 5. EventBridge Publishing

Publish events for async coordination using `backend/src/utils/events.ts`:

```typescript
import { publishEvent, createProjectEvent, EventTypes } from '../utils/events';

async function createWidget(event: any) {
  // ... create the widget in DynamoDB ...

  // Publish event for downstream consumers
  await publishEvent(createProjectEvent(
    EventTypes.PROJECT_CREATED,
    widget.projectId,
    { widgetId: widget.id, name: widget.name },
    widget.id, // correlationId
  ));

  return widget;
}
```

### 6. Idempotent EventBridge Handlers

For Lambdas triggered by EventBridge (not AppSync), use the `IdempotencyGuard`:

```typescript
import { IdempotencyGuard } from '../utils/idempotency';

const guard = new IdempotencyGuard(process.env.IDEMPOTENCY_TABLE!);

export async function handler(event: any) {
  const eventId = event.id; // EventBridge event ID

  const { executed, result } = await guard.withIdempotency(eventId, async () => {
    // Your business logic here — only runs once per eventId
    return processEvent(event.detail);
  });

  if (!executed) {
    console.log('Duplicate event, skipping');
  }

  return result;
}
```

### 7. AWSJSON Arguments

AppSync delivers `AWSJSON` arguments to Lambda resolvers as parsed **objects**, not strings — but DynamoDB items and downstream consumers expect JSON strings. Normalize before validation and persistence, as `workflow-resolver.ts` does with `toJsonString` for `definition`, `configuration`, and `metadata`:

```typescript
function toJsonString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value; // already a string — no double-encoding
  return JSON.stringify(value);
}
```

Persist the normalized strings, and write validators that accept both shapes (string or already-parsed object).

Testing rule: every resolver that takes an `AWSJSON` argument needs an object-shaped input test AND a string-shaped input test, plus a no-double-encoding assertion (a string input must persist unchanged, not as `"\"{...}\""`).

### 8. IAM-Only Orchestration Resolvers (the intake-orchestration pattern)

Some mutations are called by backend runtimes over SigV4, never by user-pool clients. `backend/src/lambda/intake-orchestration-resolver.ts` — which backs the four intake post-fabrication mutations (`intakeActivateProjectAgents`, `intakeCreateApp`, `intakeCreateBlueprint`, `intakeImportBlueprintToApp`) — is the reference implementation. It combines seven conventions:

**`@aws_iam`-only field scoping.** The schema declares the fields `@aws_iam` only (no Cognito directive), so user-pool clients never reach them. Two supporting rules:

- Declare the fields inside the primary `type Mutation` block — AppSync silently drops fields added via `extend type` blocks.
- Return types shared with the Cognito surface (e.g. `Workflow`, `RegistryAgentRecord`, `ActivateAgentsResult`) must carry `@aws_iam @aws_cognito_user_pools` — widening auth modes on a type is non-breaking for existing Cognito callers.

The handler adds a defence-in-depth identity check (mirroring the `publishGovernanceFinding` guard) so even a misconfigured directive change cannot leak the fields to user-pool callers: an IAM identity surfaces `accountId` and lacks the Cognito/OIDC `sub`/`claims` shape; anything else is rejected.

```typescript
function isIamIdentity(identity: unknown): boolean {
  if (!identity || typeof identity !== 'object') return false;
  const id = identity as Record<string, unknown>;
  if (id.claims !== undefined) return false;
  if (typeof id.sub === 'string') return false;
  return typeof id.accountId === 'string' && id.accountId.length > 0;
}
```

**Server-side scoping instead of the Cognito org guard.** `extractOrgFromEvent` returns null for IAM identities, which makes the delegated cores' own org guards no-ops. The orchestration resolver therefore enforces scoping itself: `orgId` and `sourceProjectId` are derived server-side from the session's conversations→project linkage and never read from client arguments, and cross-org access to the referenced app and blueprint rows is rejected before delegation.

**Export-only delegation to existing resolver cores.** The handler is a thin boundary — identity guard, input validation, and org/project derivation only. All substantive logic runs in the existing resolver cores, exported from their home modules and imported directly, so no invariant is re-implemented or duplicated:

```typescript
import { activateProjectAgents } from './agent-config-resolver';
import { createApp } from './registry-agent-record-resolver';
import { createWorkflow, publishWorkflow, importBlueprint } from './workflow-resolver';
```

When you need a core another resolver owns, export the core function from its module — do not copy its logic.

**`sourceProjectId` matching with a fallback.** Fabricated agents carry `sourceProjectId = session_id` (the fabricator threads the SQS `orchestration_id`, which intake sets to the session id, into the registry record). Activation therefore tries the sessionId first; when it matches zero records, the conversations-linked projectId is tried as the fallback. The result's `matchedBy` field surfaces which key matched (`'sessionId'`, `'projectId'`, or `null` for the explicit zero-activated signal).

**Idempotency by `sourceProjectId` lookup before create.** Creation mutations on this path must be retry-safe: a timed-out invocation may already have persisted its resource, and each consented retry would then mint another (live incident: one consent produced three apps). `intakeCreateApp` therefore stamps the app with a server-derived `sourceProjectId` (the session id) and, before creating anything, looks the app up by that same key (`findAppBySourceProjectId`) — a retry returns the existing app instead of a duplicate. The import step applies the same pattern keyed on the blueprint definition id preserved into the imported workflow: an already-imported blueprint returns the existing workflow (and still re-ensures its agent bindings).

**Point-of-need healing before delegation.** The fabricator persists agents to the AgentCore Registry only, while the workflow publish/import gates BatchGet the DynamoDB agents cache table — so registry-only agents would fail every publish and import with a permanent missing-agents error. Before delegating to `publishWorkflow`/`importBlueprint`, the resolver materializes any missing agents-table rows from the live registry records (`ensureAgentConfigRows` in `backend/src/lambda/ensure-agent-config-rows.ts`): a creation-only conditional Put using the same row mapping registry-sync applies, so existing richer rows are never touched. The heal is best-effort and never throws — a row that cannot be healed simply leaves the delegated gate's own failure mode in place.

**ServicesStack placement via L1 cross-stack wiring.** The Lambda, its data-source role, and the four resolvers live in `ServicesStack` (next to the intake runtime they serve), not `BackendStack` — BackendStack sits at CloudFormation's 500-resource ceiling. They attach to the BackendStack-owned API with the same L1 `CfnDataSource`/`CfnResolver` cross-stack pattern as arbiter-stack's governance-ui resolver, using a dedicated `iam.Role` assumed by `appsync.amazonaws.com` with `grantInvoke` on the Lambda. The caller side is least-privilege too: the intake runtime's `appsync:GraphQL` grant lists exactly the four field ARNs, never `Mutation/*` or the whole API. The Lambda's own IAM is the union of the delegated cores' least-privilege sets, plus the projects/conversations reads the derivation step needs.

Logging in this pattern is restricted to identifiers (field, correlationId, ids) — argument payloads are never logged, so credential sanitization holds by construction.

## Wiring a New Resolver in CDK

### 1. Create the Lambda Function

In `backend/lib/backend-stack.ts`:

```typescript
const widgetResolverFunction = new lambda.Function(this, 'WidgetResolverFunction', {
  runtime: lambda.Runtime.NODEJS_24_X,
  handler: 'widget-resolver.handler',
  code: lambda.Code.fromAsset('dist/lambda'),
  environment: {
    WIDGETS_TABLE: widgetsTable.tableName,
    USER_POOL_ID: this.userPool.userPoolId,
    EVENT_BUS_NAME: this.agentEventBus.eventBusName,
  },
  timeout: cdk.Duration.seconds(30),
});

// Grant least-privilege permissions
widgetsTable.grantReadWriteData(widgetResolverFunction);
this.agentEventBus.grantPutEventsTo(widgetResolverFunction);
```

### 2. Create the AppSync Data Source

```typescript
const widgetDataSource = this.appSyncApi.addLambdaDataSource(
  'WidgetDataSource',
  widgetResolverFunction,
);
```

### 3. Map GraphQL Fields to the Data Source

```typescript
widgetDataSource.createResolver('GetWidgetResolver', {
  typeName: 'Query',
  fieldName: 'getWidget',
});

widgetDataSource.createResolver('CreateWidgetResolver', {
  typeName: 'Mutation',
  fieldName: 'createWidget',
});
```

### 4. Add the GraphQL Schema Types

In `backend/src/schema/schema.graphql`:

```graphql
type Widget {
  id: ID!
  name: String!
  orgId: String!
  version: Int!
  createdAt: AWSDateTime!
}

input CreateWidgetInput {
  name: String!
}

extend type Query {
  getWidget(id: ID!): Widget
}

extend type Mutation {
  createWidget(input: CreateWidgetInput!): Widget
}
```

### 5. Add the esbuild Entry Point

The `build:lambda` script in `backend/package.json` already globs `src/lambda/*.ts`, so any new file in that directory is automatically bundled.

## Testing Resolvers

### Unit Tests

Create `backend/src/lambda/__tests__/widget-resolver.test.ts`:

```typescript
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { handler } from '../widget-resolver';

const ddbMock = mockClient(DynamoDBDocumentClient);

beforeEach(() => {
  ddbMock.reset();
});

describe('getWidget', () => {
  it('returns widget when found and org matches', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { id: 'w-1', name: 'Test', orgId: 'org-1', version: 1 },
    });

    const result = await handler({
      info: { fieldName: 'getWidget' },
      arguments: { id: 'w-1' },
      identity: { sub: 'user-1' },
    });

    expect(result).toEqual(expect.objectContaining({ id: 'w-1', name: 'Test' }));
  });

  it('throws Access denied when org does not match', async () => {
    // ... test org mismatch scenario
  });
});
```

### Property-Based Tests

Use `fast-check` for data transformation and serialization logic:

```typescript
import fc from 'fast-check';

describe('widget properties', () => {
  it('sanitized name never contains script tags', () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        const sanitized = sanitizeString(input, 100);
        expect(sanitized).not.toMatch(/<script/i);
      }),
      { numRuns: 100 },
    );
  });
});
```

Run tests:

```bash
cd backend
npm test                          # All tests
npm test -- --testPathPattern=widget  # Specific resolver
```

## Error Handling Conventions

| Scenario | Error Message Pattern |
|----------|----------------------|
| Resource not found | `Error('{Resource} not found')` |
| Org mismatch | `Error('Access denied')` |
| Optimistic lock conflict | `Error('Conflict: {resource} was modified concurrently. Please retry.')` |
| Validation failure | `ValidationError('{field} is required', '{field}')` |
| Permission failure | `PermissionError('Failed to {action}: {details}')` |
| Unknown field | `Error('Unknown field: {fieldName}')` |

AppSync returns these as GraphQL errors to the frontend. The frontend service layer catches them and displays appropriate toast messages or inline errors.
