/**
 * Structural assertion (not an execution test — see note below) that
 * backend/bin/app.ts loads backend/.env BEFORE constructing any CDK stack.
 *
 * Why structural rather than executed: bin/app.ts has broad side effects
 * (constructs ~9 real CDK stacks, requires ENVIRONMENT/CDK_DEFAULT_ACCOUNT
 * context, runs cdk-nag) and is intentionally outside the jest `roots`
 * config (`lib`, `src`, `test`, `scripts`) used by every other suite in
 * this package — actually importing it here would mean the FIRST execution
 * of the module (with all the ordering guarantees Node module evaluation
 * implies) happens inside a test runner rather than under `cdk synth`,
 * which is exactly the environment the fix targets. A source-position
 * assertion instead pins the property that actually matters: the
 * `loadDotenvIfPresent(...)` call textually precedes `new BackendStack(`,
 * the first stack constructed in the file. Since CDK stacks are
 * constructed synchronously and in file order at module-evaluation time,
 * textual order here IS execution order — there is no async indirection
 * between them.
 */
import * as fs from "fs";
import * as path from "path";

describe("backend/bin/app.ts — env load ordering", () => {
  const appSource = fs.readFileSync(
    path.join(__dirname, "..", "..", "bin", "app.ts"),
    "utf8",
  );

  it("imports loadDotenvIfPresent from lib/load-dotenv", () => {
    expect(appSource).toMatch(
      /import\s*\{\s*loadDotenvIfPresent\s*\}\s*from\s*["']\.\.\/lib\/load-dotenv["']/,
    );
  });

  it("calls loadDotenvIfPresent(...) before constructing the first stack", () => {
    const loadCallIndex = appSource.indexOf("loadDotenvIfPresent(");
    const firstStackIndex = appSource.indexOf("new BackendStack(");

    expect(loadCallIndex).toBeGreaterThan(-1);
    expect(firstStackIndex).toBeGreaterThan(-1);
    expect(loadCallIndex).toBeLessThan(firstStackIndex);
  });

  it("calls loadDotenvIfPresent(...) before `new cdk.App()` stacks are given a chance to synth", () => {
    // Belt-and-suspenders: also assert it precedes the AwsSolutionsChecks
    // aspect application, so no code path between module load and full
    // synth can run without .env already loaded.
    const loadCallIndex = appSource.indexOf("loadDotenvIfPresent(");
    const nagChecksIndex = appSource.indexOf("new AwsSolutionsChecks(");

    expect(nagChecksIndex).toBeGreaterThan(-1);
    expect(loadCallIndex).toBeLessThan(nagChecksIndex);
  });
});
