/**
 * Enumeration-completeness guard for fabricator-request-resolver.ts's
 * dispatch (design evidence, section C — "mirror requireOrgId exactly",
 * modelled on task-runner-resolver-dispatch-gate-enumeration.test.ts).
 *
 * Root defect closed: `requestAgentCreation`/`requestToolCreation` derived
 * org via a null-tolerant `extractOrgFromEvent` call and forwarded
 * `org_id: orgId || null` onto the SQS message — an unresolvable org
 * fabricated anyway. The fix threads BOTH ops through a shared
 * `requireOrgId` fail-closed gate called once in the top-level `handler`,
 * BEFORE either op's SQS send.
 *
 * Unlike the sibling guards' `switch (fieldName)` dispatch, this handler
 * (like task-runner-resolver.ts) dispatches via
 * `if (fieldName === '<name>') { return await <fn>(...); }` /
 * `else if` — no `else if` is actually used here (two independent `if`
 * blocks that each `return`), so the branch regex tolerates a bare `if`
 * chain without a leading `else`.
 *
 * This handler has exactly two ops. The EXEMPT_OPS list is intentionally
 * empty — there is no legitimately ungated op on this dispatch surface.
 *
 * STRENGTHENED (board task b418dfdb, decision 2763e85f): both ops
 * additionally require the architect-or-admin platform role — fabrication
 * drives Bedrock spend and creates agent/tool Registry records. The
 * "requireArchitectOrAdmin role gate" describe block below verifies each
 * gated function calls requireArchitectOrAdmin with its exact action
 * literal BEFORE its sendToFabricatorQueue side effect, and that the gate
 * helper itself checks `isAdminFromEvent(event) ||
 * hasRoleFromEvent(event, "architect")` and throws otherwise.
 */
import * as fs from "fs";
import * as path from "path";

const HANDLER_PATH = path.join(
  __dirname,
  "..",
  "fabricator-request-resolver.ts",
);

/**
 * Extracts field names dispatched on an `if (fieldName === '<name>')` /
 * `else if (fieldName === '<name>')` chain inside the handler's body, and
 * the function name each branch delegates to via `await <fn>(`.
 */
function extractDispatchBranches(
  source: string,
): Array<{ fieldName: string; handlerName: string | null }> {
  const handlerStart = source.indexOf("export const handler");
  if (handlerStart === -1) {
    throw new Error(
      "Could not locate `export const handler` in fabricator-request-resolver.ts — " +
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
 * Extracts the `export const handler = async (event...) => { ... }` body
 * by brace-counting from the arrow function's opening `{`.
 */
function extractHandlerBody(source: string): string {
  const handlerStart = source.indexOf("export const handler");
  if (handlerStart === -1) {
    throw new Error("Could not locate `export const handler`");
  }
  const bodyStart = source.indexOf("{", handlerStart);
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
const SQS_SEND_MARKER = "sqsClient.send(";

/**
 * Ops verified to be reachable only after the top-level `requireOrgId`
 * gate has run (finding: null-tolerant org derivation on the fabricator
 * request path).
 */
const GATED_OPS: Record<string, true> = {
  requestAgentCreation: true,
  requestToolCreation: true,
};

/**
 * No legitimately ungated op exists on this dispatch surface — kept empty
 * (rather than omitted) so the "every case accounted for" test below fails
 * loudly, not silently, the moment a new branch is added without updating
 * this file.
 */
const EXEMPT_OPS: Record<string, string> = {};

describe("fabricator-request-resolver — dispatch enumeration completeness", () => {
  const source = fs.readFileSync(HANDLER_PATH, "utf-8");
  const branches = extractDispatchBranches(source);
  const fieldNames = branches.map((b) => b.fieldName);
  const handlerBody = extractHandlerBody(source);

  test("the dispatch chain actually has branches to check (sanity check on the parser itself)", () => {
    expect(fieldNames.length).toBe(2);
    expect(fieldNames).toContain("requestAgentCreation");
    expect(fieldNames).toContain("requestToolCreation");
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

  test("the top-level handler calls requireOrgId before dispatching to any gated op", () => {
    const gateIdx = handlerBody.search(GATE_CALL_RE);
    expect(gateIdx).toBeGreaterThan(-1);

    for (const fieldName of Object.keys(GATED_OPS)) {
      const branchMarker = `fieldName === "${fieldName}"`;
      const branchIdx = handlerBody.indexOf(branchMarker);
      expect(branchIdx).toBeGreaterThan(-1);
      expect(gateIdx).toBeLessThan(branchIdx);
    }
  });

  test("requireOrgId's result (orgId) is forwarded as an argument into each gated op's call", () => {
    for (const fieldName of Object.keys(GATED_OPS)) {
      const branch = branches.find((b) => b.fieldName === fieldName);
      expect(branch).toBeDefined();
      expect(branch!.handlerName).not.toBeNull();

      const callRe = new RegExp(
        `await\\s+${branch!.handlerName}\\s*\\(([^)]*)\\)`,
      );
      const callMatch = callRe.exec(handlerBody);
      expect(callMatch).not.toBeNull();
      expect(/\borgId\b/.test(callMatch![1])).toBe(true);
    }
  });

  describe.each(Object.keys(GATED_OPS))(
    "GATED_OPS['%s'] handler's SQS send is downstream of orgId, not client input",
    (fieldName) => {
      test(`${fieldName} forwards orgId into its SQS-sending helper (sendToFabricatorQueue) rather than reading client input`, () => {
        const branch = branches.find((b) => b.fieldName === fieldName);
        expect(branch).toBeDefined();

        // The gated function itself (requestAgentCreation/requestToolCreation)
        // must accept an orgId parameter and pass it through to
        // sendToFabricatorQueue, never re-deriving org itself and never
        // reading event.arguments.input for org data.
        const fnDeclRe = new RegExp(
          `async function ${branch!.handlerName}\\s*\\(([^)]*)\\)`,
        );
        const fnDeclMatch = fnDeclRe.exec(source);
        expect(fnDeclMatch).not.toBeNull();
        expect(/\borgId\s*:/.test(fnDeclMatch![1])).toBe(true);
      });
    },
  );

  test("no branch in the null-tolerant style (`orgId || null`) remains in the source", () => {
    expect(source.includes("orgId || null")).toBe(false);
  });

  test("sanity: the handler body still contains the SQS send marker used by downstream helpers", () => {
    // Guards the parser's assumptions about this file's shape — if the SQS
    // client call site is renamed/moved, this test flags it rather than the
    // marker-based checks above silently no-oping.
    expect(source.includes(SQS_SEND_MARKER)).toBe(true);
  });

  describe("requireArchitectOrAdmin role gate (decision 2763e85f)", () => {
    /**
     * Extracts a top-level `(export )?(async )?function <name>(...) {...}`
     * body by brace-counting from the parameter list's closing paren.
     * Template-literal `${...}` interpolations inside the bodies are
     * brace-balanced, so plain counting stays correct. Word-bounded so
     * `requestAgentCreation` never matches inside a longer name.
     */
    function extractFunctionBody(fnName: string): string {
      const declRe = new RegExp(
        `(?:export\\s+)?(?:async\\s+)?function ${fnName}\\b\\s*\\(`,
      );
      const declMatch = declRe.exec(source);
      if (!declMatch) {
        throw new Error(
          `Could not locate function declaration for '${fnName}' in fabricator-request-resolver.ts`,
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

    const ROLE_GATE_ACTIONS: Record<string, string> = {
      requestAgentCreation: "request agent creation",
      requestToolCreation: "request tool creation",
    };

    test.each(Object.entries(ROLE_GATE_ACTIONS))(
      "%s calls requireArchitectOrAdmin with its exact action literal",
      (fn, action) => {
        const body = extractFunctionBody(fn);
        const gateRe = new RegExp(
          `requireArchitectOrAdmin\\(\\s*event\\s*,\\s*"${action}"\\s*\\)`,
        );
        expect(gateRe.test(body)).toBe(true);
      },
    );

    test.each(Object.keys(ROLE_GATE_ACTIONS).map((k) => [k]))(
      "%s's role gate precedes its sendToFabricatorQueue side effect (bite: ordering)",
      (fn) => {
        const body = extractFunctionBody(fn);
        const gateIdx = body.search(/requireArchitectOrAdmin\s*\(/);
        const sendIdx = body.indexOf("sendToFabricatorQueue(");
        expect(gateIdx).toBeGreaterThan(-1);
        expect(sendIdx).toBeGreaterThan(-1);
        expect(gateIdx).toBeLessThan(sendIdx);
      },
    );

    test("requireArchitectOrAdmin itself enforces admin-or-architect and throws otherwise (the gate has teeth)", () => {
      const body = extractFunctionBody("requireArchitectOrAdmin");
      expect(/isAdminFromEvent\s*\(\s*event\s*\)/.test(body)).toBe(true);
      expect(
        /hasRoleFromEvent\s*\(\s*event\s*,\s*"architect"\s*\)/.test(body),
      ).toBe(true);
      expect(/throw new Error\(/.test(body)).toBe(true);
    });
  });
});
