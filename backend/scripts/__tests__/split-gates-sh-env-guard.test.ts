/**
 * split-gates.sh — environment guard (bash layer).
 *
 * Mirrors the move-manifest.ts / run-rails.ts guard at the shell-script
 * entrypoint: `backend/scripts/split-gates.sh test` must refuse loudly and
 * exit non-zero WITHOUT running `npm run build` or `cdk synth` first (both
 * are slow and irrelevant once the environment itself is unsupported).
 * Tested via a real subprocess spawn, per this repo's Bash-hook testing
 * convention (shell assertions on stdout/stderr + exit code).
 */
import { execFileSync } from "child_process";
import * as path from "path";

const backendDir = path.resolve(__dirname, "..", "..");
const scriptPath = path.join(backendDir, "scripts", "split-gates.sh");

function runScript(env: string): { status: number; output: string } {
  try {
    const output = execFileSync("bash", [scriptPath, env], {
      cwd: backendDir,
      encoding: "utf-8",
      stdio: "pipe",
      timeout: 15000,
    });
    return { status: 0, output };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return {
      status: e.status ?? 1,
      output: `${e.stdout ?? ""}${e.stderr ?? ""}`,
    };
  }
}

describe("split-gates.sh — refuses non-dev gate runs loudly", () => {
  it("exits non-zero for a 'test' environment without invoking npm run build", () => {
    const { status, output } = runScript("test");
    expect(status).not.toBe(0);
    expect(output).toMatch(/test-env runs? (are|is) unsupported/i);
    expect(output).toMatch(/not\s+baseline\s+staleness/i);
    expect(output).not.toMatch(/rebuilding dist/i);
  });

  it("exits non-zero for a 'staging' environment with the same loud message", () => {
    const { status, output } = runScript("staging");
    expect(status).not.toBe(0);
    expect(output).toMatch(/unsupported/i);
  });
}, 20000);
