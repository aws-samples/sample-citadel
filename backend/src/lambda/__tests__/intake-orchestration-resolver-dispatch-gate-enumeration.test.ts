/**
 * Enumeration-completeness guard for intake-orchestration-resolver.ts
 * (finding 41c1cd9b — completes the dispatch gate-enumeration family).
 * Modeled on the dispatch gate-enumeration siblings via the shared AST
 * helpers, with the IAM-only schema pinning adapted from
 * chatter-resolver-dispatch-gate-enumeration.test.ts.
 *
 * This resolver's shape differs from the switch-only siblings: the
 * dispatch surface is the KNOWN_FIELDS set (checked up front, unknown
 * fields throw), then a `switch (fieldName)` whose default clause
 * handles the LAST known field (intakeImportBlueprintToApp) — reachable
 * only after the KNOWN_FIELDS membership check, so the default is not a
 * fail-open path.
 *
 * Classification — every op is EXEMPT (IAM-only BY DESIGN):
 *  - All four intake* mutations are `@aws_iam` in the schema (pinned
 *    below, with `@aws_cognito_user_pools` absent) — end users cannot
 *    call them; the intake session Lambdas are the sole callers.
 *  - Defence in depth: the handler ALSO verifies the caller identity is
 *    an IAM identity (isIamIdentity, real if/throw) BEFORE the dispatch
 *    switch, so a schema regression alone would not expose the ops.
 *  - Per the module doc, projectId/orgId scoping fields are derived
 *    SERVER-SIDE from the sessionId linkage, never client-supplied —
 *    extractOrgFromEvent is null for IAM callers, so org reconciliation
 *    of the cognito kind does not apply here.
 */
import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";
import {
  collectCalls,
  containsThrow,
  extractDispatch,
  findDispatchSwitch,
  findHandlerArrowBody,
  parseSource,
  walk,
} from "./fixtures/dispatch-gate-ast-helpers";

const HANDLER_PATH = path.join(
  __dirname,
  "..",
  "intake-orchestration-resolver.ts",
);
const SCHEMA_PATH = path.join(
  __dirname,
  "..",
  "..",
  "schema",
  "schema.graphql",
);

/** The full IAM-only dispatch surface, with each op's delegate. */
const EXEMPT_IAM_ONLY_OPS: Record<string, { fn: string; reason: string }> = {
  intakeActivateProjectAgents: {
    fn: "intakeActivateProjectAgents",
    reason: "IAM-only in schema (@aws_iam, pinned) + isIamIdentity gate",
  },
  intakeCreateApp: {
    fn: "intakeCreateApp",
    reason: "IAM-only in schema (@aws_iam, pinned) + isIamIdentity gate",
  },
  intakeCreateBlueprint: {
    fn: "intakeCreateBlueprint",
    reason: "IAM-only in schema (@aws_iam, pinned) + isIamIdentity gate",
  },
  intakeImportBlueprintToApp: {
    fn: "intakeImportBlueprintToApp",
    reason:
      "IAM-only in schema (@aws_iam, pinned) + isIamIdentity gate; " +
      "dispatched via the switch default clause behind the KNOWN_FIELDS " +
      "membership check",
  },
};

describe("intake-orchestration-resolver — dispatch enumeration completeness", () => {
  const source = fs.readFileSync(HANDLER_PATH, "utf-8");
  const sf = parseSource(source, "intake-orchestration-resolver.ts");
  const handlerBody = findHandlerArrowBody(sf);

  /** Extracts the string literals of the module-level KNOWN_FIELDS set. */
  function knownFieldsLiterals(): string[] {
    let literals: string[] | undefined;
    walk(sf, (n) => {
      if (
        ts.isVariableDeclaration(n) &&
        ts.isIdentifier(n.name) &&
        n.name.text === "KNOWN_FIELDS" &&
        n.initializer &&
        ts.isNewExpression(n.initializer) &&
        n.initializer.arguments?.length === 1 &&
        ts.isArrayLiteralExpression(n.initializer.arguments[0])
      ) {
        literals = n.initializer.arguments[0].elements.map((el) => {
          if (!ts.isStringLiteral(el)) {
            throw new Error(
              "KNOWN_FIELDS contains a non-string-literal element — " +
                "update this guard's parsing.",
            );
          }
          return el.text;
        });
      }
    });
    if (!literals) {
      throw new Error(
        "Could not locate `const KNOWN_FIELDS = new Set([...])` — " +
          "dispatch structure changed; update this guard.",
      );
    }
    return literals;
  }

  const knownFields = knownFieldsLiterals();

  test("the KNOWN_FIELDS dispatch surface actually has fields to check (sanity check on the parser itself)", () => {
    expect(knownFields.length).toBeGreaterThanOrEqual(4);
  });

  test("every KNOWN_FIELDS entry is accounted for in EXEMPT_IAM_ONLY_OPS", () => {
    const unaccounted = knownFields.filter((f) => !(f in EXEMPT_IAM_ONLY_OPS));
    expect(unaccounted).toEqual([]);
  });

  test("no classification entry references a field that no longer exists in KNOWN_FIELDS", () => {
    const known = new Set(knownFields);
    const stale = Object.keys(EXEMPT_IAM_ONLY_OPS).filter((k) => !known.has(k));
    expect(stale).toEqual([]);
  });

  test("the classification table covers exactly the KNOWN_FIELDS surface", () => {
    expect(Object.keys(EXEMPT_IAM_ONLY_OPS).length).toBe(knownFields.length);
  });

  test("the handler rejects unknown fields with a real if/throw on KNOWN_FIELDS membership (fails closed)", () => {
    let failClosed = false;
    walk(handlerBody, (n) => {
      if (
        ts.isIfStatement(n) &&
        ts.isPrefixUnaryExpression(n.expression) &&
        n.expression.operator === ts.SyntaxKind.ExclamationToken &&
        n.expression.operand.getText(sf) === "KNOWN_FIELDS.has(fieldName)" &&
        containsThrow(n.thenStatement)
      ) {
        failClosed = true;
      }
    });
    expect(failClosed).toBe(true);
  });

  test("the handler verifies an IAM identity (isIamIdentity, real if/throw) — defence in depth behind the schema directive", () => {
    let iamGated = false;
    walk(handlerBody, (n) => {
      if (
        ts.isIfStatement(n) &&
        ts.isPrefixUnaryExpression(n.expression) &&
        n.expression.operator === ts.SyntaxKind.ExclamationToken &&
        ts.isCallExpression(n.expression.operand) &&
        ts.isIdentifier(n.expression.operand.expression) &&
        n.expression.operand.expression.text === "isIamIdentity" &&
        containsThrow(n.thenStatement)
      ) {
        iamGated = true;
      }
    });
    expect(iamGated).toBe(true);
  });

  test("the isIamIdentity gate precedes the dispatch switch (bite: ordering)", () => {
    const text = handlerBody.getText(sf);
    const gateIdx = text.indexOf("isIamIdentity(");
    const switchIdx = text.indexOf("switch (fieldName)");
    expect(gateIdx).toBeGreaterThan(-1);
    expect(switchIdx).toBeGreaterThan(-1);
    expect(gateIdx).toBeLessThan(switchIdx);
  });

  test("the dispatch switch's explicit cases plus its default clause cover exactly the KNOWN_FIELDS surface", () => {
    const dispatch = extractDispatch(findDispatchSwitch(handlerBody));
    const explicitCases = Array.from(dispatch.cases.keys());
    // Every explicit case must be a known field…
    for (const c of explicitCases) {
      expect(knownFields).toContain(c);
    }
    // …and exactly one known field is handled by the default clause.
    const defaulted = knownFields.filter((f) => !explicitCases.includes(f));
    expect(defaulted).toEqual(["intakeImportBlueprintToApp"]);
    expect(dispatch.hasDefault).toBe(true);
    const defaultCalls = collectCalls(dispatch.defaultClause as ts.Node, sf);
    expect(
      defaultCalls.some((c) => c.callee === "intakeImportBlueprintToApp"),
    ).toBe(true);
  });

  describe.each(Object.entries(EXEMPT_IAM_ONLY_OPS))(
    "EXEMPT_IAM_ONLY_OPS['%s'] (IAM-only by design)",
    (fieldName) => {
      test(`${fieldName} is IAM-only in the schema (@aws_iam, no @aws_cognito_user_pools) — end users cannot call it`, () => {
        const schema = fs.readFileSync(SCHEMA_PATH, "utf-8");
        const line = schema
          .split("\n")
          .find((l) => l.includes(`${fieldName}(`));
        expect(line).toBeDefined();
        expect(line).toContain("@aws_iam");
        expect(line).not.toContain("@aws_cognito_user_pools");
      });
    },
  );
});
