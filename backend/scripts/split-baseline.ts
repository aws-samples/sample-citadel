/**
 * backend/scripts/split-baseline.ts
 *
 * Captures the backend-stack-split safety-net baseline from a fresh
 * `cdk synth` output and writes it to `backend/split-baseline/<stack>.json`
 * — a committed fixture the split-gates rails compare every future synth
 * against.
 *
 * This stage moves ZERO resources. Running this script against the current
 * (unmoved) `cdk.out/citadel-backend-<env>.template.json` produces the
 * reference point that later move stages, and this stage's own rails, use.
 *
 * Usage:
 *   npx ts-node -P tsconfig.scripts.json scripts/split-baseline.ts [--env dev] [--cdk-out cdk.out]
 *
 * Requires a prior `cdk synth` (or `npx cdk synth citadel-backend-<env>`)
 * so the template file exists on disk. Does not itself invoke cdk synth —
 * kept side-effect-free w.r.t. AWS/CDK tooling so it stays fast and
 * testable; `split-gates.sh` is the orchestrator that runs synth first.
 */
import * as fs from "fs";
import * as path from "path";
import { loadTemplate } from "./split-gates/template-utils";
import { buildBaseline } from "./split-gates/baseline-builder";

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

function main(): void {
  const { env, cdkOutDir } = parseArgs(process.argv.slice(2));
  const backendDir = path.resolve(__dirname, "..");
  const stackName = `citadel-backend-${env}`;
  const templatePath = path.join(
    backendDir,
    cdkOutDir,
    `${stackName}.template.json`,
  );

  if (!fs.existsSync(templatePath)) {
    process.stderr.write(
      `ERROR: template not found at ${templatePath}. Run 'npx cdk synth ${stackName}' first.\n`,
    );
    process.exit(1);
  }

  const template = loadTemplate(templatePath);
  const baseline = buildBaseline(stackName, template);

  const outDir = path.join(backendDir, "split-baseline");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${stackName}.json`);
  fs.writeFileSync(outPath, JSON.stringify(baseline, null, 2) + "\n", "utf-8");

  const resourceCount = Object.keys(baseline.resources).length;
  const resolverCount = Object.keys(baseline.resolvers).length;
  const dataSourceCount = Object.keys(baseline.dataSources).length;
  const lambdaCount = Object.keys(baseline.lambdaRolePolicies).length;
  const exportCount = Object.keys(baseline.exports).length;

  process.stdout.write(
    `Baseline captured: ${outPath}\n` +
      `  resources:   ${resourceCount}\n` +
      `  resolvers:   ${resolverCount}\n` +
      `  dataSources: ${dataSourceCount}\n` +
      `  lambdaRoles: ${lambdaCount}\n` +
      `  exports:     ${exportCount}\n`,
  );
}

main();
