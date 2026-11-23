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
 * 2. The distribution's DefaultCacheBehavior references that policy via
 *    ResponseHeadersPolicyId.
 *
 * Finding 68019420 (PR #598 follow-up): adds a report-only Content-Security-
 * Policy built from stack values, and removes the /api/* behaviour +
 * appsync-origin, which were unused — the SPA never proxies AppSync calls
 * through the CloudFront distribution's own origin (it calls the AppSync
 * endpoint directly from the browser via Amplify, see
 * frontend/src/services/server.ts). Origin inventory (file:line evidence):
 *   - AppSync GraphQL + realtime: frontend/src/services/server.ts:6-19
 *     (aws-amplify `generateClient`), frontend/src/config/awsExportsConfig.ts:39
 *     (`aws_appsync_graphqlEndpoint` read from stack-provided aws-exports.json).
 *     Realtime host is the same AppSync domain with `appsync-realtime-api`
 *     substituted for `appsync-api` (Amplify derives this internally).
 *   - Cognito: frontend/src/services/server.ts:6-19 (`aws-amplify/auth`
 *     signIn/signUp/fetchAuthSession call cognito-idp directly), reused by
 *     frontend/src/services/costService.ts:20 and traceService.ts for the
 *     Bearer idToken.
 *   - Cost/trace/replay API: frontend/src/services/costService.ts:1-20,
 *     traceService.ts:117-133, replayService.ts:48-74 — all three ride the
 *     same `costApiUrl` (`aws_cost_api_url`) host, a raw HTTPS API behind a
 *     Cognito JWT authorizer (backend/lib/telemetry-stack.ts:1060 sets
 *     costApiUrl = costHttpApi.apiEndpoint).
 *   - Per-app execute-api endpoints: frontend/src/pages/components/
 *     EndpointUrlDisplay.tsx:27-38, AppDetailView.tsx:1878-2083,
 *     PublishConfirmationScreen.tsx — endpointUrl is only rendered as text
 *     and copied to the clipboard (`navigator.clipboard.writeText`); no
 *     fetch/axios call in frontend/src targets it. DECISION: omit
 *     execute-api from connect-src — there is no browser call to justify it.
 *   - S3 presigned URLs (replay packages): frontend/src/services/
 *     replayService.ts:196-208 — `window.open(url, '_blank')`, a top-level
 *     navigation, not a fetch/XHR, so it is governed by navigation, not
 *     connect-src. No S3 host added to connect-src.
 *   - External fonts: frontend/index.html:11-13 (fonts.googleapis.com,
 *     fonts.gstatic.com) — font-src/style-src.
 *   - blob:: frontend/src/components/WorkflowPersistenceControls.tsx:36 and
 *     WorkflowToolbar.tsx:466 — `URL.createObjectURL` for local
 *     export-to-file downloads, no network origin involved.
 *   - data:: frontend/src/components/ui/banner.tsx:17 and aws-banner.tsx:17
 *     — inline base64 SVG background image — img-src data:.
 *   - Inline styles: Tailwind/Radix components use `style={{...}}` widely
 *     (25 files) — style-src 'unsafe-inline' required.
 *   - Inline scripts: frontend/index.html has none (only `<script type=
 *     "module" src="/src/main.tsx">`) — script-src omits 'unsafe-inline'.
 *   - Iframes: none (confirmed by PR #598 FrameOptions: DENY, still true).
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

  test("DefaultCacheBehavior references the policy, and the distribution has exactly one origin with no /api/* behaviour", () => {
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

    // Finding 68019420: the appsync-origin + /api/* cache behaviour were
    // unused (the SPA calls AppSync directly from the browser via Amplify,
    // not through the distribution) — exactly one origin (S3) and zero
    // CacheBehaviors should remain.
    const origins: Array<Record<string, unknown>> = config?.Origins ?? [];
    expect(origins.length).toBe(1);
    expect(origins[0].Id).toBe("s3-origin");

    const cacheBehaviors: Array<Record<string, unknown>> =
      config?.CacheBehaviors ?? [];
    expect(cacheBehaviors.length).toBe(0);
  });

  test("ResponseHeadersPolicy carries a Content-Security-Policy-Report-Only custom header with the expected directives", () => {
    const policies = template.findResources(
      "AWS::CloudFront::ResponseHeadersPolicy",
    );
    const entries = Object.values(policies);
    expect(entries.length).toBeGreaterThan(0);

    const customHeaders: Array<{ Header: string; Value: unknown }> =
      entries[0].Properties?.ResponseHeadersPolicyConfig?.CustomHeadersConfig
        ?.Items ?? [];

    const cspHeader = customHeaders.find(
      (h) => h.Header === "Content-Security-Policy-Report-Only",
    );
    expect(cspHeader).toBeDefined();

    // The header value is built from Fn::Join (Fn::Select/Fn::Split
    // fragments for the AppSync + cost-API hosts), so assert on the
    // flattened literal fragments within the Fn::Join parts array rather
    // than a single string.
    const joinParts: unknown[] =
      (cspHeader?.Value as { ["Fn::Join"]?: [string, unknown[]] })?.[
        "Fn::Join"
      ]?.[1] ?? [];
    const flattened = joinParts
      .map((p) => (typeof p === "string" ? p : JSON.stringify(p)))
      .join("");

    expect(flattened).toContain("default-src 'self'");
    expect(flattened).toContain("frame-ancestors 'none'");
    expect(flattened).toContain("object-src 'none'");
    expect(flattened).toContain("base-uri 'self'");
    expect(flattened).toContain("connect-src");
    expect(flattened).toContain("cognito-idp.us-east-1.amazonaws.com");
    expect(flattened).toContain("style-src 'self' 'unsafe-inline'");
    expect(flattened).toContain("fonts.googleapis.com");
    expect(flattened).toContain("fonts.gstatic.com");
    expect(flattened).toContain("img-src 'self' data:");
    // execute-api is deliberately NOT present — no browser call targets
    // published app endpoints (evidence in the file header comment above).
    expect(flattened).not.toContain("execute-api");
    // script-src must never carry 'unsafe-inline' — index.html has no
    // inline scripts.
    expect(flattened).not.toMatch(/script-src[^;]*unsafe-inline/);

    // Cost-API host: synthesized from the test's costApiUrl
    // ("https://cost.example.com"), confirming the policy is built from
    // stack values rather than a hard-coded host.
    expect(flattened).toContain("cost.example.com");
  });
});
