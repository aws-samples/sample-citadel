/**
 * CIT-298: Verify the datastore-resolver Lambda has s3:GetBucketTagging
 * granted on citadel-* buckets for preflight ownership verification.
 *
 * Synthesises BackendStack in-process (same pattern as
 * handler-env-contract.guard.test.ts) so CI never needs a prior `cdk synth`.
 */
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import * as fs from "fs";
import * as path from "path";
import { scaffoldBackendAssetDirs } from "./helpers/scaffold-stub-assets";

scaffoldBackendAssetDirs(["dist/lambda", "src/schema"]);

// BackendStack references asset paths outside backend/ — stub them so synth
// succeeds in CI without a full build.
const EXTRA_ASSET_DIRS = [
  path.resolve(__dirname, "../../src/lambda/seed-organizations"),
  path.resolve(__dirname, "../src/lambda/seed-admin-user"),
  path.resolve(__dirname, "../src/lambda/seed-organizations"),
];
for (const dir of EXTRA_ASSET_DIRS) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

import { BackendStack } from "../lib/backend-stack";

jest.setTimeout(60000);

function synthBackendStack(): Template {
  const app = new cdk.App();
  const stack = new BackendStack(app, "S3PreflightGrantStack", {
    environment: "test",
    env: { account: "123456789012", region: "us-east-1" },
  });
  return Template.fromStack(stack);
}

describe("CIT-298 — backend-stack S3 preflight grant", () => {
  let template: Template;

  beforeAll(() => {
    template = synthBackendStack();
  });

  it("datastore-resolver role has s3:GetBucketTagging on citadel-* buckets", () => {
    const resources = template.toJSON().Resources as Record<
      string,
      { Type: string; Properties?: Record<string, unknown> }
    >;

    // Find all IAM policies attached to the datastore-resolver role
    const policyStatements: Array<{
      Effect: string;
      Action: string | string[];
      Resource: string | string[];
    }> = [];

    for (const [, resource] of Object.entries(resources)) {
      if (resource.Type !== "AWS::IAM::Policy") continue;
      const doc = resource.Properties?.PolicyDocument as {
        Statement?: Array<{
          Effect: string;
          Action: string | string[];
          Resource: unknown;
        }>;
      };
      if (!doc?.Statement) continue;

      // Check if this policy is attached to a role whose logical ID
      // references the DataStoreResolverFunction
      const roles = resource.Properties?.Roles as Array<{ Ref?: string }>;
      const isDataStorePolicy = roles?.some(
        (r) =>
          r.Ref &&
          (r.Ref.includes("DataStoreResolver") ||
            r.Ref.includes("DatastoreResolver") ||
            r.Ref.includes("datastoreresolver")),
      );
      if (!isDataStorePolicy) continue;

      for (const stmt of doc.Statement) {
        policyStatements.push({
          Effect: stmt.Effect,
          Action: stmt.Action,
          Resource: stmt.Resource as string | string[],
        });
      }
    }

    // Find the statement with s3:GetBucketTagging
    const s3TaggingStmt = policyStatements.find((stmt) => {
      const actions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action];
      return actions.includes("s3:GetBucketTagging");
    });

    expect(s3TaggingStmt).toBeDefined();
    expect(s3TaggingStmt!.Effect).toBe("Allow");

    // Verify resource is scoped to citadel-* buckets
    const resourcesList = Array.isArray(s3TaggingStmt!.Resource)
      ? s3TaggingStmt!.Resource
      : [s3TaggingStmt!.Resource];
    const hasCitadelScope = resourcesList.some((r) => {
      if (typeof r === "string") return r.includes("citadel-*");
      // Handle Fn::Join or other intrinsic functions
      const joined = JSON.stringify(r);
      return joined.includes("citadel-*");
    });
    expect(hasCitadelScope).toBe(true);
  });
});
