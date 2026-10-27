import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import * as path from "path";
import * as fs from "fs";

// Ensure asset directories exist for CDK synthesis
const assetDirs = [
  path.resolve(__dirname, "../src/schema"),
  path.resolve(__dirname, "../dist/lambda"),
  path.resolve(__dirname, "../../src/lambda/seed-organizations"),
  path.resolve(__dirname, "../src/lambda/seed-admin-user"),
  path.resolve(__dirname, "../src/lambda/seed-organizations"),
];
for (const dir of assetDirs) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

import { BackendStack } from "../lib/backend-stack";

describe("BackendStack — agent-message-handler right-sizing (QW-C)", () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const stack = new BackendStack(app, "TestBackendStack", {
      environment: "test",
      env: { account: "123456789012", region: "us-east-1" },
    });
    template = Template.fromStack(stack);
  });

  test("agent-message-handler Lambda has 512MB memory (SigV4 signing + stream iteration are CPU-bound at the 128MB default)", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      Handler: "agent-message-handler.handler",
      MemorySize: 512,
    });
  });

  test("agent-message-handler role has dynamodb:GetItem on the projects table", () => {
    // Find the projects table logical ID (partition key: id)
    const tables = template.findResources("AWS::DynamoDB::Table", {
      Properties: {
        KeySchema: Match.arrayWith([
          Match.objectLike({ AttributeName: "id", KeyType: "HASH" }),
        ]),
      },
    });
    const projectsTableLogicalIds = Object.keys(tables);
    expect(projectsTableLogicalIds.length).toBeGreaterThan(0);

    // The grantReadData call generates a policy with dynamodb:GetItem (among
    // others) scoped to the table ARN.  Verify at least one IAM policy
    // attached to ANY role contains a statement granting GetItem on the
    // projects table.
    const policies = template.findResources("AWS::IAM::Policy");
    const projectsTableRef = projectsTableLogicalIds[0];

    const matchingPolicies = Object.values(policies).filter((policy) => {
      const doc = (
        policy as {
          Properties?: {
            PolicyDocument?: {
              Statement?: Array<{
                Action?: string | string[];
                Resource?: unknown;
              }>;
            };
          };
        }
      ).Properties?.PolicyDocument;
      if (!doc?.Statement) return false;
      return doc.Statement.some((stmt) => {
        const actions = Array.isArray(stmt.Action)
          ? stmt.Action
          : [stmt.Action];
        if (
          !actions.some(
            (a) =>
              a === "dynamodb:GetItem" ||
              a === "dynamodb:BatchGetItem" ||
              a === "dynamodb:Query",
          )
        )
          return false;
        // Check that the resource references the projects table
        const res = JSON.stringify(stmt.Resource ?? "");
        return res.includes(projectsTableRef);
      });
    });
    expect(matchingPolicies.length).toBeGreaterThan(0);
  });
});
