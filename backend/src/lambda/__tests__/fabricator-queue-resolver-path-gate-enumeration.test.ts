/**
 * Path-enumeration guard for fabricator-queue-resolver.ts (cross-tenant
 * exposure fix, design evidence bf4a13f2). This resolver has no
 * `switch (fieldName)` dispatch — it's a single-field handler with exactly
 * two access PATHS gated on whether the caller supplied a `projectId`. This
 * guard is the shape-appropriate sibling of the dispatch-gate-enumeration
 * guards used on multi-field resolvers (tool-config-resolver,
 * registry-agent-record-resolver, etc.): instead of enumerating switch
 * cases and checking each is either gated or exempted, it enumerates the
 * two known access paths and asserts BOTH are routed through the org-scope
 * gate, and that the previously-exploited unfiltered-Scan path is entirely
 * absent from the source — not just unreachable at runtime, but literally
 * not present as code a future edit could accidentally re-enable.
 *
 * Root defect this closes (see fabricator-queue-resolver-org-scoping.test.ts
 * for the behavioral tests): getFabricatorQueue leaked cross-tenant data via
 * (a) a projectId-bound Query with no org reconciliation, and (b) an
 * unfiltered ScanCommand harvesting up to 100 rows across every tenant.
 */
import * as fs from "fs";
import * as path from "path";

const HANDLER_PATH = path.join(__dirname, "..", "fabricator-queue-resolver.ts");

describe("fabricator-queue-resolver — path enumeration completeness (no dispatch switch; two projectId-gated paths)", () => {
  const source = fs.readFileSync(HANDLER_PATH, "utf-8");

  test("sanity check: the handler function actually exists at the expected export", () => {
    expect(/export const handler = async/.test(source)).toBe(true);
  });

  test("the previously-exploited unfiltered ScanCommand is entirely absent from the source (not merely unreached)", () => {
    // Not just "never called" — the import and the class reference must
    // both be gone, so a future edit can't silently reintroduce the Scan
    // path by importing it back in and wiring it up.
    expect(/\bScanCommand\b/.test(source)).toBe(false);
    expect(source).not.toMatch(
      /from ["']@aws-sdk\/lib-dynamodb["'][^;]*ScanCommand/,
    );
  });

  test("the handler resolves the caller's org via extractOrgFromEvent before either path runs a query", () => {
    const handlerBody = source.slice(source.indexOf("export const handler"));
    const orgCallIdx = handlerBody.search(/extractOrgFromEvent\s*\(/);
    const queryIdx = handlerBody.search(/new QueryCommand\s*\(/);
    expect(orgCallIdx).toBeGreaterThan(-1);
    expect(queryIdx).toBeGreaterThan(-1);
    expect(orgCallIdx).toBeLessThan(queryIdx);
  });

  test("the handler fails closed (returns before any DynamoDB call) when the caller org is unresolved", () => {
    const handlerBody = source.slice(source.indexOf("export const handler"));
    const orgCheckMatch = handlerBody.match(
      /if\s*\(\s*!callerOrg\s*\)\s*\{[^}]*return\s*\[\]\s*;/s,
    );
    expect(orgCheckMatch).not.toBeNull();
    const queryIdx = handlerBody.search(/new QueryCommand\s*\(/);
    const failClosedIdx = orgCheckMatch
      ? handlerBody.indexOf(orgCheckMatch[0])
      : -1;
    expect(failClosedIdx).toBeGreaterThan(-1);
    expect(failClosedIdx).toBeLessThan(queryIdx);
  });

  describe.each([
    { pathName: "no-projectId path", hasProjectId: false },
    { pathName: "projectId-supplied path", hasProjectId: true },
  ])("$pathName", ({ hasProjectId }) => {
    test("both paths share the SAME single QueryCommand call against the org-scoped index (no separate unscoped branch)", () => {
      const queryMatches = source.match(/new QueryCommand\s*\(/g) ?? [];
      // Exactly one QueryCommand call site in the whole module: both the
      // projectId and no-projectId cases must flow through it — a second
      // call site would mean a path bypassing the org-scope gate.
      expect(queryMatches).toHaveLength(1);

      const queryCallSite = source.slice(
        source.indexOf("new QueryCommand("),
        source.indexOf("new QueryCommand(") + 500,
      );
      expect(queryCallSite).toMatch(/IndexName:\s*ORG_INDEX_NAME/);
      expect(queryCallSite).toMatch(/orgId\s*=\s*:orgId/);
      expect(queryCallSite).toMatch(/":orgId":\s*callerOrg/);

      if (hasProjectId) {
        // The projectId path must filter WITHIN the already org-scoped
        // result set, never via a second/alternate query bound to a raw
        // client-supplied key.
        expect(source).toMatch(/item\.orchestrationId\s*===\s*projectId/);
      }
    });
  });

  test("ORG_INDEX_NAME is a fixed literal, never derived from event/arguments input", () => {
    const constMatch = source.match(
      /const ORG_INDEX_NAME\s*=\s*(["'][^"']+["']);/,
    );
    expect(constMatch).not.toBeNull();
    // Must not reference event.arguments / event.identity anywhere on the
    // same declaration line — the index name is not client-influenceable.
    expect(source).not.toMatch(/ORG_INDEX_NAME\s*=\s*event\./);
  });
});
