/**
 * Finding 82997842: FrontendStack's CfnDistribution set no
 * responseHeadersPolicyId on defaultCacheBehavior or the /api/* behaviour,
 * and no ResponseHeadersPolicy existed under backend/lib, so the SPA (which
 * holds Cognito tokens) was served without HSTS, X-Content-Type-Options,
 * X-Frame-Options or Referrer-Policy.
 *
 * Verifies:
 * 1. A AWS::CloudFront::ResponseHeadersPolicy exists whose
 *    SecurityHeadersConfig sets StrictTransportSecurity (>= 1 year,
 *    IncludeSubdomains, Override), ContentTypeOptions, FrameOptions, and
 *    ReferrerPolicy strict-origin-when-cross-origin.
 * 2. The distribution's DefaultCacheBehavior and every entry in
 *    CacheBehaviors reference that policy via ResponseHeadersPolicyId.
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
const tmpBuildDir = fs.mkdtempSync(path.join(os.tmpdir(), "fe-build-sh-"));
fs.mkdirSync(path.join(tmpBuildDir, "assets"), { recursive: true });
fs.writeFileSync(path.join(tmpBuildDir, "index.html"), "<html></html>");
fs.writeFileSync(
  path.join(tmpBuildDir, "assets", "index-abc123.js"),
  "// chunk",
);

import { FrontendStack } from "../lib/frontend-stack";

function synthFrontendStack(): Template {
  const app = new cdk.App();

  const env = { account: "123456789012", region: "us-east-1" };
  const stubStack = new cdk.Stack(app, "StubStackSH", { env });

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

  const stack = new FrontendStack(app, "TestFrontendStackSH", {
    env,
    appSyncApi: api,
    userPool,
    agentEventBus: eventBus,
    environment: "test",
    costApiUrl: "https://cost.example.com",
  });

  return Template.fromStack(stack);
}

describe("FrontendStack — security response headers policy (finding 82997842)", () => {
  let template: Template;

  beforeAll(() => {
    template = synthFrontendStack();
  });

  afterAll(() => {
    delete process.env.FRONTEND_BUILD_PATH;
    fs.rmSync(tmpBuildDir, { recursive: true, force: true });
  });

  test("a ResponseHeadersPolicy exists with a SecurityHeadersConfig", () => {
    template.hasResourceProperties("AWS::CloudFront::ResponseHeadersPolicy", {
      ResponseHeadersPolicyConfig: Match.objectLike({
        SecurityHeadersConfig: Match.objectLike({
          StrictTransportSecurity: Match.anyValue(),
        }),
      }),
    });
  });

  test("StrictTransportSecurity meets the >=1yr, IncludeSubdomains, Override contract", () => {
    const policies = template.findResources(
      "AWS::CloudFront::ResponseHeadersPolicy",
    );
    const entries = Object.values(policies);
    expect(entries.length).toBeGreaterThan(0);

    const hsts =
      entries[0].Properties?.ResponseHeadersPolicyConfig?.SecurityHeadersConfig
        ?.StrictTransportSecurity;
    expect(hsts).toBeDefined();
    expect(hsts.AccessControlMaxAgeSec).toBeGreaterThanOrEqual(31536000);
    expect(hsts.IncludeSubdomains).toBe(true);
    expect(hsts.Override).toBe(true);
  });

  test("ResponseHeadersPolicy sets ContentTypeOptions, FrameOptions, and ReferrerPolicy", () => {
    const policies = template.findResources(
      "AWS::CloudFront::ResponseHeadersPolicy",
    );
    const entries = Object.values(policies);
    expect(entries.length).toBeGreaterThan(0);

    const securityHeaders =
      entries[0].Properties?.ResponseHeadersPolicyConfig?.SecurityHeadersConfig;

    expect(securityHeaders?.ContentTypeOptions).toBeDefined();
    expect(securityHeaders?.ContentTypeOptions.Override).toBe(true);

    expect(securityHeaders?.FrameOptions).toBeDefined();
    expect(securityHeaders?.FrameOptions.Override).toBe(true);
    expect(["DENY", "SAMEORIGIN"]).toContain(
      securityHeaders?.FrameOptions.FrameOption,
    );

    expect(securityHeaders?.ReferrerPolicy).toBeDefined();
    expect(securityHeaders?.ReferrerPolicy.Override).toBe(true);
    expect(securityHeaders?.ReferrerPolicy.ReferrerPolicy).toBe(
      "strict-origin-when-cross-origin",
    );
  });

  test("DefaultCacheBehavior and every CacheBehaviors entry reference the policy", () => {
    const policies = template.findResources(
      "AWS::CloudFront::ResponseHeadersPolicy",
    );
    const policyLogicalIds = Object.keys(policies);
    expect(policyLogicalIds.length).toBeGreaterThan(0);

    const distributions = template.findResources(
      "AWS::CloudFront::Distribution",
    );
    const distEntries = Object.values(distributions);
    expect(distEntries.length).toBeGreaterThan(0);

    const config = distEntries[0].Properties?.DistributionConfig;
    const defaultBehavior = config?.DefaultCacheBehavior;
    expect(defaultBehavior?.ResponseHeadersPolicyId).toBeDefined();

    const cacheBehaviors: Array<Record<string, unknown>> =
      config?.CacheBehaviors ?? [];
    expect(cacheBehaviors.length).toBeGreaterThan(0);

    for (const behavior of cacheBehaviors) {
      expect(behavior.ResponseHeadersPolicyId).toBeDefined();
    }
  });
});
