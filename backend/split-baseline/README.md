# split-baseline/

Committed baselines for the split-gates rail 2 test (stateful logical-ID pin).

## Two baselines, two environments

| File | Environment | Used by |
|---|---|---|
| `citadel-backend-dev.json` | dev | `npm run split:gates` (default, `SPLIT_GATES_ENV` unset) |
| `citadel-backend-test.json` | test | CI jest with `SPLIT_GATES_ENV=test` |

Rail 2 (`test/split-gates-rail2-stateful-pin.test.ts`) reads the baseline matching the current `SPLIT_GATES_ENV` and asserts every stateful logical ID still exists in a fresh `cdk synth` output with unchanged deletion/update policies and key properties.

> **x86 Linux hosts:** `npm run split:gates` bundles arm64 Lambda assets and requires QEMU emulation. See [Local arm64 Bundling](../../docs/DEPLOYMENT.md#local-arm64-bundling-x86-linux-hosts) in the deployment guide.

## Why two baselines?

The dev and test stacks are deployed independently and may have different feature flags, CDK constructs, or resource sets enabled at any given time. Each baseline captures the **intended** state of its respective stack.

## Hand-pin procedure

When you make an intentional stateful change (new DynamoDB table, GSI, DeletionProtectionEnabled, etc.):

1. **Apply the change to `citadel-backend-dev.json`** — edit the resource entry by hand to reflect the intended new state.
2. **Apply the same change to `citadel-backend-test.json`** — adjust only the environment-specific names (`-dev` ↔ `-test`, tag values, etc.).
3. **Run the parity guard** to verify the baselines agree:
   ```bash
   npx jest test/split-gates-rail2-baseline-parity
   ```
4. **Run rail 2 in both environments** to confirm the pin is valid:
   ```bash
   npx jest test/split-gates-rail2-stateful-pin
   SPLIT_GATES_ENV=test npx jest test/split-gates-rail2-stateful-pin
   ```

## Never regenerate

**NEVER** regenerate a baseline to "fix" a test failure. Regeneration picks up unrelated drift from a fresh `cdk synth` and defeats the purpose of pinning — the whole point is that the baseline represents a **deliberate** snapshot, not the latest synth output. If the parity guard (`split-gates-rail2-baseline-parity.test.ts`) fails, the correct response is always to hand-edit **both** baselines.

## Environment-specific fields

The parity guard normalises only these proven env-specific patterns before comparing:

- Stack name prefix (`citadel-backend-dev` ↔ `citadel-backend-test`)
- CDK concatenated stack name in construct hashes (`citadelbackenddev` ↔ `citadelbackendtest`)
- Resource physical name suffixes (`-dev` ↔ `-test`)
- Tag values (`"dev"` ↔ `"test"`)
- SSM parameter path segments (`/dev` ↔ `/test`)
- CDK asset content hashes in S3 locations
- CDK construct-ID hash suffixes (8-char hex embedded in logical IDs)
- Async DLQ logical-ID references (`RegistrySyncDLQ` ↔ `BackendAsyncDlq`)

Everything else must match byte-for-byte after normalisation.
