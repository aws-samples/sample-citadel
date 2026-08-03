/**
 * Property test — CIT-101 acceptance criterion (design §7):
 *
 *   "frozen-or-referenced suite rejects all mutations with zero DDB writes"
 *
 * For any suite where status === 'FROZEN' OR references.length > 0, EVERY
 * mutating operation (updateEvalSuite, addEvalCase, updateEvalCase,
 * deleteEvalCase, importReplayAsEvalCase) must throw AND must perform zero
 * DDB write commands (Put/Update/Delete).
 *
 * MUTANT-BITE PROOF: a fast-check property that passes trivially against a
 * correct implementation proves little on its own — it must also FAIL
 * against a guard-stripped mutant, or it could be vacuously true (e.g. if
 * the arbitrary never generates a frozen/referenced suite, or if every
 * "mutation" already no-ops for unrelated reasons). This file's second
 * describe block imports a mutant build of the resolver with the
 * immutability guard's call-site commented out (assertSuiteMutable calls
 * removed) and asserts the SAME property FAILS against it. This is done by
 * dynamically require()-ing a mutant source file generated into
 * `../.mutant-scratch/eval-resolver.mutant.ts` from the real source with the
 * guard call-sites stripped, compiled via ts-node-free `jest` transform
 * (the file lives under src/lambda so it goes through the same ts-jest
 * transform as the module under test), run once, then deleted — the mutant
 * file is never committed.
 */
import * as fc from "fast-check";
import {
  DynamoDBDocumentClient,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
  GetCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import * as fs from "fs";
import * as path from "path";
import type { AuthContext, EvalSuite } from "../../types";

process.env.EVAL_SUITES_TABLE = "citadel-eval-suites-test";
process.env.EVAL_CASES_TABLE = "citadel-eval-cases-test";
process.env.EVENT_BUS_NAME = "citadel-agents-test";

const ddbMock = mockClient(DynamoDBDocumentClient);

function authContextFor(): AuthContext {
  return {
    userId: "user-architect",
    username: "architect",
    groups: [],
    roles: ["architect"],
  };
}

function frozenOrReferencedSuiteArb(): fc.Arbitrary<EvalSuite> {
  return fc
    .record({
      suiteId: fc.uuid(),
      orgId: fc.string({ minLength: 1, maxLength: 10 }),
      agentTargetId: fc.string({ minLength: 1, maxLength: 10 }),
      name: fc.string({ minLength: 1, maxLength: 20 }),
      description: fc.string({ maxLength: 20 }),
      semver: fc.constant("1.0.0"),
      version: fc.integer({ min: 1, max: 100 }),
      createdAt: fc.constant("2026-04-29T00:00:00.000Z"),
      createdBy: fc.constant("user-architect"),
      updatedAt: fc.constant("2026-04-29T00:00:00.000Z"),
      // Two independent immutability triggers — generate either or both.
      frozen: fc.boolean(),
      referenceCount: fc.integer({ min: 0, max: 3 }),
    })
    .filter((r) => r.frozen || r.referenceCount > 0)
    .map((r) => ({
      suiteId: r.suiteId,
      orgId: r.orgId,
      agentTargetId: r.agentTargetId,
      name: r.name,
      description: r.description,
      semver: r.semver,
      status: r.frozen ? ("FROZEN" as const) : ("DRAFT" as const),
      version: r.version,
      references: Array.from(
        { length: r.referenceCount },
        (_, i) => `ref-${i}`,
      ),
      createdAt: r.createdAt,
      createdBy: r.createdBy,
      updatedAt: r.updatedAt,
    }));
}

const CASE_INPUT_ARB = fc.record({
  name: fc.string({ minLength: 1, maxLength: 20 }),
  description: fc.string({ maxLength: 20 }),
  kind: fc.constantFrom("CONVERSATION" as const, "EXECUTION" as const),
  input: fc.record({ prompt: fc.string({ maxLength: 20 }) }),
  expectedOutcome: fc.record({
    mode: fc.constant("CONTAINS" as const),
    target: fc.string({ maxLength: 20 }),
  }),
  requiredTools: fc.constant([] as string[]),
  forbiddenTools: fc.constant([] as string[]),
});

/**
 * Run every mutating operation against a given (frozen/referenced) suite and
 * assert each one throws with zero DDB write commands. Returns the list of
 * operations that did NOT throw (empty array = property holds).
 */
async function runMutationsAgainst(
  resolverModule: typeof import("../eval-resolver"),
  suite: EvalSuite,
  caseInput: ReturnType<(typeof CASE_INPUT_ARB)["generate"]> extends never
    ? never
    : Record<string, unknown>,
): Promise<string[]> {
  const auth = authContextFor();
  const violations: string[] = [];

  const attempts: Array<[string, () => Promise<unknown>]> = [
    [
      "updateEvalSuite",
      () =>
        resolverModule.updateEvalSuite(
          suite.suiteId,
          {
            orgId: suite.orgId,
            agentTargetId: suite.agentTargetId,
            name: "mutated",
            description: "mutated",
            semver: "9.9.9",
          },
          auth,
        ),
    ],
    [
      "addEvalCase",
      () => resolverModule.addEvalCase(suite.suiteId, caseInput as never, auth),
    ],
    [
      "updateEvalCase",
      () =>
        resolverModule.updateEvalCase(
          suite.suiteId,
          "case-x",
          caseInput as never,
          auth,
        ),
    ],
    [
      "deleteEvalCase",
      () => resolverModule.deleteEvalCase(suite.suiteId, "case-x", auth),
    ],
    [
      "importReplayAsEvalCase",
      () =>
        resolverModule.importReplayAsEvalCase(
          suite.suiteId,
          {
            schemaVersion: "1.0.0",
            kind: "conversation",
            sections: { messages: [] },
          },
          auth,
        ),
    ],
  ];

  for (const [opName, run] of attempts) {
    ddbMock.reset();
    ddbMock.on(GetCommand).resolves({ Item: suite });
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    let threw = false;
    try {
      await run();
    } catch {
      threw = true;
    }

    const writeCount =
      ddbMock.commandCalls(PutCommand).length +
      ddbMock.commandCalls(UpdateCommand).length +
      ddbMock.commandCalls(DeleteCommand).length;

    if (!threw || writeCount > 0) {
      violations.push(`${opName} (threw=${threw}, writes=${writeCount})`);
    }
  }

  return violations;
}

describe("CIT-101 acceptance property: frozen-or-referenced suite rejects all mutations with zero DDB writes", () => {
  test("property holds against the real implementation (100 iterations)", async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const resolverModule = await import("../eval-resolver");

    await fc.assert(
      fc.asyncProperty(
        frozenOrReferencedSuiteArb(),
        CASE_INPUT_ARB,
        async (suite, caseInput) => {
          const violations = await runMutationsAgainst(
            resolverModule,
            suite,
            caseInput,
          );
          expect(violations).toEqual([]);
        },
      ),
      { numRuns: 100 },
    );
  });

  // ── Mutant-bite proof ────────────────────────────────────────────────────
  //
  // Generates a mutant of eval-resolver.ts with every assertSuiteMutable(...)
  // call-site stripped (guard removed), runs the SAME property against it,
  // and requires the property to FAIL — proving the test actually exercises
  // the guard rather than being vacuously true. The mutant file is written
  // to a scratch path, imported, and deleted in a finally block regardless
  // of outcome.

  const SOURCE_PATH = path.resolve(__dirname, "../eval-resolver.ts");
  const MUTANT_DIR = path.resolve(__dirname, "../.mutant-scratch");
  const MUTANT_PATH = path.join(MUTANT_DIR, "eval-resolver.mutant.ts");

  function stripGuardCallSites(source: string): string {
    // Neutralize the guard's CHECK LOGIC inside assertSuiteMutable itself,
    // rather than deleting call-sites textually — one call-site
    // (updateEvalSuite) binds the result via `const suite = await
    // assertSuiteMutable(suiteId);`, so blanking that call-site would
    // leave a dangling `const suite = ` and fail to compile. Neutralizing
    // the function body is syntactically safe at every call-site AND is a
    // more faithful "guard removed" mutant: assertSuiteMutable still runs
    // and still returns the suite (so bound call-sites keep working), but
    // the frozen/referenced check itself never throws — exactly the bug
    // class ("guard-stripped") the acceptance property must catch.
    const guardBodyPattern =
      /if \(suite\.status === 'FROZEN' \|\| \(suite\.references\?\.length \?\? 0\) > 0\) \{\s*throw new Error\(\s*`ValidationError: eval suite \$\{suiteId\} is frozen\/referenced and cannot be mutated`,\s*\);\s*\}/;
    if (!guardBodyPattern.test(source)) {
      throw new Error(
        "Mutant generation could not find the assertSuiteMutable guard body to neutralize — " +
          "the guard-bite proof would be vacuous. Source may have been refactored; update this regex.",
      );
    }
    return (
      source
        .replace(
          guardBodyPattern,
          '/* MUTANT: guard check neutralized */ if (false) { throw new Error("unreachable"); }',
        )
        // The mutant file lives one directory deeper (src/lambda/.mutant-scratch/)
        // than the original (src/lambda/), so every '../xyz' sibling import must
        // become '../../xyz' to resolve identically.
        .replace(/from '\.\.\//g, "from '../../")
    );
  }

  test("mutant-bite proof: property FAILS against a guard-stripped mutant (guard call-sites removed)", async () => {
    const originalSource = fs.readFileSync(SOURCE_PATH, "utf8");
    const mutantSource = stripGuardCallSites(originalSource);

    fs.mkdirSync(MUTANT_DIR, { recursive: true });
    fs.writeFileSync(MUTANT_PATH, mutantSource, "utf8");

    try {
      // Import the mutant through the same ts-jest transform (relative path
      // under src/lambda, sibling to the real module — its own relative
      // imports of ../types, ../adapters/lifecycle, etc. resolve identically).
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mutantModule =
        await import("../.mutant-scratch/eval-resolver.mutant");

      let propertyFailed = false;
      try {
        await fc.assert(
          fc.asyncProperty(
            frozenOrReferencedSuiteArb(),
            CASE_INPUT_ARB,
            async (suite, caseInput) => {
              const violations = await runMutationsAgainst(
                mutantModule as unknown as typeof import("../eval-resolver"),
                suite,
                caseInput,
              );
              expect(violations).toEqual([]);
            },
          ),
          { numRuns: 100 },
        );
      } catch {
        // Expected: the mutant violates the property, so fast-check throws.
        propertyFailed = true;
      }

      expect(propertyFailed).toBe(true);
    } finally {
      // Always clean up the scratch mutant — it must never be committed.
      fs.rmSync(MUTANT_DIR, { recursive: true, force: true });
    }
  });
});
