# Runbook: Cognito custom-attribute sweep

Script: `backend/scripts/audit-cognito-custom-attributes.ts`
(`npm run audit:cognito-custom-attributes`). Ticket CIT-210, finding 7aa877f8.

## Purpose

Until commit `1c025bc` the user pool client had no `WriteAttributes` allow-list,
so any signed-in user could write `custom:role=admin` or an arbitrary
`custom:organization` on their own record. Commit `39b2de8` made admin
determination group-only and the pre-token trigger now drops an unearned
`custom:role=admin` claim, so a poisoned attribute no longer grants anything.
Stale values may still be stored in the pool. This sweep finds them and, on
request, cleans them up.

Findings:

| Kind | Meaning | `--apply` action |
|---|---|---|
| `ROLE_MISMATCH` | `custom:role` set but user is not in a group of that name (includes `admin` without the `admin` group) | one group: set `custom:role` to it; no groups: delete `custom:role`; several groups: manual |
| `ORG_UNKNOWN` | `custom:organization` is not a live organisation name | delete `custom:organization` |
| `ORG_MISSING` | user is in a group but has no `custom:organization` | manual (assign via `assignUserRole`) |

Every modified user is signed out (`AdminUserGlobalSignOut`) so the next login
re-mints claims. Groups are never added or removed. Only `username` and `sub`
are printed; email is never fetched.

Exit codes: `0` no findings (or all remediated), `3` findings remain, `1` a
write failed or a fatal error.

## Prerequisites

- AWS credentials for the target account with `cognito-idp:ListUsers`,
  `AdminListGroupsForUser`, `AdminUpdateUserAttributes`,
  `AdminDeleteUserAttributes`, `AdminUserGlobalSignOut` on the pool and
  `dynamodb:Scan` on the organisations table. Read-only credentials suffice
  for dry-run.
- Env: `USER_POOL_ID`, `ORGANISATION_TABLE`, optional `AWS_REGION`
  (default `us-west-2`). `USER_POOL_ID` is in `cdk-outputs.json` under
  `citadel-backend-dev`; the table name is the `ORGANISATION_TABLE` env of the
  `user-management-resolver` Lambda (`aws lambda get-function-configuration`).
- `cd backend && npm ci`.

## Confirm the environment carries both fixes first

Running `--apply` against a pool whose client still allows self-writes only
cleans up until the next self-write. Check each environment:

1. Read the deployed sha from the provenance manifest written by `deploy.sh`
   (`deployment-manifest.json` at the repo root of the clone that deployed,
   field `git_sha`; gitignored, so read it on the deploy host). If that file is
   not available, use the CloudFormation deploy timestamp as a weaker signal:
   `aws cloudformation describe-stacks --stack-name citadel-backend-<env>
   --query 'Stacks[0].LastUpdatedTime'` must be after the commit dates of
   `1c025bc` and `39b2de8` (`git show -s --format=%ci <sha>`). Stack tags carry
   `Project`/`Environment`/`Team` only, not a sha.
2. Verify the deployed sha contains both commits:
   ```bash
   git merge-base --is-ancestor 1c025bc <deployed_sha> && echo "1c025bc: ok"
   git merge-base --is-ancestor 39b2de8 <deployed_sha> && echo "39b2de8: ok"
   ```
3. Cross-check live: `aws cognito-idp describe-user-pool-client --user-pool-id
   $USER_POOL_ID --client-id <id> --query 'UserPoolClient.WriteAttributes'`
   must list only `email`, `given_name`, `family_name`.

## Procedure

```bash
cd backend
export AWS_PROFILE=<profile> USER_POOL_ID=<pool> ORGANISATION_TABLE=<table>

# 1. Dry-run and keep an export (this is your rollback record).
npm run audit:cognito-custom-attributes -- --json > cognito-audit-$(date -u +%Y%m%dT%H%M%SZ).json
npm run audit:cognito-custom-attributes            # human-readable table

# 2. Review ROLE_MISMATCH rows with several groups and every ORG_MISSING row;
#    these are not auto-fixed. Fix them through the admin UI / assignUserRole.

# 3. Apply.
npm run audit:cognito-custom-attributes -- --apply

# 4. Re-run dry-run; expect exit 0, or exit 3 listing only manual items.
npm run audit:cognito-custom-attributes
```

Affected users are signed out and must log in again.

## Rollback

Deleted attribute values are not recoverable from Cognito. The `--json` export
from step 1 holds the previous `custom:role` / `custom:organization` for every
finding; restore an individual value with
`aws cognito-idp admin-update-user-attributes --user-pool-id $USER_POOL_ID
--username <username> --user-attributes Name=custom:organization,Value=<value>`
only after confirming the value is a live organisation name. Do not skip the
export.
