/**
 * Entry-point coverage guard (Pass 1, decision f1cbd5ef, silent-regression
 * guard layer 2): a parametrized test enumerating the 4 canonical runId
 * entry points, asserting each mints via `mintRunId()` and threads a runId
 * into its outbound event/record. A new entry point that forgets to mint
 * is caught here rather than silently shipping runId-absent.
 *
 * The 4 entry points (per architect design §1 "MINT per 4 entries"):
 *   1. chat message         — conversation-resolver.ts sendMessageToAgent
 *   2. submitTask            — task-runner-resolver.ts submitTask
 *   3. startExecution/app-invoke — execution-resolver.ts / app-invoke-handler.ts
 *   4. intake turn            — service/agent_intake_single/agent.py invoke()
 *      (TS-side coverage here is 1-3; intake is Python — see
 *      arbiter/... is out of scope for a TS grep-based registry, verified
 *      separately by test_run_id.py + test_state_run_id.py in the intake
 *      service's own suite).
 */
import { readFileSync, readdirSync } from "fs";
import { join } from "path";

const LAMBDA_DIR = join(__dirname, "..");

function readSource(relPath: string): string {
  return readFileSync(join(LAMBDA_DIR, relPath), "utf8");
}

describe("runId entry-point coverage guard (Pass 1, decision f1cbd5ef)", () => {
  const tsEntryPoints: Array<{ name: string; file: string }> = [
    {
      name: "chat message (sendMessageToAgent)",
      file: "conversation-resolver.ts",
    },
    { name: "submitTask", file: "task-runner-resolver.ts" },
    { name: "startExecution", file: "execution-resolver.ts" },
    { name: "app-invoke (processAppInvoke)", file: "app-invoke-handler.ts" },
    // CIT-102: eval-runner mints a per-case runId for Adapter A
    // (dispatchExecutionCase) and threads it onto the execution row +
    // execution.start.requested detail, exactly like startExecution.
    { name: "eval-runner (dispatchExecutionCase)", file: "eval-runner.ts" },
    // CIT-102: eval-conversation-worker mints a per-case sessionId (Adapter
    // B) AND a runId for the conversation transcript row it writes,
    // mirroring conversation-resolver's chat-message entry point.
    {
      name: "eval-conversation-worker (dispatchConversationCase)",
      file: "eval-conversation-worker.ts",
    },
  ];

  test.each(tsEntryPoints)(
    "$name imports mintRunId from the sole producer module",
    ({ file }) => {
      const source = readSource(file);
      expect(source).toMatch(
        /import\s+\{[^}]*mintRunId[^}]*\}\s+from\s+["'].*run-id["']/,
      );
    },
  );

  test.each(tsEntryPoints)(
    "$name calls mintRunId() at least once",
    ({ file }) => {
      const source = readSource(file);
      expect(source).toMatch(/mintRunId\(\)/);
    },
  );

  test("meta-test: registry above enumerates every file that imports run-id.ts", () => {
    // Discover every backend/src/lambda/*.ts file that imports mintRunId
    // (grep-based emitter discovery, mirroring the design's "registry ==
    // discovered-emitters" meta-test). A new entry point that mints but was
    // never added to tsEntryPoints above fails this test; a file that
    // mints without ANY test coverage here is caught by omission from
    // discoveredFiles matching registeredFiles. Uses plain fs (no new
    // dependency) rather than a glob library.
    const files = readdirSync(LAMBDA_DIR).filter((f) => f.endsWith(".ts"));
    const discovered = files.filter((f) => {
      try {
        const src = readSource(f);
        return /from\s+["'].*run-id["']/.test(src) && /mintRunId\(\)/.test(src);
      } catch {
        return false;
      }
    });
    const registered = tsEntryPoints.map((e) => e.file);
    expect(new Set(discovered)).toEqual(new Set(registered));
  });
});
