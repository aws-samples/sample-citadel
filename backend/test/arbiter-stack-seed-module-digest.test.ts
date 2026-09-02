/**
 * Seed-module content-digest change detection (finding 588c7fb8, HIGH).
 *
 * DEFECT: the seed custom resource (SeedAgentConfigResource in
 * arbiter-stack.ts) uploads agent module files (demo_echo_agent.py,
 * smoke_idempotency_agent.py) from arbiter/seedConfig/ to the code bucket at
 * agents/<filename>. Its ONLY change-detection input used to be a hand-bumped
 * `Version` string, so editing a module's SOURCE changed no custom-resource
 * property — CloudFormation reported the resource unchanged and never
 * re-invoked the handler, so the repository fix never reached S3.
 *
 * FIX: a content digest of the seed source (computeSeedModuleDigest — a
 * content-only sha256 folding each file's relative path + raw bytes over a
 * sorted, exclusion-filtered walk of seedConfig/) is now a custom-resource
 * property (`ModuleDigest`). Any source edit changes the digest, forcing a
 * re-upload on the next deploy. Deliberately NOT cdk.FileSystem.fingerprint
 * (the original implementation, replaced under finding b9627d6f): that
 * primitive memoizes per-file content hashes in an on-disk cache keyed by
 * `${ino}|${mtimeMs}|${size}`, so a same-length rewrite within one mtime
 * tick can be served a stale digest — the CI flake this suite's own
 * mutate-and-recompute tests reproduced. See the IMPLEMENTATION NOTE above
 * computeSeedModuleDigest in arbiter-stack.ts.
 *
 * WHAT THESE TESTS CATCH / DO NOT CATCH:
 *   - They prove the synthesized template carries a real, source-derived
 *     content digest (not a constant), that it moves when a seed module source
 *     changes, and that it covers every uploaded file (not just one entry
 *     point).
 *   - The "drift assertion" (below) proves the synthesized ModuleDigest equals
 *     a digest independently recomputed from the on-disk seed source. Because
 *     these tests synthesize from the SAME live source, they cannot see what is
 *     ACTUALLY in the S3 bucket at deploy time (that would require an AWS call);
 *     they guard the synth-time contract only. The runtime re-upload is what
 *     the CFN change-detection + the seed handler's idempotent put_object
 *     provide.
 */
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as events from "aws-cdk-lib/aws-events";
import { Bucket } from "aws-cdk-lib/aws-s3";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  scaffoldBackendAssetDirs,
  scaffoldArbiterStubs,
} from "./helpers/scaffold-stub-assets";

scaffoldBackendAssetDirs(["dist/lambda", "src/schema"]);
scaffoldArbiterStubs();

import {
  ArbiterStack,
  computeSeedModuleDigest,
  SEED_MODULE_FINGERPRINT_EXCLUDES,
} from "../lib/arbiter-stack";

const SEED_CONFIG_DIR = path.resolve(
  __dirname,
  "..",
  "..",
  "arbiter",
  "seedConfig",
);
const HEX64 = /^[0-9a-f]{64}$/;

function buildStack(environment = "test"): cdk.Stack {
  const app = new cdk.App({ context: { "aws:cdk:bundling-stacks": [] } });
  const backendStack = new cdk.Stack(app, "MockBackendStack", {
    env: { account: "123456789012", region: "us-east-1" },
  });
  const agentEventBus = new events.EventBus(backendStack, "AgentEventBus", {
    eventBusName: `citadel-agents-${environment}`,
  });
  const mkTable = (id: string, name: string, pk: string) =>
    new dynamodb.Table(backendStack, id, {
      tableName: name,
      partitionKey: { name: pk, type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
  const agentConfigTable = mkTable(
    "AgentConfigTable",
    `citadel-agents-${environment}`,
    "agentId",
  );
  const executionSpecificationsTable = mkTable(
    "ExecutionSpecificationsTable",
    `citadel-execution-specifications-${environment}`,
    "specId",
  );
  const codeBucket = new Bucket(backendStack, "CodeBucket", {
    bucketName: `citadel-code-${environment}`,
  });
  return new ArbiterStack(app, "TestArbiterStack", {
    environment,
    env: { account: "123456789012", region: "us-east-1" },
    agentEventBus,
    agentConfigTable,
    codeBucket,
    executionSpecificationsTable,
  });
}

/** The single SeedAgentConfigResource custom resource's Properties. */
function seedResourceProps(template: Template): Record<string, unknown> {
  const resources = template.findResources(
    "AWS::CloudFormation::CustomResource",
  );
  const entry = Object.entries(resources).find(([key]) =>
    key.startsWith("SeedAgentConfigResource"),
  );
  if (!entry) throw new Error("SeedAgentConfigResource not found");
  return (
    (entry[1] as { Properties?: Record<string, unknown> }).Properties ?? {}
  );
}

/** Fresh temp dir seeded with the given files; auto-cleaned by the caller. */
function mkTempSeedDir(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seed-digest-"));
  for (const [name, body] of Object.entries(files)) {
    const full = path.join(dir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
  return dir;
}

describe("ArbiterStack — seed-module content digest (finding 588c7fb8)", () => {
  describe("synthesized template wiring", () => {
    let template: Template;
    beforeAll(() => {
      template = Template.fromStack(buildStack());
    });

    test("seed custom resource carries a ModuleDigest that is a real sha256 (not a version string)", () => {
      const props = seedResourceProps(template);
      expect(typeof props.ModuleDigest).toBe("string");
      expect(props.ModuleDigest as string).toMatch(HEX64);
    });

    test("drift assertion: synthesized ModuleDigest equals a digest recomputed from the on-disk seed source", () => {
      // Catches a hardcoded/stale digest and a digest computed over the wrong
      // directory. Does NOT (and cannot, without an AWS call) verify what is
      // actually stored in the S3 bucket — that is guarded at runtime by the
      // CFN change-detection re-invoke + the handler's idempotent put_object.
      const props = seedResourceProps(template);
      expect(props.ModuleDigest).toBe(computeSeedModuleDigest(SEED_CONFIG_DIR));
    });

    test("Version lever retained alongside the digest (two-lever change detection)", () => {
      // Version is the manual force-reseed lever; ModuleDigest is the automatic
      // content lever. Both live in the custom resource properties.
      expect(seedResourceProps(template).Version).toBe("v1.4.0");
    });
  });

  describe("digest function properties (deterministic, temp dirs)", () => {
    const cleanup: string[] = [];
    afterAll(() => {
      for (const d of cleanup) fs.rmSync(d, { recursive: true, force: true });
    });

    test("changing a module source file changes the digest", () => {
      // This is the property the pre-fix `Version`-only change detection
      // lacked: a constant string is blind to source content, so a fixed
      // module never re-uploaded. The digest is content-sensitive.
      const dir = mkTempSeedDir({ "demo_echo_agent.py": "return 'v1'\n" });
      cleanup.push(dir);
      const before = computeSeedModuleDigest(dir);
      fs.writeFileSync(path.join(dir, "demo_echo_agent.py"), "return 'v2'\n");
      const after = computeSeedModuleDigest(dir);
      expect(after).not.toBe(before);
    });

    test("digest covers ALL uploaded files, not just one entry point (adding a second module moves the digest)", () => {
      const dir = mkTempSeedDir({ "demo_echo_agent.py": "return 'echo'\n" });
      cleanup.push(dir);
      const oneFile = computeSeedModuleDigest(dir);
      // Add the second real rider of the S3-upload path.
      fs.writeFileSync(
        path.join(dir, "smoke_idempotency_agent.py"),
        "return 'smoke'\n",
      );
      const twoFiles = computeSeedModuleDigest(dir);
      expect(twoFiles).not.toBe(oneFile);
    });

    test("byte-compiled caches / test dirs are excluded so the digest does not churn", () => {
      const dir = mkTempSeedDir({ "demo_echo_agent.py": "return 'echo'\n" });
      cleanup.push(dir);
      const before = computeSeedModuleDigest(dir);
      fs.mkdirSync(path.join(dir, "__pycache__"), { recursive: true });
      fs.writeFileSync(path.join(dir, "__pycache__", "demo.pyc"), "bytecode");
      fs.mkdirSync(path.join(dir, "__tests__"), { recursive: true });
      fs.writeFileSync(path.join(dir, "__tests__", "test_x.py"), "assert True");
      fs.writeFileSync(path.join(dir, "demo_echo_agent.pyc"), "bytecode2");
      const after = computeSeedModuleDigest(dir);
      expect(after).toBe(before);
      expect(SEED_MODULE_FINGERPRINT_EXCLUDES).toEqual(
        expect.arrayContaining(["__pycache__", "__tests__", "*.pyc"]),
      );
    });
  });

  describe("end-to-end bite: editing a real seed module moves the SYNTHESIZED digest", () => {
    // The strongest proof, and the direct RED/GREEN discriminator vs the
    // pre-fix stack: against the old `Version`-only resource, editing a module
    // source leaves every custom-resource property unchanged (Version is a
    // constant), so this assertion FAILS (RED). With ModuleDigest wired, the
    // synthesized digest moves while Version stays constant (GREEN) — proving
    // the digest, not Version, is what carries source content into change
    // detection.
    const moduleFile = path.join(SEED_CONFIG_DIR, "demo_echo_agent.py");

    test("appending to demo_echo_agent.py changes ModuleDigest but not Version", () => {
      const baseline = Template.fromStack(buildStack());
      const baseProps = seedResourceProps(baseline);

      const original = fs.readFileSync(moduleFile);
      try {
        fs.writeFileSync(
          moduleFile,
          Buffer.concat([
            original,
            Buffer.from(`\n# digest-bite ${Date.now()}\n`),
          ]),
        );
        const mutated = Template.fromStack(buildStack());
        const mutatedProps = seedResourceProps(mutated);

        expect(mutatedProps.ModuleDigest).not.toBe(baseProps.ModuleDigest);
        // Version is source-blind — unchanged. This is exactly why the
        // pre-fix Version-only detection missed module edits.
        expect(mutatedProps.Version).toBe(baseProps.Version);
      } finally {
        // Restore byte-identical original regardless of assertion outcome.
        fs.writeFileSync(moduleFile, original);
      }

      // Confirm the restore was byte-exact.
      expect(fs.readFileSync(moduleFile).equals(original)).toBe(true);
    });
  });
});
