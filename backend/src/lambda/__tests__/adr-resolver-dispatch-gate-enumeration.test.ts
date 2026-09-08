/**
 * Enumeration-completeness guard for adr-resolver.ts's dispatch switch
 * (finding 677c1a6c — the sixth instance of the class-closing move started
 * by registry-agent-record-resolver-dispatch-gate-enumeration.test.ts and
 * continued by app-publish-handler-dispatch-gate-enumeration.test.ts /
 * user-management-resolver-dispatch-gate-enumeration.test.ts /
 * agent-code-resolver-dispatch-gate-enumeration.test.ts /
 * tool-config-resolver-dispatch-gate-enumeration.test.ts).
 *
 * Root defect closed by finding 677c1a6c: createADR/getADR/
 * listADRsForProject (and the other adr-resolver mutations reachable via
 * this dispatch) gated only on hasPermission('adr:create'/'adr:reopen')
 * and trusted the client-supplied projectId with NO project-to-
 * organization reconciliation — a permitted user of one org could create
 * ADRs against, or read/list ADRs belonging to, another org's project.
 * The fix threads an OPTIONAL `event` parameter through every exported
 * function; the dispatch handler always supplies it, and each function
 * calls the shared `assertProjectOrgAccess` gate before any write (create/
 * supersede/reopen/lock) or before returning any data (get/list) — as an
 * ADDITIONAL check, not a replacement for hasPermission('adr:create'),
 * which remains in force.
 *
 * This handler's dispatch cases delegate to a DIRECT `await <fn>(...)`
 * call (not a dual registry/legacy path like tool-config-resolver), so
 * this guard's parser extracts ONE call site per case and verifies that
 * callee's own function body actually threads `event` to the handler AND
 * contains an `assertProjectOrgAccess(` call.
 */
import * as fs from "fs";
import * as path from "path";

const HANDLER_PATH = path.join(__dirname, "..", "adr-resolver.ts");

function extractDispatchCases(source: string): string[] {
  const switchStart = source.indexOf("switch (fieldName)");
  if (switchStart === -1) {
    throw new Error(
      "Could not locate `switch (fieldName)` in adr-resolver.ts — " +
        "dispatch structure changed; update this guard's parsing.",
    );
  }
  const defaultIdx = source.indexOf("default:", switchStart);
  if (defaultIdx === -1) {
    throw new Error(
      "Could not locate the dispatch switch's `default:` case — " +
        "update this guard's parsing.",
    );
  }
  const switchBody = source.slice(switchStart, defaultIdx);
  const caseRe = /case\s+['"]([^'"]+)['"]\s*:/g;
  const cases: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = caseRe.exec(switchBody)) !== null) {
    cases.push(m[1]);
  }
  return cases;
}

/** Slices out a single `case '<fieldName>': ... case` (or default) block. */
function extractCaseBody(source: string, fieldName: string): string {
  const switchStart = source.indexOf("switch (fieldName)");
  const defaultIdx = source.indexOf("default:", switchStart);
  const switchBody = source.slice(switchStart, defaultIdx);

  const caseIdx =
    switchBody.indexOf(`case '${fieldName}'`) !== -1
      ? switchBody.indexOf(`case '${fieldName}'`)
      : switchBody.indexOf(`case "${fieldName}"`);
  if (caseIdx === -1) {
    throw new Error(`Could not locate case '${fieldName}' in dispatch switch`);
  }
  const nextCaseIdx = switchBody.indexOf("case ", caseIdx + 1);
  return switchBody.slice(
    caseIdx,
    nextCaseIdx === -1 ? undefined : nextCaseIdx,
  );
}

/** Extracts every `await <fnName>(` call site name inside a case body. */
function extractCallSiteNames(caseBody: string): string[] {
  const callRe = /await\s+([A-Za-z0-9_]+)\s*\(/g;
  const names: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = callRe.exec(caseBody)) !== null) {
    names.push(m[1]);
  }
  return names;
}

/**
 * Extracts a top-level `(export )?async function <name>(...) { ... }` body
 * by brace-counting from the function keyword, matching the parameter
 * list's closing paren first (return-type annotations here are simple
 * `Promise<ADR>` / `Promise<ADR | null>` / `Promise<ADR[]>` shapes with no
 * nested braces, so the body's opening brace is simply the first `{` after
 * the parameter list closes).
 */
function extractFunctionBody(source: string, fnName: string): string {
  const declRe = new RegExp(
    `(?:export\\s+)?async function ${fnName}\\b\\s*\\(`,
  );
  const declMatch = declRe.exec(source);
  if (!declMatch) {
    throw new Error(
      `Could not locate function declaration for '${fnName}' in adr-resolver.ts`,
    );
  }
  const paramsOpenIdx = source.indexOf("(", declMatch.index);
  let parenDepth = 0;
  let j = paramsOpenIdx;
  for (; j < source.length; j++) {
    if (source[j] === "(") parenDepth++;
    else if (source[j] === ")") {
      parenDepth--;
      if (parenDepth === 0) break;
    }
  }
  const bodyStart = source.indexOf("{", j);
  let depth = 0;
  let i = bodyStart;
  for (; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  return source.slice(bodyStart, i + 1);
}

const GATE_CALL_RE = /assertProjectOrgAccess\s*\(/;
const EVENT_PARAM_RE = /event\?\s*:\s*unknown/;

/**
 * Every op on this dispatch surface calls assertProjectOrgAccess in its own
 * function body (createADR, supersedeADR, reopenADR, getADR,
 * listADRsForProject). `lockADR` is NOT reachable from this dispatch (no
 * top-level GraphQL mutation exposes it per its own docblock) so it is not
 * a dispatch case and is intentionally absent from both lists — it is
 * covered by unit tests in adr-resolver.test.ts / adr-resolver-org-
 * scoping.test.ts directly instead.
 */
const GATED_OPS: Record<string, { fn: string }> = {
  createADR: { fn: "createADR" },
  supersedeADR: { fn: "supersedeADR" },
  reopenADR: { fn: "reopenADR" },
  getADR: { fn: "getADR" },
  listADRsForProject: { fn: "listADRsForProject" },
};

/**
 * No case on this dispatch surface is legitimately exempt — every op reads
 * or writes governance data scoped to a projectId, so every op must
 * reconcile the caller's org. Kept as an empty object (rather than omitted)
 * so the "every case is accounted for" test below has a home to point at
 * if a genuinely exempt case is ever added.
 */
const EXEMPT_OPS: Record<string, string> = {};

describe("adr-resolver — dispatch enumeration completeness", () => {
  const source = fs.readFileSync(HANDLER_PATH, "utf-8");
  const cases = extractDispatchCases(source);

  test("the dispatch switch actually has cases to check (sanity check on the parser itself)", () => {
    expect(cases.length).toBeGreaterThanOrEqual(5);
    expect(cases).toEqual(
      expect.arrayContaining([
        "createADR",
        "supersedeADR",
        "reopenADR",
        "getADR",
        "listADRsForProject",
      ]),
    );
  });

  test("every dispatch case is accounted for in GATED_OPS or EXEMPT_OPS", () => {
    const unaccounted = cases.filter(
      (c) => !(c in GATED_OPS) && !(c in EXEMPT_OPS),
    );
    expect(unaccounted).toEqual([]);
  });

  test("GATED_OPS and EXEMPT_OPS do not both claim the same op", () => {
    const overlap = Object.keys(GATED_OPS).filter((k) => k in EXEMPT_OPS);
    expect(overlap).toEqual([]);
  });

  test("no GATED_OPS/EXEMPT_OPS entry references a case that no longer exists in the switch", () => {
    const known = new Set(cases);
    const staleGated = Object.keys(GATED_OPS).filter((k) => !known.has(k));
    const staleExempt = Object.keys(EXEMPT_OPS).filter((k) => !known.has(k));
    expect(staleGated).toEqual([]);
    expect(staleExempt).toEqual([]);
  });

  test("lockADR is not a dispatch case (documented as internal-only) and is absent from both lists", () => {
    expect(cases).not.toContain("lockADR");
    expect("lockADR" in GATED_OPS).toBe(false);
    expect("lockADR" in EXEMPT_OPS).toBe(false);
  });

  describe.each(Object.entries(GATED_OPS))(
    "GATED_OPS['%s'] dispatches to a function that threads `event` and calls assertProjectOrgAccess",
    (fieldName, meta) => {
      test(`${fieldName}'s case dispatches to ${meta.fn}`, () => {
        const caseBody = extractCaseBody(source, fieldName);
        const callSites = extractCallSiteNames(caseBody);
        expect(callSites).toContain(meta.fn);
      });

      test(`${fieldName}'s case passes \`event\` as the final argument to ${meta.fn}`, () => {
        const caseBody = extractCaseBody(source, fieldName);
        const callRe = new RegExp(
          `${meta.fn}\\s*\\([^;]*?\\bevent\\b[^;]*?\\)`,
        );
        expect(callRe.test(caseBody)).toBe(true);
      });

      test(`${meta.fn}'s declaration accepts an optional \`event?: unknown\` parameter`, () => {
        const declRe = new RegExp(
          `(?:export\\s+)?async function ${meta.fn}\\b\\s*\\(([^)]*)\\)`,
        );
        const m = declRe.exec(source);
        expect(m).not.toBeNull();
        expect(EVENT_PARAM_RE.test((m as RegExpExecArray)[1])).toBe(true);
      });

      test(`${meta.fn}'s function body contains an assertProjectOrgAccess call`, () => {
        const body = extractFunctionBody(source, meta.fn);
        expect(GATE_CALL_RE.test(body)).toBe(true);
      });
    },
  );

  describe("write-path ops gate BEFORE their DynamoDB write side effect", () => {
    test("createADR's gate call precedes its PutCommand", () => {
      const body = extractFunctionBody(source, "createADR");
      const gateIdx = body.search(GATE_CALL_RE);
      const putIdx = body.indexOf("new PutCommand(");
      expect(gateIdx).toBeGreaterThan(-1);
      expect(putIdx).toBeGreaterThan(-1);
      expect(gateIdx).toBeLessThan(putIdx);
    });

    test("supersedeADR's gate call precedes its UpdateCommand", () => {
      const body = extractFunctionBody(source, "supersedeADR");
      const gateIdx = body.search(GATE_CALL_RE);
      const updateIdx = body.indexOf("new UpdateCommand(");
      expect(gateIdx).toBeGreaterThan(-1);
      expect(updateIdx).toBeGreaterThan(-1);
      expect(gateIdx).toBeLessThan(updateIdx);
    });

    test("reopenADR's gate call precedes its audit-table PutCommand (Step 2)", () => {
      const body = extractFunctionBody(source, "reopenADR");
      const gateIdx = body.search(GATE_CALL_RE);
      const auditPutIdx = body.indexOf("new PutCommand(");
      expect(gateIdx).toBeGreaterThan(-1);
      expect(auditPutIdx).toBeGreaterThan(-1);
      expect(gateIdx).toBeLessThan(auditPutIdx);
    });
  });

  describe("read-path ops return nothing before the gate resolves", () => {
    test("getADR's gate call precedes its `return adr` statement", () => {
      const body = extractFunctionBody(source, "getADR");
      const gateIdx = body.search(GATE_CALL_RE);
      const returnIdx = body.lastIndexOf("return adr;");
      expect(gateIdx).toBeGreaterThan(-1);
      expect(returnIdx).toBeGreaterThan(-1);
      expect(gateIdx).toBeLessThan(returnIdx);
    });

    test("listADRsForProject's gate call precedes its QueryCommand (no foreign-data read at all)", () => {
      const body = extractFunctionBody(source, "listADRsForProject");
      const gateIdx = body.search(GATE_CALL_RE);
      const queryIdx = body.indexOf("new QueryCommand(");
      expect(gateIdx).toBeGreaterThan(-1);
      expect(queryIdx).toBeGreaterThan(-1);
      expect(gateIdx).toBeLessThan(queryIdx);
    });
  });

  test("handler's hasPermission('adr:create') check is not removed by this fix (additive, not a replacement)", () => {
    expect(source).toMatch(/hasPermission\(authContext, ['"]adr:create['"]\)/);
    expect(source).toMatch(/hasPermission\(authContext, ['"]adr:reopen['"]\)/);
  });
});
