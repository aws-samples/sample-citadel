/**
 * Gate-enumeration guard for the design-progress publish surface
 * (finding 41c1cd9b — completes the dispatch gate-enumeration family).
 * Modeled on chatter-resolver-dispatch-gate-enumeration.test.ts's
 * three-part shape (resolver + schema + CDK wiring) — there is no
 * fieldName switch here; design-progress-resolver.ts is a single-purpose
 * pass-through for Mutation.publishDesignProgress, whose intended sole
 * caller is design-progress-notifier.ts (an EventBridge consumer that
 * publishes via SigV4/IAM to fan out intake progress to AppSync
 * subscribers on Subscription.onDesignProgress).
 *
 * Classification: EXEMPT — with a pinned, KNOWN gap.
 *
 * TODO(finding): unlike its siblings publishChatter and
 * publishAssessmentCompletion (both `@aws_iam` ONLY), publishDesignProgress
 * carries BOTH `@aws_iam` AND `@aws_cognito_user_pools` in the schema, the
 * resolver is a raw pass-through with no identity check and no input
 * validation, no frontend code calls the mutation (grep frontend/src:
 * zero hits), and Subscription.onDesignProgress has no connect-time
 * authorizer resolver (unlike onChatter/onFabricationEvent). Net effect:
 * any authenticated end user can invoke publishDesignProgress with an
 * arbitrary projectId and spoofed sectionId/completionPercentage, and
 * AppSync broadcasts it to that project's onDesignProgress subscribers —
 * cross-tenant progress-event injection (UI spoofing; no stored data is
 * affected). The fix belongs in the schema (drop
 * `@aws_cognito_user_pools` from the mutation, matching publishChatter)
 * and is a production change, out of scope for this test-only guard.
 *
 * Every assertion below pins the CURRENT state (including the gap), so
 * whichever way the surface moves — the schema directive is removed
 * (fixing the finding), the resolver gains a gate, or a subscription
 * authorizer appears — this guard fails and forces an explicit
 * reclassification instead of silent drift.
 */
import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";
import {
  collectCalls,
  findHandlerArrowBody,
  parseSource,
  walk,
} from "./fixtures/dispatch-gate-ast-helpers";

const RESOLVER_PATH = path.join(__dirname, "..", "design-progress-resolver.ts");
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
  describe("design-progress-resolver (Mutation.publishDesignProgress)", () => {
    const source = fs.readFileSync(RESOLVER_PATH, "utf-8");
    const sf = parseSource(source, "design-progress-resolver.ts");
    const handlerBody = findHandlerArrowBody(sf);

    test("the handler is a bare pass-through: single return of event.arguments.input, no other statements — any added gate/validation forces reclassification here", () => {
      expect(handlerBody.statements.length).toBe(1);
      const stmt = handlerBody.statements[0];
      expect(ts.isReturnStatement(stmt)).toBe(true);
      expect((stmt as ts.ReturnStatement).expression?.getText(sf)).toBe(
        "event.arguments.input",
      );
    });

    test("the handler performs no identity/org derivation and no storage write (pinned exemption shape)", () => {
      const calls = collectCalls(handlerBody, sf);
      expect(calls).toEqual([]);
      let throws = false;
      walk(handlerBody, (n) => {
        if (ts.isThrowStatement(n)) throws = true;
      });
      // TODO(finding): there is not even a fail-closed input check here
      // (chatter-resolver at least throws on a missing input.orgId). Pinned
      // as-is; adding one is part of the finding's fix.
      expect(throws).toBe(false);
    });
  });

  describe("schema directives (the actual authorization surface)", () => {
    const schema = fs.readFileSync(SCHEMA_PATH, "utf-8");

    test("publishDesignProgress carries @aws_iam (the intended IAM publisher path must keep working)", () => {
      const line = schema
        .split("\n")
        .find((l) => l.includes("publishDesignProgress("));
      expect(line).toBeDefined();
      expect(line).toContain("@aws_iam");
    });

    test("TODO(finding): publishDesignProgress is ALSO end-user-callable (@aws_cognito_user_pools) — pinned KNOWN gap; when the schema is fixed this fails and the guard must be reclassified", () => {
      const line = schema
        .split("\n")
        .find((l) => l.includes("publishDesignProgress("));
      expect(line).toBeDefined();
      // Contrast: the sibling publishers are IAM-only.
      const chatterLine = schema
        .split("\n")
        .find((l) => l.includes("publishChatter("));
      expect(chatterLine).not.toContain("@aws_cognito_user_pools");
      // The pinned gap itself:
      expect(line).toContain("@aws_cognito_user_pools");
    });

    test("onDesignProgress subscribes to publishDesignProgress (the broadcast path the gap exposes)", () => {
      const idx = schema.indexOf("onDesignProgress(projectId: ID!)");
      expect(idx).toBeGreaterThan(-1);
      const slice = schema.slice(idx, idx + 300);
      expect(slice).toContain(
        '@aws_subscribe(mutations: ["publishDesignProgress"])',
      );
    });
  });

  describe("CDK wiring pins the pass-through resolver and the absence of a connect-time authorizer", () => {
    const stack = fs.readFileSync(PROJECTS_STACK_PATH, "utf-8");

    test("projects-stack wires design-progress-resolver.handler as the Mutation.publishDesignProgress resolver", () => {
      expect(stack).toContain('"design-progress-resolver.handler"');
      const resolverRe =
        /makeResolver\(\s*"PublishDesignProgressResolver",\s*"Mutation",\s*"publishDesignProgress",\s*designProgressLambdaDataSource,?\s*\)/;
      expect(resolverRe.test(stack)).toBe(true);
    });

    test("TODO(finding): no Subscription.onDesignProgress connect-time authorizer is wired (unlike onChatter) — pinned KNOWN gap; adding one is part of the finding's fix and must reclassify this guard", () => {
      expect(stack).not.toContain('"onDesignProgress"');
    });
  });
});
