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
 *
 * STRENGTHENED (board task b418dfdb): the read ops' org reconciliation
 * (finding ce470ab0) was previously described in EXEMPT_OPS prose but
 * never structurally checked — exactly the hole the registry-agent-record
 * guard's history warns about ("the EXEMPT list was the hole"). The
 * "READ ops org reconciliation" describe block below now verifies, per
 * read function on BOTH paths (registry + legacy), the real gate content:
 * extractOrgFromEvent/isAdminFromEvent derivation, fail-closed empty/null
 * results for an unresolvable caller org, canCallerSeeRow on the legacy
 * single get, org-filtering of list/search results, and that each read
 * case threads `event` into its callees.
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
 * (getToolConfig*, listToolConfigs*, searchToolConfigs) are handled by the
 * org-filter/404-shape on their own read path and are NOT re-verified by
 * this guard — it exists specifically to close the update/delete write-path
 * gap.
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
 *  - listToolConfigs / getToolConfig: reads, org-filtered/404-shaped at the
 *    collection/record level (not a write, no assertRowOrg needed). Per
 *    finding ce470ab0, the legacy (REGISTRY_ENABLED!='true') path now
 *    applies the same org reconciliation the registry read path uses
 *    (getToolConfig -> canCallerSeeRow, listToolConfigs -> filter to
 *    caller org), and getToolConfigRegistry no longer treats an absent
 *    row/record orgId as visible to a non-admin.
 *  - createToolConfig: no client-supplied orgId to reconcile (Registry path
 *    derives orgId from the caller via extractOrgFromEvent; the legacy path
 *    was fixed in the same change to do the same rather than leaving orgId
 *    blank — see createToolConfig's server-derived-orgId comment). There is
 *    no existing row to fetch-then-verify against on a create.
 *  - listIntegrationOperations: static lookup table, not tenant data.
 *  - searchToolConfigs: per finding ce470ab0, this is NO LONGER exempt — it
 *    now filters Registry search results to the caller's server-derived
 *    org (admin sees all), failing closed to an empty result when the
 *    caller's own org is unresolvable. It stays out of GATED_OPS because
 *    it is a read (a query, not a fetch-then-verify-then-write), so the
 *    assertRowOrg-shaped checks below don't apply to it; its org-filter
 *    behavior is covered directly by tool-config-resolver-org-scoping.test.ts
 *    rather than by this guard's callee-shape assertions.
 */
const EXEMPT_OPS: Record<string, string> = {
  listToolConfigs:
    "read, org-filtered per finding ce470ab0 (canCallerSeeRow / caller-org filter)",
  getToolConfig:
    "read, org-filtered/404-shaped per finding ce470ab0 (canCallerSeeRow)",
  createToolConfig:
    "no client orgId to reconcile; orgId is server-derived on both paths",
  listIntegrationOperations: "static lookup table, not tenant data",
  searchToolConfigs:
    "read; org-filtered to caller org per finding ce470ab0, not assertRowOrg-shaped",
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

  describe("READ ops org reconciliation (finding ce470ab0, strengthened per board task b418dfdb)", () => {
    /** Read ops whose dispatch case must thread `event` into every callee
     * that performs its own org reconciliation. */
    const READ_OP_CALLEES: Record<string, string[]> = {
      listToolConfigs: ["listToolConfigsRegistry", "listToolConfigs"],
      getToolConfig: ["getToolConfigRegistry", "getToolConfig"],
      searchToolConfigs: ["searchToolConfigs"],
    };

    describe.each(Object.entries(READ_OP_CALLEES))(
      "case '%s' threads `event` into its org-reconciling callee(s)",
      (fieldName, callees) => {
        test.each(callees.map((c) => [c]))(
          "passes `event` as an argument to %s",
          (callee) => {
            const caseBody = extractCaseBody(source, fieldName);
            const callRe = new RegExp(`${callee}\\s*\\([^)]*\\bevent\\b`);
            expect(callRe.test(caseBody)).toBe(true);
          },
        );
      },
    );

    test.each([
      ["listToolConfigsRegistry"],
      ["listToolConfigs"],
      ["searchToolConfigs"],
    ])(
      "%s derives caller identity server-side (extractOrgFromEvent + isAdminFromEvent) and fails closed to an empty list",
      (fn) => {
        const body = extractFunctionBody(source, fn);
        expect(/extractOrgFromEvent\s*\(/.test(body)).toBe(true);
        expect(/isAdminFromEvent\s*\(/.test(body)).toBe(true);
        // Fail-closed: an unresolvable caller org returns [] — never the
        // unfiltered set.
        expect(/return \[\];/.test(body)).toBe(true);
        // The non-admin result set is org-filtered against the derived org.
        expect(/\.filter\(/.test(body)).toBe(true);
        expect(/callerOrgId/.test(body)).toBe(true);
      },
    );

    test("getToolConfigRegistry treats cross-org AND org-less records as not-found for non-admins (both paths)", () => {
      const body = extractFunctionBody(source, "getToolConfigRegistry");
      expect(/extractOrgFromEvent\s*\(/.test(body)).toBe(true);
      expect(/isAdminFromEvent\s*\(/.test(body)).toBe(true);
      // The fail-closed disjunction (absent orgId OR mismatch → null) must
      // exist on BOTH the registry-mapped and the legacy-fallback branch —
      // the pre-fix bug was the truthy-only `mapped.orgId && ...` guard.
      expect(
        /!mapped\.orgId\s*\|\|\s*mapped\.orgId\s*!==\s*callerOrgId/.test(body),
      ).toBe(true);
      expect(
        /!legacy\.orgId\s*\|\|\s*legacy\.orgId\s*!==\s*callerOrgId/.test(body),
      ).toBe(true);
      expect(/return null;/.test(body)).toBe(true);
    });

    test("legacy getToolConfig reconciles via the shared canCallerSeeRow helper and 404-shapes the denial (null)", () => {
      const body = extractFunctionBody(source, "getToolConfig");
      expect(/canCallerSeeRow\s*\(/.test(body)).toBe(true);
      // Denial is a null return (not-found shape), not a thrown 403 — no
      // existence oracle.
      expect(/return null;/.test(body)).toBe(true);
    });

    test("searchToolConfigs org-filters results to the caller's own org with an explicit orgId equality", () => {
      const body = extractFunctionBody(source, "searchToolConfigs");
      expect(/t\.orgId\s*&&\s*t\.orgId\s*===\s*callerOrgId/.test(body)).toBe(
        true,
      );
    });

    test("bite: the fail-closed empty-list return in searchToolConfigs is guarded by the unresolvable-org check", () => {
      const body = extractFunctionBody(source, "searchToolConfigs");
      // `if (!callerOrgId) return [];` — the exact fail-closed shape; a
      // future edit that inverts or drops the guard fails here.
      expect(/if\s*\(!callerOrgId\)\s*return \[\];/.test(body)).toBe(true);
    });
  });
});
