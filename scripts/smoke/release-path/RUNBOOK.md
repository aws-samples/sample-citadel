# Release-Path Smoke Fixture — RUNBOOK

Dev-only. Never run this against `PROD` or `STAGING`. Nothing in this
directory is wired into CI (`npm test`, `npm run lint`, `pytest` never
import or execute these files) — it is an opt-in, on-demand harness.

## One-time operator setup (you must do this manually)

**These scripts NEVER create Cognito users, IAM roles, or any other
principal.** If the identity or credentials below are missing, every
script in this directory fails immediately with a message pointing back
here — it will not attempt to provision anything on your behalf.

### 1. Create the dedicated fixture Cognito user (once per dev pool)

Using an account that already has Cognito admin access to your dev user
pool:

```bash
aws cognito-idp admin-create-user \
  --user-pool-id "$USER_POOL_ID" \
  --username smoke-release-fixture \
  --user-attributes \
      Name=email,Value=smoke-release-fixture@example.invalid \
      Name=email_verified,Value=true \
      Name="custom:role",Value=architect \
      Name="custom:organization",Value=SMOKE-RELEASE-FIXTURE-ORG \
  --message-action SUPPRESS

aws cognito-idp admin-set-user-password \
  --user-pool-id "$USER_POOL_ID" \
  --username smoke-release-fixture \
  --password '<choose a strong password>' \
  --permanent
```

`custom:role=architect` is the SAME grantee tier `release:cut` and
`release:promote` already require in `backend/src/utils/auth.ts` — this
is not a new role, it reuses the existing one. `--permanent` avoids a
`NEW_PASSWORD_REQUIRED` challenge on first `USER_PASSWORD_AUTH` login (a
challenge this harness does not handle, by design — see `env.ts`).

If your user pool client does not have the `USER_PASSWORD_AUTH` auth flow
enabled, enable it on the **existing** app client used for this dev pool
(do not create a new one):

```bash
aws cognito-idp update-user-pool-client \
  --user-pool-id "$USER_POOL_ID" \
  --client-id "$USER_POOL_CLIENT_ID" \
  --explicit-auth-flows ALLOW_USER_PASSWORD_AUTH ALLOW_REFRESH_TOKEN_AUTH
```

### 2. Discover the remaining configuration values

From your dev deployment's CloudFormation outputs / stack resources
(read-only `describe-stacks`/`describe-stack-resources` calls — no
writes):

```bash
aws cloudformation describe-stacks --stack-name BackendStack-dev \
  --query "Stacks[0].Outputs"
# -> GraphQLApiUrl, UserPoolId, UserPoolClientId

aws cloudformation describe-stack-resources --stack-name BackendStack-dev \
  --query "StackResources[?ResourceType=='AWS::DynamoDB::Table'].PhysicalResourceId"
# -> find the EvalRuns table's physical name

aws cloudformation describe-stack-resources --stack-name GovernanceStack-dev \
  --query "StackResources[?ResourceType=='AWS::DynamoDB::Table'].PhysicalResourceId"
# -> find the EnvironmentReleasePointers table's physical name (needed
#    only by assert_dispatch_resolves.py; AgentReleasesTable too if you
#    want to sanity-check it directly, though the scripts never require
#    that one by name)
```

The governance-transcripts S3 bucket name (needed for `narrativeS3Uri`,
see `NARRATIVE_URI_ALLOWLIST` in `backend/src/utils/auth-event.ts`'s
sibling `execspec-resolver.ts`) follows the pattern
`citadel-governance-transcripts-<env>-<account>-<region>` — confirm the
exact name for your account/region rather than assuming it.

### 3. Export the environment

```bash
export AWS_REGION=us-east-1
export AWS_PROFILE=your-dev-profile          # scoped dev credentials only
export GRAPHQL_API_URL='https://....appsync-api...amazonaws.com/graphql'
export USER_POOL_ID='us-east-1_xxxxxxxxx'
export USER_POOL_CLIENT_ID='xxxxxxxxxxxxxxxxxxxxxxxxxx'
export SMOKE_FIXTURE_USERNAME=smoke-release-fixture
export SMOKE_FIXTURE_PASSWORD='<the password you set above>'
export EVAL_RUNS_TABLE='citadel-eval-runs-dev-xxxxxxxx'
export ENVIRONMENT_RELEASE_POINTERS_TABLE='citadel-environment-release-pointers-dev-xxxxxxxx'
export SMOKE_GOVERNANCE_TRANSCRIPTS_BUCKET_NAME='citadel-governance-transcripts-dev-123456789012-us-east-1'
```

If any of these is missing when you run a script, that script exits
immediately with a message naming exactly which variable is missing and
pointing back to this file — it never falls back to a guess.

## Running (only once the above is done)

```bash
cd scripts/smoke/release-path
npm install       # first time only — installs this directory's own,
                   # independently-pinned dependencies (see README.md's
                   # "Dependency pinning note")
npm run typecheck # tsc --noEmit, zero-execution sanity check

# Arrange + cut + promote (writes fixture rows + one release + one pointer
# move to your DEV deployment):
npx ts-node run-smoke.ts
# prints: [run-smoke] DONE. releaseId=<sha256 hex> ...

# Read-only dispatch-side check (needs the releaseId printed above):
.venv-check/bin/python3 assert_dispatch_resolves.py --release-id <the releaseId printed above>
# prints PASS: dispatch resolution RESOLVED to the expected release ...
```

Re-running `run-smoke.ts` is safe and expected — see README.md's
"Why exactly one AgentRelease row can ever exist" section. It always
converges to the same single release row; the pointer row's `version`
increments by 1 on each rerun, which the script itself asserts.

## What this does NOT cover (by design)

- It never runs the real eval-runner/judge pipeline — the `COMPLETED`
  `EvalRun` is seeded directly (see `fixtures.ts`'s module doc for why).
- It never flips governance enforcement to `strict`, and never asserts
  anything about dispatch actually being *blocked* — only that resolution
  is observable in shadow/permissive mode.
- It never exercises the `ConcurrentPromotionError` race, cross-org
  rejection paths, rollback, or grandfathering.
- It never touches `STAGING` or `PROD` — every example above targets a
  `-dev` deployment; there is no environment switch to make it target
  anything else.

## Cleanup

There is no delete path (by design — `AgentReleasesTable` has no delete
operation anywhere in the codebase, and this repo's tables generally
don't support deletion of governance-relevant rows). The fixture rows are
permanently but obviously namespaced (`SMOKE-RELEASE-FIXTURE-*` /
`SMOKE-RELEASE-FIXTURE-ORG`) — see README.md's "Namespacing" section —
so they are trivially filterable out of any real report or audit.
