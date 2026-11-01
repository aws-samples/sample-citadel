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

Re-issues the scoped IAM inline policy for each S3 datastore's `citadel-ds-{id}` role. After the S3 adapter's `requiredPolicies` was tightened to scope `DeleteBucket`/`DeleteObject` to the specific bucket ARN (instead of `*`), existing roles still carry the old wildcard grants. This script calls `PolicyManager.ensureRole` (an IAM `PutRolePolicy` upsert) for each connected S3 row.

```bash
# Dry-run — shows current vs proposed policy per role
npx ts-node --project tsconfig.scripts.json scripts/resync-datastore-roles.ts \
  --table <datastores-table>

# Apply
npx ts-node --project tsconfig.scripts.json scripts/resync-datastore-roles.ts \
  --table <datastores-table> --apply
```

Flags: `--table` (required), `--apply`, `--dry-run` (default). Idempotent.