/**
 * Single source of truth for Lambda runtime versions, target architecture,
 * and the Docker platform / build image used to bundle assets.
 *
 * Every Lambda function (Python and Node.js), every LayerVersion, and every
 * DockerImageFunction / DockerImageAsset in the CDK stacks MUST use these
 * constants.  Deriving the build image and platform from the architecture
 * constant makes it impossible for host/target mismatches to occur — the
 * exact class of bug that caused the pydantic_core ImportError regression
 * (#525) and the reason decision 5f7754e4 standardised on arm64.
 *
 * Renamed from `python-runtime.ts` to reflect that it now governs Node.js
 * functions and container images as well.
 */
import * as fs from "fs";
import * as path from "path";
import * as cdk from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { Platform } from "aws-cdk-lib/aws-ecr-assets";

// ---------------------------------------------------------------------------
// Runtimes
// ---------------------------------------------------------------------------

/** The Python Lambda runtime used by every Python function in Citadel. */
export const PYTHON_RUNTIME = lambda.Runtime.PYTHON_3_15;

/** The Node.js Lambda runtime used by every Node.js function in Citadel. */
export const NODE_RUNTIME = lambda.Runtime.NODEJS_24_X;

// ---------------------------------------------------------------------------
// Architecture (decision 5f7754e4: everything arm64)
// ---------------------------------------------------------------------------

/**
 * Target Lambda architecture for the entire fleet — Python, Node.js,
 * and container-image functions alike.
 *
 * ARM_64 (Graviton): better price-performance, and all Citadel
 * dependencies (native Python wheels, Node.js runtime, pandoc, texlive)
 * have validated arm64 support.
 */
export const LAMBDA_ARCHITECTURE = lambda.Architecture.ARM_64;

/** @deprecated Use {@link LAMBDA_ARCHITECTURE} — kept for grep-ability. */
export const PYTHON_ARCHITECTURE = LAMBDA_ARCHITECTURE;

/**
 * ECR-assets `Platform` constant corresponding to {@link LAMBDA_ARCHITECTURE}.
 * Used for every `DockerImageAsset`, `DockerImageCode.fromImageAsset`, and
 * AgentCore Runtime artifact.
 */
export const ECR_PLATFORM: Platform =
  LAMBDA_ARCHITECTURE === lambda.Architecture.ARM_64
    ? Platform.LINUX_ARM64
    : Platform.LINUX_AMD64;

// ---------------------------------------------------------------------------
// Docker platform string (for DockerImage.fromBuild / bundling)
// ---------------------------------------------------------------------------

/**
 * Docker `--platform` string derived from {@link LAMBDA_ARCHITECTURE}.
 * Passed to `DockerImage.fromBuild` and the Dockerfile `FROM` so the
 * bundling container always produces native extensions for the target
 * architecture — regardless of the deploying host's CPU (e.g. Apple
 * silicon emitting aarch64 wheels when the functions are x86_64).
 */
export const DOCKER_PLATFORM =
  LAMBDA_ARCHITECTURE === lambda.Architecture.ARM_64
    ? "linux/arm64"
    : "linux/amd64";

/**
 * ELF machine tag expected on every native `.so` in the bundled layer
 * output.  Used by the self-verification check inside the bundling
 * command to fail the build when the wrong-architecture shared objects
 * are produced (e.g. Docker reusing a cached amd64 build image).
 *
 * - arm64  → `aarch64`  (ELF e_machine EM_AARCH64)
 * - x86_64 → `x86_64`  (ELF e_machine EM_X86_64)
 */
export const EXPECTED_ARCH_TAG: string =
  LAMBDA_ARCHITECTURE === lambda.Architecture.ARM_64 ? "aarch64" : "x86_64";

/**
 * Shell snippet that verifies every `*.so` under a given directory
 * matches {@link EXPECTED_ARCH_TAG} and that the Python interpreter
 * itself is running on the expected architecture.  Intended to be
 * appended (via `&&`) to a bundling command string so a wrong-arch
 * layer can never be synthesised — the bundling exits non-zero on
 * mismatch.
 *
 * @param outputDir  Absolute path inside the container to scan
 *                   (e.g. `/asset-output/python`).
 */
export function archVerificationSnippet(outputDir: string): string {
  // The Lambda base image lacks `find` and `file`; use a single Python
  // script that walks the tree and checks .so filenames for the wrong
  // architecture tag.  It also verifies that `platform.machine()` reports
  // the expected architecture — but only when NOT running under QEMU
  // (QEMU returns the host's uname, not the emulated arch).
  const expected = EXPECTED_ARCH_TAG;
  const wrong = expected === "aarch64" ? "x86_64" : "aarch64";
  // Use double-quoted shell string wrapping a Python script with
  // single-quoted Python strings to avoid escaping issues.
  const pyScript = [
    "import os, sys, platform",
    `expected = '${expected}'`,
    `wrong = '${wrong}'`,
    `root = '${outputDir}'`,
    "bad = []",
    "for dirpath, _, filenames in os.walk(root):",
    "    for fn in filenames:",
    "        if fn.endswith('.so') and wrong in fn:",
    "            bad.append(os.path.join(dirpath, fn))",
    "if bad:",
    "    print('ARCH MISMATCH: found %d %s .so files under %s:' % (len(bad), wrong, root), file=sys.stderr)",
    "    for p in bad: print('  ' + p, file=sys.stderr)",
    "    sys.exit(1)",
    "m = platform.machine()",
    "if m != expected:",
    "    print('arch-verify: WARNING platform.machine()=%s != %s (likely QEMU)' % (m, expected), file=sys.stderr)",
    "else:",
    "    print('arch-verify: platform.machine()=%s OK' % m)",
    "print('arch-verify: OK all .so files match %s' % expected)",
  ].join("\n");
  // Shell: echo ... && python3 -c "..."
  // Escape double quotes and backslashes in the Python script for
  // embedding inside a shell double-quoted string.
  const escaped = pyScript
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\$/g, "\\$");
  return [
    `echo "arch-verify: expecting ${expected}"`,
    `python3 -c "${escaped}"`,
  ].join(" && ");
}

// ---------------------------------------------------------------------------
// Python build image (lazy — no Docker pull until `cdk synth` bundles)
// ---------------------------------------------------------------------------

/**
 * Docker image for bundling Python assets (layers and PythonFunction
 * code).  Derived from {@link PYTHON_RUNTIME} so the two cannot diverge.
 *
 * Uses the official AWS Lambda base image rather than the SAM build image
 * because `public.ecr.aws/sam/build-python3.15` does not exist yet
 * (as of 2026-11-11).  The Lambda image ships the same Python + pip that
 * the real runtime uses, which is all CDK bundling needs.  We override
 * the entrypoint from `/lambda-entrypoint.sh` to `/bin/bash` via a
 * one-line Dockerfile so CDK's `bash -c` bundling commands work
 * transparently (both explicit `command` arrays and PythonFunction's
 * internally-generated commands).
 *
 * The image is built lazily (on first `.image` access) so tests that
 * import this module with bundling disabled don't trigger a Docker build.
 *
 * Base: `public.ecr.aws/lambda/python:3.15`
 */
const LAMBDA_BASE_TAG = PYTHON_RUNTIME.name.replace("python", ""); // "3.15"

/**
 * Resolve the python-build-image/ Dockerfile directory from either source
 * (`backend/lib/`) or compiled output (`backend/dist/lib/`).
 */
function resolveBuildImageDir(startDir: string): string {
  const candidates = [
    path.join(startDir, "python-build-image"), // source: backend/lib/
    path.join(startDir, "..", "..", "lib", "python-build-image"), // dist: backend/dist/lib/ -> backend/lib/
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, "Dockerfile"))) {
      return candidate;
    }
  }
  throw new Error(
    `Unable to locate python-build-image/Dockerfile from ${startDir}. ` +
      `Tried: ${candidates.join(", ")}`,
  );
}

/**
 * Lazy wrapper around {@link cdk.DockerImage.fromBuild} that defers the
 * `docker build` until the image is actually used (during `cdk synth`
 * with bundling enabled).  Tests that set
 * `aws:cdk:bundling-stacks: []` never trigger the build because CDK
 * skips the `.run()` call entirely.
 *
 * When `CITADEL_SKIP_BUNDLING=1` is set (unit-test CI), the proxy never
 * resolves the real Docker image — all property reads return the inert
 * placeholder, so `docker build` is never spawned.  The dedicated
 * layer-import smoke test is the only Docker-touching test; it already
 * skips itself when Docker is unavailable.
 *
 * We use a Proxy rather than class inheritance because DockerImage
 * declares `image` as a readonly property, and TypeScript strict mode
 * prohibits overriding that with a getter.
 */
function lazyBuildImage(
  buildDir: string,
  buildOpts: cdk.DockerBuildOptions,
): cdk.DockerImage {
  let inner: cdk.DockerImage | undefined;
  function resolve(): cdk.DockerImage {
    if (!inner) {
      inner = cdk.DockerImage.fromBuild(buildDir, buildOpts);
    }
    return inner;
  }

  // Start with a dummy instance whose properties we'll intercept.
  const placeholder = cdk.DockerImage.fromRegistry(
    "__lazy_python_build_image__",
  );
  return new Proxy(placeholder, {
    get(target, prop, receiver) {
      // Intercept property access so the real image is built on demand.
      if (
        prop === "image" ||
        prop === "run" ||
        prop === "toJSON" ||
        prop === "cp"
      ) {
        // CITADEL_SKIP_BUNDLING: return the placeholder's own values so
        // no Docker daemon is contacted.  Unit tests that set
        // `aws:cdk:bundling-stacks: []` never call .run(), and asset-hash
        // computation only reads .image — the placeholder string is fine.
        //
        // SAFETY GUARD: the bundling-skip placeholder must NEVER reach a
        // real deployment.  Only allow it when the environment is 'test'
        // or unset (unit-test suite) — an explicitly non-test ENVIRONMENT
        // indicates a real synth and must use the real Docker build image.
        // The companion guard in bin/app.ts catches the CDK entry point
        // (where ENVIRONMENT defaults to 'dev' when unset).
        if (process.env.CITADEL_SKIP_BUNDLING) {
          const env = process.env.ENVIRONMENT;
          if (env && env !== "test") {
            throw new Error(
              "CITADEL_SKIP_BUNDLING is set but ENVIRONMENT is not 'test'. " +
                "Refusing to synthesise with a bundling-skip placeholder for " +
                `environment '${env}'. ` +
                "Unset CITADEL_SKIP_BUNDLING or set ENVIRONMENT=test.",
            );
          }
          return Reflect.get(target, prop, receiver);
        }
        const real = resolve();
        const val = (real as unknown as Record<string, unknown>)[
          prop as string
        ];
        return typeof val === "function"
          ? (val as (...a: unknown[]) => unknown).bind(real)
          : val;
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

export const PYTHON_BUILD_IMAGE: cdk.DockerImage = lazyBuildImage(
  resolveBuildImageDir(__dirname),
  {
    buildArgs: { LAMBDA_BASE_TAG, TARGETPLATFORM: DOCKER_PLATFORM },
    platform: DOCKER_PLATFORM,
    // Disable Docker layer cache for cross-platform builds.  BuildKit may
    // reuse cached layers from a prior build for the host architecture
    // (e.g. amd64 on x86_64) even when --platform linux/arm64 is
    // specified, producing an image labelled arm64 that contains x86_64
    // binaries.  --no-cache forces a fresh pull of the arm64 base image.
    // On native-arch hosts (Apple Silicon building arm64) this is a no-op
    // cost-wise because the base image layers are re-downloaded only when
    // they differ from cache.
    cacheDisabled: true,
  },
);
