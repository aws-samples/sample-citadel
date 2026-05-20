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
