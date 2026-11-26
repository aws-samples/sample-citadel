/**
 * Enumeration-completeness guard for execspec-resolver.ts's dispatch switch
 * (finding 2c262386 — module 1/4, guard 7 in the series continued from
 * adr-resolver-dispatch-gate-enumeration.test.ts / finding 677c1a6c).
 *
 * Root defect closed by finding 2c262386 (this module): approve/revise/
 * submit/reject ExecutionSpecification (and the get/list queries) gated
 * only on hasPermission('spec:approve') and trusted the client-supplied/
 * fetched projectId with NO project-to-organization reconciliation — an
 * architect in one org could approve or rewrite another org's governance
 * execution spec by specId. The fix threads an OPTIONAL `event` parameter
 * through every exported function; the dispatch handler always supplies
 * it, and each function calls the shared `assertProjectOrgAccess` gate
 * before any write or before returning any data — as an ADDITIONAL check,
 * not a replacement for hasPermission('spec:approve'), which remains in
 * force.
 *
 * This handler's dispatch cases delegate to a DIRECT `await <fn>(...)`
 * call, so this guard's parser extracts ONE call site per case and
 * verifies that callee's own function body actually threads `event` to
 * the handler AND contains an `assertProjectOrgAccess(` call.
 */
import * as fs from 'fs';
import * as path from 'path';

const HANDLER_PATH = path.join(__dirname, '..', 'execspec-resolver.ts');

function extractDispatchCases(source: string): string[] {
  const switchStart = source.indexOf('switch (fieldName)');
  if (switchStart === -1) {
    throw new Error(
      'Could not locate `switch (fieldName)` in execspec-resolver.ts — ' +
        "dispatch structure changed; update this guard's parsing.",
    );
  }
  const defaultIdx = source.indexOf('default:', switchStart);
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
  const switchStart = source.indexOf('switch (fieldName)');
  const defaultIdx = source.indexOf('default:', switchStart);
  const switchBody = source.slice(switchStart, defaultIdx);

  const caseIdx =
    switchBody.indexOf(`case '${fieldName}'`) !== -1
      ? switchBody.indexOf(`case '${fieldName}'`)
      : switchBody.indexOf(`case "${fieldName}"`);
  if (caseIdx === -1) {
    throw new Error(`Could not locate case '${fieldName}' in dispatch switch`);
  }
  const nextCaseIdx = switchBody.indexOf('case ', caseIdx + 1);
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
 * Extracts a top-level `export async function <name>(...) { ... }` body by
 * brace-counting from the function keyword, matching the parameter list's
 * closing paren first.
 */
function extractFunctionBody(source: string, fnName: string): string {
  const declRe = new RegExp(
    `(?:export\\s+)?async function ${fnName}\\b\\s*\\(`,
  );
  const declMatch = declRe.exec(source);
  if (!declMatch) {
    throw new Error(
      `Could not locate function declaration for '${fnName}' in execspec-resolver.ts`,
    );
  }
  const paramsOpenIdx = source.indexOf('(', declMatch.index);
  let parenDepth = 0;
  let j = paramsOpenIdx;
  for (; j < source.length; j++) {
    if (source[j] === '(') parenDepth++;
    else if (source[j] === ')') {
      parenDepth--;
      if (parenDepth === 0) break;
    }
  }
  const bodyStart = source.indexOf('{', j);
  let depth = 0;
  let i = bodyStart;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
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
 * function body.
 */
const GATED_OPS: Record<string, { fn: string }> = {
  createExecutionSpecification: { fn: 'createExecutionSpecification' },
  submitExecutionSpecification: { fn: 'submitExecutionSpecification' },
  approveExecutionSpecification: { fn: 'approveExecutionSpecification' },
  rejectExecutionSpecification: { fn: 'rejectExecutionSpecification' },
  reviseExecutionSpecification: { fn: 'reviseExecutionSpecification' },
  getExecutionSpecification: { fn: 'getExecutionSpecification' },
  listExecutionSpecifications: { fn: 'listExecutionSpecifications' },
};

/**
 * No case on this dispatch surface is legitimately exempt — every op reads
 * or writes governance data scoped to a projectId, so every op must
 * reconcile the caller's org.
 */
const EXEMPT_OPS: Record<string, string> = {};

describe('execspec-resolver — dispatch enumeration completeness', () => {
  const source = fs.readFileSync(HANDLER_PATH, 'utf-8');
  const cases = extractDispatchCases(source);

  test('the dispatch switch actually has cases to check (sanity check on the parser itself)', () => {
    expect(cases.length).toBeGreaterThanOrEqual(7);
    expect(cases).toEqual(
      expect.arrayContaining(Object.keys(GATED_OPS)),
    );
  });

  test('every dispatch case is accounted for in GATED_OPS or EXEMPT_OPS', () => {
    const unaccounted = cases.filter(
      (c) => !(c in GATED_OPS) && !(c in EXEMPT_OPS),
    );
    expect(unaccounted).toEqual([]);
  });

  test('GATED_OPS and EXEMPT_OPS do not both claim the same op', () => {
    const overlap = Object.keys(GATED_OPS).filter((k) => k in EXEMPT_OPS);
    expect(overlap).toEqual([]);
  });

  test('no GATED_OPS/EXEMPT_OPS entry references a case that no longer exists in the switch', () => {
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

  describe('write-path ops gate BEFORE their DynamoDB write side effect', () => {
    test("createExecutionSpecification's gate call precedes its PutCommand", () => {
      const body = extractFunctionBody(source, 'createExecutionSpecification');
      const gateIdx = body.search(GATE_CALL_RE);
      const putIdx = body.indexOf('new PutCommand(');
      expect(gateIdx).toBeGreaterThan(-1);
      expect(putIdx).toBeGreaterThan(-1);
      expect(gateIdx).toBeLessThan(putIdx);
    });

    test("approveExecutionSpecification's gate call precedes its updateStatus call (sharpest op)", () => {
      const body = extractFunctionBody(source, 'approveExecutionSpecification');
      const gateIdx = body.search(GATE_CALL_RE);
      const updateIdx = body.indexOf('updateStatus(');
      expect(gateIdx).toBeGreaterThan(-1);
      expect(updateIdx).toBeGreaterThan(-1);
      expect(gateIdx).toBeLessThan(updateIdx);
    });

    test("reviseExecutionSpecification's gate call precedes its updateStatus call", () => {
      const body = extractFunctionBody(source, 'reviseExecutionSpecification');
      const gateIdx = body.search(GATE_CALL_RE);
      const updateIdx = body.indexOf('updateStatus(');
      expect(gateIdx).toBeGreaterThan(-1);
      expect(updateIdx).toBeGreaterThan(-1);
      expect(gateIdx).toBeLessThan(updateIdx);
    });

    test("submitExecutionSpecification's gate call precedes its updateStatus call", () => {
      const body = extractFunctionBody(source, 'submitExecutionSpecification');
      const gateIdx = body.search(GATE_CALL_RE);
      const updateIdx = body.indexOf('updateStatus(');
      expect(gateIdx).toBeGreaterThan(-1);
      expect(updateIdx).toBeGreaterThan(-1);
      expect(gateIdx).toBeLessThan(updateIdx);
    });

    test("rejectExecutionSpecification's gate call precedes its updateStatus call, but follows the pre-existing audit-before-auth emit", () => {
      const body = extractFunctionBody(source, 'rejectExecutionSpecification');
      const gateIdx = body.search(GATE_CALL_RE);
      const updateIdx = body.indexOf('updateStatus(');
      const emitIdx = body.indexOf('emitGovernanceEvent(');
      expect(gateIdx).toBeGreaterThan(-1);
      expect(updateIdx).toBeGreaterThan(-1);
      expect(emitIdx).toBeGreaterThan(-1);
      // Gate must come AFTER the audit emit (preserving audit-before-auth)
      // and BEFORE the terminal write.
      expect(emitIdx).toBeLessThan(gateIdx);
      expect(gateIdx).toBeLessThan(updateIdx);
    });
  });

  describe('read-path ops return/query nothing before the gate resolves', () => {
    test("getExecutionSpecification's gate call precedes its `return spec` statement", () => {
      const body = extractFunctionBody(source, 'getExecutionSpecification');
      const gateIdx = body.search(GATE_CALL_RE);
      const returnIdx = body.lastIndexOf('return spec;');
      expect(gateIdx).toBeGreaterThan(-1);
      expect(returnIdx).toBeGreaterThan(-1);
      expect(gateIdx).toBeLessThan(returnIdx);
    });

    test("listExecutionSpecifications's gate call precedes its QueryCommand (no foreign-data read at all)", () => {
      const body = extractFunctionBody(source, 'listExecutionSpecifications');
      const gateIdx = body.search(GATE_CALL_RE);
      const queryIdx = body.indexOf('new QueryCommand(');
      expect(gateIdx).toBeGreaterThan(-1);
      expect(queryIdx).toBeGreaterThan(-1);
      expect(gateIdx).toBeLessThan(queryIdx);
    });
  });

  test("handler's hasPermission('spec:approve') check is not removed by this fix (additive, not a replacement)", () => {
    expect(source).toMatch(/hasPermission\(authContext, ['"]spec:approve['"]\)/);
  });
});
