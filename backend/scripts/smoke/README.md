# Deployed Smoke Test

Headless post-deploy smoke that validates the critical AppSync paths against a live Citadel deployment: authentication, subscriptions, conversation round-trips, tool invocation, workflow execution, and the blueprint catalog.

## Prerequisites

- Node.js 24+
- A deployed Citadel environment with a Cognito user pool client that has `ALLOW_ADMIN_USER_PASSWORD_AUTH` enabled
- A Cognito user with access to the target project
- The Echo Demo workflow and a smoke echo tool seeded in the deployment

## Environment variables

Run `--print-env-template` to get a ready-to-fill template:

```bash
node backend/scripts/smoke/deployed-smoke.mjs --print-env-template > .env.smoke
```

Fill in the values, then source them:

```bash
set -a; source .env.smoke; set +a
```

## Running

From the repository root:

```bash
npm run smoke --prefix backend
```

Or directly:

```bash
node backend/scripts/smoke/deployed-smoke.mjs
```

## What each step proves

| # | Check | What it proves |
|---|-------|----------------|
| 1 | `auth` | Cognito admin-initiate-auth returns a valid ID token (user pool client configured, user exists, password correct). |
| 2 | `subscription-negative` | Subscribing to `onConversationMessage` with a zero-UUID project triggers a refusal or completes without data — validates the project-subscription-authorizer Lambda. |
| 3 | `chat-roundtrip` | `sendMessage` + `onConversationMessage` subscription: a TURN_ACCEPTED arrives within 8 s and an agent response within 90 s — proves the intake agent, EventBridge routing, and the AppSync publish pipeline are operational. |
| 4 | `test-tool` | `testTool` mutation succeeds — validates Lambda tool execution and the tool-sandbox path. |
| 5 | `workflow-execution` | `startExecution` of the Echo Demo workflow + `onWorkflowProgress` reaches a terminal COMPLETED status with all nodes done — proves the StepRunner, node dispatch, and progress subscriptions work end to end. |
| 6 | `list-blueprints` | `listBlueprints` returns a non-empty list containing the Echo Demo — validates the blueprint catalog and the seeded data. |

## Output

A JSON report is written to stdout:

```json
{
  "timestamp": "2026-11-05T12:00:00.000Z",
  "checks": [
    { "name": "auth", "pass": true, "durationMs": 342 },
    { "name": "subscription-negative", "pass": true, "durationMs": 1204 }
  ],
  "summary": { "total": 6, "passed": 6, "failed": 0 }
}
```

Exit code `0` when all checks pass, `1` when any check fails.
