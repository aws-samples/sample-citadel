/**
 * Tracing foundation — backend stack assertions (architect task
 * 5459301e-1e7b-4bfd-bccb-b106aba2748c, design §7 test list, orchestrator
 * scope amendment: Aspect applies to ALL Lambda-bearing stacks).
 *
 * Reads the on-disk `cdk.out/citadel-backend-<env>.template.json` produced
 * by a real `cdk synth` (same convention as
 * `test/split-gates-rail2-stateful-pin.test.ts`) rather than reconstructing
 * the stack's heavy cross-stack prop graph in-memory — BackendStack is the
 * root of every other stack's dependency graph, so a faithful assertion
 * needs the actual synthesized template.
 *
 * Run `ENVIRONMENT=dev npx cdk synth citadel-backend-dev` (or
 * `npm run build && npx cdk synth <stack>`) before running this file if
 * `cdk.out/` is stale or missing.
 */
import * as fs from "fs";
import * as path from "path";
import { guardCdkOutInCi } from "./helpers/cdk-out-guard";

const ENV = process.env.SPLIT_GATES_ENV ?? "dev";
const STACK_NAME = `citadel-backend-${ENV}`;
const TEMPLATE_PATH = path.resolve(
  __dirname,
  "..",
  "cdk.out",
  `${STACK_NAME}.template.json`,
);

// CDK-framework-owned Lambdas (Custom Resource providers, log retention,
// etc.) are deliberately excluded by the EnableLambdaTracing Aspect — see
// lib/tracing-aspect.ts's skip list, mirroring bin/app.ts's pre-existing
// frameworkSuppressions distinction. Matched by logical-ID substring.
const FRAMEWORK_LAMBDA_MARKERS = [
  "LogRetention",
  "CustomS3AutoDeleteObjectsCustomResourceProviderHandler",
  "CustomCDKBucketDeployment",
  "BucketNotificationsHandler",
  "AWS679f53fac002430cb0da5b7982bd2287",
];

function isFrameworkLambda(logicalId: string): boolean {
  return FRAMEWORK_LAMBDA_MARKERS.some((marker) => logicalId.includes(marker));
}

const templateExists = fs.existsSync(TEMPLATE_PATH);

describe("tracing foundation — citadel-backend-<env> stack", () => {
  if (!templateExists) {
    guardCdkOutInCi(TEMPLATE_PATH, `npm run build && npx cdk synth ${STACK_NAME}`);
    it.skip(`skipped: fresh template missing at ${TEMPLATE_PATH} (run 'npm run build && npx cdk synth ${STACK_NAME}' first)`, () => {});
    return;
  }

  const template = JSON.parse(fs.readFileSync(TEMPLATE_PATH, "utf-8"));
  const lambdaEntries = Object.entries(template.Resources).filter(
    ([, r]: [string, any]) => r.Type === "AWS::Lambda::Function",
  ) as Array<[string, any]>;
  const appLambdaEntries = lambdaEntries.filter(
    ([id]) => !isFrameworkLambda(id),
  );

  test("at least one application Lambda is present (sanity check on the fixture)", () => {
    expect(appLambdaEntries.length).toBeGreaterThan(0);
  });

  test.each(appLambdaEntries.map(([id, r]) => [id, r]))(
    "%s has TracingConfig Mode=Active",
    (id, resource) => {
      expect(resource.Properties?.TracingConfig).toEqual({ Mode: "Active" });
    },
  );

  test.each(appLambdaEntries.map(([id, r]) => [id, r]))(
    "%s's execution role carries the AWSXRayDaemonWriteAccess managed policy",
    (id, resource) => {
      const roleRef = resource.Properties?.Role;
      expect(roleRef?.["Fn::GetAtt"]).toBeDefined();
      const roleLogicalId = roleRef["Fn::GetAtt"][0];
      const role = template.Resources[roleLogicalId];
      expect(role).toBeDefined();

      const managedPolicyArns: unknown[] =
        role.Properties?.ManagedPolicyArns ?? [];
      const hasXrayPolicy = managedPolicyArns.some((arn) => {
        const serialized = JSON.stringify(arn);
        return serialized.includes("AWSXRayDaemonWriteAccess");
      });
      expect(hasXrayPolicy).toBe(true);
    },
  );

  test("AWS::AppSync::GraphQLApi has XrayEnabled=true (pinned, already-true value)", () => {
    const apiEntries = Object.entries(template.Resources).filter(
      ([, r]: [string, any]) => r.Type === "AWS::AppSync::GraphQLApi",
    ) as Array<[string, any]>;
    expect(apiEntries.length).toBeGreaterThan(0);
    for (const [, resource] of apiEntries) {
      expect(resource.Properties?.XrayEnabled).toBe(true);
    }
  });
});
