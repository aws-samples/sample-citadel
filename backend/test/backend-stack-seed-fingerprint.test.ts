/**
 * CDK stack tests for seed custom resource content fingerprints.
 *
 * Verifies that:
 *  - SeedBlueprintsResource carries SeedFingerprint (64-hex) and Version
 *  - SeedEvalSuitesResource carries SeedFingerprint (64-hex) and Version
 *  - The synthesized fingerprints match the functions' output
 */

import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import * as path from "path";
import * as fs from "fs";

// Ensure asset directories exist for CDK synthesis
const assetDirs = [
  path.resolve(__dirname, "../src/schema"),
  path.resolve(__dirname, "../dist/lambda"),
  path.resolve(__dirname, "../src/lambda/seed-admin-user"),
  path.resolve(__dirname, "../src/lambda/seed-organizations"),
];
for (const dir of assetDirs) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

import { BackendStack } from "../lib/backend-stack";
import {
  computeSeedBlueprintFingerprint,
  SEED_VERSION as BP_SEED_VERSION,
} from "../src/lambda/seed-blueprints/definitions";
import {
  computeSeedEvalSuitesFingerprint,
  SEED_VERSION as ES_SEED_VERSION,
} from "../src/lambda/seed-eval-suites/definitions";

const HEX64 = /^[0-9a-f]{64}$/;

/** Find the custom resource properties for a given logical ID prefix. */
function findCustomResourceProps(
  template: Template,
  idPrefix: string,
): Record<string, unknown> {
  const resources = template.findResources(
    "AWS::CloudFormation::CustomResource",
  );
  const entry = Object.entries(resources).find(([key]) =>
    key.startsWith(idPrefix),
  );
  if (!entry) throw new Error(`${idPrefix} not found in template`);
  return (
    (entry[1] as { Properties?: Record<string, unknown> }).Properties ?? {}
  );
}

describe("BackendStack — seed custom resource content fingerprints", () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App({
      context: { adminEmail: "test@example.com" },
    });
    const stack = new BackendStack(app, "TestBackendStack", {
      environment: "test",
      env: { account: "123456789012", region: "us-east-1" },
    });
    template = Template.fromStack(stack);
  });

  describe("SeedBlueprintsResource", () => {
    test("carries a SeedFingerprint that is a 64-hex sha256", () => {
      const props = findCustomResourceProps(template, "SeedBlueprintsResource");
      expect(typeof props.SeedFingerprint).toBe("string");
      expect(props.SeedFingerprint as string).toMatch(HEX64);
    });

    test("SeedFingerprint matches computeSeedBlueprintFingerprint()", () => {
      const props = findCustomResourceProps(template, "SeedBlueprintsResource");
      expect(props.SeedFingerprint).toBe(computeSeedBlueprintFingerprint());
    });

    test("Version reflects SEED_VERSION from definitions", () => {
      const props = findCustomResourceProps(template, "SeedBlueprintsResource");
      expect(props.Version).toBe(`v${BP_SEED_VERSION}`);
    });
  });

  describe("SeedEvalSuitesResource", () => {
    test("carries a SeedFingerprint that is a 64-hex sha256", () => {
      const props = findCustomResourceProps(template, "SeedEvalSuitesResource");
      expect(typeof props.SeedFingerprint).toBe("string");
      expect(props.SeedFingerprint as string).toMatch(HEX64);
    });

    test("SeedFingerprint matches computeSeedEvalSuitesFingerprint()", () => {
      const props = findCustomResourceProps(template, "SeedEvalSuitesResource");
      expect(props.SeedFingerprint).toBe(computeSeedEvalSuitesFingerprint());
    });

    test("Version reflects SEED_VERSION from definitions", () => {
      const props = findCustomResourceProps(template, "SeedEvalSuitesResource");
      expect(props.Version).toBe(`v${ES_SEED_VERSION}`);
    });
  });
});
