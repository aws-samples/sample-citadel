/**
 * Shared CDK-synth test scaffolding: creates stub asset directories/files
 * (Lambda `index.py` stubs, Docker `Dockerfile` stubs) that the stack
 * constructs expect to exist on disk during `Template.fromStack`.
 *
 * All roots are anchored to this file's own `__dirname`, never to
 * `process.cwd()`, so behavior is identical whether the test runner is
 * invoked from `backend/` or from the repo root.
 *
 * `backend/test/helpers/` -> up 3 -> repo root -> `arbiter/` | `service/`.
 */
import * as fs from "fs";
import * as path from "path";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

/**
 * Resolve a path under the repo root and assert it did not escape the repo.
 * Throws if the resolved path is not inside REPO_ROOT — this is the hard
 * guard against a future off-by-one `../` regression writing outside the
 * repository (as previously happened with a `../../../arbiter` offset from
 * `backend/test/`, which landed one directory above the repo).
 */
function resolveInRepo(...segments: string[]): string {
  const resolved = path.resolve(REPO_ROOT, ...segments);
  const rootWithSep = REPO_ROOT.endsWith(path.sep)
    ? REPO_ROOT
    : REPO_ROOT + path.sep;
  if (resolved !== REPO_ROOT && !resolved.startsWith(rootWithSep)) {
    throw new Error(
      `Refusing to scaffold outside the repository: resolved "${resolved}" ` +
        `is not inside repo root "${REPO_ROOT}"`,
    );
  }
  return resolved;
}

const ARBITER_MODULES = [
  "supervisor",
  "workerWrapper",
  "fabricator",
  "seedConfig",
  "stepRunner",
  "activator",
];
const DOCKER_SERVICE_DIRS = ["hld_pdf_generator", "agent_intake_single"];
const INDEX_PY_STUB =
  "def handler(event, context): pass\ndef lambda_handler(event, context): pass\n";
const DOCKERFILE_STUB =
  'FROM public.ecr.aws/lambda/python:3.12\nCMD ["handler.handler"]\n';

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function ensureFile(filePath: string, contents: string): void {
  if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, contents);
}

/** Stub the backend-local asset dirs (dist/lambda, src/schema, etc.). */
export function scaffoldBackendAssetDirs(relativeDirs: string[]): void {
  for (const rel of relativeDirs) {
    ensureDir(path.resolve(REPO_ROOT, "backend", rel));
  }
}

/** Stub `<repo>/arbiter/<module>/index.py` for the given module names. */
export function scaffoldArbiterStubs(
  modules: string[] = ARBITER_MODULES,
): void {
  for (const mod of modules) {
    const dir = resolveInRepo("arbiter", mod);
    ensureDir(dir);
    ensureFile(path.join(dir, "index.py"), INDEX_PY_STUB);
  }
}

/** Stub `<repo>/service/<name>/Dockerfile` for the given service names. */
export function scaffoldServiceDockerfiles(
  services: string[] = DOCKER_SERVICE_DIRS,
): void {
  for (const svc of services) {
    const dir = resolveInRepo("service", svc);
    ensureDir(dir);
    ensureFile(path.join(dir, "Dockerfile"), DOCKERFILE_STUB);
  }
}

export const __testOnly = { resolveInRepo, REPO_ROOT };
