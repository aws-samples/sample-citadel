/**
 * Enumeration-completeness guard for conversation-resolver.ts's dispatch
 * switch (finding 41c1cd9b — completes the dispatch gate-enumeration
 * family). Modeled on the dispatch gate-enumeration siblings via the
 * shared AST helpers, with the IAM-only schema pinning adapted from
 * chatter-resolver-dispatch-gate-enumeration.test.ts.
 *
 * Parsing note: this handler switches on `event.info.fieldName` directly
 * (a property access) rather than destructuring to a local `fieldName`
 * identifier, so findDispatchSwitch's identifier match does not apply — a
 * local property-access switch finder (built on the shared walk/
 * extractDispatch helpers) handles it.
 *
 * Classification:
 *  - ORG-RECONCILED (assertProjectAccess, finding 60a5a6ae CRE item 1):
 *    sendMessage / getConversationHistory — the client-supplied projectId
 *    drives the DynamoDB write/read and (for sendMessage) the EventBridge
 *    dispatch that triggers agents, so it is reconciled against the
 *    caller BEFORE any side effect via the shared assertProjectAccess
 *    gate (same gate as project-resolver's getProject). Bite:
 *    source-position ordering vs the first docClient.send /
 *    eventBridgeClient.send.
 *  - ORG-RECONCILED (transitively): sendMessageToAgent — converts its
 *    arguments and delegates to sendMessage, inheriting its gate; pinned
 *    structurally (the delegate call is asserted, and sendMessage's own
 *    gate is asserted above).
 *  - EXEMPT (IAM-only BY DESIGN): publishConversationMessage — `@aws_iam`
 *    in the schema (pinned below, `@aws_cognito_user_pools` absent); the
 *    agent-message-handler Lambda is the sole caller, and the resolver is
 *    a pass-through that performs no storage write (pinned: no send
 *    calls), existing only to trigger the AppSync subscription.
 */
import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";
import {
  callReceivesBareEvent,
  collectCalls,
  containsThrow,
  extractDispatch,
  findHandlerArrowBody,
  findTopLevelFunction,
  functionBody,
  parseSource,
  walk,
  type DispatchInfo,
} from "./fixtures/dispatch-gate-ast-helpers";

const HANDLER_PATH = path.join(__dirname, "..", "conversation-resolver.ts");
const SCHEMA_PATH = path.join(
  __dirname,
  "..",
  "..",
  "schema",
  "schema.graphql",
);

const SIDE_EFFECT_CALLEES = ["docClient.send", "eventBridgeClient.send"];

const ORG_RECONCILED_OPS: Record<string, { fn: string }> = {
  sendMessage: { fn: "sendMessage" },
  getConversationHistory: { fn: "getConversationHistory" },
};

const TRANSITIVELY_RECONCILED_OPS: Record<
  string,
  { fn: string; delegatesTo: string }
> = {
  sendMessageToAgent: { fn: "sendMessageToAgent", delegatesTo: "sendMessage" },
};

const EXEMPT_OPS: Record<string, { fn: string; reason: string }> = {
  publishConversationMessage: {
    fn: "publishConversationMessage",
    reason:
      "IAM-only in schema (@aws_iam, pinned below) — backend " +
      "agent-message-handler is the sole caller; pass-through with no " +
      "storage write (pinned: no send calls)",
  },
};

/**
 * Locates `switch (event.info.fieldName)` — this handler's dispatch
 * switches on the property access directly instead of a destructured
 * local identifier.
 */
function findPropertyAccessDispatchSwitch(
  handlerBody: ts.Block,
  expressionText = "event.info.fieldName",
): ts.SwitchStatement {
  let sw: ts.SwitchStatement | undefined;
  walk(handlerBody, (n) => {
    if (
      !sw &&
      ts.isSwitchStatement(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.getText() === expressionText
    ) {
      sw = n;
    }
  });
  if (!sw) {
    throw new Error(
      `Could not locate \`switch (${expressionText})\` inside handler() — ` +
        "dispatch structure changed; update this guard's parsing.",
    );
  }
  return sw;
}

describe("conversation-resolver — dispatch enumeration completeness", () => {
  const source = fs.readFileSync(HANDLER_PATH, "utf-8");
  const sf = parseSource(source, "conversation-resolver.ts");
  const handlerBody = findHandlerArrowBody(sf);
  const dispatch: DispatchInfo = extractDispatch(
    findPropertyAccessDispatchSwitch(handlerBody),
  );
  const caseNames = Array.from(dispatch.cases.keys());

  const allClassified = new Set([
    ...Object.keys(ORG_RECONCILED_OPS),
    ...Object.keys(TRANSITIVELY_RECONCILED_OPS),
    ...Object.keys(EXEMPT_OPS),
  ]);

  test("the dispatch switch actually has cases to check (sanity check on the parser itself)", () => {
    expect(caseNames.length).toBeGreaterThanOrEqual(4);
    expect(caseNames).toEqual(
      expect.arrayContaining(["sendMessage", "publishConversationMessage"]),
    );
  });

  test("every dispatch case is accounted for in exactly one classification table", () => {
    const unaccounted = caseNames.filter((c) => !allClassified.has(c));
    expect(unaccounted).toEqual([]);
  });

  test("no classification entry references a case that no longer exists in the switch", () => {
    const known = new Set(caseNames);
    const stale = [...allClassified].filter((k) => !known.has(k));
    expect(stale).toEqual([]);
  });

  test("the classification tables jointly cover exactly the dispatch surface", () => {
    expect(allClassified.size).toBe(caseNames.length);
  });

  test("the dispatch default clause throws on unknown fields (fails closed)", () => {
    expect(dispatch.hasDefault).toBe(true);
    expect(containsThrow(dispatch.defaultClause as ts.Node)).toBe(true);
  });

  describe.each(Object.entries(ORG_RECONCILED_OPS))(
    "ORG_RECONCILED_OPS['%s'] (assertProjectAccess before any side effect)",
    (fieldName, meta) => {
      test(`case '${fieldName}' dispatches to ${meta.fn} and passes the raw \`event\` (the gate's input)`, () => {
        const clause = dispatch.cases.get(fieldName);
        expect(clause).toBeDefined();
        const calls = collectCalls(clause as ts.Node, sf);
        const target = calls.filter((c) => c.callee === meta.fn);
        expect(target.length).toBeGreaterThanOrEqual(1);
        expect(target.some((c) => callReceivesBareEvent(c.node))).toBe(true);
      });

      test(`${meta.fn} reconciles the client-supplied projectId via assertProjectAccess(<projectId>, <userId>, event)`, () => {
        const body = functionBody(findTopLevelFunction(sf, meta.fn));
        const calls = collectCalls(body, sf);
        const gates = calls.filter((c) => c.callee === "assertProjectAccess");
        expect(gates.length).toBeGreaterThanOrEqual(1);
        expect(gates.some((c) => callReceivesBareEvent(c.node))).toBe(true);
      });

      test(`${meta.fn}'s assertProjectAccess gate precedes its first side-effect call (bite: ordering)`, () => {
        const body = functionBody(findTopLevelFunction(sf, meta.fn));
        const calls = collectCalls(body, sf);
        const gates = calls.filter((c) => c.callee === "assertProjectAccess");
        const effects = calls.filter((c) =>
          SIDE_EFFECT_CALLEES.includes(c.callee),
        );
        expect(gates.length).toBeGreaterThanOrEqual(1);
        expect(effects.length).toBeGreaterThanOrEqual(1);
        expect(Math.min(...gates.map((c) => c.start))).toBeLessThan(
          Math.min(...effects.map((c) => c.start)),
        );
      });
    },
  );

  describe.each(Object.entries(TRANSITIVELY_RECONCILED_OPS))(
    "TRANSITIVELY_RECONCILED_OPS['%s'] (inherits the delegate's gate)",
    (fieldName, meta) => {
      test(`case '${fieldName}' dispatches to ${meta.fn} with the raw \`event\``, () => {
        const clause = dispatch.cases.get(fieldName);
        expect(clause).toBeDefined();
        const calls = collectCalls(clause as ts.Node, sf);
        const target = calls.filter((c) => c.callee === meta.fn);
        expect(target.length).toBeGreaterThanOrEqual(1);
        expect(target.some((c) => callReceivesBareEvent(c.node))).toBe(true);
      });

      test(`${meta.fn} delegates to ${meta.delegatesTo} (whose assertProjectAccess gate is asserted above) and performs no direct side effect itself`, () => {
        const body = functionBody(findTopLevelFunction(sf, meta.fn));
        const calls = collectCalls(body, sf);
        expect(calls.some((c) => c.callee === meta.delegatesTo)).toBe(true);
        const effects = calls.filter((c) =>
          SIDE_EFFECT_CALLEES.includes(c.callee),
        );
        expect(effects).toEqual([]);
      });
    },
  );

  describe.each(Object.entries(EXEMPT_OPS))(
    "EXEMPT_OPS['%s'] (IAM-only by design)",
    (fieldName, meta) => {
      test(`${fieldName} is IAM-only in the schema (@aws_iam, no @aws_cognito_user_pools) — end users cannot call it`, () => {
        const schema = fs.readFileSync(SCHEMA_PATH, "utf-8");
        const lines = schema.split("\n");
        const idx = lines.findIndex((l) => l.includes(`${fieldName}(`));
        expect(idx).toBeGreaterThan(-1);
        // The @aws_iam directive continues on the following line in the
        // current schema formatting — pin against the declaration plus its
        // continuation, stopping before the next field.
        const slice = lines.slice(idx, idx + 2).join("\n");
        expect(slice).toContain("@aws_iam");
        expect(slice).not.toContain("@aws_cognito_user_pools");
      });

      test(`${meta.fn} is a pass-through: it performs no storage write (no send calls) — a future write here forces reclassification`, () => {
        const body = functionBody(findTopLevelFunction(sf, meta.fn));
        const calls = collectCalls(body, sf);
        const effects = calls.filter((c) =>
          SIDE_EFFECT_CALLEES.includes(c.callee),
        );
        expect(effects).toEqual([]);
      });
    },
  );
});
