/**
 * cdk-nag — AwsSolutions-COG2 documented suppressions.
 *
 * The two Cognito User Pools in this project deliberately leave MFA off
 * the platform default:
 *
 *   - backend UserPool   — `mfa: cognito.Mfa.OPTIONAL` so customers can
 *                           enforce mandatory MFA per their own deployment
 *                           requirements rather than at platform default.
 *   - GatewayUserPool    — machine-to-machine (client_credentials) only;
 *                           MFA is inapplicable to a non-human OAuth issuer.
 *
 * These tests assert that:
 *   1. The synthesized template carries the documented `cdk_nag.rules_to_suppress`
 *      metadata block on each pool's `AWS::Cognito::UserPool` resource with
 *      `id: AwsSolutions-COG2` and a non-empty rationale that references the
 *      customer-deployment / M2M context.
 *   2. With `AwsSolutionsChecks` aspect applied, no AwsSolutions-COG2 error
 *      annotation remains on the UserPool/Resource path for either pool.
 */

import * as cdk from "aws-cdk-lib";
import { Annotations, Match, Template } from "aws-cdk-lib/assertions";
import * as events from "aws-cdk-lib/aws-events";
import * as s3 from "aws-cdk-lib/aws-s3";
import { AwsSolutionsChecks } from "cdk-nag";
import {
  scaffoldBackendAssetDirs,
  scaffoldServiceDockerfiles,
} from "./helpers/scaffold-stub-assets";

// Ensure asset directories exist for CDK synthesis (mirror existing test setup).
scaffoldBackendAssetDirs([
  "src/schema",
  "dist/lambda",
  "src/lambda/seed-admin-user",
  "src/lambda/seed-organizations",
  "src/lambda/cognito-secret-handler",
]);
scaffoldServiceDockerfiles();

import { BackendStack } from "../lib/backend-stack";
import { ServicesStack } from "../lib/services-stack";

interface SuppressionEntry {
  id: string;
  reason: string;
}

function findCog2Suppression(
  template: Template,
  userPoolName: string,
): SuppressionEntry | undefined {
  const pools = template.findResources("AWS::Cognito::UserPool", {
    Properties: { UserPoolName: userPoolName },
  });
  const ids = Object.keys(pools);
  if (ids.length !== 1) {
    throw new Error(
      `Expected exactly 1 UserPool with UserPoolName=${userPoolName}, found ${ids.length}`,
    );
  }
  const rules: SuppressionEntry[] =
    pools[ids[0]].Metadata?.cdk_nag?.rules_to_suppress ?? [];
  return rules.find((r) => r.id === "AwsSolutions-COG2");
}

describe("cdk-nag — AwsSolutions-COG2 documented suppressions", () => {
  // ---------------------------------------------------------------------------
  // backend UserPool (citadel-backend-${env}/UserPool/Resource)
  // ---------------------------------------------------------------------------

  describe("backend UserPool", () => {
    let backendStack: BackendStack;
    let backendTemplate: Template;

    beforeAll(() => {
      const app = new cdk.App();
      backendStack = new BackendStack(app, "citadel-backend-test", {
        environment: "test",
        env: { account: "123456789012", region: "us-east-1" },
      });
      // Apply the AwsSolutions pack so any un-suppressed COG2 finding would
      // surface as an error annotation on the UserPool/Resource path.
      cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: false }));
      backendTemplate = Template.fromStack(backendStack);
    });

    it("carries an AwsSolutions-COG2 suppression with a customer-deployment rationale", () => {
      const cog2 = findCog2Suppression(backendTemplate, "citadel-users-test");
      expect(cog2).toBeDefined();
      expect(cog2!.reason).toMatch(/customer.*deployment|MFA.*OPTIONAL/i);
      // Reason must be substantive, not a one-liner placeholder.
      expect(cog2!.reason.length).toBeGreaterThanOrEqual(80);
    });

    it("suppresses AwsSolutions-COG2 on UserPool with documented rationale", () => {
      const annotations = Annotations.fromStack(backendStack);
      // Confirm no AwsSolutions-COG2 errors remain on the UserPool path.
      annotations.hasNoError(
        "citadel-backend-test/UserPool/Resource",
        Match.stringLikeRegexp("AwsSolutions-COG2"),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // GatewayUserPool (citadel-services-${env}/GatewayUserPool/Resource)
  // ---------------------------------------------------------------------------

  describe("GatewayUserPool (M2M)", () => {
    let servicesStack: ServicesStack;
    let servicesTemplate: Template;

    beforeAll(() => {
      const app = new cdk.App();
      const prereq = new cdk.Stack(app, "PrereqStack", {
        env: { account: "123456789012", region: "us-east-1" },
      });
      const agentEventBus = new events.EventBus(prereq, "TestEventBus", {
        eventBusName: "test-bus",
      });
      const documentBucket = new s3.Bucket(prereq, "TestDocBucket");

      servicesStack = new ServicesStack(app, "citadel-services-test", {
        environment: "test",
        agentEventBus,
        documentBucket,
        env: { account: "123456789012", region: "us-east-1" },
      });
      cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: false }));
      servicesTemplate = Template.fromStack(servicesStack);
    });

    it("carries an AwsSolutions-COG2 suppression with an M2M rationale", () => {
      const cog2 = findCog2Suppression(
        servicesTemplate,
        "citadel-gateway-test",
      );
      expect(cog2).toBeDefined();
      expect(cog2!.reason).toMatch(
        /machine-to-machine|client_credentials|M2M/i,
      );
      expect(cog2!.reason.length).toBeGreaterThanOrEqual(80);
    });

    it("suppresses AwsSolutions-COG2 on GatewayUserPool with documented rationale", () => {
      const annotations = Annotations.fromStack(servicesStack);
      annotations.hasNoError(
        "citadel-services-test/GatewayUserPool/Resource",
        Match.stringLikeRegexp("AwsSolutions-COG2"),
      );
    });
  });
});
