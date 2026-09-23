/**
 * Stack test for arbiter-stack.ts — Lambda layer and function description
 * deployment-contract tripwire (CIT-182 class).
 *
 * AWS Lambda enforces a 256-character limit on LayerVersion and Function
 * Description fields. This test ensures all descriptions in the synthesized
 * template remain under that limit to prevent deployment failures.
 *
 * Uses aws-cdk-lib/assertions Template against a synthesized stack in an
 * isolated test App — no real AWS calls.
 */
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as events from "aws-cdk-lib/aws-events";
import { Bucket } from "aws-cdk-lib/aws-s3";
import { ArbiterStack } from "../arbiter-stack";
import {
  scaffoldBackendAssetDirs,
  scaffoldArbiterStubs,
} from "../../test/helpers/scaffold-stub-assets";

scaffoldBackendAssetDirs(["dist/lambda", "src/schema"]);
scaffoldArbiterStubs();

describe("ArbiterStack", () => {
  let app: cdk.App;
  let stack: ArbiterStack;

  beforeEach(() => {
    app = new cdk.App({ context: { "aws:cdk:bundling-stacks": [] } });
    const backendStack = new cdk.Stack(app, "MockBackendStack", {
      env: { account: "123456789012", region: "us-east-1" },
    });

    const agentEventBus = new events.EventBus(backendStack, "AgentEventBus", {
      eventBusName: "citadel-agents-test",
    });

    const agentConfigTable = new dynamodb.Table(
      backendStack,
      "AgentConfigTable",
      {
        tableName: "citadel-agents-test",
        partitionKey: { name: "agentId", type: dynamodb.AttributeType.STRING },
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      },
    );

    const codeBucket = new Bucket(backendStack, "CodeBucket", {
      bucketName: "citadel-code-test",
    });

    const executionSpecificationsTable = new dynamodb.Table(
      backendStack,
      "ExecutionSpecificationsTable",
      {
        tableName: "citadel-execution-specifications-test",
        partitionKey: { name: "specId", type: dynamodb.AttributeType.STRING },
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      },
    );

    stack = new ArbiterStack(app, "ArbiterTestStack", {
      environment: "test",
      env: { account: "123456789012", region: "us-east-1" },
      agentEventBus,
      agentConfigTable,
      codeBucket,
      executionSpecificationsTable,
    });
  });

  it("should keep all Lambda LayerVersion descriptions <= 256 chars", () => {
    const template = Template.fromStack(stack);

    // Query all LayerVersion resources
    template.allResources("AWS::Lambda::LayerVersion", {});

    const layerVersions = (
      template as unknown as {
        toJSON(): { Resources: Record<string, unknown> };
      }
    ).toJSON().Resources;
    const violations: string[] = [];

    for (const [logicalId, resource] of Object.entries(layerVersions)) {
      if (resource && typeof resource === "object") {
        const props = (resource as Record<string, unknown>).Properties;
        if (props && typeof props === "object") {
          const description = (props as Record<string, unknown>).Description;
          if (typeof description === "string") {
            const descLen = description.length;
            if (descLen > 256) {
              violations.push(`${logicalId}: ${descLen} chars (max 256)`);
            }
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("should keep all Lambda Function descriptions <= 256 chars", () => {
    const template = Template.fromStack(stack);

    const allResources = (
      template as unknown as {
        toJSON(): { Resources: Record<string, unknown> };
      }
    ).toJSON().Resources;
    const violations: string[] = [];

    for (const [logicalId, resource] of Object.entries(allResources)) {
      if (resource && typeof resource === "object") {
        const resourceObj = resource as Record<string, unknown>;
        const type = resourceObj.Type;
        if (type === "AWS::Lambda::Function") {
          const props = resourceObj.Properties;
          if (props && typeof props === "object") {
            const description = (props as Record<string, unknown>).Description;
            if (typeof description === "string") {
              const descLen = description.length;
              if (descLen > 256) {
                violations.push(`${logicalId}: ${descLen} chars (max 256)`);
              }
            }
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
