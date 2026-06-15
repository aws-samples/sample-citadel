# Org-Scoping Architecture

Resource visibility in Citadel is scoped per organization. Governance evaluation
is intentionally org-uniform (see `GOVERNANCE_ROLLOUT_RUNBOOK.md`); only resource
lists and per-resource access checks honour `orgId`.

This document is the source of truth for how the scoping model works. If you're
adding a new resource type and wondering whether it needs `orgId`, start here.

## TL;DR

- **Identity**: each user carries `custom:organization` (their org) and either
  `custom:role: admin` or membership in the Cognito `admin` group.
- **Source of truth**: AgentCore Registry for apps/agents, DynamoDB for tools
  and per-org tables (workflows, executions, integrations, datastores).
- **Read scaling**: AppsTable `#META` mirror + `OrgIndex` GSI eliminates the
  N+1 Registry scan in `listApps`.
- **Drift recovery**: a 6-hourly reconciler Lambda closes gaps between the
  Registry and the mirror.

## Trust model

Rules of thumb:

- A resolver resolves the caller's org from the JWT, not from the request
  payload. Inputs that include an `orgId` field are accepted only when the
  caller is an admin.
- `isAdminFromEvent(event)` recognises EITHER `custom:role === 'admin'` OR
  membership in the `admin` Cognito group. Both signals are first-class.
- The 'All Organizations' selector in the frontend short-circuits the org
  filter only when `isAdminFromEvent` is true; non-admins sending the magic
  string get a permission error from the backend.

Key helpers (`backend/src/utils/auth-event.ts`):

- `extractOrgFromEvent(event)`: claim-first, falls back to
  `AdminGetUserCommand` during the re-auth window. Returns `null` when there
  is no caller org at all.
- `isAdminFromEvent(event)`: claim-only — no Cognito API call. Tolerant of
  array vs comma-separated-string serialisations of `cognito:groups`.

## Where orgId lives

| Resource | Storage | orgId source | Visibility check |
|---|---|---|---|
| RegistryAgentRecord (apps) | AgentCore Registry + AppsTable `#META` mirror | `manifest.orgId` | `OrgIndex` GSI Query (admin gets Scan) |
| AgentConfig (catalog agents) | AgentCore Registry | `customMetadata.orgId` | resolver filter, admin bypass |
| ToolConfig | AgentCore Registry | `customMetadata.orgId` | resolver filter, admin bypass |
| Workflow | DynamoDB | row attribute | `OrgStatusIndex` GSI; resolver checks `userOrg` |
| Integration | DynamoDB | composite PK `ORG#<orgId>` | implicit via PK |
| DataStore | DynamoDB | row attribute | `OrgIndex` GSI |
| Execution | DynamoDB | row attribute | resolver checks `userOrg` |
| Organization | DynamoDB | PK | N/A (admin-only operations) |

Things deliberately NOT org-scoped: ADRs, ProgramReviews,
ExecutionSpecifications, AgentDesignAssessments, AuthorityUnits, CaseLaw,
ConstitutionalLayers, GovernanceLedger, API keys. The first four are
cross-cutting governance entities; the last is per-app, not per-org.

## How write paths populate orgId

### Resolver path (synchronous)

`createApp` / `createAgentConfig` / `createToolConfig` resolvers all read the
caller's org via `extractOrgFromEvent(event)` and write it onto the new
record. They reject early when the caller has no org claim. Updates preserve
the existing `orgId`; the field is never editable cross-org.

The resolvers also write the AppsTable `#META` row synchronously after the
Registry write succeeds (or update it for the existing row). Failures log
and return `false` — the resolver does not retry; the reconciler closes any
drift.

### Fabricator path

The Python Fabricator (`arbiter/fabricator/index.py`) creates Registry agent
records directly via boto3, bypassing the resolver. It threads `requested_by`
and `org_id` from the SQS event through to `_write_app_meta_row`, which
synchronously writes the AppsTable `#META` row using the same shape as the
resolver's `upsertAppMeta`. Failures are swallowed (eventually consistent).

### Backfill (one-shot)

`backend/scripts/backfill-org-ids.ts` walks legacy Registry + DDB rows and
assigns `orgId` based on the row's `createdBy` Cognito attribute, falling
back to the sentinel `'system'` when no owner can be resolved. Run
`--dry-run` first, then `--apply`. Idempotent.

## Read scaling: AppsTable `#META` + OrgIndex GSI

AgentCore Registry lacks any GSI / index / query API on custom metadata. A
naive `listApps` would do `ListRegistryRecords` + `GetRegistryRecord` per
record + client-side filter — N+1 by total Registry size, not by the
caller's org.

**Solution**: each app has a `#META` row in the existing `AppsTable`
(`partitionKey: appId`, `sortId: 'METADATA'` as a data attribute). The
`OrgIndex` GSI (PK=`orgId`, SK=`createdAt`, full projection) carries enough
fields to satisfy the `listApps` response shape directly. `listApps` becomes
a single Query against `OrgIndex` (Scan + filter for the admin all-orgs
path).

The Registry remains the source of truth. The `#META` row is a read
optimisation, kept in sync by:

1. **Resolver writes** (synchronous, eventually-consistent helper).
2. **Fabricator writes** (synchronous, swallowed on failure).
3. **Scheduled reconciler** (every 6h — see below).

For non-metadata rows in AppsTable (API keys at `${appId}#APIKEY#<id>`,
components at `${appId}#COMPONENT#<id>`), the `OrgIndex` GSI naturally
excludes them because they don't carry both `orgId` and `createdAt`.

## Reconciliation

### Scheduled (automated)

`ReconcileAppsMetaScheduledFunction` runs every 6h via EventBridge in
`--apply` mode. It walks the Registry and the AppsTable `#META` rows and
classifies each record:

| Classification | Meaning | Reconciler action |
|---|---|---|
| `in-sync` | both sides match on the comparison set | nothing |
| `missing` | Registry record exists, no `#META` row | upserts the `#META` row |
| `stale` | both sides exist but `name` / `status` / `orgId` / `version` differ | logs only |
| `orphan` | `#META` row exists, no Registry record | logs only |

`stale` and `orphan` stay log-only by design. They are admin-judgment cases:
`stale` could mean the legacy row is intentionally newer; `orphan` could
mean the deletion path's `#META` cleanup failed but the user wants a
tombstone rather than a silent disappearance. Operators inspect logs and
clean up manually.

### Manual (one-shot CLI)

Same logic, same classifications, but invoked from a developer machine:

```bash
npx ts-node --project backend/tsconfig.scripts.json \
  backend/scripts/reconcile-apps-meta.ts --dry-run
# review output, then
npx ts-node --project backend/tsconfig.scripts.json \
  backend/scripts/reconcile-apps-meta.ts --apply
```

Use the manual path for inspection / forensics. The scheduled Lambda always
runs in apply mode.

## Admin bypass

The frontend's `OrganizationContext` shows admins an `'All Organizations'`
selector. Selecting it sends the literal string `'All Organizations'` to the
backend. The backend honours the bypass only when `isAdminFromEvent(event)`
is true:

- Non-admin sending the magic string → permission error from `listApps`.
- Admin sending the magic string → `Scan + filter sortId='METADATA'` over
  AppsTable, returns every app in every org.

For `listAgentConfigs` / `listToolConfigs` the same bypass applies but via
resolver-side filtering (no separate index).

## Re-auth requirements

Deploys that change the pre-token Lambda or add new claims require users to
re-auth before their tokens carry the new claims. Phase 1 (`ee3c443`) added
`custom:organization` and `custom:role` to issued JWTs. The fallback to
`AdminGetUserCommand` in `extractOrgFromEvent` keeps things working during
the re-auth window — each request just costs one extra Cognito API call
until the user gets a fresh token.

## Operational runbook

### Deploying a change that touches org-scoping

1. Run unit tests in the affected layer (utils, lambda, services, scripts).
2. `cdk synth` to confirm no IAM regressions.
3. Deploy.
4. If the change required new claims (rare — only when modifying the
   pre-token Lambda), force or wait for re-auth.
5. Smoke-test as both an admin and a non-admin user.
6. The 6-hourly reconciler will catch any drift introduced during the
   deploy window. To verify sooner, invoke it manually:
   ```bash
   aws lambda invoke --function-name citadel-backend-dev-ReconcileAppsMetaScheduled... /tmp/out.json && cat /tmp/out.json
   ```
   or run the CLI script with `--apply`.

### Adding org-scoping to a new resource type

1. Add `orgId: String!` to the GraphQL type. Inputs do NOT carry `orgId` —
   the backend pulls from the JWT.
2. In the create / update / delete resolvers:
   - `const orgId = await extractOrgFromEvent(event)`
   - reject if `!orgId`
   - store on the record
   - never let updates rewrite `orgId` cross-org
3. In the list resolver:
   - `const admin = isAdminFromEvent(event)`
   - filter by `orgId` unless admin
4. In the get resolver:
   - return 404 (not 403) on cross-org access for non-admins
5. If the resource is created via a non-resolver path (Fabricator, scheduled
   job), thread `orgId` through that path the same way the Fabricator does
   for `_write_app_meta_row`.
6. Decide whether the resource needs a read-side index. Only the apps path
   needed one because of Registry's lack of query support; DDB-backed
   resources can usually rely on an existing GSI.

### Investigating a missing record

1. Did the backend reject the request with a 4xx? Check the resolver logs
   for `Only admins may list apps across all organizations`.
2. Is the user's `cognito:groups` claim populated? Decode their ID token and
   check.
3. Is the resource's `orgId` what you expect? Read it directly from the
   Registry / DDB.
4. For apps specifically, is the `#META` row present? Check AppsTable with
   `Key={ appId }`. If not, the reconciler will fix it within 6h, or run
   the CLI script with `--apply` now.

## Commit history reference

| Commit | Topic |
|---|---|
| `ee3c443` | Phase 1: JWT claims (`custom:organization`, `custom:role`) + auth-event helpers + admin bypass gating |
| `43a6f49` | Phase 2: `orgId` on AgentConfig + ToolConfig resolvers + backfill script |
| `1872391` | Phase 3: AppsTable `#META` mirror + `listApps` via `OrgIndex` GSI + reconciler CLI |
| `104b0e6` | Phase 3 schema fix: align with AppsTable's actual key shape |
| `2165036` | Fabricator-emitted `#META` at agent creation |
| `b279257` | `isAdminFromEvent` recognises `cognito:groups` |
| (this commit) | Scheduled reconciler Lambda + `ORG_SCOPING.md` doc |

## Limits / known gaps

- The 25 records backfilled on first deploy of Phase 2 all carry
  `orgId='system'`. Admin sees them; non-admin org users see none. If you
  want any of them assigned to a specific org, do a one-time DDB
  `UpdateItem` against the relevant table or extend the backfill script.
- `resolveRecordId` re-lists the entire Registry on every name-based agent
  lookup. Add an LRU if this becomes a hotspot.
- The pre-token Lambda only promotes the `custom:role` attribute; admin
  group membership is recognised at read time. Could overlay
  `custom:role: admin` for admin-group members in the trigger to unify the
  data model. Requires re-auth.
