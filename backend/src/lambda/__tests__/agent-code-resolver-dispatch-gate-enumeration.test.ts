/**
 * Enumeration-completeness guard for agent-code-resolver.ts's dispatch
 * switch (finding 1a9181a4 — the fourth instance of the class-closing move
 * started by registry-agent-record-resolver-dispatch-gate-enumeration.test.ts
 * and continued by app-publish-handler-dispatch-gate-enumeration.test.ts /
 * user-management-resolver-dispatch-gate-enumeration.test.ts).
 *
 * Root defect closed by finding 1a9181a4: getAgentCode and updateAgentCode
 * made S3/DynamoDB calls with NO identity read and NO org reconciliation
 * at all — any authenticated caller of any org could read or overwrite any
 * tenant's agent Python source. The fix threads BOTH ops through a single
 * shared gate, `assertAgentCodeAccess`, BEFORE any S3/DynamoDB call. This
 * guard derives the operation list directly from the handler's
 * `switch (fieldName)` source (not a manually transcribed list) so a future
 * case added to this switch without a corresponding gate call fails
 * LOUDLY instead of silently shipping ungated — same rationale as the three
 * sibling guards.
 *
 * This handler has exactly two ops. Both call assertAgentCodeAccess; only
 * updateAgentCode passes a `requiredWriteRole` argument (REQUIRED_WRITE_ROLE
 * = 'architect') — reads require org membership only, mirroring
 * getAgentConfigRegistry's read-side gate in agent-config-resolver.ts. The
 * EXEMPT_OPS list is intentionally empty — there is no legitimately
 * ungated op on this dispatch surface.
 */
import * as fs from "fs";
import * as path from "path";

const HANDLER_PATH = path.join(__dirname, "..", "agent-code-resolver.ts");

function extractDispatchCases(source: string): string[] {
  const switchStart = source.indexOf("switch (fieldName)");
  if (switchStart === -1) {
    throw new Error(
      "Could not locate `switch (fieldName)` in agent-code-resolver.ts — " +
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

/**
 * Extracts the handler function name a given case delegates to, e.g.
 * `case 'getAgentCode': return await getAgentCode(...);` -> "getAgentCode".
 */
function extractHandlerCallSite(
  switchBody: string,
  fieldName: string,
): string | null {
  const caseIdx = switchBody.indexOf(`case '${fieldName}'`);
  const idx =
    caseIdx !== -1 ? caseIdx : switchBody.indexOf(`case "${fieldName}"`);
  if (idx === -1) return null;
  const nextCaseIdx = switchBody.indexOf("case ", idx + 1);
  const slice = switchBody.slice(
    idx,
    nextCaseIdx === -1 ? undefined : nextCaseIdx,
  );
  const callRe = /await\s+([A-Za-z0-9_]+)\s*\(/;
  const m = callRe.exec(slice);
  return m ? m[1] : null;
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
      `Could not locate function declaration for '${fnName}' in agent-code-resolver.ts`,
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

const GATE_CALL_RE = /assertAgentCodeAccess\s*\(/;

/**
 * Ops verified to call assertAgentCodeAccess inside their handler function
 * body before any S3/DynamoDB side effect (finding 1a9181a4).
 * updateAgentCode additionally requires REQUIRED_WRITE_ROLE ('architect');
 * getAgentCode requires org membership only.
 */
const GATED_OPS: Record<string, { requiresWriteRole: boolean }> = {
  getAgentCode: { requiresWriteRole: false },
  updateAgentCode: { requiresWriteRole: true },
};

/**
 * No legitimately ungated op exists on this dispatch surface — kept empty
 * (rather than omitted) so the "every case accounted for" test below fails
 * loudly, not silently, the moment a new case is added without updating
 * this file.
 */
const EXEMPT_OPS: Record<string, string> = {};

describe("agent-code-resolver — dispatch enumeration completeness", () => {
  const source = fs.readFileSync(HANDLER_PATH, "utf-8");
  const cases = extractDispatchCases(source);

  test("the dispatch switch actually has cases to check (sanity check on the parser itself)", () => {
    expect(cases.length).toBe(2);
    expect(cases).toContain("getAgentCode");
    expect(cases).toContain("updateAgentCode");
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
    "GATED_OPS['%s'] handler actually calls the shared org/role gate",
    (fieldName, meta) => {
      test(`${fieldName} (requiresWriteRole=${meta.requiresWriteRole}) contains an assertAgentCodeAccess call`, () => {
        const switchStart = source.indexOf("switch (fieldName)");
        const defaultIdx = source.indexOf("default:", switchStart);
        const switchBody = source.slice(switchStart, defaultIdx);
        const handlerName = extractHandlerCallSite(switchBody, fieldName);
        expect(handlerName).not.toBeNull();
        const body = extractFunctionBody(source, handlerName as string);
        expect(GATE_CALL_RE.test(body)).toBe(true);
      });

      test(`${fieldName}'s gate call is positioned BEFORE the first S3/DynamoDB side effect in its handler body`, () => {
        const switchStart = source.indexOf("switch (fieldName)");
        const defaultIdx = source.indexOf("default:", switchStart);
        const switchBody = source.slice(switchStart, defaultIdx);
        const handlerName = extractHandlerCallSite(switchBody, fieldName);
        const body = extractFunctionBody(source, handlerName as string);
        const gateIdx = body.search(GATE_CALL_RE);
        expect(gateIdx).toBeGreaterThan(-1);

        // Side-effecting call markers used by getAgentCode/updateAgentCode:
        // the DynamoDB config GetCommand and the S3 Get/PutObjectCommand
        // sends. The gate must precede ALL of them.
        const sideEffectMarkers = [
          "new GetCommand(",
          "new GetObjectCommand(",
          "new PutObjectCommand(",
          "docClient.send(",
          "s3Client.send(",
        ];
        for (const marker of sideEffectMarkers) {
          const markerIdx = body.indexOf(marker);
          if (markerIdx === -1) continue; // not every marker appears in every handler
          expect(gateIdx).toBeLessThan(markerIdx);
        }
      });

      if (fieldName === "updateAgentCode") {
        test(`${fieldName} passes REQUIRED_WRITE_ROLE as the gate's requiredWriteRole argument`, () => {
          const switchStart = source.indexOf("switch (fieldName)");
          const defaultIdx = source.indexOf("default:", switchStart);
          const switchBody = source.slice(switchStart, defaultIdx);
          const handlerName = extractHandlerCallSite(switchBody, fieldName);
          const body = extractFunctionBody(source, handlerName as string);
          expect(
            /assertAgentCodeAccess\s*\(\s*agentId\s*,\s*event\s*,\s*REQUIRED_WRITE_ROLE\s*\)/.test(
              body,
            ),
          ).toBe(true);
        });
      } else {
        test(`${fieldName} does NOT pass a requiredWriteRole argument (read-only, org membership suffices)`, () => {
          const switchStart = source.indexOf("switch (fieldName)");
          const defaultIdx = source.indexOf("default:", switchStart);
          const switchBody = source.slice(switchStart, defaultIdx);
          const handlerName = extractHandlerCallSite(switchBody, fieldName);
          const body = extractFunctionBody(source, handlerName as string);
          expect(
            /assertAgentCodeAccess\s*\(\s*agentId\s*,\s*event\s*\)/.test(body),
          ).toBe(true);
        });
      }
    },
  );
});
