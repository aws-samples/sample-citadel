/**
 * Tracing foundation — orchestrator scope amendment coverage check.
 *
 * The architect design (task 5459301e-1e7b-4bfd-bccb-b106aba2748c) proposed
 * the EnableLambdaTracing Aspect for backend + arbiter only. The
 * orchestrator's binding scope amendment requires it on EVERY Lambda-bearing
 * stack — backend, projects, registry, arbiter, telemetry, governance,
 * services, gateway — because the acceptance path's chat resolvers live in
 * citadel-projects post-split. FrontendStack is intentionally excluded (see
 * bin/app.ts comment): its one Lambda already sets Tracing.ACTIVE directly
 * and isn't on any traced request path.
 *
 * This test is the single place that enumerates "every Lambda-bearing
 * stack" so a future stack addition that's Lambda-bearing but forgotten in
 * the Aspect loop fails loudly here, rather than only showing up as a gap
 * in coverage nobody is asserting on.
 */
import * as fs from "fs";
import * as path from "path";

const ENV = process.env.SPLIT_GATES_ENV ?? "dev";

const CDK_OUT = path.resolve(__dirname, "..", "cdk.out");

// Every stack the orchestrator amendment requires EnableLambdaTracing on.
const IN_SCOPE_STACKS = [
  "backend",
  "projects",
  "registry",
  "arbiter",
  "telemetry",
  "governance",
  "services",
  "gateway",
];

// Frontend is explicitly OUT of scope (see bin/app.ts comment above the
// Aspect loop) — asserted separately below as a negative control so a
// future accidental inclusion is visible either way.
const OUT_OF_SCOPE_STACK = "frontend";

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

function loadTemplate(stackShortName: string): any | null {
  const templatePath = path.join(
    CDK_OUT,
    `citadel-${stackShortName}-${ENV}.template.json`,
  );
  if (!fs.existsSync(templatePath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(templatePath, "utf-8"));
}

const allTemplatesPresent = IN_SCOPE_STACKS.every(
  (s) => loadTemplate(s) !== null,
);

describe("tracing foundation — Aspect stack coverage (orchestrator scope amendment)", () => {
  if (!allTemplatesPresent) {
    const missing = IN_SCOPE_STACKS.filter((s) => loadTemplate(s) === null);
    it.skip(`skipped: fresh templates missing for [${missing.join(", ")}] (run 'npm run build && npx cdk synth' for all stacks first)`, () => {});
    return;
  }

  test.each(IN_SCOPE_STACKS)(
    "citadel-%s-<env> — every application Lambda has TracingConfig Mode=Active",
    (stackShortName) => {
      const template = loadTemplate(stackShortName);
      const lambdaEntries = Object.entries(template.Resources).filter(
        ([id, r]: [string, any]) =>
          r.Type === "AWS::Lambda::Function" && !isFrameworkLambda(id),
      ) as Array<[string, any]>;

      // A stack with zero application Lambdas would make this assertion
      // vacuously true and mask a wiring mistake (e.g. Aspect never
      // applied because the stack object reference was wrong) — require
      // at least one Lambda so the loop is a meaningful check.
      expect(lambdaEntries.length).toBeGreaterThan(0);

      for (const [, resource] of lambdaEntries) {
        expect(resource.Properties?.TracingConfig).toEqual({ Mode: "Active" });
      }
    },
  );

  test(`citadel-${OUT_OF_SCOPE_STACK}-<env> is NOT covered by the Aspect (only its pre-existing direct Tracing.ACTIVE Lambda is traced)`, () => {
    const template = loadTemplate(OUT_OF_SCOPE_STACK);
    if (template === null) {
      return; // frontend synth is not required for this suite to be meaningful
    }
    const allLambdaEntries = Object.entries(template.Resources).filter(
      ([, r]: [string, any]) => r.Type === "AWS::Lambda::Function",
    ) as Array<[string, any]>;
    const appLambdaEntries = allLambdaEntries.filter(
      ([id]) => !isFrameworkLambda(id),
    );

    // FrontendStack has exactly one application Lambda
    // (UpdateEmailTemplatesFunction), which sets Tracing.ACTIVE directly in
    // frontend-stack.ts — NOT via the EnableLambdaTracing Aspect (frontend
    // is excluded from the Aspect loop in bin/app.ts). Assert on the
    // *fraction of the whole stack* (including framework Lambdas, which
    // the Aspect also never touches) to distinguish "traced because the
    // Aspect ran here" from "traced because of a pre-existing direct
    // Tracing.ACTIVE unrelated to this Aspect."
    const tracedCount = allLambdaEntries.filter(
      ([, r]: [string, any]) => r.Properties?.TracingConfig?.Mode === "Active",
    ).length;

    expect(appLambdaEntries.length).toBe(1);
    expect(tracedCount).toBe(1);
    expect(tracedCount).toBeLessThan(allLambdaEntries.length);
  });
});
