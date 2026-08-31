/**
 * backend/scripts/split-gates/run-rails.ts
 *
 * Runs rails 1, 3, 6, 7 (the rails expressible as a pure diff over
 * synthesized templates) against the committed baseline and a fresh synth,
 * prints a summary table, and exits non-zero on any failure.
 *
 * Rail 2 runs separately via Jest (`test/split-gates-rail2-stateful-pin.test.ts`)
 * because it is naturally a CDK-assertions-style test. Rails 4 (doc-claims)
 * and 5 (cdk-nag) are pre-existing repo conventions (doc-claims: stack-count
 * grep; cdk-nag: `npm run nag` / `AwsSolutionsChecks` already wired into
 * `bin/app.ts`) — `split-gates.sh` invokes them directly rather than
 * reimplementing them here.
 *
 * Usage:
 *   npx ts-node -P tsconfig.scripts.json scripts/split-gates/run-rails.ts [--env dev] [--cdk-out cdk.out]
 */
import * as fs from "fs";
import * as path from "path";
import { loadTemplate } from "./template-utils";
import { buildBaseline } from "./baseline-builder";
import { runRemovalsOnlyDiff } from "./rails/rail1-removals-only";
import {
  runResolverParity,
  NamedTemplate,
} from "./rails/rail3-resolver-parity";
import { runIamEquivalence } from "./rails/rail6-iam-equivalence";
import { runResolverEquivalence } from "./rails/rail7-resolver-equivalence";
import type { SatelliteResolverSnapshot } from "./rails/rail7-resolver-equivalence";
import {
  REMOVAL_ALLOWLIST,
  ADDITION_ALLOWLIST,
  ALLOWED_SATELLITE_ADDED_STATEMENTS,
  MOVED_RESOLVERS,
  MOVED_LAMBDA_ROLES,
  SATELLITE_STACK_NAMES,
} from "./move-manifest";
import { RailResult, StackBaseline } from "./types";

function parseArgs(argv: string[]): { env: string; cdkOutDir: string } {
  let env = "dev";
  let cdkOutDir = "cdk.out";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--env" && argv[i + 1]) {
      env = argv[i + 1];
      i++;
    } else if (argv[i] === "--cdk-out" && argv[i + 1]) {
      cdkOutDir = argv[i + 1];
      i++;
    }
  }
  return { env, cdkOutDir };
}

function printSummaryTable(results: RailResult[]): void {
  const rows = results.map((r) => ({
    Rail: r.rail,
    Name: r.name,
    Result: r.passed ? "PASS" : "FAIL",
    Violations: r.violations.length,
  }));
  const headers = ["Rail", "Name", "Result", "Violations"] as const;
  const widths = headers.map((h) =>
    Math.max(h.length, ...rows.map((r) => String(r[h]).length)),
  );
  const line = (cells: string[]) =>
    cells.map((c, i) => c.padEnd(widths[i])).join("  ");
  process.stdout.write(line([...headers]) + "\n");
  process.stdout.write(line(widths.map((w) => "-".repeat(w))) + "\n");
  for (const row of rows) {
    process.stdout.write(line(headers.map((h) => String(row[h]))) + "\n");
  }
  for (const r of results) {
    if (!r.passed) {
      process.stdout.write(`\n${r.rail} (${r.name}) violations:\n`);
      for (const v of r.violations) {
        process.stdout.write(`  - [${v.logicalId ?? "-"}] ${v.message}\n`);
      }
    }
  }
}

export function loadBaseline(baselinePath: string): StackBaseline {
  return JSON.parse(fs.readFileSync(baselinePath, "utf-8")) as StackBaseline;
}

function main(): void {
  const { env, cdkOutDir } = parseArgs(process.argv.slice(2));
  const backendDir = path.resolve(__dirname, "..", "..");
  const stackName = `citadel-backend-${env}`;
  const baselinePath = path.join(
    backendDir,
    "split-baseline",
    `${stackName}.json`,
  );
  const freshTemplatePath = path.join(
    backendDir,
    cdkOutDir,
    `${stackName}.template.json`,
  );

  if (!fs.existsSync(baselinePath)) {
    process.stderr.write(
      `ERROR: baseline not found at ${baselinePath}. Run split-baseline.ts first.\n`,
    );
    process.exit(1);
  }
  if (!fs.existsSync(freshTemplatePath)) {
    process.stderr.write(
      `ERROR: fresh template not found at ${freshTemplatePath}. Run 'npx cdk synth ${stackName}' first.\n`,
    );
    process.exit(1);
  }

  const baseline = loadBaseline(baselinePath);
  const freshTemplate = loadTemplate(freshTemplatePath);

  // rail1 expects CfnTemplate-shaped inputs; build one from the committed
  // baseline's resources map (Type/DeletionPolicy/UpdateReplacePolicy/Properties)
  // plus its exports map, rather than requiring a second committed template file.
  const baselineAsTemplate = {
    Resources: Object.fromEntries(
      Object.entries(baseline.resources).map(([logicalId, r]) => [
        logicalId,
        {
          Type: r.type,
          DeletionPolicy: r.deletionPolicy,
          UpdateReplacePolicy: r.updateReplacePolicy,
          Properties: r.properties ?? {},
        },
      ]),
    ),
    Outputs: Object.fromEntries(
      Object.entries(baseline.exports).map(([name, e]) => [
        name,
        { Value: e.value, Export: { Name: e.exportName } },
      ]),
    ),
  };

  const rail1 = runRemovalsOnlyDiff(
    baselineAsTemplate,
    freshTemplate,
    REMOVAL_ALLOWLIST,
    ADDITION_ALLOWLIST,
  );

  const satelliteTemplates: NamedTemplate[] = SATELLITE_STACK_NAMES.map(
    (name) => ({
      stackName: name,
      template: loadTemplate(
        path.join(backendDir, cdkOutDir, `${name}.template.json`),
      ),
    }),
  );
  const rail3 = runResolverParity(baseline, [
    { stackName, template: freshTemplate },
    ...satelliteTemplates,
  ]);

  // Rails 6/7 need per-satellite Lambda-policy / resolver snapshots — built
  // the same way the baseline was, from each satellite's own template.
  // MOVED_LAMBDA_ROLES / MOVED_RESOLVERS are empty until a move stage
  // populates the manifest; when populated, this block must translate each
  // satellite's own StackBaseline (resolvers keyed by fieldKey + dataSources
  // keyed by logical ID) into the flat SatelliteResolverSnapshot shape rail 7
  // expects (fieldKey -> {requestHash, responseHash, dataSourceType,
  // dataSourceLambdaFunctionArnRef}) by joining each resolver's
  // dataSourceName back to that satellite's own dataSources map.
  const satelliteLambdaPolicies: Record<
    string,
    ReturnType<typeof buildBaseline>["lambdaRolePolicies"][string]
  > = {};
  const satelliteResolvers: Record<string, SatelliteResolverSnapshot> = {};
  const backendLogicalIds = new Set(Object.keys(baseline.resources));
  for (const { stackName: satName, template } of satelliteTemplates) {
    const satBaseline = buildBaseline(
      satName,
      template,
      undefined,
      backendLogicalIds,
    );
    Object.assign(satelliteLambdaPolicies, satBaseline.lambdaRolePolicies);

    for (const [fieldKey, resolver] of Object.entries(satBaseline.resolvers)) {
      const ds = Object.values(satBaseline.dataSources).find(
        (d) => d.name === resolver.dataSourceName,
      );
      satelliteResolvers[fieldKey] = {
        requestMappingTemplateHash: resolver.requestMappingTemplateHash,
        responseMappingTemplateHash: resolver.responseMappingTemplateHash,
        dataSourceType: ds?.type ?? null,
        dataSourceLambdaFunctionArnRef: ds?.lambdaFunctionArnRef ?? null,
      };
    }
  }

  const rail6 = runIamEquivalence(
    baseline,
    satelliteLambdaPolicies,
    MOVED_LAMBDA_ROLES,
    ALLOWED_SATELLITE_ADDED_STATEMENTS,
  );
  const rail7 = runResolverEquivalence(
    baseline,
    satelliteResolvers,
    MOVED_RESOLVERS,
  );

  const results = [rail1, rail3, rail6, rail7];
  printSummaryTable(results);

  const anyFailed = results.some((r) => !r.passed);
  process.exit(anyFailed ? 1 : 0);
}

main();
