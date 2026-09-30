/**
 * backend-stack-user-org-membership-table.test.ts — decision 00d40a31
 * (option A): the caller's organization is minted server-side by the
 * pre-token-generation trigger from a DynamoDB membership store, never
 * from the client-writable `custom:organization` user attribute.
 *
 * Pins the CDK wiring that makes that possible:
 *   - `UserOrgMembershipTable` (`citadel-user-org-membership-${env}`),
 *     pk `sub` (S), PAY_PER_REQUEST, PITR, DESTROY removal policy —
 *     matching the sibling OrganisationTable;
 *   - GSI `orgName-index` (pk `orgName`) used by deleteOrganization's
 *     membership sweep;
 *   - env `USER_ORG_MEMBERSHIP_TABLE` on the pre-token Lambda (read only),
 *     the user-management resolver (read/write) and the organization
 *     resolver (read/write, for delete cleanup);
 *   - the pre-token Lambda's role must NOT carry any write action on the
 *     table — the trigger only reads.
 *
 * Style mirrors backend-stack-environment-release-pointer-table.test.ts:
 * synth a real BackendStack and assert via Template.fromStack(...).
 */
import * as cdk from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import * as path from "path";
import * as fs from "fs";

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

const TABLE_NAME = "citadel-user-org-membership-test";

type CfnResource = {
  Type?: string;
  Properties?: Record<string, any>;
};

describe("BackendStack — UserOrgMembershipTable (decision 00d40a31)", () => {
  let template: Template;
  let tableLogicalId: string;

  beforeAll(() => {
    const app = new cdk.App();
    const stack = new BackendStack(app, "TestBackendStackUserOrgMembership", {
      environment: "test",
      env: { account: "123456789012", region: "us-east-1" },
    });
    template = Template.fromStack(stack);

    const tables = template.findResources("AWS::DynamoDB::Table", {
      Properties: { TableName: TABLE_NAME },
    });
    tableLogicalId = Object.keys(tables)[0] ?? "";
  });

  test("table exists with pk `sub` (S), PAY_PER_REQUEST, PITR and DESTROY policy (matches OrganisationTable)", () => {
    template.hasResource("AWS::DynamoDB::Table", {
      Properties: Match.objectLike({
        TableName: TABLE_NAME,
        BillingMode: "PAY_PER_REQUEST",
        KeySchema: [{ AttributeName: "sub", KeyType: "HASH" }],
        AttributeDefinitions: Match.arrayWith([
          { AttributeName: "sub", AttributeType: "S" },
        ]),
        PointInTimeRecoverySpecification: {
          PointInTimeRecoveryEnabled: true,
        },
      }),
      DeletionPolicy: "Delete",
      UpdateReplacePolicy: "Delete",
    });
    expect(tableLogicalId).toMatch(/^UserOrgMembershipTable/);
  });

  test("has GSI orgName-index keyed on orgName (S)", () => {
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      TableName: TABLE_NAME,
      AttributeDefinitions: Match.arrayWith([
        { AttributeName: "orgName", AttributeType: "S" },
      ]),
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({
          IndexName: "orgName-index",
          KeySchema: [{ AttributeName: "orgName", KeyType: "HASH" }],
        }),
      ]),
    });
  });

  function lambdaByHandler(handler: string): [string, CfnResource] {
    const fns = template.findResources("AWS::Lambda::Function", {
      Properties: { Handler: handler },
    });
    const entries = Object.entries(fns);
    expect(entries).toHaveLength(1);
    return entries[0] as [string, CfnResource];
  }

  function envRefsTable(fn: CfnResource) {
    const env = fn.Properties?.Environment?.Variables ?? {};
    expect(env.USER_ORG_MEMBERSHIP_TABLE).toEqual({ Ref: tableLogicalId });
  }

  /** Collect all IAM actions granted on the table (or its indexes) to a role. */
  function actionsOnTableForFunction(fnLogicalId: string): Set<string> {
    const fn = template.findResources("AWS::Lambda::Function")[fnLogicalId];
    const roleRef = fn.Properties?.Role?.["Fn::GetAtt"]?.[0];
    expect(typeof roleRef).toBe("string");

    const actions = new Set<string>();
    const policies = template.findResources("AWS::IAM::Policy");
    for (const policy of Object.values(policies) as CfnResource[]) {
      const roles: Array<{ Ref?: string }> = policy.Properties?.Roles ?? [];
      if (!roles.some((r) => r.Ref === roleRef)) continue;
      const stmts = policy.Properties?.PolicyDocument?.Statement ?? [];
      for (const stmt of stmts) {
        const resources = Array.isArray(stmt.Resource)
          ? stmt.Resource
          : [stmt.Resource];
        const targetsTable = resources.some((r: unknown) =>
          JSON.stringify(r).includes(tableLogicalId),
        );
        if (!targetsTable || stmt.Effect !== "Allow") continue;
        const acts = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action];
        for (const a of acts) actions.add(a);
      }
    }
    return actions;
  }

  describe("pre-token-generation Lambda (read only)", () => {
    test("receives USER_ORG_MEMBERSHIP_TABLE env var", () => {
      const [, fn] = lambdaByHandler("pre-token-generation.handler");
      envRefsTable(fn);
    });

    test("is granted GetItem on the table and NO write actions", () => {
      const [id] = lambdaByHandler("pre-token-generation.handler");
      const actions = actionsOnTableForFunction(id);
      expect(actions).toContain("dynamodb:GetItem");
      for (const forbidden of [
        "dynamodb:PutItem",
        "dynamodb:UpdateItem",
        "dynamodb:DeleteItem",
        "dynamodb:BatchWriteItem",
      ]) {
        expect(actions).not.toContain(forbidden);
      }
    });
  });

  describe("user-management resolver (read/write)", () => {
    test("receives USER_ORG_MEMBERSHIP_TABLE env var", () => {
      const [, fn] = lambdaByHandler("user-management-resolver.handler");
      envRefsTable(fn);
    });

    test("is granted PutItem and GetItem on the table", () => {
      const [id] = lambdaByHandler("user-management-resolver.handler");
      const actions = actionsOnTableForFunction(id);
      expect(actions).toContain("dynamodb:PutItem");
      expect(actions).toContain("dynamodb:GetItem");
    });
  });

  describe("organization resolver (read/write for delete cleanup)", () => {
    test("receives USER_ORG_MEMBERSHIP_TABLE env var", () => {
      const [, fn] = lambdaByHandler("organization-resolver.handler");
      envRefsTable(fn);
    });

    test("is granted Query and BatchWriteItem/DeleteItem on the table (and its index)", () => {
      const [id] = lambdaByHandler("organization-resolver.handler");
      const actions = actionsOnTableForFunction(id);
      expect(actions).toContain("dynamodb:Query");
      expect(actions).toContain("dynamodb:BatchWriteItem");
      expect(actions).toContain("dynamodb:DeleteItem");
    });
  });
});
