/**
 * Rail 2 — stateful logical-ID pin.
 *
 * Jest test asserting every stateful logical ID recorded in the committed
 * baseline still exists in a fresh synth, with its DeletionPolicy /
 * UpdateReplacePolicy (DeletionProtection carried inside Properties for
 * DynamoDB) unchanged. Complements rail 1 (which does the same check as a
 * script-mode diff) with a CDK-native `Template.fromStack`-style assertion
 * against the on-disk synthesized template — catches refactor-induced
 * logical-ID drift (e.g. `overrideLogicalId` misuse or a construct rename)
 * independent of rail 1's allowlist logic.
 *
 * BucketName normalization (finding 389a16a): `AWS::S3::Bucket` physical
 * names are constructed as `<base>-<env>-<account>-<region>` (see
 * `backend/lib/backend-stack.ts`) because S3 bucket names must be globally
 * unique — the standard CDK pattern. `ci.yml` synthesizes with a fixed
 * unauthenticated sandbox account/region (`000000000000` / `us-east-1`),
 * while the committed baseline under `split-baseline/` was captured on a
 * host with real AWS credentials. No committed baseline can ever
 * byte-match CI on `BucketName` as a result — the mismatch is structural,
 * not a regression. `keyPropsEqual` (in `template-utils.ts`) normalizes
 * only the account-id and region segments of `BucketName` before
 * comparing; every other stateful key prop, and the base bucket name
 * itself, is still compared byte-identically. See the bite-proof tests in
 * `scripts/__tests__/split-gates-rail2.test.ts` proving a genuine bucket
 * rename still fails this gate.
 */
import * as fs from "fs";
import * as path from "path";
import { loadTemplate } from "../scripts/split-gates/template-utils";
import { isStatefulType } from "../scripts/split-gates/template-utils";
import { STATEFUL_KEY_PROPS } from "../scripts/split-gates/types";
import { keyPropsEqual } from "../scripts/split-gates/template-utils";
import { buildBaseline } from "../scripts/split-gates/baseline-builder";
import { CfnTemplate } from "../scripts/split-gates/types";
import { guardCdkOutInCi } from "./helpers/cdk-out-guard";

const ENV = process.env.SPLIT_GATES_ENV ?? "dev";
const STACK_NAME = `citadel-backend-${ENV}`;
const BASELINE_PATH = path.resolve(
  __dirname,
  "..",
  "split-baseline",
  `${STACK_NAME}.json`,
);
const TEMPLATE_PATH = path.resolve(
  __dirname,
  "..",
  "cdk.out",
  `${STACK_NAME}.template.json`,
);

const baselineExists = fs.existsSync(BASELINE_PATH);
const templateExists = fs.existsSync(TEMPLATE_PATH);

describe("rail 2 — stateful logical-ID pin", () => {
  if (!baselineExists || !templateExists) {
    guardCdkOutInCi(
      `baseline=${baselineExists} template=${templateExists}`,
      "split-baseline.ts and cdk synth",
    );
    it.skip(`skipped: baseline or fresh template missing (run split-baseline.ts and cdk synth first). baseline=${baselineExists} template=${templateExists}`, () => {});
    return;
  }

  const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf-8"));
  const freshTemplate: CfnTemplate = loadTemplate(TEMPLATE_PATH);
  const freshBaseline = buildBaseline(STACK_NAME, freshTemplate);

  const statefulEntries = Object.entries(
    baseline.resources as Record<string, { type: string }>,
  ).filter(([, r]) => isStatefulType(r.type)) as Array<
    [
      string,
      {
        type: string;
        deletionPolicy?: string;
        updateReplacePolicy?: string;
        properties?: Record<string, unknown>;
      },
    ]
  >;

  it("baseline contains at least one stateful resource (sanity check on the baseline itself)", () => {
    expect(statefulEntries.length).toBeGreaterThan(0);
  });

  it.each(statefulEntries)(
    "stateful resource %s still exists at the same logical ID with unchanged policy/key-properties",
    (logicalId, baselineEntry) => {
      const freshEntry = freshBaseline.resources[logicalId];
      expect(freshEntry).toBeDefined();
      expect(freshEntry.type).toBe(baselineEntry.type);
      expect(freshEntry.deletionPolicy).toBe(baselineEntry.deletionPolicy);
      expect(freshEntry.updateReplacePolicy).toBe(
        baselineEntry.updateReplacePolicy,
      );

      const keys = STATEFUL_KEY_PROPS[baselineEntry.type] ?? [];
      const { equal, diffs } = keyPropsEqual(
        baselineEntry.properties,
        freshEntry.properties,
        keys,
      );
      expect({ equal, diffs }).toEqual({ equal: true, diffs: [] });
    },
  );
});
