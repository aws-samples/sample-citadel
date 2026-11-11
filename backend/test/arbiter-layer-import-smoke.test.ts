import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

/**
 * Verify that the bundled common layer asset contains every runtime package
 * the arbiter Lambda functions import.
 *
 * When Docker is available AND a cdk.out with a layer asset exists (or can
 * be synthesised), this test mounts the layer's python/ directory into the
 * official Lambda Python runtime image and runs the critical import check.
 *
 * When Docker is absent or the asset directory cannot be found, the test
 * skips with a loud console.warn so CI operators know coverage was reduced.
 */

const BACKEND = path.resolve(__dirname, "..");
const CDK_OUT = path.join(BACKEND, "cdk.out");

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

describe("ArbiterCatalogLayer — runtime import smoke test", () => {
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
});
