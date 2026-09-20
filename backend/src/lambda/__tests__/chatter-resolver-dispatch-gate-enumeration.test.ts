/**
 * Gate-enumeration guard for the chatter tenancy surface (finding
 * 3c67ccc6; wave-2a tenancy finding 87a171ad section A). Modeled on the
 * dispatch gate-enumeration family via the shared AST helpers
 * (fixtures/dispatch-gate-ast-helpers.ts), adapted to this surface's
 * three-part shape — there is no fieldName switch here; the tenancy
 * guarantee is split across:
 *
 *  1. chatter-resolver.ts (Mutation.publishChatter): IAM-ONLY in the
 *     schema (`@aws_iam`, pinned below against
 *     ../schema/schema.graphql) — end users cannot call it; the backend
 *     publisher Lambda is the sole caller. The resolver still fails
 *     closed on a missing input.orgId (an org-less message would defeat
 *     AppSync's implicit subscription filter and broadcast to every
 *     subscriber) — asserted as a real if/throw before the return.
 *
 *  2. chatter-subscription-authorizer.ts (Subscription.onChatter /
 *     onFabricationEvent connect-time gate): validates the subscription
 *     argument `event.arguments.orgId` against the caller's
 *     server-derived org (extractOrgFromEvent), admin bypass only via
 *     isAdminFromEvent, FAIL-CLOSED on all three legs (missing requested
 *     org / unresolvable caller org / mismatch) — each leg asserted as a
 *     disjunct of the real throwing condition.
 *
 *  3. The CDK wiring (backend/lib/projects-stack.ts and
 *     backend/lib/registry-stack.ts): the authorizer Lambda must remain
 *     attached as the resolver on Subscription.onChatter (projects) and
 *     Subscription.onFabricationEvent (registry). Without that
 *     attachment the handler above is dead code and subscribing with a
 *     victim org's id silently works again — so the attachment itself is
 *     pinned here (read-only source assertions on the stack files).
 */
import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";
import {
  collectCalls,
  collectNews,
  containsThrow,
  findHandlerArrowBody,
  parseSource,
} from "./fixtures/dispatch-gate-ast-helpers";

const CHATTER_RESOLVER_PATH = path.join(__dirname, "..", "chatter-resolver.ts");
const AUTHORIZER_PATH = path.join(
  __dirname,
  "..",
  "chatter-subscription-authorizer.ts",
);
const SCHEMA_PATH = path.join(
  __dirname,
  "..",
  "..",
  "schema",
  "schema.graphql",
);
const PROJECTS_STACK_PATH = path.join(
  __dirname,
  "..",
  "..",
  "..",
  "lib",
  "projects-stack.ts",
);
const REGISTRY_STACK_PATH = path.join(
  __dirname,
  "..",
  "..",
  "..",
  "lib",
  "registry-stack.ts",
);

describe("chatter tenancy surface — gate enumeration (publish + subscribe + wiring)", () => {
  describe("chatter-resolver (Mutation.publishChatter)", () => {
    const source = fs.readFileSync(CHATTER_RESOLVER_PATH, "utf-8");
    const sf = parseSource(source, "chatter-resolver.ts");
    const handlerBody = findHandlerArrowBody(sf);

    test("fails closed on a missing input.orgId (real if/throw, not prose)", () => {
      let failClosed = false;
      const visit = (n: ts.Node): void => {
        if (
          ts.isIfStatement(n) &&
          ts.isPrefixUnaryExpression(n.expression) &&
          n.expression.operator === ts.SyntaxKind.ExclamationToken &&
          n.expression.operand.getText(sf) === "input.orgId" &&
          containsThrow(n.thenStatement)
        ) {
          failClosed = true;
        }
        n.forEachChild(visit);
      };
      visit(handlerBody);
      expect(failClosed).toBe(true);
    });

    test("the orgId check precedes the returned message construction (bite: ordering)", () => {
      const text = handlerBody.getText(sf);
      const checkIdx = text.indexOf("!input.orgId");
      const returnIdx = text.indexOf("return message");
      expect(checkIdx).toBeGreaterThan(-1);
      expect(returnIdx).toBeGreaterThan(-1);
      expect(checkIdx).toBeLessThan(returnIdx);
    });

    test("publishChatter is IAM-only in the schema (@aws_iam, no @aws_cognito_user_pools) — end users cannot publish", () => {
      const schema = fs.readFileSync(SCHEMA_PATH, "utf-8");
      const line = schema
        .split("\n")
        .find((l) => l.includes("publishChatter("));
      expect(line).toBeDefined();
      expect(line).toContain("@aws_iam");
      expect(line).not.toContain("@aws_cognito_user_pools");
    });
  });

  describe("chatter-subscription-authorizer (connect-time org validation)", () => {
    const source = fs.readFileSync(AUTHORIZER_PATH, "utf-8");
    const sf = parseSource(source, "chatter-subscription-authorizer.ts");
    const handlerBody = findHandlerArrowBody(sf);
    const calls = collectCalls(handlerBody, sf);

    test("derives the caller org server-side (extractOrgFromEvent) and recognises admin only via isAdminFromEvent", () => {
      expect(calls.some((c) => c.callee === "extractOrgFromEvent")).toBe(true);
      expect(calls.some((c) => c.callee === "isAdminFromEvent")).toBe(true);
    });

    test("fails closed on ALL three legs: missing requested orgId, unresolvable caller org, and mismatch", () => {
      // The rejecting condition is
      //   `!requestedOrgId || !callerOrgId || requestedOrgId !== callerOrgId`
      // guarding a throw. Verify each leg exists inside ONE throwing
      // if-condition, so no leg can be dropped without failing here.
      let legsFound = 0;
      const visit = (n: ts.Node): void => {
        if (ts.isIfStatement(n) && containsThrow(n.thenStatement)) {
          const cond = n.expression.getText(sf);
          const hasMissingRequested = /!\s*requestedOrgId/.test(cond);
          const hasMissingCaller = /!\s*callerOrgId/.test(cond);
          const hasMismatch = /requestedOrgId\s*!==\s*callerOrgId/.test(cond);
          if (hasMissingRequested && hasMissingCaller && hasMismatch) {
            legsFound = 3;
          }
        }
        n.forEachChild(visit);
      };
      visit(handlerBody);
      expect(legsFound).toBe(3);
    });

    test("the rejection throws the dedicated CrossOrgSubscriptionError", () => {
      const news = collectNews(handlerBody, sf);
      expect(
        news.some((x) => x.className === "CrossOrgSubscriptionError"),
      ).toBe(true);
    });

    test("onChatter requires Cognito auth in the schema (@aws_cognito_user_pools) so the authorizer sees a real identity", () => {
      const schema = fs.readFileSync(SCHEMA_PATH, "utf-8");
      const idx = schema.indexOf("onChatter(orgId: ID!)");
      expect(idx).toBeGreaterThan(-1);
      // Directives continue on the following lines up to the next field.
      const slice = schema.slice(idx, idx + 300);
      expect(slice).toContain('@aws_subscribe(mutations: ["publishChatter"])');
      expect(slice).toContain("@aws_cognito_user_pools");
    });
  });

  describe("CDK wiring pins the authorizer to the subscription fields", () => {
    test("projects-stack wires chatter-subscription-authorizer.handler as the Subscription.onChatter resolver", () => {
      const stack = fs.readFileSync(PROJECTS_STACK_PATH, "utf-8");
      // The Lambda function must be created from the authorizer handler…
      expect(stack).toContain('"chatter-subscription-authorizer.handler"');
      // …exposed as a data source…
      expect(stack).toContain("ChatterSubscriptionAuthorizer");
      // …and attached to Subscription.onChatter via makeResolver. Pin the
      // exact (typeName, fieldName, dataSource) triple in argument order so
      // rewiring onChatter to a different data source fails here.
      const resolverRe =
        /makeResolver\(\s*"OnChatterSubscriptionAuthorizerResolver",\s*"Subscription",\s*"onChatter",\s*chatterSubscriptionAuthorizerDataSource,?\s*\)/;
      expect(resolverRe.test(stack)).toBe(true);
    });

    test("registry-stack wires the same authorizer handler for Subscription.onFabricationEvent", () => {
      const stack = fs.readFileSync(REGISTRY_STACK_PATH, "utf-8");
      expect(stack).toContain('"chatter-subscription-authorizer.handler"');
      const idx = stack.indexOf('"onFabricationEvent"');
      expect(idx).toBeGreaterThan(-1);
      // The onFabricationEvent resolver attachment must reference a
      // Subscription-type resolver in the same call.
      const around = stack.slice(Math.max(0, idx - 300), idx + 100);
      expect(around).toContain('"Subscription"');
    });

    test("publishChatter's mutation resolver remains the chatter-resolver handler (the fail-closed publisher)", () => {
      const stack = fs.readFileSync(PROJECTS_STACK_PATH, "utf-8");
      expect(stack).toContain('"chatter-resolver.handler"');
      const resolverRe =
        /makeResolver\(\s*"PublishChatterResolver",\s*"Mutation",\s*"publishChatter",\s*chatterLambdaDataSource,?\s*\)/;
      expect(resolverRe.test(stack)).toBe(true);
    });
  });
});
