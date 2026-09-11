/**
 * Entrypoint smoke tests for the backfill scripts (finding: runnability
 * defect — backfill-org-name-reservations.ts and backfill-org-ids.ts were
 * unit-tested via exported functions but never actually EXECUTED as a CLI,
 * so three runnability defects (tsconfig typeRoots, ESM/CJS entry-guard
 * mismatch, missing npm wiring) shipped undetected).
 *
 * Unlike the other test files in this directory, these tests do NOT import
 * the scripts' exported functions. They spawn each script as a REAL
 * subprocess — via `npm run <script>`, the exact invocation an operator
 * uses, and via `node scripts/<file>.ts`, Node's native TypeScript
 * execution path — and assert on real process exit codes and real stdout/
 * stderr. This is the only way to catch defects that only manifest at the
 * module-loading/entry-guard level, which exported-function unit tests
 * structurally cannot see.
 *
 * No AWS calls are made: every case here is reached before any AWS SDK
 * client is constructed, because the scripts fail their env-var
 * preconditions first.
 */
import { spawnSync } from "child_process";
import * as path from "path";

const BACKEND_ROOT = path.resolve(__dirname, "..", "..");

/** Env with every var the two scripts require stripped out, so each run
 * deterministically hits its "env var required" fail-fast path regardless
 * of the ambient shell environment the test runner happens to inherit. */
function strippedEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.ORGANIZATIONS_TABLE;
  delete env.REGISTRY_ID;
  delete env.USER_POOL_ID;
  delete env.AGENT_CONFIG_TABLE;
  delete env.TOOL_CONFIG_TABLE;
  return env;
}

describe("backfill-org-name-reservations.ts entrypoint", () => {
  it("via `npm run backfill:org-name-reservations` exits non-zero with a clean env-var error, no crash", () => {
    const result = spawnSync("npm", ["run", "backfill:org-name-reservations"], {
      cwd: BACKEND_ROOT,
      env: strippedEnv(),
      encoding: "utf8",
      timeout: 20000,
    });

    expect(result.status).not.toBe(0);
    expect(result.status).not.toBeNull();
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    expect(output).toContain("ORGANIZATIONS_TABLE env var required");
    // Must be the clean thrown-Error message, not a stack-trace crash from
    // a module-loading failure (e.g. TS2580 / ERR_REQUIRE_ESM).
    expect(output).not.toContain("Cannot find name");
    expect(output).not.toContain("ERR_REQUIRE_ESM");
  });

  it("via `node scripts/backfill-org-name-reservations.ts` (native TS execution) exits non-zero with the same clean error", () => {
    const result = spawnSync(
      process.execPath,
      ["scripts/backfill-org-name-reservations.ts"],
      {
        cwd: BACKEND_ROOT,
        env: strippedEnv(),
        encoding: "utf8",
        timeout: 20000,
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.status).not.toBeNull();
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    expect(output).toContain("ORGANIZATIONS_TABLE env var required");
    expect(output).not.toContain("ReferenceError: require is not defined");
    expect(output).not.toContain("Cannot find name");
  });

  it("--dry-run wiring does not crash before the env-var check (arg parsing is safe)", () => {
    const result = spawnSync(
      "npm",
      ["run", "backfill:org-name-reservations", "--", "--dry-run"],
      {
        cwd: BACKEND_ROOT,
        env: strippedEnv(),
        encoding: "utf8",
        timeout: 20000,
      },
    );

    expect(result.status).not.toBe(0);
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    expect(output).toContain("ORGANIZATIONS_TABLE env var required");
  });
});

describe("backfill-org-ids.ts entrypoint", () => {
  it("via `npm run backfill:org-ids` exits non-zero with a clean env-var error, no crash", () => {
    const result = spawnSync("npm", ["run", "backfill:org-ids"], {
      cwd: BACKEND_ROOT,
      env: strippedEnv(),
      encoding: "utf8",
      timeout: 20000,
    });

    expect(result.status).not.toBe(0);
    expect(result.status).not.toBeNull();
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    expect(output).toContain("REGISTRY_ID env var required");
    expect(output).not.toContain("Cannot find name");
    expect(output).not.toContain("ERR_REQUIRE_ESM");
  });

  it("via `ts-node scripts/backfill-org-ids.ts` exits non-zero with a clean env-var error", () => {
    // backfill-org-ids.ts imports a local project module
    // (../src/services/registry-service) without a file extension, which
    // Node's native ESM loader for .ts files cannot resolve (ESM requires
    // explicit extensions for relative specifiers). That import-resolution
    // gap is a separate, pre-existing defect from the three this task
    // fixes (tsconfig typeRoots / entry-guard / npm wiring) and is reported
    // in the task summary rather than patched here, since fixing it for
    // native ESM breaks resolution under ts-node and ts-jest (which resolve
    // against the .ts source, not a compiled .js sibling) — a three-way
    // conflict needing its own decision. This script is therefore verified
    // via ts-node, the invocation its own header comment documents and the
    // one the npm script uses.
    const result = spawnSync(
      "npx",
      ["ts-node", "scripts/backfill-org-ids.ts"],
      {
        cwd: BACKEND_ROOT,
        env: strippedEnv(),
        encoding: "utf8",
        timeout: 20000,
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.status).not.toBeNull();
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    expect(output).toContain("REGISTRY_ID env var required");
    expect(output).not.toContain("Cannot find name");
  });

  it("--dry-run wiring does not crash before the env-var check (arg parsing is safe)", () => {
    const result = spawnSync(
      "npm",
      ["run", "backfill:org-ids", "--", "--dry-run"],
      {
        cwd: BACKEND_ROOT,
        env: strippedEnv(),
        encoding: "utf8",
        timeout: 20000,
      },
    );

    expect(result.status).not.toBe(0);
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    expect(output).toContain("REGISTRY_ID env var required");
  });
});
