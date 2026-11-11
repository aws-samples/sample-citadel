/**
 * Single source of truth for the Python Lambda runtime version and the
 * corresponding Docker image used to bundle Python assets.
 *
 * Every Python Lambda function and every Python LayerVersion in the CDK
 * stacks MUST use these constants.  Deriving the build image from the
 * runtime name makes it impossible for the two to diverge — the exact
 * class of bug that caused the pydantic_core ImportError regression
 * (#525: functions ran 3.15, but the layer was pip-installed under the
 * 3.14 SAM image, producing a 3.14-native C extension).
 */
import * as fs from "fs";
import * as path from "path";
import * as cdk from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";

/** The Python Lambda runtime used by every Python function in Citadel. */
export const PYTHON_RUNTIME = lambda.Runtime.PYTHON_3_15;

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
      if (prop === "image" || prop === "run" || prop === "toJSON" || prop === "cp") {
        const real = resolve();
        const val = (real as unknown as Record<string, unknown>)[prop as string];
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
  { buildArgs: { LAMBDA_BASE_TAG } },
);
