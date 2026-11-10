/**
 * CIT-298: Verify the datastore-resolver Lambda has s3:GetBucketTagging
 * granted on citadel-* buckets for preflight ownership verification.
 */
import * as fs from "fs";
import * as path from "path";

describe("CIT-298 — backend-stack S3 preflight grant", () => {
  let template: Record<string, unknown>;

  beforeAll(() => {
    const templatePath = path.join(
      __dirname,
      "..",
      "cdk.out",
      "citadel-backend-dev.template.json",
    );
    template = JSON.parse(fs.readFileSync(templatePath, "utf-8"));
  });

  it("datastore-resolver role has s3:GetBucketTagging on citadel-* buckets", () => {
    const resources = template.Resources as Record<
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
    const resources_list = Array.isArray(s3TaggingStmt!.Resource)
      ? s3TaggingStmt!.Resource
      : [s3TaggingStmt!.Resource];
    const hasCitadelScope = resources_list.some((r) => {
      if (typeof r === "string") return r.includes("citadel-*");
      // Handle Fn::Join or other intrinsic functions
      const joined = JSON.stringify(r);
      return joined.includes("citadel-*");
    });
    expect(hasCitadelScope).toBe(true);
  });
});
