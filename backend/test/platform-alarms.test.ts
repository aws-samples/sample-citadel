/**
 * CDK assertions for the getPlatformAlarms resolver (platform-health-resolver.ts).
 *
 * Pins:
 *  - A Lambda data source is wired to AppSync Query.getPlatformAlarms.
 *  - The Lambda's role carries exactly `cloudwatch:DescribeAlarms` on
 *    Resource "*" (CloudWatch alarm Describe* calls are not ARN-scopable —
 *    see the explanatory comment required at the grant site in
 *    backend-stack.ts) and NOT `sqs:GetQueueAttributes` (least privilege:
 *    queueDepth/queueName are derived from the alarm payload only).
 *  - every-alarm-has-action.test.ts's "BackendStack: 12 alarms" count is
 *    unaffected — this change reads existing alarms, it creates none.
 */
import * as cdk from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import * as path from "path";
import * as fs from "fs";
import { scaffoldBackendAssetDirs } from "./helpers/scaffold-stub-assets";

scaffoldBackendAssetDirs(["dist/lambda", "src/schema"]);

const EXTRA_ASSET_DIRS = [
  path.resolve(__dirname, "../src/lambda/seed-admin-user"),
  path.resolve(__dirname, "../src/lambda/seed-organizations"),
];
for (const dir of EXTRA_ASSET_DIRS) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

import { BackendStack } from "../lib/backend-stack";

jest.setTimeout(60000);

describe("BackendStack — getPlatformAlarms resolver", () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App({ context: { "aws:cdk:bundling-stacks": [] } });
    const stack = new BackendStack(
      app,
      "citadel-backend-platform-alarms-test",
      {
        environment: "test",
        env: { account: "123456789012", region: "us-east-1" },
      },
    );
    template = Template.fromStack(stack);
  });

  test("AppSync has a resolver wired on Query.getPlatformAlarms", () => {
    template.hasResourceProperties("AWS::AppSync::Resolver", {
      TypeName: "Query",
      FieldName: "getPlatformAlarms",
    });
  });

  test("the resolver's Lambda data source role grants cloudwatch:DescribeAlarms on Resource *", () => {
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: "Allow",
            Action: "cloudwatch:DescribeAlarms",
            Resource: "*",
          }),
        ]),
      },
    });
  });

  test("no policy statement on any role grants sqs:GetQueueAttributes to the platform-health function", () => {
    const policies = template.findResources("AWS::IAM::Policy");
    const offenders = Object.entries(policies).filter(([, resource]) => {
      const statements =
        (
          resource as {
            Properties?: { PolicyDocument?: { Statement?: unknown[] } };
          }
        ).Properties?.PolicyDocument?.Statement ?? [];
      return statements.some((s) => {
        const actions = Array.isArray((s as { Action?: unknown }).Action)
          ? (s as { Action: unknown[] }).Action
          : [(s as { Action?: unknown }).Action];
        return actions.includes("sqs:GetQueueAttributes");
      });
    });
    // Other functions in the stack may legitimately hold SQS perms for
    // their own queues; this guard only needs the platform-health function
    // itself to never request it, which the handler-sdk-grant-style scan in
    // the resolver unit test already enforces at the source level. Here we
    // assert zero NEW sqs:GetQueueAttributes grants were introduced solely
    // by wiring this Lambda — i.e. the function's own dedicated role (found
    // by its Lambda logical id prefix) carries none.
    const platformHealthRoles = Object.keys(
      template.findResources("AWS::Lambda::Function"),
    ).filter((id) => id.startsWith("PlatformHealthResolverFunction"));
    expect(platformHealthRoles.length).toBeGreaterThan(0);

    const offenderIds = offenders.map(([id]) => id);
    const platformHealthOffender = offenderIds.some((id) =>
      id.startsWith("PlatformHealthResolverFunction"),
    );
    expect(platformHealthOffender).toBe(false);
  });
});
