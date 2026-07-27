# Cost Query API & Budgets

Citadel tracks estimated model-invocation spend per organization and exposes it through a dedicated HTTP API, plus a lightweight budget-alerting system, both hosted in `TelemetryStack` alongside the existing invocation cost ledger.

## Overview

- **Ledger**: `citadel-cost-ledger-{env}` (DynamoDB). Rows are written by `cost-ledger-writer.ts` from three EventBridge sources (`task.completion`, `agent_intake.usage`, workflow node completion). Every row carries `estimate: true` — costs are derived from token usage and catalog pricing, never a billing invoice. Rows may additionally carry a `bedrockRequestId` (additive, nullable — present only when the originating SDK call reported one) used by Tier B reconciliation below.
- **Query surface**: a Cognito-JWT-authorized HTTP API (`citadel-cost-api-{env}`), split across two Lambdas by IAM role: `cost-query-handler.ts` (read-only — `GET /cost/summary`, `GET /cost/series`; role carries `dynamodb:Query` only, never `UpdateItem`) and `cost-budget-handler.ts` (`GET /budgets`, `PUT /budgets/{scope}`; role carries `dynamodb:Query` + `dynamodb:UpdateItem`, since it owns the whole `BUDGET#` SK domain). The route paths and response shapes are unchanged by the split — only the backing Lambda/IAM role differs per route.
- **Budgets**: stored in the same ledger table under a disjoint `SK` namespace, evaluated hourly by a separate Lambda, with alerts published to the shared EventBridge bus.

## Routes

All routes require a valid Cognito JWT (the HttpApi's default authorizer). CORS is restricted to the deployed frontend origin (`FRONTEND_ORIGIN` env/context) — no wildcard origin, since this is a bearer-token-authorized API.

| Route | Lambda | IAM role grants |
|---|---|---|
| `GET /cost/summary` | `cost-query-handler.ts` | `dynamodb:Query` only |
| `GET /cost/series` | `cost-query-handler.ts` | `dynamodb:Query` only |
| `GET /budgets` | `cost-budget-handler.ts` | `dynamodb:Query`, `dynamodb:UpdateItem` |
| `PUT /budgets/{scope}` | `cost-budget-handler.ts` | `dynamodb:Query`, `dynamodb:UpdateItem` |

The split exists purely at the IAM/Lambda layer — request/response shapes below are identical to before the split.

### `GET /cost/summary?groupBy=app|agent|model|project&from&to`

Dimension rollup for the caller's org. `from`/`to` default to the last 30 days (UTC ISO). Response:

```json
{
  "groupBy": "app",
  "from": "2026-06-25T00:00:00.000Z",
  "to": "2026-07-25T00:00:00.000Z",
  "currency": "USD",
  "currencyMixed": false,
  "totalCostMicros": 12345678,
  "pricedRows": 940,
  "unpricedRows": 6,
  "estimate": true,
  "truncated": false,
  "buckets": [
    { "key": "app-123", "label": "app-123", "costMicros": 4000000, "tokenCost": 4.0, "totalTokens": 52000, "rows": 210, "unpricedRows": 1 }
  ]
}
```

- `currencyMixed: true` means the org's rows span more than one currency in the window — `currency` is `null` and totals should be read per-bucket, never summed, until the frontend buckets by currency.
- `unpricedRows` rows are excluded from `totalCostMicros` (never fabricate a price for a call the catalog couldn't price) but are counted so the UI can disclose them via the unpriced chip.
- `truncated: true` means the window was capped at `MAX_ROWS_PER_REQUEST` (50,000) rows server-side before aggregation — the response body itself stays small regardless, since aggregation happens in the Lambda.

### `GET /cost/series?dimension=org|app|agent|model|project&id?&bucket=hour|day&from&to`

Time series for the caller's org, optionally filtered to one dimension value (`id`). Omitting `id` returns the whole-org series for that dimension type; `id` is required to drill into a specific app/agent/model/project.

```json
{
  "dimension": "app",
  "id": "app-123",
  "bucket": "day",
  "from": "2026-06-25T00:00:00.000Z",
  "to": "2026-07-25T00:00:00.000Z",
  "currency": "USD",
  "estimate": true,
  "truncated": false,
  "unpricedCount": 2,
  "points": [
    { "t": "2026-07-20", "costMicros": 1200000, "totalTokens": 15000, "rows": 40, "unpricedRows": 0 }
  ]
}
```

`t` is the UTC bucket start — `YYYY-MM-DD` for `bucket=day`, `YYYY-MM-DDTHH` for `bucket=hour`.

### `GET /budgets[?orgId=]`

Lists budgets for the caller's org (or another org, if the caller is an admin).

```json
{
  "budgets": [
    {
      "scope": "org",
      "orgId": "org-1",
      "periodType": "monthly",
      "limitMicros": 500000000,
      "thresholds": [0.8, 1.0],
      "currency": "USD",
      "updatedAt": "2026-07-01T00:00:00.000Z"
    }
  ]
}
```

### `PUT /budgets/{scope}`

Upserts a budget. `{scope}` is `org` or `app:<appId>`. Body:

```json
{ "periodType": "monthly", "limitMicros": 500000000, "thresholds": [0.8, 1.0], "currency": "USD" }
```

`limitMicros` and `thresholds` (fractions in `(0, 1]`) are validated server-side; invalid bodies return `400`.

## Org-scoping (security model)

Every non-admin read is a **base-table Query** with `KeyConditionExpression: PK = :org AND SK BETWEEN :fromIso AND :toIso`, where `:org` is derived **only** from the verified JWT claim `custom:organization` — never from a query parameter. A non-admin passing a different `?orgId=` is rejected with `403` before any DynamoDB call is made. Admins may pass `?orgId=` to read another org's data; an admin "all orgs" view would be a separate, explicitly documented Scan exception (not implemented — no route requests it).

There is deliberately **no ModelIndex GSI**: `groupBy=model` and per-model series both require aggregating base-table rows in-Lambda, which is also why every org-scoped read hits the base table rather than the per-dimension GSIs (App/Agent/Project/Workflow) — those GSI partitions aren't org-keyed, so reading them for an org rollup would require an unsafe post-filter.

### Query/budgets IAM split — an honest limitation

`cost-budget-handler.ts`'s role carries `dynamodb:UpdateItem` table-wide at the IAM layer — **IAM cannot scope `UpdateItem` to the `BUDGET#` SK namespace**. `dynamodb:LeadingKeys` constrains the *partition* key only, and `PK=ORG#<org>` comes from a verified JWT claim (the Lambda serves every org), so neither SK-level nor per-org IAM scoping of the write is possible. What the split actually guarantees is a **role-level read-vs-write separation**: `cost-query-handler.ts`'s role can never call `UpdateItem` at all, full stop. Within the budgets Lambda, the only thing standing between the table-wide grant and an accidental overwrite of a rollup row is the app-level `validatePutBudgetBody` + `parseBudgetScope` guard, which rejects anything that doesn't resolve to a `BUDGET#` SK before an `UpdateCommand` is ever built.

## Tier B reconciliation (estimate → actual)

The hourly `cost-ledger-reconciler.ts` runs two tiers:

- **Tier A** (always on): aggregate drift only — compares summed ledger tokens against `AWS/Bedrock` CloudWatch metrics per model per hour window and emits a drift metric. Never flips a row's `estimate` flag; an aggregate comparison can't honestly produce a per-row actual.
- **Tier B** (opt-in via `COST_RECONCILER_TIER_B_ENABLED=true` **and** `BEDROCK_INVOCATION_LOG_GROUP` configured to the account's Bedrock model-invocation log group): real per-row matching. Candidate rows are those with `estimate:true` and a non-empty `bedrockRequestId`. Each candidate is looked up by request id against the configured CloudWatch log group via `FilterLogEvents` (a bounded-hour window; deliberately not Logs Insights `StartQuery`, which would add async start/poll overhead and IAM surface for no benefit at this cardinality). A match triggers a conditional `UpdateItem` (`attribute_exists(PK) AND estimate = :true`) that recomputes cost via the same `computeTokenCost`/catalog-pricing lookup the writer uses, then flips `estimate` to `false` and stamps `reconciledAt`. Idempotent: re-running an already-upgraded row's conditional check fails harmlessly and is not counted as an upgrade. Unmatched rows stay `estimate:true` and are counted, never fabricated; an unpriced actual (catalog miss) still upgrades with `tokenCost:null` rather than guessing a price.
- Tier B is cleanly **inactive** — logs and skips, mutates nothing — whenever the flag is off or the log group is unconfigured, regardless of how many `bedrockRequestId`-bearing rows exist.


## Budget model

Budgets reuse the ledger table's existing `PK=ORG#<org>` partitioning (same org-isolation discipline as cost rows) under a disjoint `SK` namespace:

- `SK = BUDGET#ORG` — org-wide budget
- `SK = BUDGET#APP#<appId>` — per-app budget

`BUDGET#` sorts after any ISO-timestamped cost row (`'B'` > any digit that starts an ISO year), so a `SK BETWEEN :fromIso AND :toIso` rollup query can never sweep a budget row in by accident.

A sparse `BudgetIndex` GSI (only budget rows are projected) lets the hourly evaluator enumerate every org's budgets with a single `Query` — never a Scan, even as the ledger grows.

### Evaluation and alerts

`cost-budget-evaluator.ts` runs hourly:

1. Enumerate all budgets via `BudgetIndex`.
2. For each, compute period-to-date spend (`PK=ORG#<org> AND SK BETWEEN periodStartIso AND nowIso`, summing only `priced===true` rows — unpriced calls are tracked, never guessed at).
3. Compare against each configured threshold (e.g. `0.8`, `1.0`).
4. On a crossing, attempt an atomic conditional `UpdateItem` (`notified.<periodKey> < :threshold` or unset) — this is the dedupe: at most one publish per `(period, threshold)`, safe under concurrent/retried evaluator runs. A higher threshold crossed later in the same period (0.8 → 1.0) publishes again.
5. On a successful conditional update, publish `cost.budget.threshold.crossed` (or `cost.budget.breached` for the `1.0` threshold) to the shared EventBridge bus, source `citadel.telemetry`. See [EVENTBRIDGE_CATALOG.md](./EVENTBRIDGE_CATALOG.md#cost-budget-events) for the full event schema.

## Frontend integration

`frontend/src/services/costService.ts` is the only client for this API. Unlike `appApiService` (AppSync/GraphQL, where Amplify attaches the Cognito token implicitly), this is a raw HTTP API — the client calls `fetchAuthSession()` and attaches `Authorization: Bearer <idToken>` explicitly on every request.

The service degrades gracefully when `costApiUrl` isn't configured (a deployment or local-dev environment that hasn't threaded `TelemetryStack.costApiUrl` through `aws-exports.json` yet): every method resolves to `{ available: false, reason: 'unconfigured' }` instead of throwing or issuing a fetch to a placeholder origin, and the dashboard cost panels (`CostChartRow`, the per-app panel in `AppApiDashboard`) render nothing rather than an error state.

Config plumbing: `TelemetryStack.costApiUrl` → `FrontendStackProps.costApiUrl` → `frontend-stack.ts`'s `frontendConfig.aws_cost_api_url` (rides the existing `aws-exports.json` deployment) → `frontend/src/config/awsExportsConfig.ts`'s `convertAWSExportsToConfig` → `AmplifyConfig.costApiUrl` (`server.ts`) → `costService.ts`.
