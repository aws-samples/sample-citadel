/**
 * backend-stack-user-mgmt-global-signout-iam.test.ts — Wave-3B design item 2
 * CDK assertion: the user-management-resolver's Cognito IAM policy must
 * include cognito-idp:AdminUserGlobalSignOut, scoped to this.userPool's
 * ARN (no wildcard resource), alongside the pre-existing actions.
 */
import * as cdk from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import * as path from "path";
import * as fs from "fs";

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

describe("BackendStack — user-management-resolver Cognito IAM policy includes AdminUserGlobalSignOut", () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const stack = new BackendStack(app, "TestBackendStackGlobalSignoutIam", {
      environment: "test",
      env: { account: "123456789012", region: "us-east-1" },
    });
    template = Template.fromStack(stack);
  });

  test("includes cognito-idp:AdminUserGlobalSignOut scoped to the user pool ARN", () => {
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: "Allow",
            Action: Match.arrayWith(["cognito-idp:AdminUserGlobalSignOut"]),
            Resource: Match.objectLike({
              "Fn::GetAtt": Match.arrayWith(["Arn"]),
            }),
          }),
        ]),
      },
    });
  });

  test("the same statement still carries every pre-existing action (additive, not a replacement)", () => {
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: "Allow",
            Action: Match.arrayWith([
              "cognito-idp:ListUsers",
              "cognito-idp:AdminGetUser",
              "cognito-idp:AdminCreateUser",
              "cognito-idp:AdminAddUserToGroup",
              "cognito-idp:AdminRemoveUserFromGroup",
              "cognito-idp:AdminUpdateUserAttributes",
              "cognito-idp:AdminListGroupsForUser",
              "cognito-idp:ListGroups",
              "cognito-idp:AdminSetUserPassword",
              "cognito-idp:AdminUserGlobalSignOut",
            ]),
          }),
        ]),
      },
    });
  });

  test("no wildcard resource was introduced for this action (still scoped to a single ARN, not '*')", () => {
    const policies = template.findResources("AWS::IAM::Policy");
    let found = false;
    for (const key of Object.keys(policies)) {
      const statements =
        policies[key].Properties?.PolicyDocument?.Statement ?? [];
      for (const stmt of statements) {
        const actions = Array.isArray(stmt.Action)
          ? stmt.Action
          : [stmt.Action];
        if (actions.includes("cognito-idp:AdminUserGlobalSignOut")) {
          found = true;
          const resources = Array.isArray(stmt.Resource)
            ? stmt.Resource
            : [stmt.Resource];
          for (const r of resources) {
            expect(r).not.toBe("*");
          }
        }
      }
    }
    expect(found).toBe(true);
  });
});
