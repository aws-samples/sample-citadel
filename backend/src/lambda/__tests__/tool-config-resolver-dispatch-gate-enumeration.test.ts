/**
 * Enumeration-completeness guard for tool-config-resolver.ts's dispatch
 * switch (finding 13065e38 — the fifth instance of the class-closing move
 * started by registry-agent-record-resolver-dispatch-gate-enumeration.test.ts
 * and continued by app-publish-handler-dispatch-gate-enumeration.test.ts /
 * user-management-resolver-dispatch-gate-enumeration.test.ts /
 * agent-code-resolver-dispatch-gate-enumeration.test.ts).
 *
 * Root defect closed by finding 13065e38: updateToolConfig and
 * deleteToolConfig (both the legacy DynamoDB path and the Registry path)
 * performed NO org reconciliation before their write/delete — any
 * authenticated caller of any org could rewrite or destroy another
 * tenant's tool config, including its integrationBindings/dataStoreBindings
 * which scope datastore/integration credentials. The fix threads `event`
 * into every mutation-shaped case and each callee function fetches the
 * existing row/record THEN calls the shared `assertRowOrg` gate BEFORE any
 * DynamoDB PutCommand/DeleteCommand or Registry updateResource/
 * deleteResource call.
 *
 * Unlike the four sibling guards, this dispatch switch has a DUAL-PATH
 * shape per case: `registryEnabled ? await xRegistry(...) : await x(...)`.
 * This guard's parser extracts BOTH call sites per case (not one) and
 * verifies the case threads `event` as an argument to whichever callee(s)
 * are expected to receive it, then verifies that callee's own function
 * body actually contains an `assertRowOrg(` call before its first
 * DynamoDB/Registry side effect.
 */
import * as fs from "fs";
import * as path from "path";

const HANDLER_PATH = path.join(__dirname, "..", "tool-config-resolver.ts");

function extractDispatchCases(source: string): string[] {
  const switchStart = source.indexOf("switch (fieldName)");
  if (switchStart === -1) {
    throw new Error(
      "Could not locate `switch (fieldName)` in tool-config-resolver.ts — " +
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
 * Extracts a top-level `(async )?function <name>(...) { ... }` body (also
 * matches `export async function`) by brace-counting from the function
 * keyword, matching the parameter list's closing paren first.
 */
function extractFunctionBody(source: string, fnName: string): string {
  // Word-bounded to the exact function name so `deleteToolConfig` does not
  // match inside `deleteToolConfigRegistry`'s declaration (the `\s*\(`
  // requires the name be followed directly by whitespace/paren, and the
  // interpolated regex source has no trailing wildcard, so this is already
  // exact — but the `\b` makes the intent explicit and future-proof if the
  // pattern is ever loosened).
  const declRe = new RegExp(
    `(?:export\\s+)?async function ${fnName}\\b\\s*\\(`,
  );
  const declMatch = declRe.exec(source);
  if (!declMatch) {
    throw new Error(
      `Could not locate function declaration for '${fnName}' in tool-config-resolver.ts`,
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
  // After the parameter list's closing paren, an optional return-type
  // annotation (`: Promise<{ success: boolean; message?: string }>`) may
  // itself contain object-literal-shaped braces. Skip past it by finding
  // the FIRST `{` that is followed (after whitespace) by something other
  // than what a return-type object literal would produce — simplest robust
  // rule: walk forward counting `<`/`>` depth for generic brackets and
  // treat the body's opening brace as the first `{` encountered ONLY once
  // angle-bracket depth is back to zero (return types here are always
  // `Promise<...>`; the body brace follows the closing `>`).
  let angleDepth = 0;
  let k = j + 1;
  for (; k < source.length; k++) {
    if (source[k] === "<") angleDepth++;
    else if (source[k] === ">") {
      if (angleDepth > 0) angleDepth--;
    } else if (source[k] === "{" && angleDepth === 0) {
      break;
    }
  }
  const bodyStart = k;
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

const GATE_CALL_RE = /assertRowOrg\s*\(/;

/**
 * Ops verified to thread `event` into BOTH their registry and legacy
 * callees, each of which calls the shared `assertRowOrg` gate (fetch existing
 * row/record, then verify) before any write/delete side effect. Read ops
 * (getToolConfig*, listToolConfigs*) are handled by the pre-existing
 * org-filter/404-shape and are NOT re-verified by this guard — it exists
 * specifically to close the update/delete write-path gap.
 */
const GATED_OPS: Record<string, { registryFn: string; legacyFn: string }> = {
  updateToolConfig: {
    registryFn: "updateToolConfigRegistry",
    legacyFn: "updateToolConfig",
  },
  deleteToolConfig: {
    registryFn: "deleteToolConfigRegistry",
    legacyFn: "deleteToolConfig",
  },
};

/**
 * Ops on this dispatch surface that are legitimately NOT org-write-gated:
 *  - listToolConfigs / getToolConfig: reads, already org-filtered/404-shaped
 *    at the collection/record level (not a write, no assertRowOrg needed).
 *  - createToolConfig: no client-supplied orgId to reconcile (Registry path
 *    derives orgId from the caller via extractOrgFromEvent; the legacy path
 *    was fixed in the same change to do the same rather than leaving orgId
 *    blank — see createToolConfig's server-derived-orgId comment). There is
 *    no existing row to fetch-then-verify against on a create.
 *  - listIntegrationOperations: static lookup table, not tenant data.
 *  - searchToolConfigs: Registry semantic search, pre-existing scope (not
 *    part of this finding; tracked separately if it needs org filtering).
 */
const EXEMPT_OPS: Record<string, string> = {
  listToolConfigs: "read, already org-filtered (listToolConfigsRegistry)",
  getToolConfig:
    "read, already org-filtered/404-shaped (getToolConfigRegistry)",
  createToolConfig:
    "no client orgId to reconcile; orgId is server-derived on both paths",
  listIntegrationOperations: "static lookup table, not tenant data",
  searchToolConfigs: "Registry semantic search, out of scope for this finding",
};

describe("tool-config-resolver — dispatch enumeration completeness", () => {
  const source = fs.readFileSync(HANDLER_PATH, "utf-8");
  const cases = extractDispatchCases(source);

  test("the dispatch switch actually has cases to check (sanity check on the parser itself)", () => {
    expect(cases.length).toBeGreaterThanOrEqual(7);
    expect(cases).toEqual(
      expect.arrayContaining([
        "listToolConfigs",
        "getToolConfig",
        "createToolConfig",
        "updateToolConfig",
        "deleteToolConfig",
        "listIntegrationOperations",
        "searchToolConfigs",
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

  describe.each(Object.entries(GATED_OPS))(
    "GATED_OPS['%s'] threads `event` to both callees, each gated by assertRowOrg",
    (fieldName, meta) => {
      test(`${fieldName}'s case dispatches to both ${meta.registryFn} and ${meta.legacyFn}`, () => {
        const caseBody = extractCaseBody(source, fieldName);
        const callSites = extractCallSiteNames(caseBody);
        expect(callSites).toContain(meta.registryFn);
        expect(callSites).toContain(meta.legacyFn);
      });

      test(`${fieldName}'s case passes \`event\` as an argument to ${meta.registryFn}`, () => {
        const caseBody = extractCaseBody(source, fieldName);
        const registryCallRe = new RegExp(
          `${meta.registryFn}\\s*\\([^)]*\\bevent\\b`,
        );
        expect(registryCallRe.test(caseBody)).toBe(true);
      });

      test(`${fieldName}'s case passes \`event\` as an argument to ${meta.legacyFn}`, () => {
        const caseBody = extractCaseBody(source, fieldName);
        const legacyCallRe = new RegExp(
          `${meta.legacyFn}\\s*\\([^)]*\\bevent\\b`,
        );
        expect(legacyCallRe.test(caseBody)).toBe(true);
      });

      test(`${meta.registryFn}'s function body contains an assertRowOrg call`, () => {
        const body = extractFunctionBody(source, meta.registryFn);
        expect(GATE_CALL_RE.test(body)).toBe(true);
      });

      test(`${meta.legacyFn}'s function body contains an assertRowOrg call`, () => {
        const body = extractFunctionBody(source, meta.legacyFn);
        expect(GATE_CALL_RE.test(body)).toBe(true);
      });

      test(`${meta.registryFn}'s gate call precedes its first Registry side effect`, () => {
        const body = extractFunctionBody(source, meta.registryFn);
        const gateIdx = body.search(GATE_CALL_RE);
        expect(gateIdx).toBeGreaterThan(-1);

        const sideEffectMarkers = [
          "updateResource(",
          "deleteResource(",
          "updateResourceStatus(",
        ];
        for (const marker of sideEffectMarkers) {
          const markerIdx = body.indexOf(marker);
          if (markerIdx === -1) continue; // not every marker appears in every fn
          expect(gateIdx).toBeLessThan(markerIdx);
        }
      });

      test(`${meta.legacyFn}'s gate call precedes its first DynamoDB write side effect`, () => {
        const body = extractFunctionBody(source, meta.legacyFn);
        const gateIdx = body.search(GATE_CALL_RE);
        expect(gateIdx).toBeGreaterThan(-1);

        const sideEffectMarkers = ["new PutCommand(", "new DeleteCommand("];
        for (const marker of sideEffectMarkers) {
          const markerIdx = body.indexOf(marker);
          if (markerIdx === -1) continue;
          expect(gateIdx).toBeLessThan(markerIdx);
        }
      });
    },
  );
});
