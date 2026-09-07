/**
 * Enumeration-completeness guard for app-publish-handler.ts's dispatch
 * switch (finding 13a58234 follow-up — extends the class-closing move from
 * registry-agent-record-resolver-dispatch-gate-enumeration.test.ts to this
 * second dispatching handler).
 *
 * Same rationale as the sibling guard: derive the operation list directly
 * from the handler's `switch (fieldName)` source rather than trusting a
 * manually transcribed list, so a future case added to this switch without
 * a corresponding gate call fails LOUDLY instead of silently shipping
 * ungated.
 *
 * This handler currently has exactly two ops, publishApp and unpublishApp,
 * both gated at requiredRole='owner' via the SAME assertManifestAccess
 * helper the sibling resolver's guard checks for (finding 13a58234's fix
 * reuses that gate rather than writing a second implementation). The
 * EXEMPT_OPS list is intentionally empty — there is no legitimately
 * ungated op on this dispatch surface.
 */
import * as fs from "fs";
import * as path from "path";

const HANDLER_PATH = path.join(__dirname, "..", "app-publish-handler.ts");

function extractDispatchCases(source: string): string[] {
  const switchStart = source.indexOf("switch (fieldName)");
  if (switchStart === -1) {
    throw new Error(
      "Could not locate `switch (fieldName)` in app-publish-handler.ts — " +
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
  const caseRe = /case\s+"([^"]+)"\s*:/g;
  const cases: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = caseRe.exec(switchBody)) !== null) {
    cases.push(m[1]);
  }
  return cases;
}

/**
 * Extracts the handler function name a given case delegates to. Handles
 * both call shapes present in this file's dispatch:
 *   - `case "publishApp": return await publishApp(...)`
 *   - `case "unpublishApp": { const x = await unpublishApp(...); ... }`
 */
function extractHandlerCallSite(
  switchBody: string,
  fieldName: string,
): string | null {
  const caseIdx = switchBody.indexOf(`case "${fieldName}"`);
  if (caseIdx === -1) return null;
  // Scan forward from the case label to the next `case ` or end of the
  // switch body, then find the first `await SOMEFN(` in that slice —
  // covers both the direct-return and block-with-local-const shapes.
  const nextCaseIdx = switchBody.indexOf("case ", caseIdx + 1);
  const slice = switchBody.slice(
    caseIdx,
    nextCaseIdx === -1 ? undefined : nextCaseIdx,
  );
  const callRe = /await\s+([A-Za-z0-9_]+)\s*\(/;
  const m = callRe.exec(slice);
  return m ? m[1] : null;
}

/**
 * Extracts a top-level `export async function <name>(...) { ... }` or
 * `async function <name>(...) { ... }` body by brace-counting from the
 * `function` keyword, matching the parameter list's closing paren first
 * (parameter type annotations can contain object-literal-shaped braces).
 */
function extractFunctionBody(source: string, fnName: string): string {
  const declRe = new RegExp(`(?:export\\s+)?async function ${fnName}\\s*\\(`);
  const declMatch = declRe.exec(source);
  if (!declMatch) {
    throw new Error(
      `Could not locate function declaration for '${fnName}' in app-publish-handler.ts`,
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

const GATE_CALL_RE = /assertManifest(Owner)?Access\s*\(/;

/**
 * Ops verified to call assertManifestAccess inside their handler function
 * body before any mutating side effect (finding 13a58234). Both are
 * owner-reserved: publish provisions billable external infrastructure and
 * mints a plaintext API key; unpublish irreversibly tears the same down.
 */
const GATED_OPS: Record<string, { requiredRole: "owner" | "editor" }> = {
  publishApp: { requiredRole: "owner" },
  unpublishApp: { requiredRole: "owner" },
};

/**
 * No legitimately ungated op exists on this dispatch surface — kept empty
 * (rather than omitted) so the "every case accounted for" test below fails
 * loudly, not silently, the moment a new case is added without updating
 * this file.
 */
const EXEMPT_OPS: Record<string, string> = {};

describe("app-publish-handler — dispatch enumeration completeness", () => {
  const source = fs.readFileSync(HANDLER_PATH, "utf-8");
  const cases = extractDispatchCases(source);

  test("the dispatch switch actually has cases to check (sanity check on the parser itself)", () => {
    expect(cases.length).toBe(2);
    expect(cases).toContain("publishApp");
    expect(cases).toContain("unpublishApp");
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
    "GATED_OPS['%s'] handler actually calls a manifest-access gate",
    (fieldName, meta) => {
      test(`${fieldName} (requiredRole=${meta.requiredRole}) contains an assertManifestAccess/assertManifestOwnerAccess call`, () => {
        const switchStart = source.indexOf("switch (fieldName)");
        const defaultIdx = source.indexOf("default:", switchStart);
        const switchBody = source.slice(switchStart, defaultIdx);
        const handlerName = extractHandlerCallSite(switchBody, fieldName);
        expect(handlerName).not.toBeNull();
        const body = extractFunctionBody(source, handlerName as string);
        expect(GATE_CALL_RE.test(body)).toBe(true);
      });

      test(`${fieldName}'s gate call is positioned BEFORE the first mutating side effect in its handler body`, () => {
        const switchStart = source.indexOf("switch (fieldName)");
        const defaultIdx = source.indexOf("default:", switchStart);
        const switchBody = source.slice(switchStart, defaultIdx);
        const handlerName = extractHandlerCallSite(switchBody, fieldName);
        const body = extractFunctionBody(source, handlerName as string);
        const gateIdx = body.search(GATE_CALL_RE);
        expect(gateIdx).toBeGreaterThan(-1);

        // Side-effecting call markers used by publishApp/unpublishApp:
        // provisionApiGateway, generateApiKey, docClient.send with
        // PutCommand/UpdateCommand, ensureRole/deleteRole, and
        // eventBridgeClient.send. The gate must precede ALL of them.
        const sideEffectMarkers = [
          "provisionApiGateway(",
          "generateApiKey(",
          "ensureRole(",
          "deleteRole(",
          "new PutCommand(",
          "new UpdateCommand(",
          "eventBridgeClient.send(",
        ];
        for (const marker of sideEffectMarkers) {
          const markerIdx = body.indexOf(marker);
          if (markerIdx === -1) continue; // not every marker appears in every handler
          expect(gateIdx).toBeLessThan(markerIdx);
        }
      });
    },
  );
});
