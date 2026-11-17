/**
 * Guard test: every AWS::AppSync::GraphQLApi across all stacks must set
 * LogConfig.ExcludeVerboseContent: true.
 *
 * Without this flag, AppSync logs full request/response bodies including
 * Authorization headers to CloudWatch — a credential-leak vector.
 *
 * Reads already-synthesized templates from cdk.out/ (produced by
 * `CITADEL_SKIP_BUNDLING=1 ENVIRONMENT=test npx cdk synth --all`).
 * Skips gracefully when cdk.out is absent so a bare `npm test` does not
 * fail — mirrors the tracing-aspect-stack-coverage skip convention.
 */
import * as fs from "fs";
import * as path from "path";
import { guardCdkOutInCi } from "./helpers/cdk-out-guard";

const ENV = process.env.SPLIT_GATES_ENV ?? process.env.ENVIRONMENT ?? "dev";
const CDK_OUT = path.resolve(__dirname, "..", "cdk.out");

/** Every stack in the app. */
const ALL_STACKS = [
  "backend",
  "projects",
  "registry",
  "governance",
  "services",
  "arbiter",
  "telemetry",
  "frontend",
  "gateway",
];

function loadTemplate(stackShortName: string): any | null {
  const templatePath = path.join(
    CDK_OUT,
    `citadel-${stackShortName}-${ENV}.template.json`,
  );
  if (!fs.existsSync(templatePath)) return null;
  return JSON.parse(fs.readFileSync(templatePath, "utf-8"));
}

const allTemplatesPresent = ALL_STACKS.every((s) => loadTemplate(s) !== null);

describe("AppSync LogConfig — ExcludeVerboseContent guard", () => {
  if (!allTemplatesPresent) {
    const missing = ALL_STACKS.filter((s) => loadTemplate(s) === null);
    guardCdkOutInCi(
      missing.join(", "),
      "CITADEL_SKIP_BUNDLING=1 ENVIRONMENT=test npx cdk synth --all",
    );
    it.skip(
      `skipped: templates missing for [${missing.join(", ")}] — run synth first`,
      () => {},
    );
    return;
  }

  test("every AWS::AppSync::GraphQLApi has ExcludeVerboseContent: true", () => {
    const violations: string[] = [];
    let apiCount = 0;

    for (const stackName of ALL_STACKS) {
      const template = loadTemplate(stackName)!;
      for (const [logicalId, resource] of Object.entries<any>(
        template.Resources ?? {},
      )) {
        if (resource.Type !== "AWS::AppSync::GraphQLApi") continue;
        apiCount++;
        const logConfig = resource.Properties?.LogConfig;
        if (!logConfig || logConfig.ExcludeVerboseContent !== true) {
          violations.push(
            `citadel-${stackName}-${ENV} / ${logicalId}: ExcludeVerboseContent is ${logConfig?.ExcludeVerboseContent ?? "missing"}`,
          );
        }
      }
    }

    // Sanity: at least one API must exist in the deployment.
    expect(apiCount).toBeGreaterThanOrEqual(1);

    expect(violations).toEqual([]);
  });
});
