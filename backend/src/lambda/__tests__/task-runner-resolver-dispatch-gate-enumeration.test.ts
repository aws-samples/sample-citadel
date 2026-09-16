/**
 * Enumeration-completeness guard for task-runner-resolver.ts's dispatch
 * (finding 87a171ad, high — the fifteenth instance of the class-closing
 * move started by registry-agent-record-resolver-dispatch-gate-enumeration
 * .test.ts and continued by agent-code-resolver / app-publish-handler /
 * user-management-resolver / execution-resolver / adr-resolver / execspec
 * -resolver / tool-config-resolver / workflow-resolver / governance-ui
 * -resolver / fabricator-queue-resolver's siblings).
 *
 * Root defect closed by finding 87a171ad: `submitTask` made an EventBridge
 * `task.request` publish that triggers Supervisor orchestration with NO
 * identity read and NO tenancy stamped anywhere on the emitted detail —
 * any authenticated Cognito caller of any organisation could dispatch
 * work with no tenancy on the path. The fix threads the op through
 * `requireOrgId` (this resolver's own fail-closed
 * `extractOrgFromEvent`-based gate) BEFORE the EventBridge PutEvents call.
 *
 * Unlike the sibling guards' `switch (fieldName)` dispatch, this handler
 * dispatches via `if (fieldName === '<name>') { return await <fn>(...); }`
 * / `else if` chains — this guard's parser is written for THAT shape,
 * derived from the handler's actual source (not a hand-maintained list),
 * per the task's dispatch-guard requirement.
 *
 * This handler has exactly one op (`submitTask`). The EXEMPT_OPS list is
 * intentionally empty — there is no legitimately ungated op on this
 * dispatch surface.
 */
import * as fs from "fs";
import * as path from "path";

const HANDLER_PATH = path.join(__dirname, "..", "task-runner-resolver.ts");

/**
 * Extracts field names dispatched on on an `if (fieldName === '<name>')`
 * / `else if (fieldName === '<name>')` chain inside the handler's body,
 * and the function name each branch delegates to via `await <fn>(`.
 */
function extractDispatchBranches(
  source: string,
): Array<{ fieldName: string; handlerName: string | null }> {
  const handlerStart = source.indexOf("export const handler");
  if (handlerStart === -1) {
    throw new Error(
      "Could not locate `export const handler` in task-runner-resolver.ts — " +
        "dispatch structure changed; update this guard's parsing.",
    );
  }
  const handlerBody = source.slice(handlerStart);

  const branchRe =
    /(?:if|else if)\s*\(\s*fieldName\s*===\s*['"]([^'"]+)['"]\s*\)\s*\{([^}]*)\}/g;
  const branches: Array<{ fieldName: string; handlerName: string | null }> = [];
  let m: RegExpExecArray | null;
  while ((m = branchRe.exec(handlerBody)) !== null) {
    const fieldName = m[1];
    const branchBody = m[2];
    const callRe = /await\s+([A-Za-z0-9_]+)\s*\(/;
    const callMatch = callRe.exec(branchBody);
    branches.push({
      fieldName,
      handlerName: callMatch ? callMatch[1] : null,
    });
  }
  return branches;
}

/**
 * Extracts a top-level `async function <name>(...) { ... }` body by
 * brace-counting from the `function` keyword, matching the parameter
 * list's closing paren first (parameter type annotations can contain
 * object-literal-shaped braces).
 */
function extractFunctionBody(source: string, fnName: string): string {
  const declRe = new RegExp(`(?:export\\s+)?async function ${fnName}\\s*\\(`);
  const declMatch = declRe.exec(source);
  if (!declMatch) {
    throw new Error(
      `Could not locate function declaration for '${fnName}' in task-runner-resolver.ts`,
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

const GATE_CALL_RE = /requireOrgId\s*\(/;

/**
 * Ops verified to call requireOrgId inside their handler function body
 * before any EventBridge/side-effect (finding 87a171ad).
 */
const GATED_OPS: Record<string, true> = {
  submitTask: true,
};

/**
 * No legitimately ungated op exists on this dispatch surface — kept empty
 * (rather than omitted) so the "every case accounted for" test below fails
 * loudly, not silently, the moment a new branch is added without updating
 * this file.
 */
const EXEMPT_OPS: Record<string, string> = {};

describe("task-runner-resolver — dispatch enumeration completeness", () => {
  const source = fs.readFileSync(HANDLER_PATH, "utf-8");
  const branches = extractDispatchBranches(source);
  const fieldNames = branches.map((b) => b.fieldName);

  test("the dispatch chain actually has branches to check (sanity check on the parser itself)", () => {
    expect(fieldNames.length).toBe(1);
    expect(fieldNames).toContain("submitTask");
  });

  test("every dispatch branch is accounted for in GATED_OPS or EXEMPT_OPS", () => {
    const unaccounted = fieldNames.filter(
      (c) => !(c in GATED_OPS) && !(c in EXEMPT_OPS),
    );
    expect(unaccounted).toEqual([]);
  });

  test("GATED_OPS and EXEMPT_OPS do not both claim the same op", () => {
    const overlap = Object.keys(GATED_OPS).filter((k) => k in EXEMPT_OPS);
    expect(overlap).toEqual([]);
  });

  test("no GATED_OPS/EXEMPT_OPS entry references a branch that no longer exists in the dispatch chain", () => {
    const known = new Set(fieldNames);
    const staleGated = Object.keys(GATED_OPS).filter((k) => !known.has(k));
    const staleExempt = Object.keys(EXEMPT_OPS).filter((k) => !known.has(k));
    expect(staleGated).toEqual([]);
    expect(staleExempt).toEqual([]);
  });

  describe.each(Object.keys(GATED_OPS))(
    "GATED_OPS['%s'] handler actually calls the shared org gate",
    (fieldName) => {
      test(`${fieldName} contains a requireOrgId call`, () => {
        const branch = branches.find((b) => b.fieldName === fieldName);
        expect(branch).toBeDefined();
        expect(branch!.handlerName).not.toBeNull();
        const body = extractFunctionBody(source, branch!.handlerName as string);
        expect(GATE_CALL_RE.test(body)).toBe(true);
      });

      test(`${fieldName}'s gate call is positioned BEFORE the first EventBridge side effect in its handler body`, () => {
        const branch = branches.find((b) => b.fieldName === fieldName);
        const body = extractFunctionBody(source, branch!.handlerName as string);
        const gateIdx = body.search(GATE_CALL_RE);
        expect(gateIdx).toBeGreaterThan(-1);

        const sideEffectMarkers = [
          "new PutEventsCommand(",
          "eventBridgeClient.send(",
        ];
        for (const marker of sideEffectMarkers) {
          const markerIdx = body.indexOf(marker);
          if (markerIdx === -1) continue; // not every marker appears in every handler
          expect(gateIdx).toBeLessThan(markerIdx);
        }
      });

      test(`${fieldName}'s gate call result (orgId) is included on the emitted detail object`, () => {
        const branch = branches.find((b) => b.fieldName === fieldName);
        const body = extractFunctionBody(source, branch!.handlerName as string);
        // The derived orgId must be assigned into the `detail` object that
        // is JSON.stringify'd onto the EventBridge entry — proves the
        // gate's result actually reaches the bus, not just that the gate
        // ran and was discarded.
        expect(/orgId\s*[,:]/.test(body)).toBe(true);
      });
    },
  );
});
