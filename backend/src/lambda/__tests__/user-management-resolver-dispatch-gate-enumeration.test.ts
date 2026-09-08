/**
 * Enumeration-completeness guard for user-management-resolver.ts's dispatch
 * switch (finding f21582e6 — the class-closing move mirroring
 * registry-agent-record-resolver-dispatch-gate-enumeration.test.ts and
 * app-publish-handler-dispatch-gate-enumeration.test.ts).
 *
 * Root cause of f21582e6 was that listUsers, getUser, listOrganizations and
 * listAvailableRoles read NO identity at all — the bug class this guard
 * closes is "a dispatch case whose handler never reads caller identity",
 * not merely "no admin gate" (several ops in this module are deliberately
 * non-admin-gated reads that still MUST read identity to fail closed).
 *
 * Unlike the two existing guards (which check for a single shared mutation
 * gate function name, assertManifestAccess/assertManifestOwnerAccess), this
 * module has no single shared gate call — each handler independently reads
 * `event.identity?.username || event.identity?.claims?.username` (inline,
 * for the pre-existing mutating ops) or calls the newer
 * `requireCallerUsername(event)` helper (for the ops fixed by f21582e6).
 * IDENTITY_READ_RE below matches either shape so pre-existing and
 * newly-fixed handlers are both recognized.
 *
 * Every case must appear in exactly one of:
 *   - GATED_OPS: handler function body reads caller identity (either shape)
 *     before returning/mutating.
 *   - EXEMPT_OPS: legitimately exempt, each with an explicit reason.
 *
 * If neither list accounts for a case, or a GATED op's handler function no
 * longer reads identity, the test fails loudly.
 */
import * as fs from "fs";
import * as path from "path";

const RESOLVER_PATH = path.join(__dirname, "..", "user-management-resolver.ts");

function extractDispatchCases(source: string): string[] {
  const switchStart = source.indexOf("switch (fieldName)");
  if (switchStart === -1) {
    throw new Error(
      "Could not locate `switch (fieldName)` in user-management-resolver.ts — " +
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
 * `case 'listUsers': return await listUsers(event);` -> "listUsers".
 */
function extractHandlerCallSite(
  switchBody: string,
  fieldName: string,
): string | null {
  const caseRe = new RegExp(
    `case\\s+['"]${fieldName}['"]\\s*:\\s*\\n?\\s*return\\s+await\\s+([A-Za-z0-9_]+)\\s*\\(`,
  );
  const m = caseRe.exec(switchBody);
  return m ? m[1] : null;
}

/**
 * Extracts a top-level `async function <name>(...) { ... }` body by
 * brace-counting from the `function` keyword, matching the parameter
 * list's closing paren first (parameter type annotations can contain
 * object-literal-shaped braces).
 */
function extractFunctionBody(source: string, fnName: string): string {
  const declRe = new RegExp(`async function ${fnName}\\s*\\(`);
  const declMatch = declRe.exec(source);
  if (!declMatch) {
    throw new Error(
      `Could not locate function declaration for '${fnName}' in user-management-resolver.ts`,
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

/**
 * Matches either identity-read shape present in this file:
 *  - the pre-existing inline read: `event.identity?.username ||
 *    event.identity?.claims?.username`
 *  - the f21582e6 helper: `requireCallerUsername(event)`
 */
const IDENTITY_READ_RE =
  /(event\.identity\?\.username\s*\|\|\s*event\.identity\?\.claims\?\.username)|(requireCallerUsername\s*\()/;

/**
 * Ops verified to read caller identity inside their handler function body.
 * `reason` documents why (admin-gated mutation, org-scoped read, or
 * self-scoped op) — enforcement is structural (IDENTITY_READ_RE against the
 * real source), this is documentation for humans.
 */
const GATED_OPS: Record<string, { reason: string }> = {
  listUsers: { reason: "org-scoped read; admin bypass (f21582e6 fix)" },
  getUser: { reason: "org-scoped read; admin/self bypass (f21582e6 fix)" },
  listAvailableRoles: {
    reason:
      "no tenant data, but must fail closed on unresolvable identity (f21582e6 fix)",
  },
  listOrganizations: { reason: "org-scoped read; admin bypass (f21582e6 fix)" },
  adminCreateUser: { reason: "pre-existing admin-gated mutation" },
  assignUserRole: {
    reason:
      "pre-existing admin-gated mutation; org-confinement gap accepted separately (finding 59e5a79c), NOT touched here",
  },
  removeUserRole: {
    reason:
      "pre-existing admin-gated mutation; org-confinement gap accepted separately (finding 59e5a79c), NOT touched here",
  },
  changePassword: {
    reason: "pre-existing self-scoped mutation (own password only)",
  },
  adminResetUserPassword: { reason: "pre-existing admin-gated mutation" },
  adminResendInvitation: { reason: "pre-existing admin-gated mutation" },
};

/**
 * Ops that legitimately do not read identity directly in their OWN handler
 * body, each with an explicit reason.
 */
const EXEMPT_OPS: Record<string, string> = {
  getCurrentUserProfile:
    "reads identity itself (inline shape) to resolve the caller's own username, " +
    "then delegates the identity-gated work to getUser(username, event) — " +
    "the delegate is separately covered by GATED_OPS.getUser",
};

describe("user-management-resolver — dispatch enumeration completeness", () => {
  const source = fs.readFileSync(RESOLVER_PATH, "utf-8");
  const cases = extractDispatchCases(source);

  test("the dispatch switch actually has cases to check (sanity check on the parser itself)", () => {
    expect(cases.length).toBeGreaterThanOrEqual(11);
    expect(cases).toContain("listUsers");
    expect(cases).toContain("getUser");
    expect(cases).toContain("listOrganizations");
    expect(cases).toContain("listAvailableRoles");
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

  test("getCurrentUserProfile (EXEMPT) still reads identity inline before delegating", () => {
    const switchStart = source.indexOf("switch (fieldName)");
    const defaultIdx = source.indexOf("default:", switchStart);
    const switchBody = source.slice(switchStart, defaultIdx);
    const handlerName = extractHandlerCallSite(
      switchBody,
      "getCurrentUserProfile",
    );
    expect(handlerName).not.toBeNull();
    const body = extractFunctionBody(source, handlerName as string);
    expect(IDENTITY_READ_RE.test(body)).toBe(true);
  });

  describe.each(Object.entries(GATED_OPS))(
    "GATED_OPS['%s'] handler actually reads caller identity",
    (fieldName, meta) => {
      test(`${fieldName} (${meta.reason}) contains an identity-read (inline or requireCallerUsername)`, () => {
        const switchStart = source.indexOf("switch (fieldName)");
        const defaultIdx = source.indexOf("default:", switchStart);
        const switchBody = source.slice(switchStart, defaultIdx);
        const handlerName = extractHandlerCallSite(switchBody, fieldName);
        expect(handlerName).not.toBeNull();
        const body = extractFunctionBody(source, handlerName as string);
        expect(IDENTITY_READ_RE.test(body)).toBe(true);
      });
    },
  );
});
