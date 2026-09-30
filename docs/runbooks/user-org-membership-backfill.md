# Runbook: UserOrgMembership backfill

Script: `backend/scripts/backfill-user-org-membership.ts`
(`npm run backfill:user-org-membership`). Decision 00d40a31 (server-derived
`custom:organization` claim). Background: `docs/ORG_SCOPING.md`, section
"The `custom:organization` claim is server-derived".

## Purpose

The pre-token-generation trigger now mints the `custom:organization` JWT claim
from the `UserOrgMembership` DynamoDB table (pk `sub`) and never reads the
stored user-pool attribute. `assignUserRole` writes both going forward, but
every user assigned before this change has an attribute and no row. For those
users the next token minted after the deploy carries **no org claim** (the
trigger adds `custom:organization` to `claimsToSuppress`, so the readable
attribute cannot leak into the ID token in its place), and every org-scoped
resolver fails closed on it. This script creates the missing rows from the
attribute, once.

Per user:

| Outcome                | Meaning                                                                          | Write?                                                                                                          |
| ---------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `WRITE`                | `custom:organization` is a live org name and no row exists                       | `PutItem { sub, orgName, updatedAt, updatedBy: 'backfill' }` with `attribute_not_exists(sub)`                   |
| `ALREADY_PRESENT`      | row exists with the same `orgName`                                               | no (idempotent)                                                                                                 |
| `SKIPPED_ROW_MISMATCH` | row exists with a different `orgName`                                            | no. The table is authoritative; the attribute is the suspect side. Reconcile by hand or re-run `assignUserRole` |
| `SKIPPED_UNKNOWN_ORG`  | attribute is not a live organisation name (tombstones/reservations do not count) | no. Fix with the attribute sweep (`ORG_UNKNOWN`) or `assignUserRole`                                            |
| `NO_SUB`               | user record has no `sub` attribute                                               | no. Manual                                                                                                      |
| `NO_ORG_ATTRIBUTE`     | user has no `custom:organization`                                                | nothing to backfill                                                                                             |

Flags: none (dry-run, the default), `--dry-run` (explicit alias; cannot be
combined with `--apply`), `--apply`.

Exit codes: `0` nothing left to do, `3` work remains (dry-run found rows to
write, and/or `SKIPPED_*` / `NO_SUB` findings need a human), `1` a `PutItem`
failed or a fatal error.

Output hygiene: only `username` and `sub` are printed. `ListUsers` is called
without `AttributesToGet` (Cognito rejects `custom:` names there); the script
projects `sub` and `custom:organization` and discards the rest, so email is
never retained or logged.

## DEPLOY ORDER — read before deploying

```
1. cdk deploy citadel-backend-<env>          (creates the table, wires the trigger)
2. npm run backfill:user-org-membership -- --apply     IMMEDIATELY after step 1
3. Tokens re-mint on their own within 1 hour; no forced sign-out needed
```

Why the order matters, and what the window looks like:

- **Already-issued tokens stay valid.** Access and ID tokens live 1 hour
  (`accessTokenValidity` in `backend-stack.ts`; ID token default). Nothing is
  re-evaluated mid-token: a token that already carries the org claim keeps
  working until it expires, whether or not the row exists. Users who are
  active at deploy time notice nothing until their next refresh.
- **Freshly minted tokens reflect the table at mint time.** From the moment
  step 1 completes, every token refresh (refresh-token grant) or login runs
  the new trigger. A user with no row gets a token with **no
  `custom:organization` claim**. That user can still sign in, but every
  org-scoped list/get/mutate returns "unresolvable org" / denied until (a) a
  row exists for their `sub` and (b) they mint a fresh token.
- **The window is therefore [end of step 1, end of step 2] plus each user's
  own refresh cadence.** Running step 2 within minutes keeps the number of
  users who refresh inside the window small; most users' 1-hour tokens outlast
  the backfill and their next refresh already sees the row. Do not deploy and
  leave the backfill for later, and do not run the backfill BEFORE the deploy
  (the table does not exist yet — the script fails fast on the missing table).
- **After step 2 there is nothing to force.** A user who did mint a claim-less
  token inside the window gets the claim back on their next refresh (≤ 1 hour)
  without any admin action. If a specific user must be unblocked sooner, sign
  them out with `aws cognito-idp admin-user-global-sign-out` and have them log
  in again; the trigger reads the table with `ConsistentRead`, so the new row
  is visible immediately.

Do not skip the dry-run: it tells you how many rows will be written and lists
every user the script will NOT fix (`SKIPPED_UNKNOWN_ORG`,
`SKIPPED_ROW_MISMATCH`, `NO_SUB`). Those users will be locked out of
org-scoped data after their next refresh until an admin assigns them via
`assignUserRole`.

## Prerequisites

- AWS credentials for the target account with `cognito-idp:ListUsers` on the
  pool, `dynamodb:Scan` on the organisations table, and `dynamodb:GetItem` +
  `dynamodb:PutItem` on the membership table. Read-only credentials suffice
  for dry-run.
- Env: `USER_POOL_ID`, `ORGANISATION_TABLE`, `USER_ORG_MEMBERSHIP_TABLE`,
  optional `AWS_REGION` (default `us-west-2`). `USER_POOL_ID` is in
  `cdk-outputs.json` under `citadel-backend-dev`. The two table names are the
  same-named env vars of the deployed `pre-token-generation` /
  `user-management-resolver` Lambdas:
  ```bash
  aws lambda get-function-configuration --function-name <pre-token-generation fn> \
    --query 'Environment.Variables.USER_ORG_MEMBERSHIP_TABLE'
  aws lambda get-function-configuration --function-name <user-management-resolver fn> \
    --query 'Environment.Variables.ORGANISATION_TABLE'
  ```
- `cd backend && npm ci`.

## Procedure

```bash
cd backend
export AWS_PROFILE=<profile> USER_POOL_ID=<pool> \
       ORGANISATION_TABLE=<orgs table> USER_ORG_MEMBERSHIP_TABLE=<membership table>

# 1. Dry-run. Expect exit 3 with plannedWrites > 0 on a first run.
npm run backfill:user-org-membership

# 2. Review the findings block. SKIPPED_ROW_MISMATCH / SKIPPED_UNKNOWN_ORG /
#    NO_SUB users are NOT fixed by this script.

# 3. Apply.
npm run backfill:user-org-membership -- --apply

# 4. Re-run dry-run; expect exit 0, or exit 3 listing only findings.
npm run backfill:user-org-membership

# 5. Optional cross-check with the attribute sweep. With
#    USER_ORG_MEMBERSHIP_TABLE set it reports ORG_NO_MEMBERSHIP for any user
#    still lacking a row.
npm run audit:cognito-custom-attributes
```

The script is idempotent: re-running after `--apply` finds every user
`ALREADY_PRESENT` and writes nothing. It is also safe to run while
`assignUserRole` is in use: the `PutItem` is conditional on
`attribute_not_exists(sub)`, so a row written concurrently by an admin wins
and is counted as `ALREADY_PRESENT`.

## Rollback

The script only creates rows; it never modifies or deletes one. To undo a run,
delete the rows it created — they are the ones with `updatedBy = 'backfill'`:

```bash
aws dynamodb scan --table-name "$USER_ORG_MEMBERSHIP_TABLE" \
  --filter-expression 'updatedBy = :b' \
  --expression-attribute-values '{":b":{"S":"backfill"}}' \
  --projection-expression '#s' --expression-attribute-names '{"#s":"sub"}'
# then, per sub:
aws dynamodb delete-item --table-name "$USER_ORG_MEMBERSHIP_TABLE" \
  --key '{"sub":{"S":"<sub>"}}'
```

Deleting a row removes the org claim from that user's next token (they lose
org-scoped access). The attribute is untouched by this script, so re-running
`--apply` restores the rows.
