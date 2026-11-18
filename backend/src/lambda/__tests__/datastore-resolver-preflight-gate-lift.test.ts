/**
 * Citadel PR-1 — C2: datastore-resolver must invoke adapter.preflight
 * UNCONDITIONALLY — not only when requiredPolicies(...) returns a non-empty
 * policy list. The KnowledgeBaseAdapter's connect policies are empty
 * whenever knowledgeBaseId/collectionId are absent from config (CIT-299),
 * which previously meant preflight was skipped entirely on that path,
 * silently defeating the ownership check this PR adds.
 *
 * This is a regression guard at the source level (AST), since the full
 * createDataStore/connectDataStore integration paths already have end-to-end
 * coverage elsewhere (datastore-resolver-preflight-rollback.test.ts) that
 * exercises the S3 adapter, whose connect policies are never empty.
 */
import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";

const HANDLER_PATH = path.join(__dirname, "..", "datastore-resolver.ts");

function findFunction(sf: ts.SourceFile, name: string): ts.FunctionDeclaration {
  let found: ts.FunctionDeclaration | undefined;
  sf.forEachChild((n) => {
    if (ts.isFunctionDeclaration(n) && n.name?.text === name) found = n;
  });
  if (!found) throw new Error(`function ${name} not found`);
  return found;
}

function collectCallTexts(node: ts.Node, sf: ts.SourceFile): string[] {
  const out: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      out.push(n.getText(sf));
    }
    n.forEachChild(visit);
  };
  visit(node);
  return out;
}

/**
 * Find the `if (adapter.preflight) { ... }` block and determine whether it
 * is nested INSIDE an `if (policies.length > 0)` block (the bug this test
 * guards against) or is a sibling/ancestor-independent statement.
 */
function preflightGuardIsNestedInPolicyGate(
  fnBody: ts.Node,
  sf: ts.SourceFile,
): boolean {
  let nested = false;
  const visit = (n: ts.Node, insidePolicyGate: boolean): void => {
    if (
      ts.isIfStatement(n) &&
      n.expression.getText(sf).includes("policies.length > 0")
    ) {
      insidePolicyGate = true;
    }
    if (
      ts.isIfStatement(n) &&
      n.expression.getText(sf).includes("adapter.preflight")
    ) {
      if (insidePolicyGate) nested = true;
    }
    n.forEachChild((child) => visit(child, insidePolicyGate));
  };
  visit(fnBody, false);
  return nested;
}

describe("datastore-resolver — C2 preflight gate-lift (source-level guard)", () => {
  const source = fs.readFileSync(HANDLER_PATH, "utf-8");
  const sf = ts.createSourceFile(
    "datastore-resolver.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );

  test("createDataStore's adapter.preflight check is NOT nested inside the policies.length > 0 gate", () => {
    const fn = findFunction(sf, "createDataStore");
    expect(preflightGuardIsNestedInPolicyGate(fn.body!, sf)).toBe(false);
  });

  test("connectDataStore's adapter.preflight check is NOT nested inside the policies.length > 0 gate", () => {
    const fn = findFunction(sf, "connectDataStore");
    expect(preflightGuardIsNestedInPolicyGate(fn.body!, sf)).toBe(false);
  });

  test("createDataStore still calls adapter.preflight when it is defined", () => {
    const fn = findFunction(sf, "createDataStore");
    const calls = collectCallTexts(fn.body!, sf);
    expect(calls.some((c) => c.includes("adapter.preflight"))).toBe(true);
  });

  test("connectDataStore still calls adapter.preflight when it is defined", () => {
    const fn = findFunction(sf, "connectDataStore");
    const calls = collectCallTexts(fn.body!, sf);
    expect(calls.some((c) => c.includes("adapter.preflight"))).toBe(true);
  });

  test("createDataStore injects config.dataStoreId/orgId BEFORE the preflight call (ordering)", () => {
    const fn = findFunction(sf, "createDataStore");
    const text = fn.body!.getText(sf);
    const idInjectionIdx = text.indexOf("config.dataStoreId = dataStoreId");
    const preflightIdx = text.indexOf("adapter.preflight");
    expect(idInjectionIdx).toBeGreaterThanOrEqual(0);
    expect(preflightIdx).toBeGreaterThanOrEqual(0);
    expect(idInjectionIdx).toBeLessThan(preflightIdx);
  });
});
