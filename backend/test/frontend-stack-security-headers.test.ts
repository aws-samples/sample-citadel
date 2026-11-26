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
 * Finding 68019420 (PR #598 follow-up): adds a Content-Security-Policy
 * (enforcing; first shipped report-only) built from stack values, and removes the /api/* behaviour +
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
 *     connect-src. No S3 host needed for that path.
 *   - S3 presigned PUT (document upload): frontend/src/services/
 *     documentService.ts:59 does `fetch(uploadUrl, { method: 'PUT' })` to a
 *     URL minted by backend/src/lambda/document-upload-resolver.ts
 *     (`getSignedUrl` on a default `S3Client`, so virtual-hosted regional:
 *     https://<bucket>.s3.<region>.amazonaws.com). That is a browser fetch,
 *     so the documents-bucket host is in connect-src (exact host, no
 *     `*.s3.<region>` wildcard).
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

interface SynthOverrides {
  account?: string;
  region?: string;
  environment?: string;
}

function synthFrontendStack(overrides: SynthOverrides = {}): Template {
  const app = new cdk.App();

  const env = {
    account: overrides.account ?? "123456789012",
    region: overrides.region ?? "us-east-1",
  };
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
    environment: overrides.environment ?? "test",
    costApiUrl: "https://cost.example.com",
  });

  return Template.fromStack(stack);
}

type CustomHeader = { Header: string; Value: unknown; Override?: boolean };

function getCustomHeaders(template: Template): CustomHeader[] {
  const policies = Object.values(
    template.findResources("AWS::CloudFront::ResponseHeadersPolicy"),
  );
  expect(policies.length).toBeGreaterThan(0);
  return (
    policies[0].Properties?.ResponseHeadersPolicyConfig?.CustomHeadersConfig
      ?.Items ?? []
  );
}

// Renders a synthesized CFN value to a string: Fn::Join is resolved
// recursively, literals pass through, and any other intrinsic (Fn::Select,
// Ref, ...) becomes a `{{json}}` placeholder so its presence stays visible.
function renderValue(value: unknown): string {
  if (typeof value === "string") return value;
  const join = (value as { ["Fn::Join"]?: [string, unknown[]] })?.["Fn::Join"];
  if (join) return join[1].map(renderValue).join(join[0]);
  return `{{${JSON.stringify(value)}}}`;
}

// Same as renderValue, but every non-Join, non-string intrinsic becomes an
// 80-character placeholder, approximating the length of the deployed value
// (a real host is at most ~80 characters).
function renderWithPlaceholders(value: unknown): string {
  if (typeof value === "string") return value;
  const join = (value as { ["Fn::Join"]?: [string, unknown[]] })?.["Fn::Join"];
  if (join) return join[1].map(renderWithPlaceholders).join(join[0]);
  return "x".repeat(80);
}

// CloudFront rejects the managed security header names in
// CustomHeadersConfig (InvalidRequest); the policy must live in
// SecurityHeadersConfig.ContentSecurityPolicy instead.
function getCspConfig(template: Template): {
  ContentSecurityPolicy: unknown;
  Override?: boolean;
} {
  const policies = Object.values(
    template.findResources("AWS::CloudFront::ResponseHeadersPolicy"),
  );
  expect(policies.length).toBeGreaterThan(0);
  const csp =
    policies[0].Properties?.ResponseHeadersPolicyConfig?.SecurityHeadersConfig
      ?.ContentSecurityPolicy;
  expect(csp).toBeDefined();
  return csp;
}

function getEnforcingPolicy(template: Template): string {
  return renderValue(getCspConfig(template).ContentSecurityPolicy);
}

function parseDirectives(policy: string): Map<string, string> {
  const directives = new Map<string, string>();
  for (const part of policy.split(";")) {
    const directive = part.trim();
    if (!directive) continue;
    const [name, ...sources] = directive.split(/\s+/);
    directives.set(name, sources.join(" "));
  }
  return directives;
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

  test("the Content-Security-Policy is set through SecurityHeadersConfig with override on", () => {
    const csp = getCspConfig(template);
    expect(csp.Override).toBe(true);

    const policy = renderValue(csp.ContentSecurityPolicy);
    expect(policy).toContain("script-src 'self'");
    expect(policy).toContain("worker-src 'self' blob:");
    expect(policy).toContain(
      "https://citadel-documents-test-123456789012-us-east-1.s3.us-east-1.amazonaws.com",
    );
  });

  test("no custom header uses a CloudFront-managed security header name (InvalidRequest)", () => {
    const names = getCustomHeaders(template).map((h) => h.Header);
    expect(
      names.filter((n) => n.startsWith("Content-Security-Policy")),
    ).toEqual([]);
  });

  test("the resolved Content-Security-Policy stays below the 1783-character CloudFront limit", () => {
    const policy = renderWithPlaceholders(
      getCspConfig(template).ContentSecurityPolicy,
    );
    expect(policy.length).toBeLessThan(1783);
  });

  test("no Content-Security-Policy-Report-Only header remains alongside the enforcing one", () => {
    const names = getCustomHeaders(template).map((h) => h.Header);
    expect(names).not.toContain("Content-Security-Policy-Report-Only");
  });

  test("the static directives match the agreed policy exactly", () => {
    const directives = parseDirectives(getEnforcingPolicy(template));

    expect(directives.get("default-src")).toBe("'self'");
    expect(directives.get("frame-ancestors")).toBe("'none'");
    expect(directives.get("object-src")).toBe("'none'");
    expect(directives.get("base-uri")).toBe("'self'");
    expect(directives.get("img-src")).toBe("'self' data:");
    expect(directives.get("font-src")).toBe("'self' https://fonts.gstatic.com");
    expect(directives.get("style-src")).toBe(
      "'self' 'unsafe-inline' https://fonts.googleapis.com",
    );
    expect(directives.get("script-src")).toBe("'self'");
    expect(directives.get("worker-src")).toBe("'self' blob:");
  });

  test("script-src carries neither 'unsafe-inline' nor 'unsafe-eval'", () => {
    const policy = getEnforcingPolicy(template);
    const scriptSrc = parseDirectives(policy).get("script-src") ?? "";

    expect(scriptSrc).not.toContain("unsafe-inline");
    expect(scriptSrc).not.toContain("unsafe-eval");
    expect(policy).not.toMatch(/script-src[^;]*unsafe-inline/);
  });

  test("connect-src lists the AppSync, Cognito and cost API hosts built from stack values", () => {
    const connectSrc =
      parseDirectives(getEnforcingPolicy(template)).get("connect-src") ?? "";

    expect(connectSrc.startsWith("'self' ")).toBe(true);
    expect(connectSrc).toContain("https://cognito-idp.us-east-1.amazonaws.com");
    expect(connectSrc).toContain("wss://");
    expect(connectSrc).toContain("appsync-realtime-api");
    // Cost-API host: synthesized from the test's costApiUrl
    // ("https://cost.example.com"), confirming the policy is built from
    // stack values rather than a hard-coded host.
    expect(connectSrc).toContain("cost.example.com");
  });

  test("connect-src carries the documents-bucket virtual-hosted regional host for presigned uploads", () => {
    const connectSrc =
      parseDirectives(getEnforcingPolicy(template)).get("connect-src") ?? "";

    expect(connectSrc.split(" ")).toContain(
      "https://citadel-documents-test-123456789012-us-east-1.s3.us-east-1.amazonaws.com",
    );
  });

  test("the documents host follows the stack's account, region and environment (not hard-coded)", () => {
    const other = synthFrontendStack({
      account: "999999999999",
      region: "eu-west-1",
      environment: "prod",
    });
    const connectSrc =
      parseDirectives(getEnforcingPolicy(other)).get("connect-src") ?? "";

    expect(connectSrc.split(" ")).toContain(
      "https://citadel-documents-prod-999999999999-eu-west-1.s3.eu-west-1.amazonaws.com",
    );
    expect(connectSrc).not.toContain("123456789012");
    expect(connectSrc).toContain("https://cognito-idp.eu-west-1.amazonaws.com");
  });

  test("the documents bucket name formula matches the one BackendStack uses to create the bucket", () => {
    const backendSource = fs.readFileSync(
      path.join(backendDir, "lib", "backend-stack.ts"),
      "utf8",
    );
    const frontendSource = fs.readFileSync(
      path.join(backendDir, "lib", "frontend-stack.ts"),
      "utf8",
    );
    const formula =
      "`citadel-documents-${props.environment}-${this.account}-${this.region}`";

    expect(backendSource).toContain(`bucketName: ${formula}`);
    expect(frontendSource).toContain(formula);
  });

  test("the policy has no wildcard sources and no execute-api host", () => {
    const policy = getEnforcingPolicy(template);

    expect(policy).not.toContain("*");
    // The test's cost API is cost.example.com, so any execute-api in the
    // policy would be a hard-coded or wildcard published-app host.
    expect(policy).not.toContain("execute-api");
  });
});
