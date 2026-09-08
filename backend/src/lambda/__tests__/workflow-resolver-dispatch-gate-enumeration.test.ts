/**
 * Enumeration-completeness guard for workflow-resolver.ts's dispatch switch
 * (finding 2c262386 lower set — workflow/execution addition to the
 * dispatch-gate-enumeration series continued from
 * execspec-resolver-dispatch-gate-enumeration.test.ts and siblings).
 *
 * Root defect closed by finding 2c262386: createWorkflow and importWorkflow
 * trusted a client-supplied input.orgId outright and stamped it verbatim
 * onto the new workflow row — a caller could plant a DRAFT workflow into
 * ANOTHER tenant's workspace by setting orgId=victim. The fix threads the
 * AppSync `event` into createWorkflow/importWorkflow (both already accept
 * an optional `event` for reuse by the IAM-only intake-orchestration
 * caller, which derives orgId itself and passes no event) and each callee
 * derives the caller's org via `extractOrgFromEvent` and REJECTS a
 * mismatched or unresolvable org BEFORE any DynamoDB PutCommand — reject,
 * not coerce (decision b5d463f2 mutation convention).
 *
 * Existing-row mutation/read ops (getWorkflow, updateWorkflow,
 * deleteWorkflow, publishWorkflow, updateWorkflowConfiguration,
 * exportWorkflow, getWorkflowVersion, importBlueprint, listAppWorkflows)
 * already gate via `getWorkflow`'s or their own inline
 * `extractOrgFromEvent` + `Access denied` check against the LOADED row's
 * orgId (not a client-supplied create input) — those are accounted for as
 * EXEMPT here (their own field-level tests cover them) since this guard is
 * scoped to the create/import client-orgId-trust defect specifically.
 * listWorkflows/listBlueprints are read-only collection queries scoped by
 * the caller's derived org already (listWorkflows) or global blueprint
 * data (listBlueprints) — also EXEMPT.
 */
import * as fs from "fs";
import * as path from "path";

const HANDLER_PATH = path.join(__dirname, "..", "workflow-resolver.ts");

function extractDispatchCases(source: string): string[] {
  const switchStart = source.indexOf("switch (fieldName)");
  if (switchStart === -1) {
    throw new Error(
      "Could not locate `switch (fieldName)` in workflow-resolver.ts — " +
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

/**
 * Extracts a top-level `[export] async function <name>(...) { ... }` body
 * by brace-counting from the function keyword, matching the parameter
 * list's closing paren first.
 */
function extractFunctionBody(source: string, fnName: string): string {
  const declRe = new RegExp(
    `(?:export\\s+)?async function ${fnName}\\b\\s*\\(`,
  );
  const declMatch = declRe.exec(source);
  if (!declMatch) {
    throw new Error(
      `Could not locate function declaration for '${fnName}' in workflow-resolver.ts`,
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

const GATE_CALL_RE = /extractOrgFromEvent\s*\(/;
const EVENT_PARAM_RE = /event\?\s*:\s*unknown/;

/**
 * Ops whose callee must derive-and-reject the caller's org against a
 * client-supplied create/import input before any write.
 */
const GATED_OPS: Record<string, { fn: string }> = {
  createWorkflow: { fn: "createWorkflow" },
  importWorkflow: { fn: "importWorkflowFn" },
};

/**
 * Every other dispatch case is exempt from THIS guard because it already
 * gates by loading an existing row and reconciling ITS orgId
 * (getWorkflow/updateWorkflow/deleteWorkflow/publishWorkflow/
 * updateWorkflowConfiguration/exportWorkflow/getWorkflowVersion/
 * listAppWorkflows/importBlueprint — all covered by field-level tests in
 * workflow-resolver.test.ts), or is a collection read with no create-shaped
 * client-orgId-trust surface (listWorkflows/listBlueprints).
 */
const EXEMPT_OPS: Record<string, string> = {
  getWorkflow: "existing-row org check via extractOrgFromEvent+Access denied",
  listWorkflows: "caller-derived org query, no client orgId trusted for writes",
  listBlueprints: "global blueprint read, no org dimension",
  updateWorkflow: "existing-row org check via getWorkflow",
  deleteWorkflow: "existing-row org check via getWorkflow",
  publishWorkflow: "existing-row org check via getWorkflow",
  updateWorkflowConfiguration: "existing-row org check via getWorkflow",
  importBlueprint: "derives orgId from the target App row, not client input",
  exportWorkflow: "existing-row org check via getWorkflow",
  getWorkflowVersion: "existing-row org check via getWorkflow",
  listAppWorkflows: "existing-row org check via the App row",
};

describe("workflow-resolver — dispatch enumeration completeness (create/import org-trust)", () => {
  const source = fs.readFileSync(HANDLER_PATH, "utf-8");
  const cases = extractDispatchCases(source);

  test("the dispatch switch actually has cases to check (sanity check on the parser itself)", () => {
    expect(cases.length).toBeGreaterThanOrEqual(11);
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
    "GATED_OPS['%s'] dispatches to a function that threads `event`, accepts it optionally, and calls extractOrgFromEvent",
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

      test(`${meta.fn}'s function body contains an extractOrgFromEvent call`, () => {
        const body = extractFunctionBody(source, meta.fn);
        expect(GATE_CALL_RE.test(body)).toBe(true);
      });
    },
  );

  describe("gated create/import ops derive-and-reject org BEFORE their DynamoDB write side effect", () => {
    test("createWorkflow's extractOrgFromEvent call precedes its PutCommand", () => {
      const body = extractFunctionBody(source, "createWorkflow");
      const gateIdx = body.search(GATE_CALL_RE);
      const putIdx = body.indexOf("new PutCommand(");
      expect(gateIdx).toBeGreaterThan(-1);
      expect(putIdx).toBeGreaterThan(-1);
      expect(gateIdx).toBeLessThan(putIdx);
    });

    test("importWorkflowFn's extractOrgFromEvent call precedes its PutCommand", () => {
      const body = extractFunctionBody(source, "importWorkflowFn");
      const gateIdx = body.search(GATE_CALL_RE);
      const putIdx = body.indexOf("new PutCommand(");
      expect(gateIdx).toBeGreaterThan(-1);
      expect(putIdx).toBeGreaterThan(-1);
      expect(gateIdx).toBeLessThan(putIdx);
    });
  });

  test("createWorkflow rejects a mismatched orgId rather than silently coercing (reject-not-coerce wording present)", () => {
    const body = extractFunctionBody(source, "createWorkflow");
    expect(body).toMatch(/Access denied.*orgId does not match/s);
  });

  test("importWorkflowFn rejects a mismatched orgId rather than silently coercing (reject-not-coerce wording present)", () => {
    const body = extractFunctionBody(source, "importWorkflowFn");
    expect(body).toMatch(/Access denied.*orgId does not match/s);
  });
});
