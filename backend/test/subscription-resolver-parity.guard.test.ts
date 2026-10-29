/**
 * Subscription-resolver parity guard — every `type Subscription` field in
 * schema.graphql must have a wired AWS::AppSync::Resolver in one of the
 * resolver-owning stacks' synthesized CloudFormation templates, OR be
 * listed in the DIRECTIVE_ONLY_FIELDS allowlist (for admin-only
 * directive-gated fields that need no tenancy-key Lambda).
 *
 * This is the subscription-specific twin of schema-resolver-parity-guard.test.ts
 * (which covers Query/Mutation). It ensures no future subscription field
 * can be added without a connect-time authorization resolver.
 *
 * Reads already-synthesized templates from cdk.out. Skips gracefully if
 * cdk.out is absent so a bare `npm test` (no prior synth) does not fail.
 */
import * as fs from "fs";
import * as path from "path";
import { parse } from "graphql";
import type { DocumentNode, ObjectTypeDefinitionNode } from "graphql";
import {
  loadTemplate,
  extractResolverKeys,
} from "../scripts/split-gates/template-utils";
import { guardCdkOutInCi } from "./helpers/cdk-out-guard";

const ENV = process.env.SPLIT_GATES_ENV ?? "dev";

const SDL_PATH = path.resolve(
  __dirname,
  "..",
  "src",
  "schema",
  "schema.graphql",
);

/** Resolver-owning stacks (same set as schema-resolver-parity-guard). */
const RESOLVER_STACK_NAMES = [
  `citadel-backend-${ENV}`,
  `citadel-registry-${ENV}`,
  `citadel-projects-${ENV}`,
  `citadel-governance-${ENV}`,
  `citadel-services-${ENV}`,
  `citadel-arbiter-${ENV}`,
];

/**
 * Subscription fields gated by AppSync directives rather than a Lambda
 * resolver. These are admin-only via `@aws_cognito_user_pools(cognito_groups:
 * ["admin"])` — AppSync rejects non-admin tokens at CONNECT time, so no
 * tenancy-key Lambda is needed.
 */
const DIRECTIVE_ONLY_FIELDS: ReadonlyMap<string, string> = new Map([
  [
    "Subscription.onGovernanceFinding",
    'Admin-only via @aws_cognito_user_pools(cognito_groups: ["admin"])',
  ],
  [
    "Subscription.onGovernanceEvent",
    'Admin-only via @aws_cognito_user_pools(cognito_groups: ["admin"])',
  ],
]);

function cdkOutTemplatePath(stackName: string): string {
  return path.resolve(__dirname, "..", "cdk.out", `${stackName}.template.json`);
}

const templatesExist = RESOLVER_STACK_NAMES.every((name) =>
  fs.existsSync(cdkOutTemplatePath(name)),
);

describe("subscription resolver parity guard", () => {
  if (!templatesExist) {
    const missing = RESOLVER_STACK_NAMES.filter(
      (name) => !fs.existsSync(cdkOutTemplatePath(name)),
    );
    guardCdkOutInCi(missing.join(", "), "cdk synth first");
    it.skip(`skipped: cdk.out template(s) missing (run cdk synth first). missing=${missing.join(", ")}`, () => {});
    return;
  }

  const sdl: DocumentNode = parse(fs.readFileSync(SDL_PATH, "utf8"));

  const subscriptionDef = sdl.definitions.find(
    (d): d is ObjectTypeDefinitionNode =>
      d.kind === "ObjectTypeDefinition" && d.name.value === "Subscription",
  );

  if (!subscriptionDef || !subscriptionDef.fields) {
    throw new Error(
      "schema.graphql has no Subscription type — parser or schema regressed",
    );
  }

  const subscriptionFields = subscriptionDef.fields.map((f) => f.name.value);

  // Merge resolver keys (Subscription.*) across every resolver-owning stack.
  const wiredKeys = new Set<string>();
  for (const stackName of RESOLVER_STACK_NAMES) {
    const template = loadTemplate(cdkOutTemplatePath(stackName));
    for (const key of extractResolverKeys(template).keys()) {
      if (key.startsWith("Subscription.")) {
        wiredKeys.add(key);
      }
    }
  }

  it("sanity check: at least 9 subscription resolvers found across stacks (3 existing + 6 new)", () => {
    expect(wiredKeys.size).toBeGreaterThanOrEqual(9);
  });

  it.each(subscriptionFields.map((f) => [f] as const))(
    "Subscription.%s has a wired AppSync Resolver (or a documented directive-only reason)",
    (fieldName) => {
      const key = `Subscription.${fieldName}`;
      if (DIRECTIVE_ONLY_FIELDS.has(key)) return;
      expect(wiredKeys.has(key)).toBe(true);
    },
  );

  it("every DIRECTIVE_ONLY_FIELDS entry corresponds to a real schema field (no stale allowlist entries)", () => {
    const allFields = new Set(
      subscriptionFields.map((f) => `Subscription.${f}`),
    );
    for (const key of DIRECTIVE_ONLY_FIELDS.keys()) {
      expect(allFields.has(key)).toBe(true);
    }
  });
});
