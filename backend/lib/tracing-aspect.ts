import * as cdk from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as iam from "aws-cdk-lib/aws-iam";
import { NagSuppressions } from "cdk-nag";
import { IConstruct } from "constructs";

/**
 * EnableLambdaTracing — CDK Aspect that turns on AWS X-Ray active tracing
 * for every user-owned Lambda function it visits.
 *
 * Tracing foundation design (architect task 5459301e-1e7b-4bfd-bccb-b106aba2748c,
 * level 2 §1(a)/(b) and §6 item 4), scope amended by the orchestrator to apply
 * across ALL Lambda-bearing stacks (backend, projects, registry, arbiter,
 * telemetry, governance, services, gateway) rather than just backend+arbiter.
 *
 * Ground-truth correction vs. the architect design: the design's claim of
 * "no Lambda traced today" (pattern_search for `tracing:` → 0 hits) was
 * INCORRECT. Three pre-existing, independent mechanisms already exist:
 *   - `backend-stack.ts` and `arbiter-stack.ts` each have an "O-03" forEach
 *     over `this.node.findAll()` that sets `TracingConfig: {Mode: 'Active'}`
 *     via `addPropertyOverride` on every Lambda — but WITHOUT attaching
 *     `AWSXRayDaemonWriteAccess`, so traces are silently denied at runtime
 *     (exactly the failure mode design §6 item 4 warns about: "property
 *     override alone without the managed policy = traces silently denied").
 *   - `services-stack.ts` sets `tracing: lambda.Tracing.ACTIVE` directly
 *     (CDK-native, which DOES auto-attach the managed policy) on 7 of its
 *     Lambdas, but not all of them.
 *   - `frontend-stack.ts` sets it directly on its one Lambda.
 * This Aspect is therefore NOT purely additive for backend/arbiter — for
 * those two stacks it is idempotent on `TracingConfig` (already Active) and
 * is the FIX for the missing-managed-policy gap. For every other stack
 * (projects, registry, telemetry, governance, gateway, and services'
 * untouched functions) it is the sole source of tracing.
 *
 * For each visited `lambda.CfnFunction` (the L1 escape hatch under every L2
 * `lambda.Function` / `PythonFunction` / `DockerImageFunction`):
 *   1. Sets `TracingConfig.Mode = 'Active'`.
 *   2. Attaches the AWS-managed `AWSXRayDaemonWriteAccess` policy to the
 *      function's execution role (grants xray:PutTraceSegments,
 *      xray:PutTelemetryRecords, xray:GetSamplingRules, xray:GetSamplingTargets).
 *      `Tracing.ACTIVE` set via the L2 API would attach this automatically,
 *      but the Aspect visits the L1 `CfnFunction` directly (uniform across
 *      L2/L3 constructs including `PythonFunction`/`DockerImageFunction`),
 *      so the managed-policy attachment is done explicitly here — both steps
 *      are required; the property alone leaves traces silently denied.
 *   3. Adds a centralized `AwsSolutions-IAM4` cdk-nag suppression on the
 *      function's role for that managed policy (mirrors the wording already
 *      used in governance-stack.ts for other AWS-managed-policy attachments).
 *
 * Skips CDK-framework-owned Lambdas (Custom Resource providers, log
 * retention, bucket notification handlers, etc.) — these are not
 * `lambda.Function`/`PythonFunction`/`DockerImageFunction` app constructs and
 * their tracing/IAM posture is upstream-managed, not application code.
 */
export class EnableLambdaTracing implements cdk.IAspect {
  visit(node: IConstruct): void {
    if (!(node instanceof lambda.Function)) {
      return;
    }

    // Skip CDK/L2-framework-generated Lambdas (Custom Resource providers,
    // BucketDeployment/BucketNotifications handlers, log retention, etc.).
    // These are constructed by CDK library code, not application code, and
    // their IAM/tracing posture is upstream-managed (see the existing
    // frameworkSuppressions block in bin/app.ts for the same distinction).
    const constructPath = node.node.path;
    if (
      /LogRetention[0-9a-f]{32}/i.test(constructPath) ||
      /BucketNotificationsHandler/.test(constructPath) ||
      /Custom::CDKBucketDeployment/.test(constructPath) ||
      /AWS679f53fac002430cb0da5b7982bd2287/.test(constructPath) ||
      /^.*\/Provider\//.test(constructPath)
    ) {
      return;
    }

    const cfnFunction = node.node.defaultChild as lambda.CfnFunction;
    if (!cfnFunction) {
      return;
    }

    cfnFunction.tracingConfig = { mode: "Active" };

    const role = node.role;
    if (role) {
      role.addManagedPolicy(
        iam.ManagedPolicy.fromAwsManagedPolicyName("AWSXRayDaemonWriteAccess"),
      );

      NagSuppressions.addResourceSuppressions(
        role,
        [
          {
            id: "AwsSolutions-IAM4",
            reason:
              "AWSXRayDaemonWriteAccess is the AWS-managed policy required for active " +
              "X-Ray tracing (PutTraceSegments/PutTelemetryRecords). Attached " +
              "automatically by the EnableLambdaTracing Aspect; scoped to X-Ray write only.",
            appliesTo: [
              "Policy::arn:<AWS::Partition>:iam::aws:policy/AWSXRayDaemonWriteAccess",
            ],
          },
        ],
        true,
      );
    }
  }
}
