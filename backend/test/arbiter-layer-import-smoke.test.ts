import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

/**
 * Verify that the bundled common layer asset contains every runtime package
 * the arbiter Lambda functions import, AND that native extensions are compiled
 * for the target architecture (x86_64).
 *
 * When Docker is available AND a cdk.out with a layer asset exists (or can
 * be synthesised), this test mounts the layer's python/ directory into the
 * official Lambda Python runtime image and runs the critical import check
 * under `--platform linux/amd64` to match the function architecture.
 *
 * An additional test asserts that bundled .so filenames carry the expected
 * x86_64 architecture tag, catching the exact class of bug where an
 * Apple-silicon host produces aarch64 wheels for x86_64 functions.
 *
 * When Docker is absent or the asset directory cannot be found, the test
 * skips with a loud console.warn so CI operators know coverage was reduced.
 */

const BACKEND = path.resolve(__dirname, "..");
const CDK_OUT = path.join(BACKEND, "cdk.out");

/** Expected arch tag in .so filenames — must match the function architecture. */
const EXPECTED_ARCH_TAG = "x86_64-linux-gnu";

/** The imports every arbiter function must be able to resolve from the layer. */
const IMPORT_CHECK =
  'import pydantic_core, strands, mcp, boto3; from strands import Agent; print(\\"layer-ok\\")';

function dockerAvailable(): boolean {
  try {
    execSync("docker info", { stdio: "ignore", timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Find the layer asset directory.  The catalogLayer asset is the one that
 * contains a `python/` subdirectory with `catalog/` and `common/` inside.
 */
function findLayerAsset(): string | undefined {
  if (!fs.existsSync(CDK_OUT)) return undefined;
  for (const entry of fs.readdirSync(CDK_OUT)) {
    if (!entry.startsWith("asset.")) continue;
    const candidate = path.join(CDK_OUT, entry, "python");
    if (
      fs.existsSync(candidate) &&
      fs.existsSync(path.join(candidate, "catalog")) &&
      fs.existsSync(path.join(candidate, "common"))
    ) {
      return path.join(CDK_OUT, entry);
    }
  }
  return undefined;
}

/**
 * Recursively find all .so files under a directory.
 */
function findSoFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findSoFiles(full));
    } else if (entry.name.endsWith(".so")) {
      results.push(entry.name);
    }
  }
  return results;
}

describe("ArbiterCatalogLayer — runtime import smoke test", () => {
  // Opt out of the jest-env-setup.ts default: this test intentionally
  // needs Docker and must not carry the skip-bundling flag into the
  // CDK synth if it ever synthesises.
  delete process.env.CITADEL_SKIP_BUNDLING;

  const hasDocker = dockerAvailable();

  if (!hasDocker) {
    // eslint-disable-next-line no-console
    console.warn(
      "⚠️  SKIPPING layer import test: Docker is not available.  " +
        "Run with Docker to verify the layer contains all runtime dependencies.",
    );
    test.skip("Docker not available — layer import check skipped", () => {});
    return;
  }

  const layerAsset = findLayerAsset();

  if (!layerAsset) {
    // eslint-disable-next-line no-console
    console.warn(
      "⚠️  SKIPPING layer import test: no cdk.out layer asset found.  " +
        "Run `npx cdk synth` first, or the test will auto-skip.",
    );
    test.skip("cdk.out layer asset not found — layer import check skipped", () => {});
    return;
  }

  test("layer asset satisfies all runtime imports (pydantic_core, strands, mcp, boto3)", () => {
    const cmd = [
      "docker run --rm",
      "--platform linux/amd64",
      "--entrypoint python",
      `-v ${layerAsset}/python:/opt/python`,
      "-e PYTHONPATH=/opt/python",
      "public.ecr.aws/lambda/python:3.15",
      `-c "${IMPORT_CHECK}"`,
    ].join(" ");

    const output = execSync(cmd, {
      encoding: "utf-8",
      timeout: 300_000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    expect(output).toContain("layer-ok");
  }, /* 5 min timeout for Docker pull + import */ 360_000);

  test("bundled .so files carry the x86_64 architecture tag", () => {
    const soFiles = findSoFiles(path.join(layerAsset, "python"));
    // There must be at least one .so (pydantic_core ships native extensions)
    expect(soFiles.length).toBeGreaterThan(0);

    // Every arch-tagged .so must carry the expected tag.
    // Format: _pydantic_core.cpython-315-x86_64-linux-gnu.so
    const archTagged = soFiles.filter((f) => /cpython-\d+-.+\.so$/.test(f));
    expect(archTagged.length).toBeGreaterThan(0);

    const wrongArch = archTagged.filter((f) => !f.includes(EXPECTED_ARCH_TAG));
    expect(wrongArch).toEqual([]);
  });
});
