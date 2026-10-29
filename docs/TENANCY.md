# Organisation Model (Tenancy)

Citadel is a multi-tenant platform. Every row in every table carries an `orgId` (or `organization`) attribute, and every read and write path enforces tenant isolation. There is no shared default organisation — an unresolvable org is a hard deny.

## Organisation source by caller type

| Caller type | Org resolution path |
|---|---|
| **Cognito (human user)** | The `custom:organization` JWT claim, minted at sign-in by the pre-token-generation trigger from the `UserOrgMembership` DynamoDB table. The claim is server-derived and immutable for the lifetime of the token. |
| **IAM (arbiter / runtime agent)** | The org is derived from the session's bound project — the arbiter threads `orgId` from the project row into the execution context, and `withSessionOrg` patches it onto the synthesised AppSync identity before calling downstream resolvers. |
| **System / seed Lambda** | Seeded records use sentinel org values (see Sentinels below). No fallback to a default org. |

## Fail-closed rule

If the caller's organisation cannot be resolved, the request is denied. There is no `"Default"` or `"default"` pooling organisation. The deny is implemented as `OrgUnresolvedError` (defined in `backend/src/utils/auth-event.ts`) and emits a `Citadel/Resolvers` → `OrgUnresolved` CloudWatch metric with a `resolver` dimension.

This rule applies uniformly:

- Cognito callers with a missing or empty `custom:organization` claim are denied.
- IAM callers that cannot resolve an org from the session's project are denied.
- No resolver, handler, or arbiter module falls back to a hardcoded org string.

## Guard primitives

| Primitive | Location | Purpose |
|---|---|---|
| `requireCallerOrg(event, resolverName)` | `backend/src/utils/auth-event.ts` | Extracts the caller's org and throws `OrgUnresolvedError` when absent. Used on list/create paths. Does NOT special-case admins. |
| `assertRowOrg(row, event)` | `backend/src/utils/auth-event.ts` | Verifies a fetched row's `orgId` matches the caller's org. Admin bypass. Throws `CrossOrgAccessError` on mismatch. |
| `withSessionOrg(event, orgId)` | `backend/src/lambda/intake-orchestration-resolver.ts` | Patches an IAM-authenticated event with the session-derived org so downstream resolver calls see a `custom:organization` identity claim. |
| `resolveProjectDocumentKey(projectId, orgId, ...)` | `backend/src/utils/document-key.ts` | Builds org-prefixed S3 document keys so documents are partitioned by tenant in the bucket namespace. |
| `tenant_guard` module | `arbiter/common/tenant_guard.py` | `require_same_org(record, bound_org)` for point reads, `filter_by_org(records, bound_org)` for scans. Fails closed on mismatch or missing orgId. Emits `TenantOrgMismatch` and `OrgUnknownRecord` CloudWatch metrics. |

## Sentinels

Two sentinel values exist for platform-owned records:

| Sentinel | Used by | Meaning |
|---|---|---|
| `"All Organizations"` | System-seeded agents and tools in the registry | Visible to all tenants. Read sites that need these records pass `allow_system=True` (arbiter) or include `"All Organizations"` in their filter condition (backend). Cannot be claimed by a tenant — `NameKeyCollision` metric fires if a tenant record collides with a system record's name key. |
| `"system"` | Seeded blueprints and eval suites | Visible to all tenants when listing published blueprints. The workflow resolver's list path includes `orgId = callerOrg OR orgId = 'system'` in its filter. |

Neither sentinel grants write access — they are read-only visibility markers.

## Backfill scripts

Backfill scripts in `backend/scripts/` stamp `orgId` onto legacy rows that predate per-table org tagging. Run them after schema changes that add org columns or when onboarding data from an un-tagged source.

| Script | Purpose |
|---|---|
| `backfill-project-org.ts` | Stamps `organization` on project rows. |
| `backfill-record-org.ts` | Stamps `orgId` on registry records. |
| `backfill-org-ids.ts` | Stamps `orgId` on remaining tables. |
| `backfill-user-org-membership.ts` | Creates `UserOrgMembership` rows from existing Cognito `custom:organization` attributes. |
| `backfill-org-name-reservations.ts` | Reserves org-scoped name keys in the approval cache. |

All scripts are idempotent and safe to re-run.

## Metrics to watch

| Metric | Namespace | Meaning |
|---|---|---|
| `OrgUnresolved` | `Citadel/Resolvers` | A caller reached a resolver with no resolvable org. Should be zero in steady state. Non-zero means a user was provisioned without an organisation or the pre-token-generation trigger failed. |
| `NameKeyCollision` | `Citadel/RegistrySync` | A registry sync attempted to write a name-keyed cache entry that conflicts with an existing row from a different org. Investigate whether a tenant is colliding with a system record or another tenant. |
| `TenantOrgMismatch` | `Citadel/Arbiter` | The arbiter's `tenant_guard` rejected a record whose `orgId` does not match the bound execution org. May indicate a misconfigured agent or a stale record reference. |
| `OrgUnknownRecord` | `Citadel/Arbiter` | A record has no `orgId` set (pre-tagging legacy). The guard fails closed — the record is excluded. Run the appropriate backfill script to tag it. |
| `MissingProjectOrg` | `Citadel/AgentMessages` | An agent message handler encountered a project with no `organization` attribute. Run `backfill-project-org.ts`. |
