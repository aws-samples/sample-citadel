/**
 * Regression test for the scaffold-stub-asset path anchoring bug.
 *
 * Previously, 10 test files computed the `arbiter/`/`service/` scaffold
 * roots as `path.resolve(__dirname, '../../../arbiter')` from
 * `backend/test/` — one `../` too many, landing one directory above the
 * repository root. Running the suite with a different process.cwd() (e.g.
 * from the repo root instead of `backend/`) did not change the bug (the
 * paths were always `__dirname`-relative, never `process.cwd()`-relative),
 * but the wrong offset meant every invocation wrote stub files outside the
 * repository.
 *
 * This test asserts that the resolved roots stay inside the repository
 * toplevel regardless of `process.cwd()`, and that the hard guard rejects
 * an out-of-repo target.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  scaffoldArbiterStubs,
  scaffoldServiceDockerfiles,
  scaffoldBackendAssetDirs,
  __testOnly,
} from "./helpers/scaffold-stub-assets";

const { REPO_ROOT, resolveInRepo } = __testOnly;

function withinRepo(p: string): boolean {
  const rootWithSep = REPO_ROOT.endsWith(path.sep)
    ? REPO_ROOT
    : REPO_ROOT + path.sep;
  return p === REPO_ROOT || p.startsWith(rootWithSep);
}

describe("scaffold-stub-assets path anchoring", () => {
  const originalCwd = process.cwd();

  afterEach(() => {
    process.chdir(originalCwd);
  });

  it("resolves REPO_ROOT to the actual git toplevel, not one level above it", () => {
    expect(fs.existsSync(path.join(REPO_ROOT, "arbiter"))).toBe(true);
    expect(fs.existsSync(path.join(REPO_ROOT, "backend"))).toBe(true);
    // The previously-buggy `../../../arbiter` offset would have resolved to
    // REPO_ROOT's parent directory, which does not contain `backend/`.
    expect(fs.existsSync(path.join(path.dirname(REPO_ROOT), "backend"))).toBe(
      false,
    );
  });

  it("keeps the arbiter stub root inside the repo regardless of process.cwd()", () => {
    for (const cwd of [
      REPO_ROOT,
      path.join(REPO_ROOT, "backend"),
      os.tmpdir(),
    ]) {
      process.chdir(cwd);
      const resolved = resolveInRepo("arbiter", "supervisor");
      expect(withinRepo(resolved)).toBe(true);
      expect(resolved).toBe(path.join(REPO_ROOT, "arbiter", "supervisor"));
    }
  });

  it("keeps the service Dockerfile root inside the repo regardless of process.cwd()", () => {
    for (const cwd of [
      REPO_ROOT,
      path.join(REPO_ROOT, "backend"),
      os.tmpdir(),
    ]) {
      process.chdir(cwd);
      const resolved = resolveInRepo("service", "hld_pdf_generator");
      expect(withinRepo(resolved)).toBe(true);
      expect(resolved).toBe(
        path.join(REPO_ROOT, "service", "hld_pdf_generator"),
      );
    }
  });

  it("throws instead of writing when a resolved target would escape the repo", () => {
    expect(() => resolveInRepo("..", "escaped-outside-repo")).toThrow(
      /Refusing to scaffold outside the repository/,
    );
  });

  it("scaffoldArbiterStubs writes index.py only under <repoRoot>/arbiter/<module>", () => {
    process.chdir(path.join(REPO_ROOT, "backend"));
    scaffoldArbiterStubs(["supervisor"]);
    const expected = path.join(REPO_ROOT, "arbiter", "supervisor", "index.py");
    expect(fs.existsSync(expected)).toBe(true);
    expect(withinRepo(expected)).toBe(true);
  });

  it("scaffoldServiceDockerfiles writes Dockerfile only under <repoRoot>/service/<name>", () => {
    process.chdir(REPO_ROOT);
    scaffoldServiceDockerfiles(["hld_pdf_generator"]);
    const expected = path.join(
      REPO_ROOT,
      "service",
      "hld_pdf_generator",
      "Dockerfile",
    );
    expect(fs.existsSync(expected)).toBe(true);
    expect(withinRepo(expected)).toBe(true);
  });

  it("scaffoldBackendAssetDirs anchors relative dirs under <repoRoot>/backend", () => {
    process.chdir(os.tmpdir());
    scaffoldBackendAssetDirs(["dist/lambda"]);
    const expected = path.join(REPO_ROOT, "backend", "dist", "lambda");
    expect(fs.existsSync(expected)).toBe(true);
    expect(withinRepo(expected)).toBe(true);
  });
});
