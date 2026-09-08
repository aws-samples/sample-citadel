/**
 * CDK test for finding 7aa877f8 (Layer 1 — Cognito).
 *
 * The user pool client previously declared no `writeAttributes` /
 * `readAttributes`, so Cognito's permissive default applied: the client
 * could write ALL mutable, non-developer-only attributes, including
 * `custom:role` and `custom:organization`. Combined with
 * ALLOW_USER_SRP_AUTH / ALLOW_USER_PASSWORD_AUTH (end users hold tokens
 * with UpdateUserAttributes scope), any authenticated user could
 * self-grant `custom:role=admin`.
 *
 * This test pins an EXPLICIT WriteAttributes allow-list that excludes both
 * custom attributes, so the permissive default cannot silently return
 * (e.g. via a future CDK/L1 refactor that drops the `writeAttributes`
 * prop). ReadAttributes is intentionally not asserted narrow here — read
 * exposure of these attributes is not the escalation vector; only WRITE
 * is.
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

describe("BackendStack — UserPoolClient WriteAttributes allow-list (finding 7aa877f8)", () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App({
      context: {
        adminEmail: "test-admin@example.com",
      },
    });
    const stack = new BackendStack(app, "TestBackendStack", {
      environment: "test",
      env: { account: "123456789012", region: "us-east-1" },
    });
    template = Template.fromStack(stack);
  });

  test("UserPoolClient declares an explicit WriteAttributes list", () => {
    template.hasResourceProperties("AWS::Cognito::UserPoolClient", {
      WriteAttributes: Match.anyValue(),
    });
  });

  test("WriteAttributes excludes custom:role and custom:organization", () => {
    const clients = template.findResources("AWS::Cognito::UserPoolClient");
    const ids = Object.keys(clients);
    expect(ids.length).toBeGreaterThan(0);

    for (const id of ids) {
      const writeAttrs: string[] = clients[id].Properties.WriteAttributes;
      expect(Array.isArray(writeAttrs)).toBe(true);
      expect(writeAttrs).not.toContain("custom:role");
      expect(writeAttrs).not.toContain("custom:organization");
    }
  });

  test("WriteAttributes still includes the standard attributes the app legitimately writes", () => {
    // Enumeration (see PR description): no frontend/resolver code path calls
    // updateUserAttributes for the caller's own record. The only
    // AdminUpdateUserAttributesCommand call is server-side, admin-only,
    // via Admin* API (assignUserRole in user-management-resolver.ts),
    // which is not gated by the client's WriteAttributes at all. The
    // standard profile fields configured as mutable standardAttributes
    // (email, given_name, family_name) are kept writable for self-service
    // profile editing/verification flows Cognito itself may exercise
    // (e.g. email re-verification).
    const clients = template.findResources("AWS::Cognito::UserPoolClient");
    const ids = Object.keys(clients);
    for (const id of ids) {
      const writeAttrs: string[] = clients[id].Properties.WriteAttributes;
      expect(writeAttrs).toEqual(
        expect.arrayContaining(["email", "given_name", "family_name"]),
      );
    }
  });
});
