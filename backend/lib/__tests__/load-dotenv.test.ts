/**
 * Unit tests for loadDotenvIfPresent (finding: CDK_DOCKER=docker in
 * backend/.env is not read by a bare `npx cdk diff/synth`, only by
 * deploy.sh).
 *
 * Covers: load-if-absent (never overrides process.env), missing-file
 * no-op, and parity with deploy.sh's `load_env` bash function for the
 * ordinary .env shapes it already tolerates (comments, blank lines,
 * quoted values, values containing '=', and the two shapes deploy.sh
 * itself silently drops: `export `-prefixed lines and space-before-`=`
 * lines).
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { loadDotenvIfPresent } from "../load-dotenv";

describe("loadDotenvIfPresent", () => {
  let tmpDir: string;
  const ownedKeys: string[] = [];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "load-dotenv-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    for (const key of ownedKeys) {
      delete process.env[key];
    }
    ownedKeys.length = 0;
  });

  function writeEnv(contents: string): string {
    const file = path.join(tmpDir, ".env");
    fs.writeFileSync(file, contents);
    return file;
  }

  function track(...keys: string[]): void {
    ownedKeys.push(...keys);
  }

  it("sets a key that is absent from process.env", () => {
    track("LOADER_TEST_ABSENT_KEY");
    const file = writeEnv("LOADER_TEST_ABSENT_KEY=hello\n");
    loadDotenvIfPresent(file);
    expect(process.env.LOADER_TEST_ABSENT_KEY).toBe("hello");
  });

  it("does NOT override a key already present in process.env", () => {
    track("LOADER_TEST_EXISTING_KEY");
    process.env.LOADER_TEST_EXISTING_KEY = "from-shell";
    const file = writeEnv("LOADER_TEST_EXISTING_KEY=from-file\n");
    loadDotenvIfPresent(file);
    expect(process.env.LOADER_TEST_EXISTING_KEY).toBe("from-shell");
  });

  it("is a silent no-op when the file is missing (never throws)", () => {
    const missing = path.join(tmpDir, "does-not-exist.env");
    expect(() => loadDotenvIfPresent(missing)).not.toThrow();
  });

  it("skips comment and blank lines", () => {
    track("LOADER_TEST_AFTER_COMMENT");
    const file = writeEnv(
      [
        "# a full-line comment",
        "",
        "   ",
        "LOADER_TEST_AFTER_COMMENT=value",
      ].join("\n"),
    );
    loadDotenvIfPresent(file);
    expect(process.env.LOADER_TEST_AFTER_COMMENT).toBe("value");
  });

  it("strips inline comments the same way deploy.sh's ${line%%#*} does", () => {
    track("LOADER_TEST_INLINE_COMMENT");
    const file = writeEnv("LOADER_TEST_INLINE_COMMENT=abc # trailing note\n");
    loadDotenvIfPresent(file);
    expect(process.env.LOADER_TEST_INLINE_COMMENT).toBe("abc");
  });

  it("strips one layer of surrounding double quotes, matching xargs", () => {
    track("LOADER_TEST_DQUOTE");
    const file = writeEnv('LOADER_TEST_DQUOTE="quoted value"\n');
    loadDotenvIfPresent(file);
    expect(process.env.LOADER_TEST_DQUOTE).toBe("quoted value");
  });

  it("strips one layer of surrounding single quotes, matching xargs", () => {
    track("LOADER_TEST_SQUOTE");
    const file = writeEnv("LOADER_TEST_SQUOTE='single quoted'\n");
    loadDotenvIfPresent(file);
    expect(process.env.LOADER_TEST_SQUOTE).toBe("single quoted");
  });

  it("preserves embedded '=' characters in the value", () => {
    track("LOADER_TEST_EMBEDDED_EQ");
    const file = writeEnv("LOADER_TEST_EMBEDDED_EQ=key=val=extra\n");
    loadDotenvIfPresent(file);
    expect(process.env.LOADER_TEST_EMBEDDED_EQ).toBe("key=val=extra");
  });

  it("drops an `export `-prefixed line, exactly as deploy.sh's regex does", () => {
    track("LOADER_TEST_EXPORT_PREFIXED");
    const file = writeEnv("export LOADER_TEST_EXPORT_PREFIXED=value\n");
    loadDotenvIfPresent(file);
    // deploy.sh's `^([A-Za-z_][A-Za-z0-9_]*)=(.*)$` never matches a line
    // starting with `export `, so the whole line is silently skipped —
    // the loader must reproduce that exact (non-)behavior for parity.
    expect(process.env.LOADER_TEST_EXPORT_PREFIXED).toBeUndefined();
  });

  it("drops a line with a space before '=', exactly as deploy.sh's regex does", () => {
    track("LOADER_TEST_SPACED_EQ");
    const file = writeEnv("LOADER_TEST_SPACED_EQ = value\n");
    loadDotenvIfPresent(file);
    expect(process.env.LOADER_TEST_SPACED_EQ).toBeUndefined();
  });

  it("loads multiple keys from a realistic backend/.env-shaped file", () => {
    track("LOADER_TEST_ENVIRONMENT", "LOADER_TEST_CDK_DOCKER");
    const file = writeEnv(
      [
        "# Environment for deployment",
        "LOADER_TEST_ENVIRONMENT=dev",
        "",
        "# Container build tool (finch or docker)",
        "LOADER_TEST_CDK_DOCKER=docker",
      ].join("\n"),
    );
    loadDotenvIfPresent(file);
    expect(process.env.LOADER_TEST_ENVIRONMENT).toBe("dev");
    expect(process.env.LOADER_TEST_CDK_DOCKER).toBe("docker");
  });
});
