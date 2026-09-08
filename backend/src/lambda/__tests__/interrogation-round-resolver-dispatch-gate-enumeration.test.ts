/**
 * Enumeration-completeness guard for interrogation-round-resolver.ts's
 * dispatch switch (finding 2c262386 — module 3/4, guard 9 in the series).
 *
 * Root defect closed by finding 2c262386 (this module): stabiliseRound
 * writes a governance transcript to S3 (encrypted, carries PII) and sets
 * TERMINAL state (STABILISED) on a foreign round, gated only on
 * hasPermission('adr:create') with no project-to-organization
 * reconciliation of the client-supplied projectId. The fix threads an
 * OPTIONAL `event` parameter through every exported function; the
 * dispatch handler always supplies it. This guard also asserts
 * stabiliseRound's gate call precedes BOTH the S3 PutObjectCommand AND the
 * idempotent-STABILISED early-return.
 */
import * as fs from "fs";
import * as path from "path";

const HANDLER_PATH = path.join(
  __dirname,
  "..",
  "interrogation-round-resolver.ts",
);

function extractDispatchCases(source: string): string[] {
  const switchStart = source.indexOf("switch (fieldName)");
  if (switchStart === -1) {
    throw new Error(
      "Could not locate `switch (fieldName)` in interrogation-round-resolver.ts — " +
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

function extractCallSiteNames(caseBody: string): string[] {
  const callRe = /await\s+([A-Za-z0-9_]+)\s*\(/g;
  const names: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = callRe.exec(caseBody)) !== null) {
    names.push(m[1]);
  }
  return names;
}

function extractFunctionBody(source: string, fnName: string): string {
  const declRe = new RegExp(
    `(?:export\\s+)?async function ${fnName}\\b\\s*\\(`,
  );
  const declMatch = declRe.exec(source);
  if (!declMatch) {
    throw new Error(
      `Could not locate function declaration for '${fnName}' in interrogation-round-resolver.ts`,
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

const GATED_OPS: Record<string, { fn: string }> = {
  startInterrogationRound: { fn: "startInterrogationRound" },
  injectConstraints: { fn: "injectConstraints" },
  stabiliseRound: { fn: "stabiliseRound" },
  getInterrogationRound: { fn: "getInterrogationRound" },
  listInterrogationRounds: { fn: "listInterrogationRounds" },
};

const EXEMPT_OPS: Record<string, string> = {};

describe("interrogation-round-resolver — dispatch enumeration completeness", () => {
  const source = fs.readFileSync(HANDLER_PATH, "utf-8");
  const cases = extractDispatchCases(source);

  test("the dispatch switch actually has cases to check (sanity check on the parser itself)", () => {
    expect(cases.length).toBeGreaterThanOrEqual(5);
    expect(cases).toEqual(expect.arrayContaining(Object.keys(GATED_OPS)));
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

  describe.each(Object.entries(GATED_OPS))(
    "GATED_OPS['%s'] dispatches to a function that threads `event` and calls assertProjectOrgAccess",
    (fieldName, meta) => {
      test(`${fieldName}'s case dispatches to ${meta.fn}`, () => {
        const caseBody = extractCaseBody(source, fieldName);
        const callSites = extractCallSiteNames(caseBody);
        expect(callSites).toContain(meta.fn);
      });

      test(`${fieldName}'s case passes \`event\` as an argument to ${meta.fn}`, () => {
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

  describe("stabiliseRound gates before every state-changing side effect", () => {
    test("stabiliseRound's gate call precedes the idempotent-STABILISED early-return", () => {
      const body = extractFunctionBody(source, "stabiliseRound");
      const gateIdx = body.search(GATE_CALL_RE);
      const earlyReturnMatch =
        /current\.status\s*===\s*['"]STABILISED['"]/.exec(body);
      expect(gateIdx).toBeGreaterThan(-1);
      expect(earlyReturnMatch).not.toBeNull();
      expect(gateIdx).toBeLessThan((earlyReturnMatch as RegExpExecArray).index);
    });

    test("stabiliseRound's gate call precedes the S3 PutObjectCommand (transcript write)", () => {
      const body = extractFunctionBody(source, "stabiliseRound");
      const gateIdx = body.search(GATE_CALL_RE);
      const putObjectIdx = body.indexOf("new PutObjectCommand(");
      expect(gateIdx).toBeGreaterThan(-1);
      expect(putObjectIdx).toBeGreaterThan(-1);
      expect(gateIdx).toBeLessThan(putObjectIdx);
    });

    test("stabiliseRound's gate call precedes the terminal UpdateCommand", () => {
      const body = extractFunctionBody(source, "stabiliseRound");
      const gateIdx = body.search(GATE_CALL_RE);
      const updateIdx = body.indexOf("new UpdateCommand(");
      expect(gateIdx).toBeGreaterThan(-1);
      expect(updateIdx).toBeGreaterThan(-1);
      expect(gateIdx).toBeLessThan(updateIdx);
    });
  });

  describe("other write-path ops gate BEFORE their DynamoDB write side effect", () => {
    test("startInterrogationRound's gate call precedes its PutCommand", () => {
      const body = extractFunctionBody(source, "startInterrogationRound");
      const gateIdx = body.search(GATE_CALL_RE);
      const putIdx = body.indexOf("new PutCommand(");
      expect(gateIdx).toBeGreaterThan(-1);
      expect(putIdx).toBeGreaterThan(-1);
      expect(gateIdx).toBeLessThan(putIdx);
    });

    test("injectConstraints's gate call precedes its UpdateCommand", () => {
      const body = extractFunctionBody(source, "injectConstraints");
      const gateIdx = body.search(GATE_CALL_RE);
      const updateIdx = body.indexOf("new UpdateCommand(");
      expect(gateIdx).toBeGreaterThan(-1);
      expect(updateIdx).toBeGreaterThan(-1);
      expect(gateIdx).toBeLessThan(updateIdx);
    });
  });

  describe("read-path ops return/query nothing before the gate resolves", () => {
    test("getInterrogationRound's gate call precedes its `return round` statement", () => {
      const body = extractFunctionBody(source, "getInterrogationRound");
      const gateIdx = body.search(GATE_CALL_RE);
      const returnIdx = body.lastIndexOf("return round;");
      expect(gateIdx).toBeGreaterThan(-1);
      expect(returnIdx).toBeGreaterThan(-1);
      expect(gateIdx).toBeLessThan(returnIdx);
    });

    test("listInterrogationRounds's gate call precedes its QueryCommand (no foreign-data read at all)", () => {
      const body = extractFunctionBody(source, "listInterrogationRounds");
      const gateIdx = body.search(GATE_CALL_RE);
      const queryIdx = body.indexOf("new QueryCommand(");
      expect(gateIdx).toBeGreaterThan(-1);
      expect(queryIdx).toBeGreaterThan(-1);
      expect(gateIdx).toBeLessThan(queryIdx);
    });
  });

  test("handler's hasPermission('adr:create') check is not removed by this fix (additive, not a replacement)", () => {
    expect(source).toMatch(/hasPermission\(authContext, ['"]adr:create['"]\)/);
  });
});
