/**
 * Enumeration-completeness guard for document-upload-resolver.ts's
 * dispatch switch (finding 41c1cd9b — completes the dispatch
 * gate-enumeration family). Modeled on the dispatch gate-enumeration
 * siblings via the shared AST helpers
 * (fixtures/dispatch-gate-ast-helpers.ts).
 *
 * Classification — every op is ORG-RECONCILED (assertProjectAccess,
 * finding 60a5a6ae CRE item 1): every field acts on a client-supplied
 * projectId used to build S3 keys (write for generateDocumentUploadUrl —
 * the worst case, since a cross-tenant write feeds the knowledge base),
 * so each case clause reconciles projectId against the caller via the
 * shared assertProjectAccess gate BEFORE calling its delegate. The gate
 * sits in the CASE CLAUSE here (not inside the delegates), so the bite
 * assertion orders the clause's gate call against the clause's delegate
 * call.
 *
 * getDocumentIngestionStatus note (pinned in the source comment): the
 * delegate derives its S3-facing projectId from the documentKey prefix,
 * but the gate checks args.projectId — the schema-supplied value — so the
 * check never trusts a value assembled from the same untrusted key.
 */
import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";
import {
  callReceivesBareEvent,
  collectCalls,
  containsThrow,
  extractDispatch,
  findDispatchSwitch,
  findHandlerArrowBody,
  parseSource,
} from "./fixtures/dispatch-gate-ast-helpers";

const HANDLER_PATH = path.join(__dirname, "..", "document-upload-resolver.ts");

/** Every op, with its delegate and the argument expression the gate receives. */
const ORG_RECONCILED_OPS: Record<string, { fn: string; gateArg: string }> = {
  generateDocumentUploadUrl: {
    fn: "generateUploadUrl",
    gateArg: "args.input.projectId",
  },
  listProjectDocuments: {
    fn: "listProjectDocuments",
    gateArg: "args.projectId",
  },
  getDocumentIngestionStatus: {
    fn: "getDocumentIngestionStatus",
    gateArg: "args.projectId",
  },
  deleteDocument: {
    fn: "deleteDocument",
    gateArg: "args.projectId",
  },
};

describe("document-upload-resolver — dispatch enumeration completeness", () => {
  const source = fs.readFileSync(HANDLER_PATH, "utf-8");
  const sf = parseSource(source, "document-upload-resolver.ts");
  const handlerBody = findHandlerArrowBody(sf);
  const dispatch = extractDispatch(findDispatchSwitch(handlerBody));
  const caseNames = Array.from(dispatch.cases.keys());

  test("the dispatch switch actually has cases to check (sanity check on the parser itself)", () => {
    expect(caseNames.length).toBeGreaterThanOrEqual(4);
    expect(caseNames).toEqual(
      expect.arrayContaining(["generateDocumentUploadUrl", "deleteDocument"]),
    );
  });

  test("every dispatch case is accounted for in ORG_RECONCILED_OPS", () => {
    const unaccounted = caseNames.filter((c) => !(c in ORG_RECONCILED_OPS));
    expect(unaccounted).toEqual([]);
  });

  test("no classification entry references a case that no longer exists in the switch", () => {
    const known = new Set(caseNames);
    const stale = Object.keys(ORG_RECONCILED_OPS).filter((k) => !known.has(k));
    expect(stale).toEqual([]);
  });

  test("the classification table covers exactly the dispatch surface", () => {
    expect(Object.keys(ORG_RECONCILED_OPS).length).toBe(caseNames.length);
  });

  test("the dispatch default clause throws on unknown fields (fails closed)", () => {
    expect(dispatch.hasDefault).toBe(true);
    expect(containsThrow(dispatch.defaultClause as ts.Node)).toBe(true);
  });

  describe.each(Object.entries(ORG_RECONCILED_OPS))(
    "ORG_RECONCILED_OPS['%s'] (assertProjectAccess in the case clause)",
    (fieldName, meta) => {
      test(`case '${fieldName}' calls assertProjectAccess(${meta.gateArg}, <userId>, event)`, () => {
        const clause = dispatch.cases.get(fieldName);
        expect(clause).toBeDefined();
        const calls = collectCalls(clause as ts.Node, sf);
        const gates = calls.filter((c) => c.callee === "assertProjectAccess");
        expect(gates.length).toBeGreaterThanOrEqual(1);
        expect(gates.some((c) => callReceivesBareEvent(c.node))).toBe(true);
        // The gate must check the schema-supplied projectId expression, not
        // a value derived from another untrusted argument.
        expect(
          gates.some((c) =>
            c.node.arguments.some((a) => a.getText(sf) === meta.gateArg),
          ),
        ).toBe(true);
      });

      test(`the assertProjectAccess gate precedes the ${meta.fn} delegate call (bite: ordering)`, () => {
        const clause = dispatch.cases.get(fieldName);
        const calls = collectCalls(clause as ts.Node, sf);
        const gates = calls.filter((c) => c.callee === "assertProjectAccess");
        const targets = calls.filter((c) => c.callee === meta.fn);
        expect(gates.length).toBeGreaterThanOrEqual(1);
        expect(targets.length).toBeGreaterThanOrEqual(1);
        expect(Math.min(...gates.map((c) => c.start))).toBeLessThan(
          Math.min(...targets.map((c) => c.start)),
        );
      });
    },
  );
});
