/**
 * Enumeration-completeness guard for execution-resolver.ts's dispatch
 * switch (finding 2c262386 — execution-resolver addition to the
 * dispatch-gate-enumeration series continued from
 * workflow-resolver-dispatch-gate-enumeration.test.ts and siblings).
 *
 * Root defect closed by finding 2c262386: listExecutions ran its
 * WorkflowIndex query directly with NO org check of any kind — any
 * client-supplied workflowId exposed that workflow's executions (including
 * input/output) across tenants, while every sibling op on this dispatch
 * surface (get/start/cancel/resume) already reconciled org via
 * `extractOrgFromEvent` + an "Access denied" throw before any read/write.
 * The fix loads the parent WORKFLOWS_TABLE row for the requested
 * workflowId (the org source of truth — EXECUTIONS_TABLE carries no orgId
 * GSI, only WorkflowIndex on workflowId+startedAt) and reconciles it
 * against the caller's derived org BEFORE running the executions query —
 * refuse, not filter-and-return.
 */
import * as fs from "fs";
import * as path from "path";

const HANDLER_PATH = path.join(__dirname, "..", "execution-resolver.ts");

function extractDispatchCases(source: string): string[] {
  const switchStart = source.indexOf("switch (fieldName)");
  if (switchStart === -1) {
    throw new Error(
      "Could not locate `switch (fieldName)` in execution-resolver.ts — " +
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
    switchBody.indexOf(`case "${fieldName}"`) !== -1
      ? switchBody.indexOf(`case "${fieldName}"`)
      : switchBody.indexOf(`case '${fieldName}'`);
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
      `Could not locate function declaration for '${fnName}' in execution-resolver.ts`,
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
  // From the params-closing paren, the return-type annotation (which may
  // itself contain object-literal braces, e.g. `Promise<{ items: ... }>`)
  // comes before the real body brace. Walk forward tracking `<`/`>` and
  // `{`/`}` nesting so a brace inside the type annotation's angle brackets
  // is not mistaken for the body's opening brace — the true body start is
  // the first top-level `{` encountered while angle-bracket depth is 0.
  let angleDepth = 0;
  let bodyStart = -1;
  for (let k = j + 1; k < source.length; k++) {
    const ch = source[k];
    if (ch === "<") angleDepth++;
    else if (ch === ">") angleDepth = Math.max(0, angleDepth - 1);
    else if (ch === "{" && angleDepth === 0) {
      bodyStart = k;
      break;
    }
  }
  if (bodyStart === -1) {
    throw new Error(
      `Could not locate body opening brace for '${fnName}' in execution-resolver.ts`,
    );
  }
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

const GATE_CALL_RE = /extractOrgFromEvent\s*\(/;
const DENY_RE = /Access denied/;

/**
 * Every op on this dispatch surface that touches tenant-scoped execution
 * or workflow data must, somewhere in its call chain, call
 * extractOrgFromEvent and be able to throw "Access denied" on
 * mismatch/unresolvable org before any read/write of that data. `fn` is
 * the function the dispatch case calls directly; `gateOwner` is the
 * function whose body actually performs the check (some ops delegate to
 * `getExecution` for the gate rather than checking inline).
 */
const GATED_OPS: Record<string, { fn: string; gateOwner: string }> = {
  getExecution: { fn: "getExecution", gateOwner: "getExecution" },
  listExecutions: { fn: "listExecutions", gateOwner: "listExecutions" },
  startExecution: { fn: "startExecution", gateOwner: "startExecution" },
  cancelExecution: { fn: "cancelExecution", gateOwner: "getExecution" },
  resumeExecution: { fn: "resumeExecution", gateOwner: "getExecution" },
};

/**
 * publishWorkflowProgress is an IAM-signed fan-out mutation that only
 * echoes its input back to AppSync subscribers — it touches no
 * tenant-scoped DynamoDB row at all, so there is nothing to reconcile.
 */
const EXEMPT_OPS: Record<string, string> = {
  publishWorkflowProgress: "IAM-signed echo, no tenant data read/written",
};

describe("execution-resolver — dispatch enumeration completeness (org reconciliation)", () => {
  const source = fs.readFileSync(HANDLER_PATH, "utf-8");
  const cases = extractDispatchCases(source);

  test("the dispatch switch actually has cases to check (sanity check on the parser itself)", () => {
    expect(cases.length).toBeGreaterThanOrEqual(6);
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
    "GATED_OPS['%s'] dispatches to a function that threads `event`, and its gate owner calls extractOrgFromEvent and can throw Access denied",
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

      test(`${meta.fn} threads event to its gate owner ${meta.gateOwner} (directly or via delegation)`, () => {
        if (meta.fn === meta.gateOwner) {
          // The dispatched function IS the gate owner — already proven by
          // the next two tests on gateOwner's own body.
          expect(true).toBe(true);
          return;
        }
        const body = extractFunctionBody(source, meta.fn);
        const callRe = new RegExp(
          `${meta.gateOwner}\\s*\\([^;]*?\\bevent\\b[^;]*?\\)`,
        );
        expect(callRe.test(body)).toBe(true);
      });

      test(`${meta.gateOwner}'s function body contains an extractOrgFromEvent call`, () => {
        const body = extractFunctionBody(source, meta.gateOwner);
        expect(GATE_CALL_RE.test(body)).toBe(true);
      });

      test(`${meta.gateOwner}'s function body can throw "Access denied"`, () => {
        const body = extractFunctionBody(source, meta.gateOwner);
        expect(DENY_RE.test(body)).toBe(true);
      });
    },
  );

  test("listExecutions's extractOrgFromEvent call precedes its executions QueryCommand", () => {
    const body = extractFunctionBody(source, "listExecutions");
    const gateIdx = body.search(GATE_CALL_RE);
    const queryIdx = body.indexOf("new QueryCommand(");
    expect(gateIdx).toBeGreaterThan(-1);
    expect(queryIdx).toBeGreaterThan(-1);
    expect(gateIdx).toBeLessThan(queryIdx);
  });

  test("listExecutions loads the parent workflow row (org source of truth) before its gate check", () => {
    const body = extractFunctionBody(source, "listExecutions");
    const getIdx = body.indexOf("new GetCommand(");
    const gateIdx = body.search(GATE_CALL_RE);
    expect(getIdx).toBeGreaterThan(-1);
    expect(gateIdx).toBeGreaterThan(-1);
    expect(getIdx).toBeLessThan(gateIdx);
  });
});
