/**
 * Tests for the shared dispatch gate-enumeration AST helpers
 * (fixtures/dispatch-gate-ast-helpers.ts). Carries the synthetic
 * comment/string-literal decoy tests that previously lived inline in each
 * guard (see eval-run-resolver-dispatch-gate-enumeration.test.ts), so every
 * guard importing the shared helpers inherits proven immunity without
 * re-stating the synthetic cases file-by-file.
 */
import {
  callReceivesBareEvent,
  callReceivesIdentifier,
  callReceivesStringLiteral,
  collectCalls,
  collectFieldNameComparisons,
  collectNews,
  collectPropertyAssignments,
  containsThrow,
  extractDispatch,
  findDispatchSwitch,
  findHandlerArrowBody,
  findTopLevelFunction,
  functionBody,
  parseSource,
} from "./fixtures/dispatch-gate-ast-helpers";

describe("dispatch-gate-ast-helpers — shared guard parsing", () => {
  describe("AST inspection is immune to gate names in comments and string literals", () => {
    test("gate names appearing ONLY in comments and string literals produce zero call sites", () => {
      const snippet = [
        "async function decoy(event: unknown): Promise<null> {",
        "  // canCallerSeeRow(row, event) must gate this — prose only.",
        '  const a = "resolveScopedOrgFromEvent(event, orgId)";',
        "  const b = `assertRowOrg(suite, event)`;",
        "  return null;",
        "}",
      ].join("\n");
      const decoySf = parseSource(snippet, "decoy.ts");
      const decoyFn = findTopLevelFunction(decoySf, "decoy");
      const names = collectCalls(functionBody(decoyFn), decoySf).map(
        (c) => c.callee,
      );
      expect(names).not.toContain("canCallerSeeRow");
      expect(names).not.toContain("resolveScopedOrgFromEvent");
      expect(names).not.toContain("assertRowOrg");
    });

    test("the same helpers DO detect a real gate call (immunity is not blindness)", () => {
      const snippet = [
        "async function real(event: unknown): Promise<void> {",
        "  await assertRowOrg(suite, event);",
        "}",
      ].join("\n");
      const realSf = parseSource(snippet, "real.ts");
      const realFn = findTopLevelFunction(realSf, "real");
      const calls = collectCalls(functionBody(realFn), realSf);
      const names = calls.map((c) => c.callee);
      expect(names).toContain("assertRowOrg");
      const gate = calls.find((c) => c.callee === "assertRowOrg");
      expect(callReceivesBareEvent(gate!.node)).toBe(true);
      expect(callReceivesIdentifier(gate!.node, "suite")).toBe(true);
    });
  });

  describe("switch-dispatch extraction", () => {
    const handlerSource = [
      "export const handler = async (event: unknown): Promise<unknown> => {",
      "  const fieldName = (event as { info: { fieldName: string } }).info.fieldName;",
      "  switch (fieldName) {",
      '    case "gatedOp":',
      "      return await gatedOp(event);",
      '    case "exemptOp":',
      "      return await exemptOp();",
      "    default:",
      "      throw new Error(`Unknown field: ${fieldName}`);",
      "  }",
      "};",
    ].join("\n");

    test("extractDispatch derives case labels and the throwing default from source", () => {
      const sf = parseSource(handlerSource, "handler.ts");
      const dispatch = extractDispatch(
        findDispatchSwitch(findHandlerArrowBody(sf)),
      );
      expect(Array.from(dispatch.cases.keys())).toEqual([
        "gatedOp",
        "exemptOp",
      ]);
      expect(dispatch.hasDefault).toBe(true);
      expect(containsThrow(dispatch.defaultClause!)).toBe(true);
    });

    test("a switch on a different identifier is NOT mistaken for the dispatch switch", () => {
      const source = [
        "export const handler = async (event: unknown): Promise<unknown> => {",
        "  const fieldName = 'x';",
        "  switch (fieldName) {",
        '    case "realOp":',
        "      return null;",
        "    default:",
        "      throw new Error('nope');",
        "  }",
        "};",
        "function other(source: string): void {",
        "  switch (source) {",
        '    case "SCAN":',
        "      break;",
        "  }",
        "}",
      ].join("\n");
      const sf = parseSource(source, "two-switches.ts");
      const dispatch = extractDispatch(
        findDispatchSwitch(findHandlerArrowBody(sf)),
      );
      expect(Array.from(dispatch.cases.keys())).toEqual(["realOp"]);
    });
  });

  describe("if-chain dispatch extraction (task-runner / tool-approval shape)", () => {
    test("collectFieldNameComparisons derives the compared literals and operators", () => {
      const source = [
        "export const handler = async (event: unknown): Promise<unknown> => {",
        "  const fieldName = 'x';",
        '  if (fieldName !== "onlyOp") {',
        "    throw new Error(`Unsupported field: ${fieldName}`);",
        "  }",
        "  return await onlyOp(event);",
        "};",
      ].join("\n");
      const sf = parseSource(source, "if-dispatch.ts");
      const comparisons = collectFieldNameComparisons(findHandlerArrowBody(sf));
      expect(comparisons).toHaveLength(1);
      expect(comparisons[0].literal).toBe("onlyOp");
      expect(comparisons[0].operator).toBe("!==");
    });

    test("comparisons in comments/strings are not collected; reversed operand order is", () => {
      const source = [
        "export const handler = async (event: unknown): Promise<unknown> => {",
        "  const fieldName = 'x';",
        '  // if (fieldName === "decoyOp") — prose only',
        "  const s = 'fieldName === \"stringDecoy\"';",
        '  if ("reversedOp" === fieldName) {',
        "    return null;",
        "  }",
        "  return s;",
        "};",
      ].join("\n");
      const sf = parseSource(source, "if-dispatch-decoy.ts");
      const comparisons = collectFieldNameComparisons(findHandlerArrowBody(sf));
      expect(comparisons.map((c) => c.literal)).toEqual(["reversedOp"]);
    });
  });

  describe("supporting collectors", () => {
    test("collectNews finds `new PutCommand(...)` construction sites with positions", () => {
      const source = [
        "async function writeIt(): Promise<void> {",
        "  const gate = check();",
        "  await docClient.send(new PutCommand({ TableName: 't', Item: {} }));",
        "}",
      ].join("\n");
      const sf = parseSource(source, "news.ts");
      const body = functionBody(findTopLevelFunction(sf, "writeIt"));
      const news = collectNews(body, sf);
      expect(news.map((n) => n.className)).toContain("PutCommand");
      const calls = collectCalls(body, sf);
      const gate = calls.find((c) => c.callee === "check");
      expect(gate!.start).toBeLessThan(
        news.find((n) => n.className === "PutCommand")!.start,
      );
    });

    test("callReceivesStringLiteral matches exact literal arguments only", () => {
      const source = [
        "function f(): void {",
        '  hasPermission(authContext, "tool:approve");',
        '  hasRoleFromEvent(event, "architect");',
        "}",
      ].join("\n");
      const sf = parseSource(source, "literals.ts");
      const calls = collectCalls(
        functionBody(findTopLevelFunction(sf, "f")),
        sf,
      );
      const perm = calls.find((c) => c.callee === "hasPermission");
      expect(callReceivesStringLiteral(perm!.node, "tool:approve")).toBe(true);
      expect(callReceivesStringLiteral(perm!.node, "tool:invoke")).toBe(false);
      const role = calls.find((c) => c.callee === "hasRoleFromEvent");
      expect(callReceivesStringLiteral(role!.node, "architect")).toBe(true);
    });

    test("collectPropertyAssignments returns initializer text for the named property", () => {
      const source = [
        "function build(callerOrgId: string, input: { orgId?: string }): object {",
        "  return {",
        "    orgId: callerOrgId,",
        "    nested: { orgId: callerOrgId },",
        "    other: input.orgId,",
        "  };",
        "}",
      ].join("\n");
      const sf = parseSource(source, "props.ts");
      const assignments = collectPropertyAssignments(
        functionBody(findTopLevelFunction(sf, "build")),
        "orgId",
        sf,
      );
      expect(assignments).toEqual(["callerOrgId", "callerOrgId"]);
    });
  });
});
