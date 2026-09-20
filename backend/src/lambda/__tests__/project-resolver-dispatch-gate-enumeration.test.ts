/**
 * Enumeration-completeness guard for project-resolver.ts's dispatch
 * switch (finding 41c1cd9b — completes the dispatch gate-enumeration
 * family). Modeled on the dispatch gate-enumeration siblings via the
 * shared AST helpers (fixtures/dispatch-gate-ast-helpers.ts).
 *
 * Classification — every op is ORG-RECONCILED, in one of three shapes:
 *  - readGate: getProject / listProjects — admin bypass via
 *    isAdminFromEvent; non-admins are owner-or-same-org checked
 *    (getProject throws "Access denied" on mismatch; listProjects scopes
 *    the query to the caller's org via extractOrgFromEvent). getProject
 *    doubles as the shared access gate that assertProjectAccess in
 *    ../utils/project-access.ts mirrors (finding 60a5a6ae).
 *  - accessRecheck: updateProject / uploadDocument — the delegate's
 *    FIRST step re-runs getProject (which enforces the owner-or-same-org
 *    gate) and throws when it returns null, BEFORE any write/emit. Bite:
 *    source-position ordering vs the first docClient.send /
 *    emitEvent call.
 *  - serverDerivedWrite: createProject — stamps the persisted row's
 *    `organization:` from the server-derived caller org
 *    (extractOrgFromEvent) and `owner:` from the caller's identity;
 *    the deliberate `|| DEFAULT_ORGANIZATION` fallback keeps claim-less
 *    users on a real, shared GSI partition (documented in the source) —
 *    the client cannot choose the organization.
 */
import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";
import {
  callReceivesBareEvent,
  collectCalls,
  collectPropertyAssignments,
  containsThrow,
  extractDispatch,
  findDispatchSwitch,
  findHandlerArrowBody,
  findTopLevelFunction,
  functionBody,
  parseSource,
} from "./fixtures/dispatch-gate-ast-helpers";

const HANDLER_PATH = path.join(__dirname, "..", "project-resolver.ts");

const SIDE_EFFECT_CALLEES = ["docClient.send", "emitEvent"];

const READ_GATED_OPS: Record<string, { fn: string }> = {
  getProject: { fn: "getProject" },
  listProjects: { fn: "listProjects" },
};

const ACCESS_RECHECK_OPS: Record<string, { fn: string }> = {
  updateProject: { fn: "updateProject" },
  uploadDocument: { fn: "uploadDocument" },
};

const SERVER_DERIVED_WRITE_OPS: Record<string, { fn: string }> = {
  createProject: { fn: "createProject" },
};

describe("project-resolver — dispatch enumeration completeness", () => {
  const source = fs.readFileSync(HANDLER_PATH, "utf-8");
  const sf = parseSource(source, "project-resolver.ts");
  const handlerBody = findHandlerArrowBody(sf);
  const dispatch = extractDispatch(findDispatchSwitch(handlerBody));
  const caseNames = Array.from(dispatch.cases.keys());

  const allClassified = new Set([
    ...Object.keys(READ_GATED_OPS),
    ...Object.keys(ACCESS_RECHECK_OPS),
    ...Object.keys(SERVER_DERIVED_WRITE_OPS),
  ]);

  test("the dispatch switch actually has cases to check (sanity check on the parser itself)", () => {
    expect(caseNames.length).toBeGreaterThanOrEqual(5);
    expect(caseNames).toEqual(
      expect.arrayContaining(["getProject", "createProject"]),
    );
  });

  test("every dispatch case is accounted for in exactly one classification table", () => {
    const unaccounted = caseNames.filter((c) => !allClassified.has(c));
    expect(unaccounted).toEqual([]);
  });

  test("no classification entry references a case that no longer exists in the switch", () => {
    const known = new Set(caseNames);
    const stale = [...allClassified].filter((k) => !known.has(k));
    expect(stale).toEqual([]);
  });

  test("the classification tables jointly cover exactly the dispatch surface", () => {
    expect(allClassified.size).toBe(caseNames.length);
  });

  test("the dispatch default clause throws on unknown fields (fails closed)", () => {
    expect(dispatch.hasDefault).toBe(true);
    expect(containsThrow(dispatch.defaultClause as ts.Node)).toBe(true);
  });

  test("every dispatch case forwards the raw `event` into its delegate (the gates' input)", () => {
    for (const [fieldName, clause] of dispatch.cases) {
      const calls = collectCalls(clause, sf);
      expect({
        fieldName,
        forwardsEvent: calls.some((c) => callReceivesBareEvent(c.node)),
      }).toEqual({ fieldName, forwardsEvent: true });
    }
  });

  describe("READ_GATED_OPS['getProject'] (ORG-RECONCILED: admin bypass, else owner-or-same-org)", () => {
    const body = functionBody(findTopLevelFunction(sf, "getProject"));
    const calls = collectCalls(body, sf);

    test("derives identity server-side: isAdminFromEvent bypass + extractOrgFromEvent org check", () => {
      expect(calls.some((c) => c.callee === "isAdminFromEvent")).toBe(true);
      expect(calls.some((c) => c.callee === "extractOrgFromEvent")).toBe(true);
    });

    test("fails closed: a real if/throw guards the hasAccess decision", () => {
      let failClosed = false;
      const visit = (n: ts.Node): void => {
        if (
          ts.isIfStatement(n) &&
          ts.isPrefixUnaryExpression(n.expression) &&
          n.expression.operator === ts.SyntaxKind.ExclamationToken &&
          n.expression.operand.getText(sf) === "hasAccess" &&
          containsThrow(n.thenStatement)
        ) {
          failClosed = true;
        }
        n.forEachChild(visit);
      };
      visit(body);
      expect(failClosed).toBe(true);
    });

    test("the hasAccess decision covers both legs: owner match OR same organization", () => {
      const text = body.getText(sf);
      const idx = text.indexOf("const hasAccess");
      expect(idx).toBeGreaterThan(-1);
      const slice = text.slice(idx, idx + 200);
      expect(slice).toContain("project.owner === userId");
      expect(slice).toContain("project.organization === userOrganization");
    });
  });

  describe("READ_GATED_OPS['listProjects'] (ORG-RECONCILED: admin full scan, else org-scoped query)", () => {
    const body = functionBody(findTopLevelFunction(sf, "listProjects"));
    const calls = collectCalls(body, sf);

    test("derives identity server-side: isAdminFromEvent bypass + extractOrgFromEvent scoping", () => {
      expect(calls.some((c) => c.callee === "isAdminFromEvent")).toBe(true);
      expect(calls.some((c) => c.callee === "extractOrgFromEvent")).toBe(true);
    });

    test("the non-admin path queries the OrganizationIndex keyed on the server-derived org (never a client argument)", () => {
      const text = body.getText(sf);
      expect(text).toContain('IndexName: "OrganizationIndex"');
      expect(text).toContain('":org": userOrganization');
    });
  });

  describe.each(Object.entries(ACCESS_RECHECK_OPS))(
    "ACCESS_RECHECK_OPS['%s'] (ORG-RECONCILED via the getProject gate)",
    (fieldName, meta) => {
      const body = functionBody(findTopLevelFunction(sf, meta.fn));
      const calls = collectCalls(body, sf);

      test(`${meta.fn} re-runs the getProject access gate with the raw \`event\` and throws when it returns null`, () => {
        const gates = calls.filter((c) => c.callee === "getProject");
        expect(gates.length).toBeGreaterThanOrEqual(1);
        expect(gates.some((c) => callReceivesBareEvent(c.node))).toBe(true);
        expect(containsThrow(body)).toBe(true);
      });

      test(`${meta.fn}'s getProject gate precedes its first side-effect call (bite: ordering)`, () => {
        const gates = calls.filter((c) => c.callee === "getProject");
        const effects = calls.filter((c) =>
          SIDE_EFFECT_CALLEES.includes(c.callee),
        );
        expect(gates.length).toBeGreaterThanOrEqual(1);
        expect(effects.length).toBeGreaterThanOrEqual(1);
        expect(Math.min(...gates.map((c) => c.start))).toBeLessThan(
          Math.min(...effects.map((c) => c.start)),
        );
      });
    },
  );

  describe("SERVER_DERIVED_WRITE_OPS['createProject'] (ORG-RECONCILED by server-side derivation)", () => {
    const body = functionBody(findTopLevelFunction(sf, "createProject"));
    const calls = collectCalls(body, sf);

    test("derives the organization server-side (extractOrgFromEvent) before the write", () => {
      const gates = calls.filter((c) => c.callee === "extractOrgFromEvent");
      const effects = calls.filter((c) =>
        SIDE_EFFECT_CALLEES.includes(c.callee),
      );
      expect(gates.length).toBeGreaterThanOrEqual(1);
      expect(effects.length).toBeGreaterThanOrEqual(1);
      expect(Math.min(...gates.map((c) => c.start))).toBeLessThan(
        Math.min(...effects.map((c) => c.start)),
      );
    });

    test("the persisted row's organization: is the server-derived value and owner: is the caller identity — never client input", () => {
      const orgAssignments = collectPropertyAssignments(
        body,
        "organization",
        sf,
      );
      expect(orgAssignments).toEqual(["userOrganization"]);
      const ownerAssignments = collectPropertyAssignments(body, "owner", sf);
      expect(ownerAssignments).toEqual(["userId"]);
    });
  });
});
