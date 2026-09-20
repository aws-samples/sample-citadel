/**
 * Gate-enumeration guard for generate-report-url.ts's single-field dispatch
 * surface (finding 13f1f782 — completes the dispatch gate-enumeration
 * family for this resolver, mirroring the PR #174/#176 shape via the shared
 * AST helpers in fixtures/dispatch-gate-ast-helpers.ts).
 *
 * Unlike the multi-field resolvers (document-upload-resolver,
 * document-resolver), generate-report-url.ts has no `switch (fieldName)` —
 * it backs a single Query field (`generateReportDownloadUrl`) via a bare
 * `export const handler = async (event) => {...}`. This guard derives the
 * handler body directly (findHandlerArrowBody) rather than a dispatch
 * switch, and asserts the ONE op reconciles the client-supplied projectId
 * against the caller via assertProjectAccess BEFORE the DynamoDB read
 * (GetCommand) and the S3 presign (getSignedUrl) — the fix for finding
 * 13f1f782 (a cross-tenant caller could presign and read any project's
 * assessment report).
 *
 * Per backend/test/dispatch-gate-coverage-guard.test.ts, this guard's
 * existence is what removes generate-report-url from that meta-guard's
 * DOCUMENTED_EXEMPTIONS — the module is now classified as guarded.
 */
import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";
import {
  collectCalls,
  findHandlerArrowBody,
  parseSource,
} from "./fixtures/dispatch-gate-ast-helpers";

const HANDLER_PATH = path.join(__dirname, "..", "generate-report-url.ts");

describe("generate-report-url — dispatch enumeration completeness (single-field surface)", () => {
  const source = fs.readFileSync(HANDLER_PATH, "utf-8");
  const sf = parseSource(source, "generate-report-url.ts");
  const handlerBody = findHandlerArrowBody(sf);

  test("the handler has no fieldName dispatch switch (sanity check on the parser/handler shape)", () => {
    let hasSwitch = false;
    const walk = (n: ts.Node) => {
      if (ts.isSwitchStatement(n)) hasSwitch = true;
      n.forEachChild(walk);
    };
    walk(handlerBody);
    expect(hasSwitch).toBe(false);
  });

  test("this is the ONE op on the dispatch surface: generateReportDownloadUrl (Query, single field, no other cases to account for)", () => {
    // Sanity-checks the guard itself is scoped to a real op, not vacuous.
    expect(source).toContain("export const handler");
    expect(source).toContain("event.arguments");
  });

  test("the handler calls assertProjectAccess(projectId, userId, event)", () => {
    const calls = collectCalls(handlerBody, sf);
    const gates = calls.filter((c) => c.callee === "assertProjectAccess");
    expect(gates.length).toBeGreaterThanOrEqual(1);
    expect(
      gates.some((c) =>
        c.node.arguments.some((a) => a.getText(sf) === "projectId"),
      ),
    ).toBe(true);
  });

  test("bite (ordering): assertProjectAccess precedes the DynamoDB read (GetCommand) and the S3 presign (getSignedUrl)", () => {
    const calls = collectCalls(handlerBody, sf);
    const gates = calls.filter((c) => c.callee === "assertProjectAccess");
    const ddbReads = calls.filter((c) => c.callee === "docClient.send");
    const presigns = calls.filter((c) => c.callee === "getSignedUrl");

    expect(gates.length).toBeGreaterThanOrEqual(1);
    expect(ddbReads.length).toBeGreaterThanOrEqual(1);
    expect(presigns.length).toBeGreaterThanOrEqual(1);

    const gateStart = Math.min(...gates.map((c) => c.start));
    expect(gateStart).toBeLessThan(Math.min(...ddbReads.map((c) => c.start)));
    expect(gateStart).toBeLessThan(Math.min(...presigns.map((c) => c.start)));
  });

  test("the gate receives the schema-supplied projectId, not a value derived elsewhere", () => {
    const calls = collectCalls(handlerBody, sf);
    const gates = calls.filter((c) => c.callee === "assertProjectAccess");
    const gateArgTexts = gates.flatMap((c) =>
      c.node.arguments.map((a) => a.getText(sf)),
    );
    expect(gateArgTexts).toContain("projectId");
  });
});
