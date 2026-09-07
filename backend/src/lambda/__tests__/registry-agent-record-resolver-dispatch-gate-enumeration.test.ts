/**
 * Enumeration-completeness guard for registry-agent-record-resolver.ts's
 * dispatch switch (finding 6400b440 follow-up).
 *
 * The previous "every op is gated" claim was a hand-maintained list that
 * missed deleteApp entirely. This test derives the operation list directly
 * from the handler's `switch (fieldName)` source — by parsing the actual
 * `case "..."` labels out of the file — rather than trusting a manually
 * transcribed list, so a future case added to the switch without a
 * corresponding entry here fails LOUDLY instead of silently shipping
 * ungated.
 *
 * Every case must appear in exactly one of:
 *   - GATED_OPS: calls an assertManifestAccess/assertManifestOwnerAccess
 *     gate (verified by grep against the case's handler function body, not
 *     just asserted by hand) before any mutating side effect.
 *   - EXEMPT_OPS: legitimately gate-free, each with an explicit reason
 *     (pure read with its own tenant check, IAM-only internal, or a
 *     documented pre-existing gap called out for follow-up rather than
 *     silently passed over).
 *
 * If neither list accounts for a case, or a GATED op's handler function no
 * longer contains a gate call, the test fails.
 */
import * as fs from "fs";
import * as path from "path";

const RESOLVER_PATH = path.join(
  __dirname,
  "..",
  "registry-agent-record-resolver.ts",
);

function extractDispatchCases(source: string): string[] {
  const switchStart = source.indexOf("switch (fieldName)");
  if (switchStart === -1) {
    throw new Error(
      "Could not locate `switch (fieldName)` in registry-agent-record-resolver.ts — " +
        "dispatch structure changed; update this guard's parsing.",
    );
  }
  // Slice from the switch to the closing `default:` case (present in every
  // version of this dispatch) so we don't accidentally pick up unrelated
  // `case "..."` strings elsewhere in the file.
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
 * Extracts the handler function name a given case delegates to, e.g.
 * `case "deleteApp": return await deleteApp(...)` -> "deleteApp". Handles
 * both single-line and multi-line call sites.
 */
function extractHandlerCallSite(
  switchBody: string,
  fieldName: string,
): string | null {
  const caseRe = new RegExp(
    `case\\s+"${fieldName}"\\s*:\\s*\\n?\\s*return\\s+await\\s+([A-Za-z0-9_]+)\\s*\\(`,
  );
  const m = caseRe.exec(switchBody);
  return m ? m[1] : null;
}

/**
 * Extracts a top-level (module-scope) `async function <name>(...) { ... }`
 * body by brace-counting from the `function` keyword. Handler functions in
 * this file are never nested, so top-level brace balance is a safe
 * boundary — sufficient for a static "does this function call a gate"
 * check without a full parser.
 */
function extractFunctionBody(source: string, fnName: string): string {
  const declRe = new RegExp(`(?:export\\s+)?async function ${fnName}\\s*\\(`);
  const declMatch = declRe.exec(source);
  if (!declMatch) {
    throw new Error(
      `Could not locate function declaration for '${fnName}' in registry-agent-record-resolver.ts`,
    );
  }
  // Find the END of the parameter list first (matching parens, since
  // parameter type annotations can themselves contain object-literal-shaped
  // braces, e.g. `component: { type: string; data: string }`), THEN look
  // for the function body's opening brace after that — otherwise the first
  // `{` found could belong to a parameter type annotation rather than the
  // function body, desyncing the brace counter from the very start.
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
 * Ops verified to call an assertManifestAccess/assertManifestOwnerAccess
 * gate inside their handler function body before any mutating side effect.
 * `requiredRole` documents which role the call site pins (for humans
 * reading this list); the actual enforcement is verified structurally by
 * extractFunctionBody + GATE_CALL_RE against the real source, not merely
 * asserted here.
 */
const GATED_OPS: Record<string, { requiredRole: "owner" | "editor" }> = {
  updateApp: { requiredRole: "editor" },
  deleteApp: { requiredRole: "owner" },
  addAppComponent: { requiredRole: "editor" },
  removeAppComponent: { requiredRole: "editor" },
  updateAgentBinding: { requiredRole: "editor" },
  setAppConfigSchema: { requiredRole: "editor" },
  setAppConfigValues: { requiredRole: "editor" },
  setAppAuthConfig: { requiredRole: "editor" },
  grantAppAccess: { requiredRole: "owner" },
  revokeAppAccess: { requiredRole: "owner" },
  createAppApiKey: { requiredRole: "editor" },
  revokeAppApiKey: { requiredRole: "editor" },
  rotateAppApiKey: { requiredRole: "editor" },
};

/**
 * Ops that legitimately have NO assertManifestAccess gate call, each with
 * an explicit reason. This list must be kept honest — a case landing here
 * with a hand-wavy reason defeats the point of the guard.
 */
const EXEMPT_OPS: Record<string, string> = {
  getApp: "pure read; enforces its own inline org-equality tenant check",
  listApps: "pure read, scoped to the caller's own orgId argument",
  createApp:
    "creates a new app; no existing manifest access map to check against " +
    "— the creator becomes the implicit creator-owner via manifest.createdBy",
  listAppApiKeys:
    "pure read of API key metadata (no plaintext secret); relies on the " +
    "AppSync field-level auth already applied ahead of this resolver",
  listAppAccessEntries: "pure read of the access-control listing",
  getAppMetrics: "pure read of aggregated metrics",
  publishAppStatusEvent:
    "internal EventBridge publish helper invoked by other already-gated " +
    "handlers, not a caller-facing app mutation in its own right",
  // KNOWN PRE-EXISTING GAP — flagged, NOT silently excused. Both mutate the
  // manifest's workflowIds (writeManifestMutation + updateResource) with NO
  // assertManifestAccess call, matching the exact shape of finding 6400b440
  // (deleteApp). Left out of this fix's scope because gating them at
  // 'editor' would require updating existing passing tests in
  // registry-agent-record-resolver-workflows.test.ts and
  // registry-agent-record-resolver-identity.test.ts that currently seed
  // `access: {}` with no createdBy and assert success with no identity
  // gate at all — that is a second, separate fix that needs its own
  // red/green cycle and reviewer sign-off, not something to fold silently
  // into the deleteApp fix. Tracked for a dedicated follow-up; DO NOT
  // remove this entry without actually adding the gate.
  bindWorkflowToApp:
    "PRE-EXISTING GAP, not yet gated — mutates manifest.workflowIds with " +
    "no assertManifestAccess call; tracked for follow-up, see comment above",
  unbindWorkflowFromApp:
    "PRE-EXISTING GAP, not yet gated — mutates manifest.workflowIds with " +
    "no assertManifestAccess call; tracked for follow-up, see comment above",
};

describe("registry-agent-record-resolver — dispatch enumeration completeness", () => {
  const source = fs.readFileSync(RESOLVER_PATH, "utf-8");
  const cases = extractDispatchCases(source);

  test("the dispatch switch actually has cases to check (sanity check on the parser itself)", () => {
    expect(cases.length).toBeGreaterThan(15);
    expect(cases).toContain("deleteApp");
    expect(cases).toContain("grantAppAccess");
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
    },
  );
});
