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

```bash
# Dry-run
npx ts-node --project tsconfig.scripts.json scripts/backfill-record-org.ts \
  --org Default --registry-id <id> --table-agents <table> --table-tools <table>

# Apply (also treating orgId '' as missing)
npx ts-node --project tsconfig.scripts.json scripts/backfill-record-org.ts \
  --org Default --registry-id <id> --table-agents <table> --table-tools <table> \
  --include-empty --apply
```

Flags: `--org` (required), `--registry-id` (required), `--table-agents` (required),
`--table-tools` (required), `--apply`, `--dry-run` (default), `--include-empty`
(treat orgId `''` as missing — rows with orgId `'All Organizations'` are never touched).
