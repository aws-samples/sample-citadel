# Policy Manager

The Policy Manager is the IAM credential-vending subsystem that enforces least-privilege access across every resource type in the platform — datastores, integrations, and agents. It dynamically creates, attaches, assumes, and tears down scoped IAM roles at runtime so that no Lambda function or agent worker ever operates with more permissions than it needs for the task at hand.

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Core Concepts](#core-concepts)
- [Component Map](#component-map)
- [How It Works](#how-it-works)
- [Scoped Role Naming Convention](#scoped-role-naming-convention)
- [Policy Computation](#policy-computation)
- [Cross-Account Access](#cross-account-access)
- [Retry and Resilience](#retry-and-resilience)
- [CDK Infrastructure Grants](#cdk-infrastructure-grants)
- [Error Handling](#error-handling)
- [Testing Strategy](#testing-strategy)
- [Architectural Decisions](#architectural-decisions)
- [Best Practice Alignment](#best-practice-alignment)
- [Adding Policy Manager to a New Component](#adding-policy-manager-to-a-new-component)

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        Lambda / Agent Worker                            │
│                                                                         │
│  1. Adapter.requiredPolicies(config, accountId, region)                 │
│        ↓ returns PolicyStatement[]                                      │
│  2. PolicyManager.ensureRole(resourceId, policies, accountId, scope)    │
│        ↓ creates IAM role + attaches inline policy                      │
│  3. PolicyManager.assumeScopedRole(resourceId, accountId, scope)        │
│        ↓ returns { accessKeyId, secretAccessKey, sessionToken }         │
│  4. Adapter.connect(config, scopedCredentials)                          │
│        ↓ uses scoped creds to talk to the target service                │
│  5. PolicyManager.deleteRole(resourceId, scope)   ← on resource delete  │
└─────────────────────────────────────────────────────────────────────────┘
            │                    │                    │
            ▼                    ▼                    ▼
       ┌──────────┐         ┌──────────┐         ┌──────────┐
       │   IAM    │         │   STS    │         │  Target  │
       │ (roles)  │         │ (assume) │         │ Service  │
       └──────────┘         └──────────┘         └──────────┘
```

The flow is always the same regardless of scope:

1. An adapter declares what IAM actions it needs via `requiredPolicies()`.
2. `PolicyManager.ensureRole()` creates (or updates) a dedicated IAM role with exactly those permissions.
3. `PolicyManager.assumeScopedRole()` returns temporary STS credentials bound to that role.
4. The adapter uses those credentials to interact with the target AWS service.
5. On resource deletion, `PolicyManager.deleteRole()` cleans up the role and its inline policy.

---

## Core Concepts

### PolicyScope

A discriminated union that controls the role name prefix and logically separates IAM roles by resource type:

```typescript
type PolicyScope = 'datastore' | 'integration' | 'agent';
```

Each scope gets its own prefix so that CDK wildcard grants (`arn:aws:iam::*:role/citadel-ds-*`) can be scoped per Lambda function. This means the datastore resolver Lambda can only manage `citadel-ds-*` roles, the integration resolver can only manage `citadel-int-*` roles, and so on.

### PolicyStatement

The minimal unit of permission declaration. Every adapter returns arrays of these:

```typescript
interface PolicyStatement {
  actions: string[];   // e.g. ['s3:GetObject', 's3:PutObject']
  resources: string[]; // e.g. ['arn:aws:s3:::my-bucket/*']
}
```

### RequiredPolicies

Adapters return separate policy sets for provisioning vs. connecting:

```typescript
interface RequiredPolicies {
  provision: PolicyStatement[];  // Permissions needed to create a new resource
  connect: PolicyStatement[];    // Permissions needed to use an existing resource
}
```

This separation means a `CONNECT_EXISTING` operation never gets `CreateBucket` or `CreateTable` permissions.

### ScopedCredentials

The temporary credentials returned by `assumeScopedRole()`:

```typescript
interface ScopedCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
}
```

---

## Component Map

| File | Role |
|------|------|
| `backend/src/utils/policy-manager.ts` | Core `PolicyManager` class — role CRUD, STS assume, retry logic |
| `backend/src/utils/policy-helpers.ts` | `computeIntegrationPolicies()` and `computeAgentPolicies()` — dynamic policy builders |
| `backend/src/adapters/base.ts` | `PolicyStatement`, `RequiredPolicies`, `ConnectorAdapter` interface |
| `backend/src/adapters/errors.ts` | `PermissionError` thrown by PolicyManager on IAM/STS failures |
| `backend/src/lambda/datastore-resolver.ts` | Uses PolicyManager for datastore scope |
| `backend/src/lambda/integration-resolver.ts` | Uses PolicyManager (indirectly via adapters) for integration scope |
| `backend/src/lambda/agent-credential-vender.ts` | Uses PolicyManager for agent scope |
| `backend/src/adapters/integration/base-integration-adapter.ts` | Delegates to `computeIntegrationPolicies()` |
| `backend/src/lambda/adapters/*.ts` | 20+ concrete adapters, each implementing `requiredPolicies()` |
| `backend/lib/backend-stack.ts` | CDK grants for `citadel-ds-*` and `citadel-int-*` roles |
| `backend/lib/arbiter-stack.ts` | CDK grants for `citadel-agent-*` roles |

---

## How It Works

### 1. Role Creation — `ensureRole()`

```typescript
async ensureRole(
  resourceId: string,
  policies: PolicyStatement[],
  accountId: string,
  scope?: PolicyScope,          // defaults to 'datastore'
  crossAccountRoleArn?: string  // optional cross-account trust
): Promise<void>
```

This method:

1. Derives the role name from the scope prefix and resource ID (e.g. `citadel-ds-<uuid>`).
2. Resolves the calling Lambda's execution role ARN from STS `GetCallerIdentity`.
3. Builds a trust policy that allows the Lambda execution role (and optionally a cross-account role) to assume the new role.
4. Calls `iam:CreateRole` with the trust policy and tags (`ManagedBy: citadel`, `ResourceId`, `Scope`).
5. If the role already exists (`EntityAlreadyExistsException`), it silently continues — making the operation idempotent.
6. Calls `iam:PutRolePolicy` to attach an inline policy named `DataStoreAccess` containing exactly the actions and resources from the `PolicyStatement[]` array.

The inline policy document is built by the static `buildPolicyDocument()` method:

```typescript
static buildPolicyDocument(policies: PolicyStatement[]): Record<string, any> {
  return {
    Version: '2012-10-17',
    Statement: policies.map(p => ({
      Effect: 'Allow',
      Action: p.actions,
      Resource: p.resources,
    })),
  };
}
```

### 2. Credential Assumption — `assumeScopedRole()`

```typescript
async assumeScopedRole(
  resourceId: string,
  accountId: string,
  scope?: PolicyScope,
  crossAccountRoleArn?: string
): Promise<ScopedCredentials>
```

This method:

1. Constructs the role ARN: `arn:aws:iam::<accountId>:role/<scopePrefix><resourceId>`.
2. If a cross-account role ARN is provided, first assumes that role to get intermediate credentials, then creates a new STS client with those credentials.
3. Calls `sts:AssumeRole` on the scoped role with a session name of `citadel-<scope>-<resourceId>`.
4. Returns the temporary credentials.
5. Both the cross-account assume and the scoped assume use `retryWithBackoff()` to handle IAM eventual consistency.

### 3. Role Deletion — `deleteRole()`

```typescript
async deleteRole(resourceId: string, scope?: PolicyScope): Promise<void>
```

Performs a two-step cleanup:

1. `iam:DeleteRolePolicy` to remove the inline policy.
2. `iam:DeleteRole` to remove the role itself.

Both steps tolerate `NoSuchEntityException` so the operation is idempotent — safe to call even if the role was already cleaned up.

### 4. Backward Compatibility

The `scope` parameter was added after the initial datastore-only implementation. To avoid breaking existing callers, `ensureRole()` and `assumeScopedRole()` accept the scope as an optional parameter that defaults to `'datastore'`. They also detect if the fourth argument looks like an ARN (rather than a scope string) and treat it as `crossAccountRoleArn` for backward compatibility.

---

## Scoped Role Naming Convention

| Scope | Prefix | Example Role Name | CDK Wildcard Grant |
|-------|--------|-------------------|--------------------|
| `datastore` | `citadel-ds-` | `citadel-ds-a1b2c3d4-...` | `arn:aws:iam::<account>:role/citadel-ds-*` |
| `integration` | `citadel-int-` | `citadel-int-e5f6g7h8-...` | `arn:aws:iam::<account>:role/citadel-int-*` |
| `agent` | `citadel-agent-` | `citadel-agent-i9j0k1l2-...` | `arn:aws:iam::<account>:role/citadel-agent-*` |

The naming convention is critical because:

- CDK stacks grant IAM permissions using wildcard patterns on these prefixes. If the prefix changes, the Lambda functions lose the ability to create/delete roles.
- The `policy-scope-roles.test.ts` test suite explicitly validates that `getRoleName()` produces the expected prefixes and that all three scopes produce distinct prefixes.
- Tags on each role (`ManagedBy: citadel`, `ResourceId`, `Scope`) enable auditing and automated cleanup.

---

## Policy Computation

### Datastore Policies

Each datastore adapter implements `requiredPolicies()` directly. For example, the S3 adapter:

```typescript
// S3Adapter.requiredPolicies()
return {
  provision: [
    { actions: ['s3:CreateBucket', 's3:PutBucketVersioning', ...], resources: ['*'] },
  ],
  connect: [
    { actions: ['s3:HeadBucket', 's3:ListBucket', 's3:GetObject', 's3:PutObject'],
      resources: [bucketArn, `${bucketArn}/*`] },
  ],
};
```

The DynamoDB adapter similarly scopes connect policies to the specific table ARN and its indexes.

### Integration Policies

Integration adapters delegate to `computeIntegrationPolicies()` in `policy-helpers.ts`. This function generates up to four policy types based on the integration's configuration:

1. **Secret read** — `secretsmanager:GetSecretValue` scoped to the integration's secret ARN.
2. **SSM parameter read** — `ssm:GetParameter` scoped to the integration's parameter prefix.
3. **AgentCore gateway invocation** — `bedrock-agentcore:InvokeGatewayTarget` for `AWS_LAMBDA`, `AWS_SMITHY`, and `MCP_SERVER` types.
4. **Lambda invocation** — `lambda:InvokeFunction` for `AWS_LAMBDA` types with a configured `lambdaArn`.

### Agent Policies

`computeAgentPolicies()` generates policies based on an agent's declared permissions:

```typescript
interface AgentPermissions {
  models?: string[];       // Bedrock model IDs → bedrock:InvokeModel
  dataStores?: string[];   // DataStore IDs → sts:AssumeRole on citadel-ds-<id>
  integrations?: string[]; // Integration IDs → sts:AssumeRole on citadel-int-<id>
}
```

This creates a permission chain: an agent's scoped role grants `sts:AssumeRole` on datastore and integration roles, which in turn grant access to the actual AWS resources. This is a deliberate two-hop design that ensures agents can only access resources they've been explicitly granted.

---

## Cross-Account Access

PolicyManager supports cross-account resource access through a two-hop STS assume pattern:

```
Lambda Execution Role
  → sts:AssumeRole(crossAccountRoleArn)     ← hop 1: into the remote account
    → sts:AssumeRole(citadel-ds-<id>)     ← hop 2: into the scoped role
```

When `crossAccountRoleArn` is provided:

1. The trust policy on the scoped role includes both the Lambda execution role and the cross-account role as principals.
2. `assumeScopedRole()` first assumes the cross-account role, then uses those intermediate credentials to assume the scoped role.

When no cross-account role is provided, the trust policy contains a single principal (the Lambda execution role as a string, not an array), and `assumeScopedRole()` directly assumes the scoped role.

---

## Retry and Resilience

### `retryWithBackoff()`

```typescript
async retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number,
  baseDelayMs: number
): Promise<T>
```

A generic exponential backoff retry mechanism used internally for STS `AssumeRole` calls. IAM role creation has eventual consistency — a role may not be assumable immediately after creation. The retry handles this:

- **Initial attempt** + up to `maxRetries` additional attempts.
- **Delay formula**: `baseDelayMs * 2^attempt` (exponential backoff).
- **On exhaustion**: throws the last error encountered.

The datastore resolver inserts a 2-second delay between `ensureRole()` and `assumeScopedRole()` as an additional buffer for IAM propagation. The `assumeScopedRole()` method itself uses 3 retries with a 2-second base delay (so delays of 2s, 4s, 8s).

For cross-account assumes, the first hop uses 3 retries with a 1-second base delay.

### Property-Based Testing of Retry

The retry mechanism is validated with property-based tests (fast-check) that verify:

- Operations that fail ≤ `maxRetries` times then succeed → returns success.
- Operations that fail > `maxRetries` times → throws the last error.
- Delay between attempt `i` and `i+1` is approximately `baseDelayMs * 2^i`.

---

## CDK Infrastructure Grants

Each Lambda function that uses PolicyManager needs two sets of IAM permissions granted at the CDK level:

### 1. IAM Role Management Permissions

```typescript
// backend-stack.ts — datastore resolver
new iam.PolicyStatement({
  actions: ['iam:CreateRole', 'iam:DeleteRole', 'iam:GetRole',
            'iam:PutRolePolicy', 'iam:DeleteRolePolicy', 'iam:TagRole'],
  resources: [`arn:aws:iam::${account}:role/citadel-ds-*`],
})
```

```typescript
// backend-stack.ts — integration resolver
// Same actions, but scoped to: arn:aws:iam::<account>:role/citadel-int-*
```

```typescript
// arbiter-stack.ts — agent credential vender + worker wrapper
// Same actions, but scoped to: arn:aws:iam::<account>:role/citadel-agent-*
```

### 2. STS Permissions

```typescript
new iam.PolicyStatement({
  actions: ['sts:AssumeRole', 'sts:GetCallerIdentity'],
  resources: ['*'],
})
```

`sts:AssumeRole` uses `resources: ['*']` because the scoped roles are created dynamically and their ARNs aren't known at deploy time. The actual access control is enforced by the trust policy on each scoped role, which only allows the specific Lambda execution role to assume it.

---

## Error Handling

PolicyManager uses the `PermissionError` class from the unified error hierarchy (`backend/src/adapters/errors.ts`):

```typescript
class PermissionError extends ConnectorError {
  constructor(message: string, cause?: Error) {
    super(message, 'PERMISSION_ERROR', false, cause);
  }
}
```

Key error handling behaviors:

| Operation | Error | Behavior |
|-----------|-------|----------|
| `ensureRole` → `CreateRole` | `EntityAlreadyExistsException` | Silently continues (idempotent) |
| `ensureRole` → `PutRolePolicy` | Any error | Throws `PermissionError` |
| `deleteRole` → `DeleteRolePolicy` | `NoSuchEntityException` | Silently continues (idempotent) |
| `deleteRole` → `DeleteRole` | `NoSuchEntityException` | Silently continues (idempotent) |
| `assumeScopedRole` | Any error | Retries with exponential backoff, then throws |

`PermissionError` is marked `retryable: false` because IAM permission failures are typically configuration issues, not transient errors.

---

## Testing Strategy

The Policy Manager has three layers of test coverage:

### Unit Tests (`backend/src/adapters/__tests__/policy-manager.test.ts`)

Uses `aws-sdk-client-mock` to mock IAM and STS clients. Validates:

- Role creation with each scope prefix (`citadel-ds-`, `citadel-int-`, `citadel-agent-`).
- Backward compatibility (defaults to `datastore` scope when no scope is provided).
- `assumeScopedRole()` constructs the correct role ARN.
- `deleteRole()` calls the correct IAM commands with the correct role name.
- `buildPolicyDocument()` produces valid IAM policy JSON.
- `getRoleName()` returns the expected scoped name.

### Property-Based Tests (`backend/src/lambda/adapters/__tests__/policy-manager.property.test.ts`)

Uses `fast-check` to generate random inputs and verify invariants:

- **Property 2**: For any valid `dataStoreId` and `PolicyStatement[]`, `ensureRole` creates a role named `citadel-ds-{dataStoreId}` with an inline policy whose statements match the input 1:1.
- **Property 3**: When a cross-account role ARN is provided, the trust policy contains both principals as an array. When omitted, the trust policy contains a single string principal.
- **Property 4**: The retry mechanism correctly succeeds after transient failures and correctly fails after exhausting retries, with exponential backoff timing.

Each property runs 100 iterations (20 for timing-sensitive tests).

### Scope Naming Tests (`backend/src/adapters/__tests__/policy-scope-roles.test.ts`)

Validates that role naming patterns match what CDK stacks expect:

- Datastore roles match `^citadel-ds-`.
- Integration roles match `^citadel-int-`.
- Agent roles match `^citadel-agent-`.
- All three scopes produce distinct prefixes.

### Policy Helper Tests (`backend/src/utils/__tests__/policy-manager.test.ts`)

Validates `computeIntegrationPolicies()` and `computeAgentPolicies()`:

- Integration policies include secret-read, SSM-read, gateway invocation, and Lambda invocation as appropriate.
- Agent policies include Bedrock model invocation and `sts:AssumeRole` on datastore/integration roles.
- Empty permissions produce empty policy arrays.

### Integration Adapter Policy Tests (`backend/src/adapters/__tests__/integration-adapter-policies.test.ts`)

Validates that all 13 integration adapter types return correct policies through the `UnifiedRegistry`:

- SaaS connectors (Confluence, Jira, etc.) return secret-read and SSM-read policies.
- AgentCore connectors (AWS_LAMBDA, AWS_SMITHY, MCP_SERVER) return gateway target and Lambda invocation policies.
- All integration adapters return empty `provision` policies (integrations are never provisioned).
---
## Architectural Decisions

### 1. One Role Per Resource

Each datastore, integration, and agent gets its own dedicated IAM role rather than sharing roles. This means:
- Deleting a resource cleanly removes its permissions without affecting others
- Policy updates for one resource don't require coordinating with others
- Audit trails clearly show which resource performed which action

### 2. Inline Policies Over Managed Policies

The system uses a single inline policy (`DataStoreAccess`) per role rather than AWS managed policies. This avoids the 10-managed-policy-per-role limit and simplifies updates — `PutRolePolicy` is an atomic overwrite.

### 3. Scope-Based Prefix Convention

Rather than a single prefix for all dynamic roles, the three-prefix system (`citadel-ds-`, `citadel-int-`, `citadel-agent-`) enables CDK to grant each Lambda only the scope it needs. This is a defense-in-depth measure that limits blast radius if a Lambda is compromised.

### 4. Adapter-Driven Policy Declaration

Adapters own their policy requirements rather than having a central policy registry. This keeps policy definitions co-located with the code that uses them and makes it impossible to add a new adapter without declaring its permissions.

### 5. Provision vs. Connect Separation

The `RequiredPolicies` interface splits policies into `provision` (create infrastructure) and `connect` (use infrastructure). This ensures that a `CONNECT_EXISTING` operation never receives `CreateBucket` or `CreateTable` permissions.

### 6. Agent Permission Chaining

Agent roles don't get direct resource permissions. Instead, they get `sts:AssumeRole` on the datastore/integration roles they declare. This creates a two-hop permission chain that reuses the existing scoped roles and avoids duplicating policy definitions.

---

## Best Practice Alignment

### Principle of Least Privilege
Every scoped role contains only the permissions declared by the adapter's `requiredPolicies()` for the specific operation. Policies are resource-scoped to specific ARNs (bucket names, table names, function ARNs) rather than wildcards wherever possible.

### Defense in Depth
Three layers of access control:
1. CDK grants restrict which role name patterns each Lambda can manage
2. Trust policies on scoped roles restrict which principals can assume them
3. Inline policies on scoped roles restrict what actions the assumed credentials can perform

### Temporary Credentials
All resource access uses STS temporary credentials from `AssumeRole`. No long-lived access keys are stored or passed around.

### Separation of Concerns
- Adapters declare what permissions they need (policy computation)
- PolicyManager handles how those permissions are provisioned (IAM operations)
- CDK stacks define who is allowed to use PolicyManager (infrastructure grants)

### Idempotency
All PolicyManager operations are safe to retry: `ensureRole` handles existing roles, `deleteRole` handles missing roles, and `PutRolePolicy` overwrites atomically.

### Auditability
Every scoped role is tagged with `ManagedBy=citadel`, `ResourceId`, and `Scope`, making it straightforward to identify and audit dynamically created roles via IAM or CloudTrail.

---

## Adding Policy Manager to a New Component

### Step 1: Define Required Policies

If creating a new adapter, implement `requiredPolicies()`:

```typescript
import { ConnectorAdapter, RequiredPolicies } from '../../adapters/base';

export class MyNewAdapter implements ConnectorAdapter {
  // ... category, spec, etc.

  requiredPolicies(config: Record<string, any>, accountId: string, region: string): RequiredPolicies {
    return {
      provision: [],
      connect: [
        {
          actions: ['myservice:ReadData', 'myservice:WriteData'],
          resources: [`arn:aws:myservice:${region}:${accountId}:resource/${config.resourceName}`],
        },
      ],
    };
  }
}
```

If computing policies outside the adapter pattern (like agent credentials), add a helper function to `backend/src/utils/policy-helpers.ts`.

### Step 2: Use PolicyManager in Your Lambda

```typescript
import { PolicyManager } from '../utils/policy-manager';

const policyManager = new PolicyManager();

export async function handler(event: any) {
  const { accountId, region } = await policyManager.getAccountContext();
  const adapter = getAdapter(event.type);
  const policies = adapter.requiredPolicies(config, accountId, region).connect;

  if (policies.length > 0) {
    await policyManager.ensureRole(resourceId, policies, accountId, 'datastore');
    const creds = await policyManager.assumeScopedRole(resourceId, accountId, 'datastore');
    await adapter.connect(config, creds);
  }
}
```

### Step 3: Add CDK IAM Grants

In your CDK stack, grant the Lambda permission to manage roles in the appropriate scope:

```typescript
myLambda.addToRolePolicy(
  new iam.PolicyStatement({
    effect: iam.Effect.ALLOW,
    actions: [
      'iam:CreateRole', 'iam:DeleteRole', 'iam:GetRole',
      'iam:PutRolePolicy', 'iam:DeleteRolePolicy', 'iam:TagRole',
    ],
    resources: [`arn:aws:iam::${this.account}:role/citadel-ds-*`], // match your scope
  })
);

myLambda.addToRolePolicy(
  new iam.PolicyStatement({
    effect: iam.Effect.ALLOW,
    actions: ['sts:AssumeRole', 'sts:GetCallerIdentity'],
    resources: ['*'],
  })
);
```

### Step 4: Register in the Unified Registry (if adding an adapter)

Add your adapter to `buildDataStoreAdapters()` or `buildIntegrationAdapters()` in `backend/src/adapters/registry.ts`:

```typescript
function buildDataStoreAdapters(): Record<string, ConnectorAdapter> {
  return {
    // ... existing adapters
    MY_NEW_TYPE: new MyNewAdapter(),
  };
}
```

### Step 5: Handle Cleanup

Always delete the scoped role when the resource is deleted:

```typescript
try {
  await policyManager.deleteRole(resourceId, 'datastore');
} catch (error) {
  console.warn('Failed to delete IAM role:', error);
}
```

### Step 6: Adding a New Policy Scope

If you need a scope beyond `datastore`, `integration`, and `agent`:

1. Add the scope to the `PolicyScope` type and `SCOPE_PREFIXES` map in `policy-manager.ts`:
   ```typescript
   export type PolicyScope = 'datastore' | 'integration' | 'agent' | 'workflow';
   const SCOPE_PREFIXES: Record<PolicyScope, string> = {
     datastore: 'citadel-ds-',
     integration: 'citadel-int-',
     agent: 'citadel-agent-',
     workflow: 'citadel-wf-',
   };
   ```

2. Update the `isScope()` type guard to include the new value.

3. Add CDK grants for the new prefix pattern in the appropriate stack.

4. Add a test in `policy-scope-roles.test.ts` to verify the naming convention.

