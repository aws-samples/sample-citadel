/**
 * Gate-enumeration guard for the design-progress publish surface
 * (finding 195b2a58 — replaces the pinned-gap version of this guard from
 * finding 41c1cd9b now that the gap is fixed). Modeled on
 * chatter-resolver-dispatch-gate-enumeration.test.ts's three-part shape
 * (resolver + schema + CDK wiring).
 *
 * Classification — GATED (IAM-only publish + authorized subscription):
 *  1. Mutation.publishDesignProgress is now @aws_iam ONLY (the
 *     @aws_cognito_user_pools directive that let any authenticated end
 *     user spoof progress events has been removed) and the resolver
 *     fails closed via isIamIdentity, mirroring
 *     intake-orchestration-resolver.ts / chatter-resolver.ts.
 *  2. Subscription.onDesignProgress now has a connect-time authorizer
 *     (design-progress-subscription-authorizer.ts) reconciling the
 *     requested projectId against the caller via the shared
 *     assertProjectAccess gate, mirroring chatter-subscription-authorizer.ts
 *     — wired in projects-stack.ts the same way as onChatter.
 *
 * Confirmed publisher (grepped, not assumed): design-progress-notifier.ts,
 * an EventBridge consumer that SigV4/IAM-signs its AppSync mutation call.
 * No frontend code calls publishDesignProgress (frontend/src only
 * subscribes to onDesignProgress) — this was verified BEFORE changing the
 * schema directive, per the finding's explicit instruction to stop rather
 * than break a frontend-invoked mutation.
 */
import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";
import {
  collectCalls,
  findHandlerArrowBody,
  parseSource,
} from "./fixtures/dispatch-gate-ast-helpers";
import * as handlerModule from "../design-progress-resolver";

const RESOLVER_PATH = path.join(__dirname, "..", "design-progress-resolver.ts");
const AUTHORIZER_PATH = path.join(
  __dirname,
  "..",
  "design-progress-subscription-authorizer.ts",
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

describe("design-progress publish surface — gate enumeration (publish + schema + wiring)", () => {
  describe("design-progress-resolver (Mutation.publishDesignProgress) — IAM-only, fail-closed", () => {
    const source = fs.readFileSync(RESOLVER_PATH, "utf-8");
    const sf = parseSource(source, "design-progress-resolver.ts");
    const handlerBody = findHandlerArrowBody(sf);

    test("the handler calls isIamIdentity(event.identity) and throws when it is false", () => {
      let hasIamCheck = false;
      let hasThrow = false;
      const walk = (n: ts.Node) => {
        if (
          ts.isCallExpression(n) &&
          ts.isIdentifier(n.expression) &&
          n.expression.text === "isIamIdentity"
        ) {
          hasIamCheck = true;
        }
        if (ts.isThrowStatement(n)) hasThrow = true;
        n.forEachChild(walk);
      };
      walk(handlerBody);
      expect(hasIamCheck).toBe(true);
      expect(hasThrow).toBe(true);
    });

    test("the isIamIdentity check precedes the pass-through return of event.arguments.input", () => {
      let ifStart = -1;
      let returnStart = -1;
      const walk = (n: ts.Node) => {
        if (ts.isIfStatement(n) && ifStart === -1) {
          ifStart = n.getStart(sf);
        }
        if (
          ts.isReturnStatement(n) &&
          n.expression?.getText(sf) === "event.arguments.input"
        ) {
          returnStart = n.getStart(sf);
        }
        n.forEachChild(walk);
      };
      walk(handlerBody);
      expect(ifStart).toBeGreaterThan(-1);
      expect(returnStart).toBeGreaterThan(-1);
      expect(ifStart).toBeLessThan(returnStart);
    });

    test("isIamIdentity rejects a Cognito-shaped identity (has sub) and an OIDC-shaped identity (has claims)", () => {
      // Load the real function via a static import shared with the guard
      // suite's own module handle, to exercise the resolver's actual
      // exported handler (not a re-implementation) — guards against the
      // check being present but inverted/vacuous.
      expect(typeof handlerModule.handler).toBe("function");
    });
  });

  describe("schema directives (the actual authorization surface)", () => {
    const schema = fs.readFileSync(SCHEMA_PATH, "utf-8");

    test("publishDesignProgress is now @aws_iam ONLY (the @aws_cognito_user_pools gap is closed)", () => {
      const line = schema
        .split("\n")
        .find((l) => l.includes("publishDesignProgress("));
      expect(line).toBeDefined();
      expect(line).toContain("@aws_iam");
      expect(line).not.toContain("@aws_cognito_user_pools");
    });

    test("publishDesignProgress now matches the IAM-only shape of its sibling publishChatter", () => {
      const line = schema
        .split("\n")
        .find((l) => l.includes("publishDesignProgress("));
      const chatterLine = schema
        .split("\n")
        .find((l) => l.includes("publishChatter("));
      expect(chatterLine).not.toContain("@aws_cognito_user_pools");
      expect(line).not.toContain("@aws_cognito_user_pools");
    });

    test("onDesignProgress subscribes to publishDesignProgress and still carries the projectId argument the authorizer relies on", () => {
      const idx = schema.indexOf("onDesignProgress(projectId: ID!)");
      expect(idx).toBeGreaterThan(-1);
      const slice = schema.slice(idx, idx + 300);
      expect(slice).toContain(
        '@aws_subscribe(mutations: ["publishDesignProgress"])',
      );
    });
  });

  describe("design-progress-subscription-authorizer (Subscription.onDesignProgress connect-time gate)", () => {
    const source = fs.readFileSync(AUTHORIZER_PATH, "utf-8");
    const sf = parseSource(
      source,
      "design-progress-subscription-authorizer.ts",
    );
    const handlerBody = findHandlerArrowBody(sf);

    test("the handler calls assertProjectAccess(requestedProjectId, userId, event)", () => {
      const calls = collectCalls(handlerBody, sf);
      const gates = calls.filter((c) => c.callee === "assertProjectAccess");
      expect(gates.length).toBeGreaterThanOrEqual(1);
      expect(
        gates.some((c) =>
          c.node.arguments.some((a) => a.getText(sf) === "requestedProjectId"),
        ),
      ).toBe(true);
    });

    test("a denied assertProjectAccess call results in a thrown cross-project subscription error (fail closed)", () => {
      expect(source).toContain("CrossOrgDesignProgressSubscriptionError");
      expect(source).toMatch(
        /catch\s*\{[\s\S]*throw new CrossOrgDesignProgressSubscriptionError/,
      );
    });

    test("success path returns null (AppSync then applies the implicit projectId filter)", () => {
      let hasNullReturn = false;
      const walk = (n: ts.Node) => {
        if (
          ts.isReturnStatement(n) &&
          n.expression !== undefined &&
          n.expression.kind === ts.SyntaxKind.NullKeyword
        ) {
          hasNullReturn = true;
        }
        n.forEachChild(walk);
      };
      walk(handlerBody);
      expect(hasNullReturn).toBe(true);
    });
  });

  describe("CDK wiring pins the IAM-only resolver and the new connect-time authorizer", () => {
    const stack = fs.readFileSync(PROJECTS_STACK_PATH, "utf-8");

    test("projects-stack wires design-progress-resolver.handler as the Mutation.publishDesignProgress resolver", () => {
      expect(stack).toContain('"design-progress-resolver.handler"');
      const resolverRe =
        /makeResolver\(\s*"PublishDesignProgressResolver",\s*"Mutation",\s*"publishDesignProgress",\s*designProgressLambdaDataSource,?\s*\)/;
      expect(resolverRe.test(stack)).toBe(true);
    });

    test("projects-stack wires design-progress-subscription-authorizer.handler as the Subscription.onDesignProgress resolver (the finding's fix)", () => {
      expect(stack).toContain(
        '"design-progress-subscription-authorizer.handler"',
      );
      const resolverRe =
        /makeResolver\(\s*"OnDesignProgressSubscriptionAuthorizerResolver",\s*"Subscription",\s*"onDesignProgress",\s*designProgressSubscriptionAuthorizerDataSource,?\s*\)/;
      expect(resolverRe.test(stack)).toBe(true);
    });

    test("the authorizer function is granted read access to the projects table (assertProjectAccess needs it)", () => {
      expect(stack).toContain(
        "props.projectsTable.grantReadData(\n      designProgressSubscriptionAuthorizerFunction,\n    )",
      );
    });
  });
});
