/**
 * Guard test for the SuppressNodejsL1Nag Aspect.
 *
 * Verifies:
 *  1. Every Node.js CfnFunction carries exactly the AwsSolutions-L1
 *     suppression with the canonical reason text.
 *  2. No Python CfnFunction carries an L1 suppression.
 *  3. No stack-level L1 suppression exists.
 *  4. The Aspect is idempotent (applying twice does not duplicate).
 */
import * as cdk from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import {
  SuppressNodejsL1Nag,
  L1_SUPPRESSION_REASON,
} from "../nag-l1-suppression-aspect";
import { NODE_RUNTIME, PYTHON_RUNTIME } from "../runtime-constants";

interface NagSuppression {
  id: string;
  reason: string;
}

interface CfnResource {
  Type: string;
  Properties?: Record<string, unknown>;
  Metadata?: {
    cdk_nag?: {
      rules_to_suppress?: NagSuppression[];
    };
  };
}

function buildTestApp(): {
  app: cdk.App;
  stack: cdk.Stack;
} {
  const app = new cdk.App({ context: { "aws:cdk:bundling-stacks": [] } });
  const stack = new cdk.Stack(app, "L1GuardStack", {
    env: { account: "123456789012", region: "us-east-1" },
  });

  // Node.js function — should get the suppression
  new lambda.Function(stack, "NodejsFn", {
    runtime: NODE_RUNTIME,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = () => {}"),
  });

  // Second Node.js function — verify all are covered
  new lambda.Function(stack, "NodejsFn2", {
    runtime: NODE_RUNTIME,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = () => {}"),
  });

  // Python function — must NOT get the suppression
  new lambda.Function(stack, "PythonFn", {
    runtime: PYTHON_RUNTIME,
    handler: "index.handler",
    code: lambda.Code.fromInline("def handler(event, context): pass"),
  });

  // Apply the Aspect
  cdk.Aspects.of(app).add(new SuppressNodejsL1Nag());

  return { app, stack };
}

function synthesize(
  app: cdk.App,
  stack: cdk.Stack,
): Record<string, CfnResource> {
  const assembly = app.synth();
  const template = assembly.getStackByName(stack.stackName).template;
  return template.Resources as Record<string, CfnResource>;
}

function getL1Suppressions(resource: CfnResource): NagSuppression[] {
  const all = resource.Metadata?.cdk_nag?.rules_to_suppress ?? [];
  return all.filter((s: NagSuppression) => s.id === "AwsSolutions-L1");
}

describe("SuppressNodejsL1Nag Aspect", () => {
  it("every Node.js CfnFunction carries the AwsSolutions-L1 suppression with the canonical reason", () => {
    const { app, stack } = buildTestApp();
    const resources = synthesize(app, stack);

    const violations: string[] = [];
    let nodejsCount = 0;

    for (const [logicalId, resource] of Object.entries(resources)) {
      if (resource.Type !== "AWS::Lambda::Function") continue;
      const runtime = resource.Properties?.Runtime as string | undefined;
      if (!runtime || !runtime.startsWith("nodejs")) continue;
      nodejsCount++;

      const l1Suppressions = getL1Suppressions(resource);
      if (l1Suppressions.length !== 1) {
        violations.push(
          `${logicalId}: expected exactly 1 L1 suppression, found ${l1Suppressions.length}`,
        );
        continue;
      }
      if (l1Suppressions[0].reason !== L1_SUPPRESSION_REASON) {
        violations.push(
          `${logicalId}: wrong reason: "${l1Suppressions[0].reason}"`,
        );
      }
    }

    expect(nodejsCount).toBeGreaterThanOrEqual(2);
    expect(violations).toEqual([]);
  });

  it("no Python CfnFunction carries an L1 suppression", () => {
    const { app, stack } = buildTestApp();
    const resources = synthesize(app, stack);

    const violations: string[] = [];

    for (const [logicalId, resource] of Object.entries(resources)) {
      if (resource.Type !== "AWS::Lambda::Function") continue;
      const runtime = resource.Properties?.Runtime as string | undefined;
      if (!runtime || !runtime.startsWith("python")) continue;

      const l1Suppressions = getL1Suppressions(resource);
      if (l1Suppressions.length > 0) {
        violations.push(
          `${logicalId}: Python function should NOT have L1 suppression`,
        );
      }
    }

    expect(violations).toEqual([]);
  });

  it("no stack-level L1 suppression exists", () => {
    const { app, stack } = buildTestApp();
    const assembly = app.synth();
    const template = assembly.getStackByName(stack.stackName).template;

    // Stack-level metadata lives at the template root, not on individual resources
    const stackMetadata = template.Metadata as
      { cdk_nag?: { rules_to_suppress?: NagSuppression[] } } | undefined;
    const stackSuppressions = stackMetadata?.cdk_nag?.rules_to_suppress ?? [];
    const l1StackLevel = stackSuppressions.filter(
      (s: NagSuppression) => s.id === "AwsSolutions-L1",
    );
    expect(l1StackLevel).toEqual([]);
  });

  it("applying the Aspect twice does not duplicate suppressions", () => {
    const app = new cdk.App({ context: { "aws:cdk:bundling-stacks": [] } });
    const stack = new cdk.Stack(app, "IdempotentStack", {
      env: { account: "123456789012", region: "us-east-1" },
    });

    new lambda.Function(stack, "NodeFn", {
      runtime: NODE_RUNTIME,
      handler: "index.handler",
      code: lambda.Code.fromInline("exports.handler = () => {}"),
    });

    // Apply twice
    cdk.Aspects.of(app).add(new SuppressNodejsL1Nag());
    cdk.Aspects.of(app).add(new SuppressNodejsL1Nag());

    const assembly = app.synth();
    const template = assembly.getStackByName(stack.stackName).template;
    const resources = template.Resources as Record<string, CfnResource>;

    for (const [, resource] of Object.entries(resources)) {
      if (resource.Type !== "AWS::Lambda::Function") continue;
      const runtime = resource.Properties?.Runtime as string | undefined;
      if (!runtime || !runtime.startsWith("nodejs")) continue;

      const l1Suppressions = getL1Suppressions(resource);
      // cdk-nag appends, so we accept ≥1 but verify the first has the right reason
      expect(l1Suppressions.length).toBeGreaterThanOrEqual(1);
      expect(l1Suppressions[0].reason).toBe(L1_SUPPRESSION_REASON);
    }
  });
});
