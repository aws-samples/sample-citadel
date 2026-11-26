import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { DOCKER_PLATFORM, EXPECTED_ARCH_TAG } from "../lib/runtime-constants";
import {
  wrongArchFiles,
  layerAssetDirFromTemplate,
} from "./helpers/layer-asset-helpers";

/**
 * Verify that the bundled common layer asset contains every runtime package
 * the arbiter Lambda functions import, AND that native extensions are compiled
 * for the target architecture (derived from runtime-constants.ts).
 *
 * Platform and expected .so tag are imported — never hardcoded — so a
 * change in runtime-constants.ts automatically updates the test.
 *
 * The layer asset directory is located DETERMINISTICALLY from the synthesised
 * template (cdk.out/citadel-arbiter-test.template.json → LayerVersion
 * Content.S3Key → cdk.out/asset.<hash>/python).  The test synthesises
 * only if the template is absent; it never deletes env flags.
 *
 * This test MUST run under the bundling jest config (jest.bundling.config.js)
 * and FAIL — not skip — when Docker is unavailable.  Skipping silently hid
 * the original x86_64 regression.
 */

const BACKEND = path.resolve(__dirname, "..");
const CDK_OUT = path.join(BACKEND, "cdk.out");
const TEMPLATE = path.join(CDK_OUT, "citadel-arbiter-test.template.json");

/** The imports every arbiter function must be able to resolve from the layer. */
const IMPORT_CHECK =
  'import pydantic_core, strands, mcp, boto3; from strands import Agent; print(\\"layer-ok\\")';

/**
 * Recursively find all .so filenames under a directory.
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

/**
 * Fail hard when Docker is not available — do NOT skip.
 * Skipping hid the x86_64 regression for the entire branch.
 */
function requireDocker(): void {
  try {
    execSync("docker info", { stdio: "ignore", timeout: 10_000 });
  } catch {
    throw new Error(
      "Docker is not available.  The layer import smoke test REQUIRES Docker " +
        "and must run only in the bundling CI job (npm run test:bundling).  " +
        "Do not run this test without Docker — it must fail, not skip.",
    );
  }
}

/**
 * Ensure cdk.out has been synthesised.  Synthesise only if the template
 * is absent.  Never delete env flags.
 */
function ensureSynthesised(): void {
  if (fs.existsSync(TEMPLATE)) return;
  // eslint-disable-next-line no-console
  console.log(
    "cdk.out/citadel-arbiter-test.template.json not found — running cdk synth…",
  );
  execSync("npx cdk synth citadel-arbiter-test --quiet", {
    cwd: BACKEND,
    stdio: "inherit",
    timeout: 2_700_000,
    env: { ...process.env, ENVIRONMENT: "test" },
  });
  if (!fs.existsSync(TEMPLATE)) {
    throw new Error(
      "cdk synth completed but template still not found at " + TEMPLATE,
    );
  }
}

describe(`ArbiterCatalogLayer — runtime import smoke (${DOCKER_PLATFORM})`, () => {
  // Opt out of jest-env-setup.ts: this test needs Docker and real bundling.
  delete process.env.CITADEL_SKIP_BUNDLING;

  requireDocker();
  ensureSynthesised();

  const layerAsset = layerAssetDirFromTemplate(TEMPLATE);
  if (!layerAsset) {
    throw new Error(
      "Could not locate the catalog layer asset directory from " +
        TEMPLATE +
        ".  The template exists but no LayerVersion with a matching " +
        "asset.*/python/catalog+common directory was found.",
    );
  }

  test(`layer asset satisfies all runtime imports on ${DOCKER_PLATFORM} (pydantic_core, strands, mcp, boto3)`, () => {
    const cmd = [
      "docker run --rm",
      `--platform ${DOCKER_PLATFORM}`,
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

  test(`bundled .so files carry the ${EXPECTED_ARCH_TAG} architecture tag`, () => {
    const soFiles = findSoFiles(path.join(layerAsset, "python"));
    expect(soFiles.length).toBeGreaterThan(0);

    const wrong = wrongArchFiles(soFiles, EXPECTED_ARCH_TAG);
    expect(wrong).toEqual([]);
  });
});
