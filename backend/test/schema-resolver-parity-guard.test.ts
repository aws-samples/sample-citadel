/**
 * Generic parity guard — every schema.graphql Query/Mutation field must
 * have a wired AWS::AppSync::Resolver in one of the resolver-owning
 * stacks' synthesized CloudFormation templates.
 *
 * Motivated by finding 24563f6c: `Mutation.resumeExecution` was declared
 * in schema.graphql with a tested handler in execution-resolver.ts, but no
 * stack ever called `.createResolver(...)` / `new CfnResolver(...)` for it
 * — the field returned null in live dev. Neither the type checker, nor the
 * handler's own unit tests, nor `cdk synth` (which happily synthesizes an
 * AppSync API with fewer resolvers than schema fields — that is not a CFN
 * error) can catch a declared-but-unwired field. Only a guard that parses
 * the schema and cross-checks it against the resolver set closes this
 * defect CLASS, not just this one instance. (`scripts/split-gates/rails/
 * rail3-resolver-parity.ts` is a DIFFERENT check — it detects resolver
 * fields lost/gained relative to a pre-split baseline snapshot during the
 * backend-stack-split refactor; a field that was NEVER wired in the first
 * place has no baseline entry to diff against, so rail 3 would not have
 * caught this.)
 *
 * Resolver-owning stacks (confirmed by grep for `createResolver(` /
 * `new appsyncCfn.CfnResolver(` across backend/lib/*.ts — both produce the
 * identical `AWS::AppSync::Resolver` CFN resource type, so scanning for
 * that resource type in the synthesized template covers both wiring
 * styles uniformly): backend, registry, projects, governance, services,
 * arbiter. frontend/gateway/telemetry own zero AppSync resolvers.
 *
 * Reads already-synthesized templates from cdk.out (produced by
 * `npx cdk synth citadel-backend-dev citadel-registry-dev
 * citadel-projects-dev citadel-governance-dev citadel-services-dev
 * citadel-arbiter-dev`, or a full `npx cdk synth --all`). Skips gracefully
 * if cdk.out is absent so a bare `npm test` (no prior synth) does not fail
 * the whole suite — mirrors the existing rail-2 stateful-pin test's skip
 * convention (test/split-gates-rail2-stateful-pin.test.ts).
 */
import * as fs from "fs";
import * as path from "path";
import { parse } from "graphql";
import type { DocumentNode, ObjectTypeDefinitionNode } from "graphql";
import {
  loadTemplate,
  extractResolverKeys,
} from "../scripts/split-gates/template-utils";

const ENV = process.env.SPLIT_GATES_ENV ?? "dev";

const SDL_PATH = path.resolve(
  __dirname,
  "..",
  "src",
  "schema",
  "schema.graphql",
);

/** Every stack that wires at least one AWS::AppSync::Resolver against the
 * shared BackendStack GraphQL API. See file header for how this list was
 * derived. */
const RESOLVER_STACK_NAMES = [
  `citadel-backend-${ENV}`,
  `citadel-registry-${ENV}`,
  `citadel-projects-${ENV}`,
  `citadel-governance-${ENV}`,
  `citadel-services-${ENV}`,
  `citadel-arbiter-${ENV}`,
];

/**
 * Fields deliberately excluded from this guard's enforcement. Every entry
 * MUST carry a reason. Two categories are valid here:
 *   (a) genuinely non-Lambda-resolver fields (none exist in this schema
 *       today — every Query/Mutation field is Lambda-resolver-backed);
 *   (b) PRE-EXISTING unwired fields discovered BY this guard, tracked as
 *       separate findings rather than fixed here (scope discipline — see
 *       reasons below). These are NOT "intentionally unwired" in the
 *       design sense; they are known, tracked defects of the identical
 *       class as 24563f6c/resumeExecution, temporarily allowlisted so this
 *       guard can ship green for the field it was built to catch
 *       (resumeExecution) without also silently blocking on 7 unrelated,
 *       already-broken fields it happened to also surface. Removing an
 *       entry here (because its resolver was wired) should make its test
 *       start passing; removing it WITHOUT wiring the resolver will make
 *       the guard fail again, as intended.
 */
const DELIBERATELY_UNWIRED: ReadonlyMap<string, string> = new Map([
  // --- pre-existing, tracked separately (finding 0018a6d7), NOT fixed by
  // this change (finding 24563f6c/d037634b only) ---
  [
    "Mutation.updateAgentStatus",
    "Pre-existing gap surfaced by this guard, same class as resumeExecution. Handler exists (agent-resolver.ts:125) but no stack wires a resolver for it. Tracked separately: finding 0018a6d7. Not in scope for finding 24563f6c.",
  ],
  [
    "Mutation.updateProjectProgress",
    "Pre-existing gap surfaced by this guard, same class as resumeExecution. Tracked separately: finding 0018a6d7. Not in scope for finding 24563f6c.",
  ],
  [
    "Mutation.testTool",
    "Pre-existing gap surfaced by this guard, same class as resumeExecution. Tracked separately: finding 0018a6d7. Not in scope for finding 24563f6c.",
  ],
  [
    "Query.listAvailableDataSources",
    "Pre-existing gap surfaced by this guard, same class as resumeExecution. Tracked separately: finding 0018a6d7. Not in scope for finding 24563f6c.",
  ],
  [
    "Query.listIntegrationOperations",
    "Pre-existing gap surfaced by this guard, same class as resumeExecution. Tracked separately: finding 0018a6d7. Not in scope for finding 24563f6c.",
  ],
  [
    "Query.getDashboardMetrics",
    "Pre-existing gap surfaced by this guard, same class as resumeExecution. Tracked separately: finding 0018a6d7. Not in scope for finding 24563f6c.",
  ],
  [
    "Query.getRecentActivity",
    "Pre-existing gap surfaced by this guard, same class as resumeExecution. Tracked separately: finding 0018a6d7. Not in scope for finding 24563f6c.",
  ],
]);

function cdkOutTemplatePath(stackName: string): string {
  return path.resolve(__dirname, "..", "cdk.out", `${stackName}.template.json`);
}

const templatesExist = RESOLVER_STACK_NAMES.every((name) =>
  fs.existsSync(cdkOutTemplatePath(name)),
);

describe("schema <-> AppSync resolver parity guard", () => {
  if (!templatesExist) {
    const missing = RESOLVER_STACK_NAMES.filter(
      (name) => !fs.existsSync(cdkOutTemplatePath(name)),
    );
    it.skip(`skipped: cdk.out template(s) missing (run cdk synth first). missing=${missing.join(", ")}`, () => {});
    return;
  }

  const sdl: DocumentNode = parse(fs.readFileSync(SDL_PATH, "utf8"));

  function schemaFieldNames(typeName: "Query" | "Mutation"): string[] {
    const def = sdl.definitions.find(
      (d): d is ObjectTypeDefinitionNode =>
        d.kind === "ObjectTypeDefinition" && d.name.value === typeName,
    );
    if (!def || !def.fields) {
      throw new Error(
        `schema.graphql has no ${typeName} type — parser or schema regressed`,
      );
    }
    return def.fields.map((f) => f.name.value);
  }

  const queryFields = schemaFieldNames("Query");
  const mutationFields = schemaFieldNames("Mutation");

  it("sanity check: schema declares a non-trivial number of Query and Mutation fields", () => {
    expect(queryFields.length).toBeGreaterThan(10);
    expect(mutationFields.length).toBeGreaterThan(10);
  });

  // Merge resolver keys ("TypeName.fieldName") across every resolver-owning
  // stack's synthesized template.
  const wiredKeys = new Set<string>();
  for (const stackName of RESOLVER_STACK_NAMES) {
    const template = loadTemplate(cdkOutTemplatePath(stackName));
    for (const key of extractResolverKeys(template).keys()) {
      wiredKeys.add(key);
    }
  }

  it("sanity check: at least one resolver was found across the scanned stacks (guard is not vacuous)", () => {
    expect(wiredKeys.size).toBeGreaterThan(50);
  });

  it.each(queryFields.map((f) => [f] as const))(
    "Query.%s has a wired AppSync Resolver (or a documented allowlist reason)",
    (fieldName) => {
      const key = `Query.${fieldName}`;
      if (DELIBERATELY_UNWIRED.has(key)) return;
      expect(wiredKeys.has(key)).toBe(true);
    },
  );

  it.each(mutationFields.map((f) => [f] as const))(
    "Mutation.%s has a wired AppSync Resolver (or a documented allowlist reason)",
    (fieldName) => {
      const key = `Mutation.${fieldName}`;
      if (DELIBERATELY_UNWIRED.has(key)) return;
      expect(wiredKeys.has(key)).toBe(true);
    },
  );

  it("every DELIBERATELY_UNWIRED entry corresponds to a real schema field (no stale allowlist entries)", () => {
    const allFields = new Set([
      ...queryFields.map((f) => `Query.${f}`),
      ...mutationFields.map((f) => `Mutation.${f}`),
    ]);
    for (const key of DELIBERATELY_UNWIRED.keys()) {
      expect(allFields.has(key)).toBe(true);
    }
  });
});
