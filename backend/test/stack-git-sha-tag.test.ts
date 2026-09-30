/**
 * CIT-215 — deployment provenance tags.
 *
 * Every stack in the app must carry a `GitSha` (and `GitRef`) tag so the
 * question "is fix X deployed?" is answerable from CloudFormation alone:
 *
 *   aws cloudformation describe-stacks --stack-name <s> --query 'Stacks[0].Tags'
 *   git merge-base --is-ancestor <fix-sha> <GitSha>
 *
 * Contract (lib/git-provenance.ts, wired in bin/app.ts):
 *   - value comes from CDK context `gitSha` (`-c gitSha=<sha>`, passed by
 *     deploy.sh), falling back to env `CITADEL_GIT_SHA`;
 *   - if neither is set the tag is `unknown` — synth must NEVER fail;
 *   - the CDK app never shells out to git (deterministic synth, works in CI
 *     without a .git directory).
 *
 * Assertions run at two levels: the cloud-assembly stack artifact `tags`
 * (what the CDK CLI hands to CloudFormation as stack-level tags, i.e. what
 * `describe-stacks` returns) and the `Tags` property of a representative
 * taggable resource inside each stack (tag propagation via the Tags aspect).
 */
import * as cdk from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as s3 from "aws-cdk-lib/aws-s3";
import {
  GIT_PROVENANCE_ENV,
  GIT_PROVENANCE_TAGS,
  UNKNOWN_GIT_VALUE,
  applyGitProvenanceTags,
  resolveGitProvenance,
} from "../lib/git-provenance";

const STACK_NAMES = [
  "citadel-backend-test",
  "citadel-projects-test",
  "citadel-registry-test",
  "citadel-services-test",
  "citadel-governance-test",
  "citadel-arbiter-test",
  "citadel-telemetry-test",
  "citadel-frontend-test",
  "citadel-gateway-test",
];

/**
 * Mirror the bin/app.ts wiring: one App, N stacks, provenance resolved once
 * from the app's context and applied at the App scope so it propagates to
 * every stack (present and future) without per-stack code.
 */
function buildApp(
  context: Record<string, string> | undefined,
  env: Record<string, string | undefined>,
): { app: cdk.App; stacks: cdk.Stack[] } {
  const app = new cdk.App({ context });
  const stacks = STACK_NAMES.map((name) => {
    const stack = new cdk.Stack(app, name, {
      env: { account: "123456789012", region: "us-east-1" },
    });
    // One representative taggable resource per stack.
    new s3.Bucket(stack, "Bucket");
    new dynamodb.Table(stack, "Table", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    });
    return stack;
  });
  const provenance = resolveGitProvenance({
    context: (key) => app.node.tryGetContext(key),
    env,
  });
  applyGitProvenanceTags(app, provenance);
  return { app, stacks };
}

describe("resolveGitProvenance", () => {
  test("CDK context gitSha/gitRef win over env", () => {
    expect(
      resolveGitProvenance({
        context: (k) =>
          ({ gitSha: "abc123", gitRef: "feat/x" })[k as "gitSha" | "gitRef"],
        env: {
          [GIT_PROVENANCE_ENV.SHA]: "env-sha",
          [GIT_PROVENANCE_ENV.REF]: "env-ref",
        },
      }),
    ).toEqual({ gitSha: "abc123", gitRef: "feat/x" });
  });

  test("falls back to CITADEL_GIT_SHA / CITADEL_GIT_REF env when context is absent", () => {
    expect(
      resolveGitProvenance({
        context: () => undefined,
        env: {
          [GIT_PROVENANCE_ENV.SHA]: "  env-sha  ",
          [GIT_PROVENANCE_ENV.REF]: "main",
        },
      }),
    ).toEqual({ gitSha: "env-sha", gitRef: "main" });
  });

  test("neither context nor env -> 'unknown' for both, without throwing", () => {
    expect(
      resolveGitProvenance({ context: () => undefined, env: {} }),
    ).toEqual({ gitSha: UNKNOWN_GIT_VALUE, gitRef: UNKNOWN_GIT_VALUE });
  });

  test("blank / non-string values are treated as unset", () => {
    expect(
      resolveGitProvenance({
        context: (k) => (k === "gitSha" ? 42 : "   "),
        env: { [GIT_PROVENANCE_ENV.SHA]: "" },
      }),
    ).toEqual({ gitSha: UNKNOWN_GIT_VALUE, gitRef: UNKNOWN_GIT_VALUE });
  });

  test("no context reader and no env object still resolves (defaults to process.env)", () => {
    const saved = {
      sha: process.env[GIT_PROVENANCE_ENV.SHA],
      ref: process.env[GIT_PROVENANCE_ENV.REF],
    };
    delete process.env[GIT_PROVENANCE_ENV.SHA];
    delete process.env[GIT_PROVENANCE_ENV.REF];
    try {
      expect(resolveGitProvenance({})).toEqual({
        gitSha: UNKNOWN_GIT_VALUE,
        gitRef: UNKNOWN_GIT_VALUE,
      });
    } finally {
      if (saved.sha !== undefined) process.env[GIT_PROVENANCE_ENV.SHA] = saved.sha;
      if (saved.ref !== undefined) process.env[GIT_PROVENANCE_ENV.REF] = saved.ref;
    }
  });
});

describe("GitSha / GitRef stack tags (CIT-215)", () => {
  test("tag key names are the documented ones", () => {
    expect(GIT_PROVENANCE_TAGS).toEqual({ SHA: "GitSha", REF: "GitRef" });
    expect(GIT_PROVENANCE_ENV).toEqual({
      SHA: "CITADEL_GIT_SHA",
      REF: "CITADEL_GIT_REF",
    });
  });

  test("with -c gitSha=abc123 every stack artifact carries stack-level tag GitSha=abc123 (and GitRef)", () => {
    const { app } = buildApp(
      { gitSha: "abc123", gitRef: "feat/deploy-sha-stack-tag" },
      {},
    );
    const assembly = app.synth();
    for (const name of STACK_NAMES) {
      const artifact = assembly.getStackByName(name);
      expect(artifact.tags).toMatchObject({
        GitSha: "abc123",
        GitRef: "feat/deploy-sha-stack-tag",
      });
    }
  });

  test("with -c gitSha=abc123 a representative taggable resource in every stack carries Tag GitSha=abc123", () => {
    const { stacks } = buildApp({ gitSha: "abc123" }, {});
    expect(stacks).toHaveLength(STACK_NAMES.length);
    for (const stack of stacks) {
      const template = Template.fromStack(stack);
      template.hasResourceProperties("AWS::S3::Bucket", {
        Tags: Match.arrayWith([{ Key: "GitSha", Value: "abc123" }]),
      });
      template.hasResourceProperties("AWS::DynamoDB::Table", {
        Tags: Match.arrayWith([{ Key: "GitSha", Value: "abc123" }]),
      });
    }
  });

  test("env CITADEL_GIT_SHA is used when the context key is absent", () => {
    const { app } = buildApp(undefined, {
      [GIT_PROVENANCE_ENV.SHA]: "deadbeef",
      [GIT_PROVENANCE_ENV.REF]: "main",
    });
    const artifact = app.synth().getStackByName(STACK_NAMES[0]);
    expect(artifact.tags).toMatchObject({ GitSha: "deadbeef", GitRef: "main" });
  });

  test("absent context AND env -> GitSha=unknown on every stack, synth does not throw", () => {
    let built: ReturnType<typeof buildApp> | undefined;
    expect(() => {
      built = buildApp(undefined, {});
    }).not.toThrow();
    const assembly = built!.app.synth();
    for (const name of STACK_NAMES) {
      expect(assembly.getStackByName(name).tags).toMatchObject({
        GitSha: UNKNOWN_GIT_VALUE,
        GitRef: UNKNOWN_GIT_VALUE,
      });
    }
    Template.fromStack(built!.stacks[0]).hasResourceProperties(
      "AWS::S3::Bucket",
      { Tags: Match.arrayWith([{ Key: "GitSha", Value: UNKNOWN_GIT_VALUE }]) },
    );
  });
});

describe("bin/app.ts wiring", () => {
  test("app.ts applies the provenance tags at App scope and never shells out to git", () => {
    // Static check: keeps the wiring honest without paying for a full 9-stack
    // synth (which needs Docker bundling + cdk-nag) in unit tests.
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const src = fs.readFileSync(
      path.resolve(__dirname, "..", "bin", "app.ts"),
      "utf8",
    );
    expect(src).toMatch(/from "\.\.\/lib\/git-provenance"/);
    expect(src).toMatch(/resolveGitProvenance\(/);
    expect(src).toMatch(/applyGitProvenanceTags\(\s*app\s*,/);
    // No shell-out to git from the CDK app (comments may mention the command).
    expect(src).not.toMatch(/child_process|execSync|spawnSync|execFileSync/);
  });
});
