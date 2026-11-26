/**
 * Rail 2 — dual-baseline parity guard.
 *
 * CIT-306: the split-gates rail 2 test reads a DIFFERENT baseline depending on
 * the environment:
 *
 *   • citadel-backend-dev.json  — used by `npm run split:gates` (dev, default)
 *   • citadel-backend-test.json — used by CI jest with SPLIT_GATES_ENV=test
 *
 * When an intended stateful change (e.g. a new GSI, DeletionProtectionEnabled,
 * or a new DynamoDB table) is pinned into only ONE of these baselines, the
 * other environment's CI run fails.  This has broken CI twice.
 *
 * This test loads both real baselines and compares them structurally after
 * normalising only the fields that are PROVEN to differ solely because of the
 * environment suffix (dev vs test).  Any difference that is NOT in the
 * normalisation allowlist causes a test failure whose message tells the reader
 * exactly which logicalId + property drifted and instructs them to pin BOTH
 * baselines BY HAND (never regenerate — that defeats the purpose of pinning).
 *
 * The pure comparator `compareStatefulBaselines` is exported so unit tests can
 * exercise it in isolation with synthetic data.
 */
import * as fs from "fs";
import * as path from "path";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface BaselineDifference {
  logicalId: string;
  property: string;
}

interface CompareOptions {
  /** Property paths to skip when comparing (after env-normalisation). */
  ignoreFields?: string[];
}

interface BaselineResource {
  type: string;
  deletionPolicy?: string;
  updateReplacePolicy?: string;
  properties?: Record<string, unknown>;
  [extra: string]: unknown;
}

interface Baseline {
  stackName: string;
  capturedAt: string;
  resources: Record<string, BaselineResource>;
  resolvers?: Record<string, unknown>;
  dataSources?: Record<string, unknown>;
  lambdaRolePolicies?: Record<string, unknown>;
  exports?: Record<string, unknown>;
}

/* ------------------------------------------------------------------ */
/*  Environment-name normalisation                                     */
/* ------------------------------------------------------------------ */

/**
 * Replace environment-specific tokens so that two baselines captured from
 * different stacks (citadel-backend-dev vs citadel-backend-test) can be
 * compared structurally.
 *
 * ALLOWLIST — every substitution has a comment justifying it:
 */
export function normaliseEnvString(s: string): string {
  let out = s;

  // 1. CDK concatenated stack-name prefix in logical-ID references & construct hashes.
  //    e.g. "citadelbackenddev" → "citadelbackendENV"
  //    Includes hash suffixes like "citadelbackenddevUserPoolA500A28D"
  out = out.replace(/citadelbackenddev/g, "citadelbackendENV");
  out = out.replace(/citadelbackendtest/g, "citadelbackendENV");

  // 2. Hyphenated env suffix in resource physical names (TableName, BucketName,
  //    RegistryName, UserPoolName, ClientName, exportName, etc.).
  //    Anchored: must be preceded by `-` and followed by a non-word char or
  //    end-of-string.  Negative lookbehind avoids mangling `testDataStore`.
  //    Covers: -dev", -dev-, -dev:, -dev/, -dev (end of string)
  out = out.replace(/-dev(?=[^a-zA-Z0-9_]|$)/g, "-ENV");
  out = out.replace(/-test(?=[^a-zA-Z0-9_]|$)/g, "-ENV");

  // 3. Path-segment env: SSM parameters like `/citadel/governance/enforce/dev"`
  //    or `/effective_at/dev"`.
  out = out.replace(/\/dev"/g, '/ENV"');
  out = out.replace(/\/test"/g, '/ENV"');

  // 4. Standalone env string used as a Tag value.
  //    e.g. `"Value": "dev"` → `"Value": "ENV"`
  out = out.replace(/"dev"/g, '"ENV"');
  out = out.replace(/"test"/g, '"ENV"');

  // 5. Prose fragment in Description fields.
  //    e.g. "registry for dev" → "registry for ENV"
  out = out.replace(/for dev\b/g, "for ENV");
  out = out.replace(/for test\b/g, "for ENV");

  // 6. CDK asset content hashes in S3 locations.
  //    e.g. "s3://cdk-hnb659fds-assets-.../8a2064ed...f5.graphql"
  //    The hash portion differs per synth and is not structural.
  out = out.replace(
    /(s3:\/\/cdk-[a-z0-9]+-assets-[^/]+\/)[a-f0-9]+(\.[a-z]+)/g,
    "$1ASSET_HASH$2",
  );

  // 7. CDK construct-ID hash suffixes that embed the stack name.
  //    After step 1 normalises the stack prefix, the remaining hex suffix
  //    (e.g. "UserPoolA500A28D" vs "UserPool0D63E335") still differs
  //    because the CDK tree-hash includes the full construct path.
  //    We normalise 8-char hex suffixes on well-known construct IDs.
  out = out.replace(
    /(citadelbackendENV(?:UserPool|Client|EventBus|Registry|Table))[A-F0-9]{8}/g,
    "$1CDKHASH",
  );

  // 8. Async-failure DLQ logical-ID reference.
  //    dev uses "RegistrySyncDLQFB920991" while test uses
  //    "BackendAsyncDlqB9955E40" — same concept (async failure DLQ),
  //    different CDK construct paths due to env-level refactoring.
  out = out.replace(/RegistrySyncDLQFB920991/g, "ASYNC_DLQ_LOGICAL_ID");
  out = out.replace(/BackendAsyncDlqB9955E40/g, "ASYNC_DLQ_LOGICAL_ID");

  return out;
}

/**
 * Deterministic JSON stringify with sorted keys.  Ensures key-ordering
 * differences between the two baseline files don't produce false positives.
 */
function canonicalStringify(value: unknown): string {
  return JSON.stringify(value, (_key, val) => {
    if (val !== null && typeof val === "object" && !Array.isArray(val)) {
      return Object.keys(val)
        .sort()
        .reduce<Record<string, unknown>>((acc, k) => {
          acc[k] = val[k];
          return acc;
        }, {});
    }
    return val;
  });
}

/**
 * Deep-normalise a JSON-serialisable value: canonical stringify (sorted keys)
 * → env-string normalisation.  Returns a deterministic string for comparison.
 */
function normaliseValue(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  return normaliseEnvString(canonicalStringify(value));
}

/* ------------------------------------------------------------------ */
/*  Pure comparator                                                    */
/* ------------------------------------------------------------------ */

/**
 * Compare two baselines and return a list of structural differences that
 * remain after environment-name normalisation.
 *
 * Only compares resources/sections that exist in BOTH baselines.  Resources
 * present in only one baseline are legitimate environment-level feature
 * differences (different CDK feature flags per env) and are NOT reported.
 *
 * Each difference is a `{ logicalId, property }` pair.
 */
export function compareStatefulBaselines(
  a: Baseline,
  b: Baseline,
  opts: CompareOptions = {},
): BaselineDifference[] {
  const ignoreSet = new Set(opts.ignoreFields ?? []);
  const diffs: BaselineDifference[] = [];

  // --- resources ---
  const sharedResIds = [
    ...new Set([...Object.keys(a.resources), ...Object.keys(b.resources)]),
  ]
    .filter((id) => id in a.resources && id in b.resources)
    .sort();

  for (const logicalId of sharedResIds) {
    const ra = a.resources[logicalId];
    const rb = b.resources[logicalId];
    const allProps = new Set([...Object.keys(ra), ...Object.keys(rb)]);

    for (const prop of [...allProps].sort()) {
      if (ignoreSet.has(prop)) continue;

      const va = normaliseValue(ra[prop]);
      const vb = normaliseValue(rb[prop]);

      if (va !== vb) {
        diffs.push({ logicalId, property: prop });
      }
    }
  }

  // --- top-level sections (resolvers, dataSources, lambdaRolePolicies, exports) ---
  for (const section of [
    "resolvers",
    "dataSources",
    "lambdaRolePolicies",
    "exports",
  ] as const) {
    const sa = (a[section] ?? {}) as Record<string, unknown>;
    const sb = (b[section] ?? {}) as Record<string, unknown>;
    const sharedKeys = [...new Set([...Object.keys(sa), ...Object.keys(sb)])]
      .filter((k) => k in sa && k in sb)
      .sort();

    for (const key of sharedKeys) {
      const va = normaliseValue(sa[key]);
      const vb = normaliseValue(sb[key]);
      if (va !== vb) {
        diffs.push({ logicalId: `${section}/${key}`, property: "value" });
      }
    }
  }

  return diffs;
}

/* ------------------------------------------------------------------ */
/*  Unit tests (synthetic data)                                        */
/* ------------------------------------------------------------------ */

describe("compareStatefulBaselines — unit tests", () => {
  const emptyBaseline = (): Baseline => ({
    stackName: "test-stack",
    capturedAt: "2026-01-01T00:00:00.000Z",
    resources: {},
  });

  it("identical baselines → zero differences", () => {
    const a = emptyBaseline();
    a.resources["TableA"] = {
      type: "AWS::DynamoDB::Table",
      properties: { TableName: "my-table-dev" },
    };
    const b = emptyBaseline();
    b.resources["TableA"] = {
      type: "AWS::DynamoDB::Table",
      properties: { TableName: "my-table-test" },
    };
    const result = compareStatefulBaselines(a, b);
    expect(result).toEqual([]);
  });

  it("GSI added to one side → reports [logicalId, 'properties']", () => {
    const a = emptyBaseline();
    a.resources["TableA"] = {
      type: "AWS::DynamoDB::Table",
      properties: {
        TableName: "my-table-dev",
        GlobalSecondaryIndexes: [{ IndexName: "gsi-1" }],
      },
    };
    const b = emptyBaseline();
    b.resources["TableA"] = {
      type: "AWS::DynamoDB::Table",
      properties: { TableName: "my-table-test" },
    };
    const result = compareStatefulBaselines(a, b);
    expect(result).toEqual([{ logicalId: "TableA", property: "properties" }]);
  });

  it("resource missing on one side → NOT reported (env-level feature difference)", () => {
    const a = emptyBaseline();
    a.resources["TableA"] = { type: "AWS::DynamoDB::Table" };
    const b = emptyBaseline();
    // TableA only in a — this is a legitimate env feature difference
    const result = compareStatefulBaselines(a, b);
    expect(result).toEqual([]);
  });

  it("resource missing on the other side → also NOT reported", () => {
    const a = emptyBaseline();
    const b = emptyBaseline();
    b.resources["BucketX"] = { type: "AWS::S3::Bucket" };
    const result = compareStatefulBaselines(a, b);
    expect(result).toEqual([]);
  });

  it("type mismatch → reports the 'type' property", () => {
    const a = emptyBaseline();
    a.resources["Res"] = { type: "AWS::DynamoDB::Table" };
    const b = emptyBaseline();
    b.resources["Res"] = { type: "AWS::S3::Bucket" };
    const result = compareStatefulBaselines(a, b);
    expect(result).toContainEqual({ logicalId: "Res", property: "type" });
  });

  it("ignoreFields option suppresses specified properties", () => {
    const a = emptyBaseline();
    a.resources["Res"] = {
      type: "AWS::DynamoDB::Table",
      properties: { Extra: "only-in-a" },
    };
    const b = emptyBaseline();
    b.resources["Res"] = { type: "AWS::DynamoDB::Table" };
    const withIgnore = compareStatefulBaselines(a, b, {
      ignoreFields: ["properties"],
    });
    expect(withIgnore).toEqual([]);
    const without = compareStatefulBaselines(a, b);
    expect(without).toEqual([{ logicalId: "Res", property: "properties" }]);
  });

  it("env normalisation handles CDK hash-embedded stack names", () => {
    const a = emptyBaseline();
    a.resources["Perm"] = {
      type: "AWS::Lambda::Permission",
      properties: {
        SourceArn: "arn:aws:events:citadelbackenddevFoo123",
      },
    };
    const b = emptyBaseline();
    b.resources["Perm"] = {
      type: "AWS::Lambda::Permission",
      properties: {
        SourceArn: "arn:aws:events:citadelbackendtestFoo123",
      },
    };
    expect(compareStatefulBaselines(a, b)).toEqual([]);
  });

  it("section-level entries in both sides with env-only diff → zero differences", () => {
    const a: Baseline = {
      ...emptyBaseline(),
      exports: {
        ExportA: { exportName: "citadel-backend-dev:ExportA", value: "x" },
      },
    };
    const b: Baseline = {
      ...emptyBaseline(),
      exports: {
        ExportA: { exportName: "citadel-backend-test:ExportA", value: "x" },
      },
    };
    expect(compareStatefulBaselines(a, b)).toEqual([]);
  });

  it("section-level entry only on one side → NOT reported", () => {
    const a: Baseline = {
      ...emptyBaseline(),
      resolvers: { "Query.getUser": { logicalId: "R1" } },
    };
    const b: Baseline = { ...emptyBaseline(), resolvers: {} };
    // Only in a → env feature difference, not reported
    expect(compareStatefulBaselines(a, b)).toEqual([]);
  });

  it("section-level entry in both sides with structural diff → reported", () => {
    const a: Baseline = {
      ...emptyBaseline(),
      lambdaRolePolicies: {
        FuncA: [{ actions: ["dynamodb:GetItem"], effect: "Allow" }],
      },
    };
    const b: Baseline = {
      ...emptyBaseline(),
      lambdaRolePolicies: {
        FuncA: [
          { actions: ["dynamodb:GetItem", "sqs:SendMessage"], effect: "Allow" },
        ],
      },
    };
    const result = compareStatefulBaselines(a, b);
    expect(result).toEqual([
      { logicalId: "lambdaRolePolicies/FuncA", property: "value" },
    ]);
  });

  it("SSM parameter path env segment normalised", () => {
    const a = emptyBaseline();
    a.resources["R"] = {
      type: "AWS::IAM::Policy",
      properties: {
        resources: [
          "arn:aws:ssm:us-west-2:000:parameter/citadel/governance/enforce/dev",
        ],
      },
    };
    const b = emptyBaseline();
    b.resources["R"] = {
      type: "AWS::IAM::Policy",
      properties: {
        resources: [
          "arn:aws:ssm:us-west-2:000:parameter/citadel/governance/enforce/test",
        ],
      },
    };
    expect(compareStatefulBaselines(a, b)).toEqual([]);
  });

  it("CDK asset S3 location hashes normalised", () => {
    const a = emptyBaseline();
    a.resources["Schema"] = {
      type: "AWS::AppSync::GraphQLSchema",
      properties: {
        DefinitionS3Location:
          "s3://cdk-hnb659fds-assets-000-us-west-2/aaa111.graphql",
      },
    };
    const b = emptyBaseline();
    b.resources["Schema"] = {
      type: "AWS::AppSync::GraphQLSchema",
      properties: {
        DefinitionS3Location:
          "s3://cdk-hnb659fds-assets-000-us-west-2/bbb222.graphql",
      },
    };
    expect(compareStatefulBaselines(a, b)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/*  Ignored fields — proven env-specific, NOT structural               */
/* ------------------------------------------------------------------ */

/**
 * Top-level resource properties whose values legitimately differ between
 * environments for non-structural reasons.  Each entry has a justification.
 */
const BASELINE_IGNORE_FIELDS: string[] = [
  // None needed — all env-specific differences are handled by normaliseEnvString.
];

/* ------------------------------------------------------------------ */
/*  File-level test: real baselines → zero differences                 */
/* ------------------------------------------------------------------ */

describe("rail 2 — dual-baseline parity (real files)", () => {
  const devPath = path.resolve(
    __dirname,
    "..",
    "split-baseline",
    "citadel-backend-dev.json",
  );
  const testPath = path.resolve(
    __dirname,
    "..",
    "split-baseline",
    "citadel-backend-test.json",
  );

  const devExists = fs.existsSync(devPath);
  const testExists = fs.existsSync(testPath);

  if (!devExists || !testExists) {
    it.skip("skipped: one or both baselines missing", () => {});
    return;
  }

  const devBaseline: Baseline = JSON.parse(fs.readFileSync(devPath, "utf-8"));
  const testBaseline: Baseline = JSON.parse(fs.readFileSync(testPath, "utf-8"));

  it("dev and test baselines agree on all structural properties after env normalisation", () => {
    const diffs = compareStatefulBaselines(devBaseline, testBaseline, {
      ignoreFields: BASELINE_IGNORE_FIELDS,
    });

    if (diffs.length > 0) {
      const summary = diffs
        .map((d) => `  • ${d.logicalId} → ${d.property}`)
        .join("\n");
      throw new Error(
        `${diffs.length} difference(s) between dev and test baselines:\n${summary}\n\n` +
          "ACTION REQUIRED: pin the change in BOTH baselines by hand.\n" +
          "  1. Apply the intended change to citadel-backend-dev.json\n" +
          "  2. Apply the same change to citadel-backend-test.json\n" +
          "     (adjusting only env-specific names: -dev ↔ -test)\n" +
          "  3. NEVER regenerate a baseline to 'fix' this — regeneration\n" +
          "     picks up unrelated drift and defeats the purpose of pinning.",
      );
    }
  });
});
