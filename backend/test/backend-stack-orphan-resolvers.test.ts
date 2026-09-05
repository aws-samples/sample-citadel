import * as cdk from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import * as path from "path";
import * as fs from "fs";

// Ensure asset directories exist for CDK synthesis
const assetDirs = [
  path.resolve(__dirname, "../src/schema"),
  path.resolve(__dirname, "../dist/lambda"),
  path.resolve(__dirname, "../../src/lambda/seed-organizations"),
  path.resolve(__dirname, "../src/lambda/seed-admin-user"),
];
for (const dir of assetDirs) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

import { BackendStack } from "../lib/backend-stack";

/**
 * Finding 0018a6d7: schema-resolver-parity-guard surfaced 7 fields with
 * tested handlers but no wired AppSync Resolver. This file asserts the two
 * BackendStack-owned fields that WERE wired (mirroring the sibling-field
 * precedent: resumeExecution @ backend-stack.ts:3013), proving each
 * resolver exists on the expected TypeName/FieldName AND is attached to
 * the same datasource as its already-wired sibling on the same handler.
 *
 * The other five fields (updateAgentStatus — see
 * projects-stack.test.ts — plus the four that stay allowlisted:
 * updateProjectProgress, testTool, getDashboardMetrics, getRecentActivity)
 * are covered elsewhere; see schema-resolver-parity-guard.test.ts for the
 * justification comments on the four deliberately-unwired fields.
 */
describe("BackendStack — finding 0018a6d7 orphan resolver wiring", () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const stack = new BackendStack(app, "TestBackendStack", {
      environment: "test",
      env: { account: "123456789012", region: "us-east-1" },
    });
    template = Template.fromStack(stack);
  });

  describe("Query.listAvailableDataSources", () => {
    test("has a wired AppSync Resolver on the DataStore datasource", () => {
      template.hasResourceProperties("AWS::AppSync::Resolver", {
        TypeName: "Query",
        FieldName: "listAvailableDataSources",
        DataSourceName: Match.anyValue(),
      });
    });

    test("is attached to the SAME datasource as its sibling listDataStores", () => {
      const resolvers = template.findResources("AWS::AppSync::Resolver");
      const bySibling = Object.values(resolvers).filter(
        (r: unknown) =>
          (r as { Properties: { FieldName: string } }).Properties.FieldName ===
          "listDataStores",
      );
      const byNew = Object.values(resolvers).filter(
        (r: unknown) =>
          (r as { Properties: { FieldName: string } }).Properties.FieldName ===
          "listAvailableDataSources",
      );
      expect(bySibling).toHaveLength(1);
      expect(byNew).toHaveLength(1);
      expect(
        (byNew[0] as { Properties: { DataSourceName: unknown } }).Properties
          .DataSourceName,
      ).toEqual(
        (bySibling[0] as { Properties: { DataSourceName: unknown } }).Properties
          .DataSourceName,
      );
    });
  });

  describe("Query.listIntegrationOperations", () => {
    test("has a wired AppSync Resolver on the ToolConfig datasource", () => {
      template.hasResourceProperties("AWS::AppSync::Resolver", {
        TypeName: "Query",
        FieldName: "listIntegrationOperations",
        DataSourceName: Match.anyValue(),
      });
    });

    test("is attached to the SAME datasource as its sibling getToolConfig", () => {
      const resolvers = template.findResources("AWS::AppSync::Resolver");
      const bySibling = Object.values(resolvers).filter(
        (r: unknown) =>
          (r as { Properties: { FieldName: string } }).Properties.FieldName ===
          "getToolConfig",
      );
      const byNew = Object.values(resolvers).filter(
        (r: unknown) =>
          (r as { Properties: { FieldName: string } }).Properties.FieldName ===
          "listIntegrationOperations",
      );
      expect(bySibling).toHaveLength(1);
      expect(byNew).toHaveLength(1);
      expect(
        (byNew[0] as { Properties: { DataSourceName: unknown } }).Properties
          .DataSourceName,
      ).toEqual(
        (bySibling[0] as { Properties: { DataSourceName: unknown } }).Properties
          .DataSourceName,
      );
    });
  });
});
