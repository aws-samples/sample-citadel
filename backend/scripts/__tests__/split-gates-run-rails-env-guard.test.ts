/**
 * run-rails.ts invokes the move manifest's data to diff a fresh synth
 * against the committed baseline. Before this fix, passing --env test
 * silently used dev-suffixed satellite stack names / resolver keys,
 * producing large spurious rail 3/6/7 violations that are indistinguishable
 * from real baseline staleness (decision 453d1acc forbids regenerating the
 * baseline to "fix" that).
 *
 * This test invokes the real CLI entrypoint as a subprocess with
 * --env test and asserts it fails FAST (before attempting to read any
 * baseline/cdk.out file — neither of which exists for a "test" stack in
 * this checkout) with a loud message. It does not need a real synth: the
 * guard must fire before any file I/O, so no fixtures are required.
 */
import { execFileSync } from "child_process";
import * as path from "path";

const backendDir = path.resolve(__dirname, "..", "..");
const runRailsScript = path.join(
  backendDir,
  "scripts",
  "split-gates",
  "run-rails.ts",
);

function runWithEnv(env: string): { status: number; output: string } {
  try {
    const output = execFileSync(
      "npx",
      ["ts-node", "-P", "tsconfig.scripts.json", runRailsScript, "--env", env],
      { cwd: backendDir, encoding: "utf-8", stdio: "pipe" },
    );
    return { status: 0, output };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return {
      status: e.status ?? 1,
      output: `${e.stdout ?? ""}${e.stderr ?? ""}`,
    };
  }
}

describe("run-rails.ts — refuses non-dev gate runs loudly", () => {
  it("exits non-zero immediately for --env test, before any baseline/cdk.out lookup", () => {
    const { status, output } = runWithEnv("test");
    expect(status).not.toBe(0);
    expect(output).toMatch(/test-env runs? (are|is) unsupported/i);
    expect(output).toMatch(/not\s+baseline\s+staleness/i);
    // Must fail BEFORE the pre-existing "baseline not found" / "fresh
    // template not found" messages, which would mislead a reader into
    // thinking this is a staleness problem.
    expect(output).not.toMatch(/baseline not found/i);
    expect(output).not.toMatch(/fresh template not found/i);
  });
}, 30000);
