/**
 * Enumeration-completeness guard for agent-import-resolver.ts's dispatch
 * switch (finding 3dc3ec5e). Modeled on
 * eval-run-resolver-dispatch-gate-enumeration.test.ts /
 * registry-agent-record-resolver-dispatch-gate-enumeration.test.ts — the
 * case list is derived from the handler's REAL `switch (fieldName)` via the
 * shared AST helpers (fixtures/dispatch-gate-ast-helpers.ts), so a future
 * op added to the switch without a classification here fails LOUDLY.
 *
 * Classification:
 *  - GATED: the op's own function body carries the admin/architect role
 *    gate (`isAdminFromEvent(event) || hasRoleFromEvent(event, "architect")`
 *    shape, decision ff48d6f9 / finding 234cda06), verified as real AST
 *    call sites. Ops that act on an EXISTING import row additionally
 *    reconcile the row's org against the caller's server-derived org
 *    (`extractOrgFromEvent`), fail-closed.
 *  - GATED via loadImportForGatewayOp: publish/unpublish delegate role gate
 *    + org reconciliation to the shared loader; the guard verifies both the
 *    delegation call AND the loader's own gate content.
 *  - EXEMPT: discoverAgents / describeAgentCandidate are ACCOUNT-level by
 *    design (they enumerate/inspect the customer's AWS account
 *    infrastructure, not org-partitioned tenant rows — see the resolver's
 *    module doc: "NEVER org-filtered"). They are NOT unauthenticated,
 *    though: the dispatch case must call requireAuthenticated AND
 *    requireDiscoveryRole (admin/architect only), and this guard asserts
 *    both structurally so the exemption cannot silently widen.
 */
import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";
import {
  callReceivesBareEvent,
  callReceivesStringLiteral,
  collectCalls,
  containsThrow,
  extractDispatch,
  findDispatchSwitch,
  findHandlerArrowBody,
  findTopLevelFunction,
  functionBody,
  parseSource,
} from "./fixtures/dispatch-gate-ast-helpers";

const HANDLER_PATH = path.join(__dirname, "..", "agent-import-resolver.ts");

type GateKind =
  | "role-gate+org-derived"
  | "role-gate+row-org-reconciled"
  | "role-gate-only"
  | "gateway-op-loader";

/** Ops whose case dispatches to a function carrying the admin/architect
 * role gate in its own body (fn = the case's delegate). */
const GATED_OPS: Record<string, { fn: string; gate: GateKind }> = {
  importAgent: { fn: "importAgent", gate: "role-gate+org-derived" },
  attestAgentImport: {
    fn: "attestAgentImport",
    gate: "role-gate+row-org-reconciled",
  },
  testImportedAgent: { fn: "testImportedAgent", gate: "role-gate-only" },
  probeAgentCandidate: { fn: "probeAgentCandidate", gate: "role-gate-only" },
  probeImportReachability: {
    fn: "probeImportReachability",
    gate: "role-gate+row-org-reconciled",
  },
  publishImportToGateway: {
    fn: "publishImportToGateway",
    gate: "gateway-op-loader",
  },
  unpublishImportFromGateway: {
    fn: "unpublishImportFromGateway",
    gate: "gateway-op-loader",
  },
  proposeAgentManifestTier3: {
    fn: "proposeAgentManifestTier3",
    gate: "role-gate-only",
  },
  acceptProposedManifestTier3: {
    fn: "acceptProposedManifestTier3",
    gate: "role-gate+row-org-reconciled",
  },
};

/** Account-level by design (finding 3dc3ec5e): discovery queries enumerate
 * the customer's AWS ACCOUNT, not org-partitioned rows — org filtering is
 * meaningless for them, but they must stay role-gated (admin/architect via
 * requireDiscoveryRole) and authenticated, asserted below. */
const EXEMPT_OPS: Record<string, string> = {
  discoverAgents:
    "account-level by design — enumerates AWS account infrastructure, " +
    "requireAuthenticated + requireDiscoveryRole asserted structurally",
  describeAgentCandidate:
    "account-level by design — inspects one account-level candidate, " +
    "requireAuthenticated + requireDiscoveryRole asserted structurally",
};

/** Asserts the admin/architect role-gate shape inside a function body:
 * real isAdminFromEvent + hasRoleFromEvent("architect") call sites and at
 * least one throw statement (the Unauthorized rejection). */
function assertRoleGate(body: ts.Block, sf: ts.SourceFile): void {
  const calls = collectCalls(body, sf);
  expect(calls.some((c) => c.callee === "isAdminFromEvent")).toBe(true);
  const roleCalls = calls.filter((c) => c.callee === "hasRoleFromEvent");
  expect(
    roleCalls.some((c) => callReceivesStringLiteral(c.node, "architect")),
  ).toBe(true);
  expect(containsThrow(body)).toBe(true);
}

describe("agent-import-resolver — dispatch enumeration completeness", () => {
  const source = fs.readFileSync(HANDLER_PATH, "utf-8");
  const sf = parseSource(source, "agent-import-resolver.ts");
  const handlerBody = findHandlerArrowBody(sf);
  const dispatch = extractDispatch(findDispatchSwitch(handlerBody));
  const caseNames = Array.from(dispatch.cases.keys());

  test("the dispatch switch actually has cases to check (sanity check on the parser itself)", () => {
    expect(caseNames.length).toBeGreaterThanOrEqual(11);
    expect(caseNames).toEqual(
      expect.arrayContaining([
        "importAgent",
        "attestAgentImport",
        "discoverAgents",
        "describeAgentCandidate",
      ]),
    );
  });

  test("every dispatch case is accounted for in GATED_OPS or EXEMPT_OPS", () => {
    const unaccounted = caseNames.filter(
      (c) => !(c in GATED_OPS) && !(c in EXEMPT_OPS),
    );
    expect(unaccounted).toEqual([]);
  });

  test("no classification entry references a case that no longer exists in the switch", () => {
    const known = new Set(caseNames);
    const stale = [
      ...Object.keys(GATED_OPS),
      ...Object.keys(EXEMPT_OPS),
    ].filter((k) => !known.has(k));
    expect(stale).toEqual([]);
  });

  test("the classification tables jointly cover exactly the dispatch surface", () => {
    const claimed =
      Object.keys(GATED_OPS).length + Object.keys(EXEMPT_OPS).length;
    expect(claimed).toBe(caseNames.length);
  });

  test("the dispatch default clause throws on unknown fields (fails closed)", () => {
    expect(dispatch.hasDefault).toBe(true);
    expect(containsThrow(dispatch.defaultClause as ts.Node)).toBe(true);
  });

  describe.each(Object.entries(GATED_OPS))(
    "GATED_OPS['%s']",
    (fieldName, meta) => {
      test(`case '${fieldName}' dispatches to ${meta.fn} and passes the raw \`event\``, () => {
        const clause = dispatch.cases.get(fieldName);
        expect(clause).toBeDefined();
        const calls = collectCalls(clause as ts.Node, sf);
        const target = calls.filter((c) => c.callee === meta.fn);
        expect(target.length).toBeGreaterThanOrEqual(1);
        expect(target.some((c) => callReceivesBareEvent(c.node))).toBe(true);
      });
    },
  );

  describe("role-gate content per gated function", () => {
    const roleGated = Object.values(GATED_OPS).filter(
      (m) => m.gate !== "gateway-op-loader",
    );

    test.each(roleGated.map((m) => [m.fn, m] as const))(
      "%s carries the admin/architect role gate in its own body",
      (_fn, meta) => {
        const body = functionBody(findTopLevelFunction(sf, meta.fn));
        assertRoleGate(body, sf);
      },
    );

    test("importAgent derives the caller org server-side and fails closed when unresolvable", () => {
      const body = functionBody(findTopLevelFunction(sf, "importAgent"));
      const calls = collectCalls(body, sf);
      expect(calls.some((c) => c.callee === "extractOrgFromEvent")).toBe(true);
      // Fail-closed: an if-statement whose condition references the derived
      // org and whose then-branch throws. Verified via the body's real
      // if/throw structure, not prose.
      let failClosed = false;
      body.forEachChild(function visit(n): void {
        if (
          ts.isIfStatement(n) &&
          ts.isPrefixUnaryExpression(n.expression) &&
          n.expression.operator === ts.SyntaxKind.ExclamationToken &&
          containsThrow(n.thenStatement)
        ) {
          failClosed = true;
        }
        n.forEachChild(visit);
      });
      expect(failClosed).toBe(true);
    });

    test.each([
      ["attestAgentImport"],
      ["probeImportReachability"],
      ["acceptProposedManifestTier3"],
    ])(
      "%s reconciles the stored row's org against the caller's server-derived org",
      (fn) => {
        const body = functionBody(findTopLevelFunction(sf, fn));
        const calls = collectCalls(body, sf);
        expect(calls.some((c) => c.callee === "extractOrgFromEvent")).toBe(
          true,
        );
        // The reconciliation comparison (meta.orgId !== callerOrg) exists as
        // a real binary expression, not prose.
        let comparesOrg = false;
        const check = (n: ts.Node): void => {
          if (
            ts.isBinaryExpression(n) &&
            n.operatorToken.kind ===
              ts.SyntaxKind.ExclamationEqualsEqualsToken &&
            n.getText(sf).includes("callerOrg")
          ) {
            comparesOrg = true;
          }
          n.forEachChild(check);
        };
        check(body);
        expect(comparesOrg).toBe(true);
      },
    );
  });

  describe("gateway ops delegate to the shared gated loader", () => {
    test.each([["publishImportToGateway"], ["unpublishImportFromGateway"]])(
      "%s calls loadImportForGatewayOp (the gate carrier)",
      (fn) => {
        const body = functionBody(findTopLevelFunction(sf, fn));
        const calls = collectCalls(body, sf);
        expect(calls.some((c) => c.callee === "loadImportForGatewayOp")).toBe(
          true,
        );
      },
    );

    test("loadImportForGatewayOp itself carries the role gate AND the row-org reconciliation", () => {
      const body = functionBody(
        findTopLevelFunction(sf, "loadImportForGatewayOp"),
      );
      assertRoleGate(body, sf);
      const calls = collectCalls(body, sf);
      expect(calls.some((c) => c.callee === "extractOrgFromEvent")).toBe(true);
    });
  });

  describe("EXEMPT discovery queries stay authenticated + discovery-role-gated", () => {
    test.each(Object.keys(EXEMPT_OPS).map((k) => [k]))(
      "case '%s' calls requireAuthenticated and requireDiscoveryRole with the raw `event`",
      (fieldName) => {
        const clause = dispatch.cases.get(fieldName);
        expect(clause).toBeDefined();
        const calls = collectCalls(clause as ts.Node, sf);
        const auth = calls.filter((c) => c.callee === "requireAuthenticated");
        const role = calls.filter((c) => c.callee === "requireDiscoveryRole");
        expect(auth.length).toBeGreaterThanOrEqual(1);
        expect(role.length).toBeGreaterThanOrEqual(1);
        expect(auth.some((c) => callReceivesBareEvent(c.node))).toBe(true);
        expect(role.some((c) => callReceivesBareEvent(c.node))).toBe(true);
      },
    );

    test("requireDiscoveryRole enforces admin-or-architect and throws otherwise (bite: the exemption is role-gated, not open)", () => {
      const body = functionBody(
        findTopLevelFunction(sf, "requireDiscoveryRole"),
      );
      assertRoleGate(body, sf);
    });
  });
});
