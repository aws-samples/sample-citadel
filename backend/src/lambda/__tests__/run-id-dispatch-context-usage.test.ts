/**
 * Red-first test for verify-p1 NEEDS_CHANGES item 2 (GATING): the
 * build-time guard (`buildDispatchContext`/`build_dispatch_context`,
 * design §3 layer 1) had ZERO production call sites, so the required-field
 * typecheck it enforces never bound a real dispatch path — effective
 * live-path protection was test-time source-regex + runtime metric only.
 *
 * This asserts each of the 4 TS entry points imports `buildDispatchContext`
 * from the sole producer module AND calls it when constructing its
 * outbound dispatch/event envelope, so a future entry point that omits
 * `runId` from its envelope construction fails `tsc` for real, not just in
 * an isolated compile-fail fixture.
 */
import { readFileSync } from "fs";
import { join } from "path";

const LAMBDA_DIR = join(__dirname, "..");

function readSource(relPath: string): string {
  return readFileSync(join(LAMBDA_DIR, relPath), "utf8");
}

describe("buildDispatchContext routes the 4 entry-point envelopes (Pass 1, decision f1cbd5ef)", () => {
  const tsEntryPoints: Array<{ name: string; file: string }> = [
    {
      name: "chat message (sendMessageToAgent)",
      file: "conversation-resolver.ts",
    },
    { name: "submitTask", file: "task-runner-resolver.ts" },
    { name: "startExecution", file: "execution-resolver.ts" },
    { name: "app-invoke (processAppInvoke)", file: "app-invoke-handler.ts" },
  ];

  test.each(tsEntryPoints)(
    "$name imports buildDispatchContext from the sole producer module",
    ({ file }) => {
      const source = readSource(file);
      expect(source).toMatch(
        /import\s+\{[^}]*buildDispatchContext[^}]*\}\s+from\s+["'].*run-id["']/,
      );
    },
  );

  test.each(tsEntryPoints)(
    "$name calls buildDispatchContext(...) at least once",
    ({ file }) => {
      const source = readSource(file);
      expect(source).toMatch(/buildDispatchContext\(/);
    },
  );
});
