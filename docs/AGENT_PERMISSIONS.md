# Agent Scoped Credentials

Fabricated worker agents run user-uploaded Python code inside a shared Lambda. Without scoping, every agent gets the Lambda's full IAM permissions (`bedrock:InvokeModel *`, S3 read, DynamoDB read, EventBridge put). The agent credential vending system restricts each agent to only the AWS permissions it declares, and runs agent code in an isolated subprocess so credentials never touch the parent process.

## Architecture

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────────────┐
│  SQS Queue  │────▶│  Worker Wrapper  │────▶│ Credential Vender   │
│  (task msg) │     │  (Python Lambda) │     │ (TypeScript Lambda) │
└─────────────┘     └───────┬──────────┘     └──────────┬──────────┘
                            │                           │
                   reads config from              ┌─────┴──────┐
                   DynamoDB, checks               │PolicyManager│
                   requiredPermissions            └─────┬──────┘
                            │                           │
                   spawns subprocess              creates/assumes
                   with scoped creds              citadel-agent-{id}
                   in child env only              IAM role via STS
                            │
                   ┌────────▼────────┐
                   │  Subprocess     │
                   │  agent_runner.py│
                   │  (isolated env) │
                   │  boto3 uses     │
                   │  scoped creds   │
                   └─────────────────┘
```

## Why Subprocess Isolation

An earlier approach set scoped credentials as environment variables on the parent Lambda process (`os.environ['AWS_ACCESS_KEY_ID'] = ...`). This has several security risks:

1. **Credential exfiltration** — User-uploaded agent code runs in the same process and can read `os.environ` to extract the scoped credentials, then send them to an external endpoint. The credentials are valid for up to 1 hour (STS default), so leaked credentials remain usable long after the Lambda finishes.

2. **Cross-agent leakage** — If the Lambda processes multiple agents sequentially (SQS batch size > 1, or a crash before cleanup), a later agent could read credentials left over from a previous agent's execution in `os.environ`.

3. **Process introspection** — Environment variables are visible in `/proc/self/environ` and via Lambda runtime introspection, making them accessible to any code running in the same process.

4. **Cleanup fragility** — The `finally` block that removes env vars can be bypassed if the process crashes or the agent code calls `os._exit()`.

Subprocess isolation eliminates all of these risks:

- Scoped credentials are passed only to the **child process's environment** via `subprocess.run(env=child_env)`. The parent's `os.environ` is never modified.
- When the subprocess exits, its environment is destroyed by the OS. No cleanup code needed.
- The parent retains its original Lambda IAM role credentials throughout, so post-processing (EventBridge events) always works.
- Even if the agent code reads `os.environ` in the subprocess, it only sees the scoped credentials — never the parent Lambda's ambient permissions.

## How It Works

### 1. Agent config declares permissions

When an agent is created (via the Fabricator or manually), its config in DynamoDB can include a `requiredPermissions` field:

```json
{
  "agentId": "my-agent",
  "config": {
    "filename": "my_agent.py",
    "name": "My Agent",
    "description": "Does things",
    "requiredPermissions": {
      "models": ["anthropic.claude-sonnet-4-20250514"],
      "dataStores": ["ds-abc-123"],
      "integrations": ["int-xyz-456"]
    }
  }
}
```

| Field | Type | Effect |
|-------|------|--------|
| `models` | `string[]` | Grants `bedrock:InvokeModel` scoped to those specific foundation model ARNs |
| `dataStores` | `string[]` | Grants `sts:AssumeRole` on the datastore's scoped role (`citadel-ds-{id}`) |
| `integrations` | `string[]` | Grants `sts:AssumeRole` on the integration's scoped role (`citadel-int-{id}`) |

### 2. Worker wrapper invokes the credential vender

When the Python worker wrapper processes a task from SQS, it:

1. Loads the agent config from DynamoDB
2. Checks for `config.requiredPermissions`
3. If present, invokes the `agent-credential-vender` Lambda synchronously with the agent ID and permissions
4. The credential vender returns temporary STS credentials (or null if no permissions are needed)

### 3. Credential vender creates a scoped IAM role

The TypeScript credential vender Lambda (`backend/src/lambda/agent-credential-vender.ts`):

1. Calls `computeAgentPolicies()` to convert the declared permissions into IAM `PolicyStatement` arrays
2. Calls `PolicyManager.ensureRole(agentId, policies, accountId, 'agent')` to create or update an IAM role named `citadel-agent-{agentId}` with an inline policy containing exactly those statements
3. Calls `PolicyManager.assumeScopedRole(agentId, accountId, 'agent')` to get temporary STS credentials for that role
4. Returns the credentials to the worker wrapper

### 4. Agent code runs in an isolated subprocess

The worker wrapper spawns `agent_runner.py` as a subprocess:

```python
result = subprocess.run(
    [sys.executable, AGENT_RUNNER_PATH],
    input=runner_input,       # agent module path + request as JSON via stdin
    capture_output=True,
    text=True,
    timeout=840,              # 14 minutes (Lambda timeout is 15)
    env=child_env,            # scoped credentials ONLY in child env
)
```

The child environment is a copy of the parent's env with AWS credential keys overwritten (if scoped credentials exist) or removed (if not). The parent's `os.environ` is never modified.

The `agent_runner.py` script:
1. Reads the module path and request from stdin
2. Loads and executes the agent module
3. Writes the response as JSON to stdout
4. Exits — the OS destroys the child's environment

### 5. Backward compatibility

Agents without `requiredPermissions` in their config continue to run in a subprocess using the Lambda's ambient IAM role (credential env vars are removed from the child env so boto3 falls back to the metadata service). No changes are needed to existing agent configs.

## IAM Role Naming

The PolicyManager uses scoped prefixes to keep roles organized:

| Scope | Role name pattern | Created by |
|-------|-------------------|------------|
| Datastore | `citadel-ds-{dataStoreId}` | Datastore resolver on connect/provision |
| Integration | `citadel-int-{integrationId}` | Integration resolver (future) |
| Agent | `citadel-agent-{agentId}` | Credential vender on agent execution |

Each role gets a trust policy allowing the creating Lambda's execution role to assume it, and an inline policy with only the declared permissions.

## CDK Infrastructure

The arbiter stack (`backend/lib/arbiter-stack.ts`) provisions:

- `AgentCredentialVender` — Node.js Lambda with `iam:CreateRole/DeleteRole/PutRolePolicy` on `citadel-agent-*` and `sts:AssumeRole/GetCallerIdentity` on `*`
- `WorkerAgentWrapper` — Python Lambda with `lambda:InvokeFunction` on the credential vender (granted via `credentialVenderLambda.grantInvoke`)
- Environment variable `CREDENTIAL_VENDER_FUNCTION` passed to the worker wrapper

## Policy Computation

`backend/src/utils/policy-helpers.ts` provides `computeAgentPolicies()`:

```typescript
computeAgentPolicies(agentId, {
  models: ['anthropic.claude-sonnet-4-20250514'],
  dataStores: ['ds-abc'],
  integrations: ['int-xyz'],
}, accountId, region)
```

Returns:

```json
[
  {
    "actions": ["bedrock:InvokeModel"],
    "resources": ["arn:aws:bedrock:us-west-2::foundation-model/anthropic.claude-sonnet-4-20250514"]
  },
  {
    "actions": ["sts:AssumeRole"],
    "resources": ["arn:aws:iam::123456789012:role/citadel-ds-ds-abc"]
  },
  {
    "actions": ["sts:AssumeRole"],
    "resources": ["arn:aws:iam::123456789012:role/citadel-int-int-xyz"]
  }
]
```

## Example: Restricting an Agent to a Single Model

Agent config:

```json
{
  "requiredPermissions": {
    "models": ["anthropic.claude-sonnet-4-20250514"]
  }
}
```

Result: the agent can only call `bedrock:InvokeModel` on Claude Sonnet 4. Attempts to invoke other models will get `AccessDeniedException`.

## Example: Agent with Datastore Access

Agent config:

```json
{
  "requiredPermissions": {
    "models": ["anthropic.claude-sonnet-4-20250514"],
    "dataStores": ["ds-my-s3-bucket"]
  }
}
```

Result: the agent can invoke Claude Sonnet 4 and assume the `citadel-ds-ds-my-s3-bucket` role (which has S3 read/write on that specific bucket). The agent code would call `sts:AssumeRole` to get the datastore credentials, or use the scoped session directly.

## Workflow Execution Permissions

Workflow execution (see [BLUEPRINTS_WORKFLOWS.md](./BLUEPRINTS_WORKFLOWS.md#how-access-and-permissions-work)) adds a second least-privilege surface alongside credential vending: the Step Runner engine, the worker's workflow-dispatch path, a timeout watchdog, a progress fan-out, the workflow/execution resolvers, and two seed Lambdas. Grants name specific tables, queues, buses, and ARN patterns — never a blanket `*` on data-plane actions. For the operator-facing summary, see the [IAM posture notes in WORKFLOW_USER_GUIDE.md](./WORKFLOW_USER_GUIDE.md#iam-posture).

### Per-function grants

The workflow-execution grants per function:

| Function | Actions | Resources | Notes |
|----------|---------|-----------|-------|
| `StepRunnerFunction` | DynamoDB read/write | Executions table | Owns durable execution state |
| | DynamoDB read | Workflows, agent config, and tools config tables | Definition and agent lookups at dispatch |
| | `events:PutEvents` | `citadel-agents-{env}` bus | Emits `workflow.*` progress events |
| | `sqs:SendMessage` | `citadel-worker-agent-queue-{env}` | Send-only node dispatch — never Receive/Delete; the worker owns consumption |
| | `cloudwatch:PutMetricData` | `*`, narrowed to the `Citadel/Workflows` namespace | `NodeDurationMs` / `NodeFailure` metrics |
| `WorkerAgentWrapper` | `bedrock:InvokeModel`, `bedrock:InvokeModelWithResponseStream` | `arn:aws:bedrock:*::foundation-model/anthropic.claude-*`, `arn:aws:bedrock:*::foundation-model/amazon.*`, `arn:aws:bedrock:*:{account}:inference-profile/*` | Scoped model ARNs — never a blanket `*` |
| | `events:PutEvents` | `citadel-agents-{env}` bus | Emits `workflow.node.completed` / `workflow.node.failed` |
| | DynamoDB read | Agent config and execution specifications tables | Config load plus a read-only dispatch-time spec check |
| | S3 read | Agent code bucket | Downloads `agents/<filename>` for subprocess execution |
| | `lambda:InvokeFunction` | Credential vender | Scoped-credential vending (see [How It Works](#how-it-works)) |
| | `iam:CreateRole` / `DeleteRole` / `GetRole` / `PutRolePolicy` / `DeleteRolePolicy` / `TagRole`, `sts:AssumeRole` | `arn:aws:iam::{account}:role/citadel-agent-*` | PolicyManager role lifecycle; `sts:GetCallerIdentity` on `*` |
| | `bedrock-agentcore:GetRegistryRecord`, `bedrock-agentcore:ListRegistryRecords` | Registry ARN (when the registry is enabled) | Read-only registry lookups |
| | `cloudwatch:PutMetricData` | `*`, narrowed to `Citadel/Workflows` | |
| `WorkflowTimeoutWatchdogFunction` | `dynamodb:Scan`, `dynamodb:UpdateItem` | Executions table | Explicit two-action statement — deliberately not `grantReadWriteData` |
| | `events:PutEvents` | `citadel-agents-{env}` bus | Emits `workflow.failed` on timeout |
| | `cloudwatch:PutMetricData` | `*`, narrowed to `Citadel/Workflows` | `WorkflowTimedOut` metric |
| `WorkflowProgressFanoutFunction` | `appsync:GraphQL` | `{apiArn}/types/Mutation/fields/publishWorkflowProgress` | Single-field grant on the progress mutation |
| | `cloudwatch:PutMetricData` | `*`, narrowed to `Citadel/Workflows` | `FanoutPublishFailure` metric |
| `WorkflowResolverFunction` | DynamoDB read/write | Workflows and apps tables | `importBlueprint` appends to `app.workflowIds` |
| | DynamoDB read | Agent config table | Publish-time `verifyAgentsExist` batch lookup |
| | `events:PutEvents`, `cognito-idp:AdminGetUser` | Bus; user pool | Org-scoped access checks |
| `ExecutionResolverFunction` | DynamoDB read/write | Executions table | |
| | DynamoDB read | Workflows table | Enforces the `PUBLISHED` gate on `startExecution` |
| | `events:PutEvents`, `cognito-idp:AdminGetUser` | Bus; user pool | Org-scoped access checks |
| `SeedBlueprintsFunction` | DynamoDB write | Workflows table | Write-only; idempotent via `attribute_not_exists(workflowId)` |
| `SeedAgentConfigFunction` | DynamoDB write | Agent config table | Seeds the `demo-echo-agent` config |
| | DynamoDB write | Authority units and constitutional layers tables | Governance seed data |
| | `bedrock-agentcore:CreateRegistryRecord`, `bedrock-agentcore:ListRegistryRecords` | Registry ARN (when the registry is enabled) | Create/List only — no update, status change, or delete |
| | `s3:PutObject*` | Agent code bucket, `agents/*` prefix | Path-scoped `grantPut`; uploads `agents/demo_echo_agent.py` |

### Invocation topology

- `StepRunnerFunction` — triggered by four EventBridge rules on the agents bus: `execution.start.requested`, `workflow.node.completed`, `workflow.node.failed`, and `execution.cancel.requested`
- `WorkerAgentWrapper` — consumes `citadel-worker-agent-queue-{env}` (batch size 1, dead-letter queue after 3 receives); workflow node dispatches arrive as discriminated messages sent by the Step Runner
- `WorkflowTimeoutWatchdogFunction` — EventBridge schedule, every 5 minutes; fails executions `running` longer than `WORKFLOW_TIMEOUT_SECONDS` (default 3600) via a conditional update
- `WorkflowProgressFanoutFunction` — triggered by a rule matching the seven `workflow.*` progress event types; calls the `publishWorkflowProgress` mutation

The Step Runner and its rules, the worker, the watchdog, the fan-out rule, and `SeedAgentConfigFunction` are provisioned by the arbiter stack (`backend/lib/arbiter-stack.ts`); the fan-out Lambda, the workflow/execution resolvers, and `SeedBlueprintsFunction` by the backend stack (`backend/lib/backend-stack.ts`).

### Governance of workflow-dispatched agents

Workflow node dispatch reuses the subprocess isolation described above. The worker's `_process_workflow_node` builds the child environment via `worker_governance.build_subprocess_env`, which installs three governance variables:

| Variable | Value | Effect |
|----------|-------|--------|
| `CITADEL_AGENT_ID` | The node's `agentId` | Triggers installation of the layer-2 `GovernedToolHandler` in `agent_runner` — without it, layer-2 tool governance is bypassed |
| `CITADEL_WORKFLOW_ID` | The execution ID (not the reusable workflow template ID) | Correlates every worker-tool-handler finding to a single run, mirroring the supervisor path's orchestration ID |
| `MODEL_OVERRIDE` | The node's `modelOverride`, only when 256 characters or fewer | Consumed by `agent_runner` — the same mechanism as the supervisor path |

`systemPromptAddition` is appended to the agent's system prompt before dispatch, capped at `WORKER_MAX_PROMPT_ADDITION_CHARS` (the arbiter stack does not set the variable, so deployed environments use the default of 4000); oversized values are skipped with a warning, never truncated. The supervisor path's `DENIED_TOOLS` denial list is not populated on the workflow path. Scoped credentials from the credential vender are passed only into the child subprocess environment — the parent Lambda's environment is never modified.

## File Locations

| File | Purpose |
|------|---------|
| `backend/src/lambda/agent-credential-vender.ts` | Credential vender Lambda handler |
| `backend/src/utils/policy-manager.ts` | PolicyManager (IAM role lifecycle) |
| `backend/src/utils/policy-helpers.ts` | `computeAgentPolicies()` |
| `arbiter/workerWrapper/index.py` | Python worker wrapper (spawns subprocess) |
| `arbiter/workerWrapper/agent_runner.py` | Subprocess runner (executes agent code) |
| `backend/lib/arbiter-stack.ts` | CDK infrastructure for both Lambdas |
| `backend/src/lambda/__tests__/agent-credential-vender.test.ts` | Unit tests |
| `arbiter/stepRunner/executor.py` | Step Runner orchestration (dispatch, completion, cancellation) |
| `arbiter/stepRunner/timeout_watchdog.py` | Scheduled execution-timeout sweep |
| `arbiter/workerWrapper/worker_governance.py` | Override caps and subprocess env governance |
| `backend/src/lambda/workflow-progress-fanout.ts` | Progress fan-out to AppSync |
| `backend/src/lambda/seed-blueprints/index.ts` | Seed blueprint loader |
| `backend/lib/backend-stack.ts` | CDK infrastructure for the resolvers, fan-out, and blueprint seeding |
