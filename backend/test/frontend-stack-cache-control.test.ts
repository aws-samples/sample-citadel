/**
 * CIT-307: Frontend cache-control — two-deployment split + lifecycle rule.
 *
 * Verifies:
 * 1. Two Custom::CDKBucketDeployment resources exist (assets vs index)
 * 2. Hashed assets get `public, max-age=31536000, immutable`
 * 3. Index/non-hashed files get `no-cache, no-store, must-revalidate`
 * 4. Both deployments have Prune: false
 * 5. Assets deployment is a dependency of the index deployment
 * 6. S3 lifecycle rule expires `assets/` objects after 30 days
 */
import * as cdk from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import * as appsync from "aws-cdk-lib/aws-appsync";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as events from "aws-cdk-lib/aws-events";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";

// backend/ root — used for schema path below
const backendDir = path.resolve(__dirname, "..");

// Create a minimal frontend build directory for BucketDeployment source
const tmpBuildDir = fs.mkdtempSync(path.join(os.tmpdir(), "fe-build-"));
fs.mkdirSync(path.join(tmpBuildDir, "assets"), { recursive: true });
fs.writeFileSync(path.join(tmpBuildDir, "index.html"), "<html></html>");
fs.writeFileSync(
  path.join(tmpBuildDir, "assets", "index-abc123.js"),
  "// chunk",
);

import { FrontendStack } from "../lib/frontend-stack";

function synthFrontendStack(): Template {
  const app = new cdk.App();

  // Minimal stub stacks for FrontendStack dependencies
  const env = { account: "123456789012", region: "us-east-1" };
  const stubStack = new cdk.Stack(app, "StubStack", { env });

  const userPool = new cognito.UserPool(stubStack, "TestUserPool");
  const api = new appsync.GraphqlApi(stubStack, "TestApi", {
    name: "TestApi",
    definition: appsync.Definition.fromSchema(
      appsync.SchemaFile.fromAsset(
        path.join(backendDir, "src/schema/schema.graphql"),
      ),
    ),
  });
  const eventBus = new events.EventBus(stubStack, "TestBus");

  process.env.FRONTEND_BUILD_PATH = tmpBuildDir;
  process.env.CITADEL_SKIP_BUNDLING = "1";

  const stack = new FrontendStack(app, "TestFrontendStack", {
    env,
    appSyncApi: api,
    userPool,
    agentEventBus: eventBus,
    environment: "test",
    costApiUrl: "https://cost.example.com",
  });

  return Template.fromStack(stack);
}

describe("FrontendStack — CIT-307 cache-control split deployment", () => {
  let template: Template;

  beforeAll(() => {
    template = synthFrontendStack();
  });

  afterAll(() => {
    delete process.env.FRONTEND_BUILD_PATH;
    fs.rmSync(tmpBuildDir, { recursive: true, force: true });
  });

  test("has exactly two Custom::CDKBucketDeployment resources", () => {
    const deployments = template.findResources("Custom::CDKBucketDeployment");
    expect(Object.keys(deployments)).toHaveLength(2);
  });

  test("hashed assets deployment has immutable cache-control and prune false", () => {
    template.hasResourceProperties("Custom::CDKBucketDeployment", {
      SystemMetadata: Match.objectLike({
        "cache-control": "public, max-age=31536000, immutable",
      }),
      Prune: false,
    });
  });

  test("index deployment has no-cache cache-control and prune false", () => {
    template.hasResourceProperties("Custom::CDKBucketDeployment", {
      SystemMetadata: Match.objectLike({
        "cache-control": "no-cache, no-store, must-revalidate",
      }),
      Prune: false,
    });
  });

  test("assets deployment is a dependency of the index deployment", () => {
    const resources = template.findResources("Custom::CDKBucketDeployment");
    const entries = Object.entries(resources);

    // Find the index deployment (the one with no-cache)
    const indexEntry = entries.find(
      ([, res]) =>
        res.Properties?.SystemMetadata?.["cache-control"] ===
        "no-cache, no-store, must-revalidate",
    );
    expect(indexEntry).toBeDefined();
    const [, indexRes] = indexEntry!;

    // It must have a DependsOn that references the assets deployment
    const assetsEntry = entries.find(
      ([, res]) =>
        res.Properties?.SystemMetadata?.["cache-control"] ===
        "public, max-age=31536000, immutable",
    );
    expect(assetsEntry).toBeDefined();
    const [assetsLogicalId] = assetsEntry!;

    // DependsOn can be a string or array
    const dependsOn: string[] = Array.isArray(indexRes.DependsOn)
      ? indexRes.DependsOn
      : [indexRes.DependsOn].filter(Boolean);

    expect(dependsOn).toEqual(
      expect.arrayContaining([expect.stringContaining(assetsLogicalId)]),
    );
  });

  test("site bucket has a lifecycle rule expiring assets/ after 30 days", () => {
    template.hasResourceProperties("AWS::S3::Bucket", {
      BucketName: Match.stringLikeRegexp("^citadel-frontend-test-"),
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          Match.objectLike({
            Prefix: "assets/",
            ExpirationInDays: 30,
            NoncurrentVersionExpiration: Match.objectLike({
              NoncurrentDays: 30,
            }),
            Status: "Enabled",
          }),
        ]),
      },
    });
  });
});
