import { runIamEquivalence } from "../../scripts/split-gates/rails/rail6-iam-equivalence";
import {
  StackBaseline,
  NormalizedPolicyStatement,
} from "../../scripts/split-gates/types";

function stmt(
  actions: string[],
  resources: string[],
  effect = "Allow",
): NormalizedPolicyStatement {
  return {
    effect,
    actions: [...actions].sort(),
    resources: [...resources].sort(),
    conditionKeys: [],
  };
}

function makeBaseline(
  lambdaRolePolicies: Record<string, NormalizedPolicyStatement[]>,
): StackBaseline {
  return {
    stackName: "citadel-backend-dev",
    capturedAt: new Date().toISOString(),
    resources: {},
    resolvers: {},
    dataSources: {},
    lambdaRolePolicies,
    exports: {},
  };
}

describe("rail 6 — IAM privilege-equivalence (positive)", () => {
  it("passes trivially with an empty move manifest", () => {
    const baseline = makeBaseline({});
    const result = runIamEquivalence(baseline, {}, []);
    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it("passes when the satellite role's statements are an exact subset of baseline", () => {
    const baseline = makeBaseline({
      RegistryAgentRecordResolverFn: [
        stmt(
          ["dynamodb:GetItem", "dynamodb:PutItem"],
          ["arn:aws:dynamodb:*:*:table/citadel-apps-dev"],
        ),
      ],
    });
    const result = runIamEquivalence(
      baseline,
      {
        RegistryAgentRecordResolverFnSat: [
          stmt(
            ["dynamodb:GetItem"],
            ["arn:aws:dynamodb:*:*:table/citadel-apps-dev"],
          ),
        ],
      },
      [
        {
          baselineLogicalId: "RegistryAgentRecordResolverFn",
          satelliteLogicalId: "RegistryAgentRecordResolverFnSat",
          satelliteStackName: "citadel-registry-dev",
        },
      ],
    );
    expect(result.passed).toBe(true);
  });
});

describe("rail 6 — IAM privilege-equivalence (negative: doctored broadened statement must FAIL correctly)", () => {
  it("FAILS when the satellite role adds an action not present in baseline", () => {
    const baseline = makeBaseline({
      AgentImportResolverFn: [
        stmt(
          ["secretsmanager:GetSecretValue"],
          ["arn:aws:secretsmanager:*:*:secret:citadel/agent-import/*"],
        ),
      ],
    });
    const result = runIamEquivalence(
      baseline,
      {
        AgentImportResolverFnSat: [
          stmt(
            ["secretsmanager:GetSecretValue", "secretsmanager:PutSecretValue"],
            ["arn:aws:secretsmanager:*:*:secret:citadel/agent-import/*"],
          ),
        ],
      },
      [
        {
          baselineLogicalId: "AgentImportResolverFn",
          satelliteLogicalId: "AgentImportResolverFnSat",
          satelliteStackName: "citadel-registry-dev",
        },
      ],
    );
    expect(result.passed).toBe(false);
    expect(
      result.violations.some(
        (v) =>
          v.logicalId === "AgentImportResolverFnSat" &&
          /not covered by the baseline/.test(v.message),
      ),
    ).toBe(true);
  });

  it("FAILS when the satellite role widens Resource from a scoped ARN to a wildcard", () => {
    const baseline = makeBaseline({
      AgentImportResolverFn: [
        stmt(
          ["sts:AssumeRole"],
          ["arn:aws:iam::123456789012:role/citadel-import-scoped"],
        ),
      ],
    });
    const result = runIamEquivalence(
      baseline,
      {
        AgentImportResolverFnSat: [stmt(["sts:AssumeRole"], ["*"])],
      },
      [
        {
          baselineLogicalId: "AgentImportResolverFn",
          satelliteLogicalId: "AgentImportResolverFnSat",
          satelliteStackName: "citadel-registry-dev",
        },
      ],
    );
    expect(result.passed).toBe(false);
    expect(
      result.violations.some((v) => v.logicalId === "AgentImportResolverFnSat"),
    ).toBe(true);
  });

  it("FAILS when no baseline policy exists for the mapped Lambda", () => {
    const baseline = makeBaseline({});
    const result = runIamEquivalence(
      baseline,
      { SomeSatFn: [stmt(["dynamodb:Query"], ["*"])] },
      [
        {
          baselineLogicalId: "MissingBaselineFn",
          satelliteLogicalId: "SomeSatFn",
          satelliteStackName: "citadel-registry-dev",
        },
      ],
    );
    expect(result.passed).toBe(false);
    expect(
      result.violations.some((v) => v.logicalId === "MissingBaselineFn"),
    ).toBe(true);
  });
});
