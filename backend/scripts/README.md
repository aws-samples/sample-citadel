# Backfill & Ops Scripts

One-off migration scripts for stamping missing attributes before
removing fallback code-paths. All scripts are **dry-run by default**.

## backfill-project-org

Stamps `organization` on project rows that lack it (or have it empty/null).

```bash
# Dry-run — see what would change
npx ts-node --project tsconfig.scripts.json scripts/backfill-project-org.ts \
  --org Default --table <projects-table>

# Apply
npx ts-node --project tsconfig.scripts.json scripts/backfill-project-org.ts \
  --org Default --table <projects-table> --apply
```

Flags: `--org` (required), `--table` (required), `--apply`, `--dry-run` (default).

## backfill-record-org

Stamps `orgId` on agents/tools projection rows and DRAFT registry records.

By default only considers rows with a `citadelKind` attribute (projection rows).
Keys starting `decision#` (bookkeeping, not records) and rows with
orgId `'All Organizations'` are **always** skipped.

**Dual-key cache twin resolution** (PR #369): an agent/tool may have two
rows — one keyed by a recordId (UUID) and one keyed by its display name
(`agentId == name`). For each candidate, the script looks up the twin row;
if the twin carries a non-absent `orgId`, the candidate inherits that value
(including `'All Organizations'`). Otherwise the `--org` flag value is stamped.
Dry-run output includes the resolved `orgId` and its source (`twin` | `flag`)
for each candidate.

```bash
# Dry-run
npx ts-node --project tsconfig.scripts.json scripts/backfill-record-org.ts \
  --org Default --registry-id <id> --table-agents <table> --table-tools <table>

# Also consider rows lacking citadelKind
npx ts-node --project tsconfig.scripts.json scripts/backfill-record-org.ts \
  --org Default --registry-id <id> --table-agents <table> --table-tools <table> \
  --include-unkinded

# Apply
npx ts-node --project tsconfig.scripts.json scripts/backfill-record-org.ts \
  --org Default --registry-id <id> --table-agents <table> --table-tools <table> \
  --include-unkinded --apply
```

Flags: `--org` (required), `--registry-id` (required), `--table-agents` (required),
`--table-tools` (required), `--apply`, `--dry-run` (default), `--include-unkinded`
(also consider rows lacking `citadelKind` whose orgId is absent — `decision#` keys
and orgId `'All Organizations'` rows are never touched).

## resync-datastore-roles

Re-issues the scoped IAM inline policy for each S3 datastore's `citadel-ds-{id}` role **and** backfills Citadel ownership tags on the S3 buckets. After the S3 adapter's `requiredPolicies` was tightened to scope `DeleteBucket`/`DeleteObject` to the specific bucket ARN (instead of `*`), existing roles still carry the old wildcard grants. Additionally, the new tag-based adoption guard requires `citadel:dataStoreId` + `citadel:orgId` tags on every bucket — existing buckets created before the guard have none.

**Policy resync:** calls `PolicyManager.ensureRole` (IAM `PutRolePolicy` upsert) for each connected S3 row.

**Tag backfill:** reads each bucket's tags via `GetBucketTagging`. If the required Citadel tags are absent and the DynamoDB row proves ownership, applies `ManagedBy=citadel`, `citadel:dataStoreId`, and `citadel:orgId` via `PutBucketTagging`, merging with any pre-existing tags (never dropping foreign tags). If tags exist with a **different** `dataStoreId`/`orgId`, prints CONFLICT and skips (never overwrites).

```bash
# Dry-run — shows current vs proposed policy per role + tag actions
npx ts-node --project tsconfig.scripts.json scripts/resync-datastore-roles.ts \
  --table <datastores-table>

# Apply — re-issues inline policy + tags buckets (idempotent)
npx ts-node --project tsconfig.scripts.json scripts/resync-datastore-roles.ts \
  --table <datastores-table> --apply
```

Flags: `--table` (required), `--apply`, `--dry-run` (default). Idempotent.

## reconcile-seeded-rows

Collapses twin DDB rows for seeded agents into a canonical recordId-keyed
row + thin name-keyed pointer, copies S3 modules to scoped keys, and
rewrites seeded blueprint definitions to reference agents by recordId
instead of friendly name. Fixes orgId `'Default'` → `'All Organizations'`
on agent rows and `'Default'` → `'system'` on seeded blueprint rows only
(user-created blueprints are never touched by the org rewrite).

The seeded blueprint set is imported from `seed-blueprints` via
`SEEDED_BLUEPRINT_IDS` — this is the single source of truth for which
workflow IDs are seeded.

Seeded agents are identified by `createdBy = 'seedConfig'` on the
recordId-keyed row.

```bash
# Dry-run — see what would change
npx ts-node --project tsconfig.scripts.json scripts/reconcile-seeded-rows.ts \
  --table <AGENT_CONFIG_TABLE> --workflows-table <WORKFLOWS_TABLE> \
  --bucket <AGENT_BUCKET_NAME>

# Apply (idempotent — safe to re-run)
npx ts-node --project tsconfig.scripts.json scripts/reconcile-seeded-rows.ts \
  --table <AGENT_CONFIG_TABLE> --workflows-table <WORKFLOWS_TABLE> \
  --bucket <AGENT_BUCKET_NAME> --apply
```

### Reverting non-seeded blueprint orgId

If the previous (buggy) version of this script already ran and rewrote
user-created blueprint orgId values from `'Default'` to `'system'`, use
`--revert-nonseeded-org` to undo the damage. This sets orgId back to the
specified value for every blueprint that is NOT in the seeded set and whose
orgId is currently `'system'`.

```bash
# Dry-run first — see which rows would revert
npx ts-node --project tsconfig.scripts.json scripts/reconcile-seeded-rows.ts \
  --table <AGENT_CONFIG_TABLE> --workflows-table <WORKFLOWS_TABLE> \
  --bucket <AGENT_BUCKET_NAME> \
  --revert-nonseeded-org Default

# Apply the revert (idempotent)
npx ts-node --project tsconfig.scripts.json scripts/reconcile-seeded-rows.ts \
  --table <AGENT_CONFIG_TABLE> --workflows-table <WORKFLOWS_TABLE> \
  --bucket <AGENT_BUCKET_NAME> \
  --revert-nonseeded-org Default --apply
```

Flags: `--table` (required), `--workflows-table` (required), `--bucket`
(required), `--apply`, `--dry-run` (default), `--org-sentinel` (default
`'All Organizations'`), `--names` (comma-separated, restricts to listed agents),
`--revert-nonseeded-org <org>` (revert non-seeded blueprints with orgId
`'system'` to the given org; dry-run default; idempotent).
