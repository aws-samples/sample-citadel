/**
 * Duplicate CloudWatch alarm physical-name guard.
 *
 * Incident: backend-stack.ts's "AppSync5xxAlarm" (owned by
 * citadel-backend-<env> since March) and telemetry-stack.ts's
 * "AppSync5xxAlarm" (new platform-health SLO suite) both resolved to the
 * SAME alarmName literal after env interpolation —
 * `citadel-appsync-5xx-<env>` — because telemetry duplicated rather than
 * reused the metric. AWS::EarlyValidation::ResourceExistenceCheck rejects
 * any changeset that tries to CREATE a CloudWatch::Alarm physical name that
 * another stack already owns, which blocked the entire telemetry changeset
 * (6 SLO alarms + platform-health dashboard + CORS fix), and everything
 * downstream of telemetry in deploy order.
 *
 * This test synthesizes every stack the app factory (bin/app.ts) builds and
 * asserts no AWS::CloudWatch::Alarm AlarmName literal (post env
 * interpolation) appears in more than one stack template. It is the
 * single place that would catch a repeat of this class of bug across ANY
 * two stacks, not just backend/telemetry.
 *
 * Reads pre-synthesized `cdk.out/*.template.json` files, following the same
 * pattern as test/tracing-aspect-stack-coverage.test.ts — the CI test phase
 * (buildspec-test.yml) runs `npm test` without a prior `cdk synth`, so this
 * self-skips (loudly, naming the missing templates) when cdk.out is absent
 * rather than failing the suite. Run `npx cdk synth --all` first to get a
 * real pass/fail locally or in a pipeline stage that does synth.
 */
import * as fs from "fs";
import * as path from "path";

const ENV = process.env.SPLIT_GATES_ENV ?? "dev";

const CDK_OUT = path.resolve(__dirname, "..", "cdk.out");

// Every stack the app factory (bin/app.ts) instantiates.
const ALL_STACKS = [
  "backend",
  "projects",
  "registry",
  "services",
  "governance",
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
  if (!fs.existsSync(templatePath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(templatePath, "utf-8"));
}

const allTemplatesPresent = ALL_STACKS.every((s) => loadTemplate(s) !== null);

describe("duplicate CloudWatch alarm physical-name guard (deploy-blocking regression)", () => {
  if (!allTemplatesPresent) {
    const missing = ALL_STACKS.filter((s) => loadTemplate(s) === null);
    it.skip(`skipped: fresh templates missing for [${missing.join(", ")}] (run 'npm run build && npx cdk synth --all' first)`, () => {});
    return;
  }

  test("no AWS::CloudWatch::Alarm AlarmName literal appears in more than one stack template", () => {
    // alarmName -> list of "stackShortName/logicalId" owners.
    const owners = new Map<string, string[]>();

    for (const stackShortName of ALL_STACKS) {
      const template = loadTemplate(stackShortName);
      for (const [logicalId, resource] of Object.entries<any>(
        template.Resources,
      )) {
        if (resource.Type !== "AWS::CloudWatch::Alarm") continue;
        const alarmName = resource.Properties?.AlarmName;
        // Only literal strings are checkable here; skip unresolved
        // intrinsics (Fn::Join/Ref), none of which occur today but this
        // keeps the guard honest if that ever changes.
        if (typeof alarmName !== "string") continue;
        const list = owners.get(alarmName) ?? [];
        list.push(`${stackShortName}/${logicalId}`);
        owners.set(alarmName, list);
      }
    }

    const duplicates = [...owners.entries()].filter(
      ([, ownerList]) => ownerList.length > 1,
    );

    if (duplicates.length > 0) {
      const detail = duplicates
        .map(([name, ownerList]) => `  ${name}: ${ownerList.join(", ")}`)
        .join("\n");
      throw new Error(
        `Duplicate CloudWatch alarm physical name(s) found across stacks ` +
          `(each would fail AWS::EarlyValidation::ResourceExistenceCheck on ` +
          `whichever stack deploys second):\n${detail}`,
      );
    }

    expect(duplicates).toEqual([]);
  });
});
