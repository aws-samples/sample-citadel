import { runResolverParity } from "../../scripts/split-gates/rails/rail3-resolver-parity";
import { StackBaseline, CfnTemplate } from "../../scripts/split-gates/types";

function makeBaseline(fieldKeys: string[]): StackBaseline {
  const resolvers: StackBaseline["resolvers"] = {};
  for (const key of fieldKeys) {
    const [typeName, fieldName] = key.split(".");
    resolvers[key] = {
      logicalId: `${typeName}${fieldName}Resolver`,
      typeName,
      fieldName,
      dataSourceName: "SomeDataSource",
      requestMappingTemplateHash: "abc",
      responseMappingTemplateHash: "def",
      requestMappingTemplateBytes: 10,
      responseMappingTemplateBytes: 10,
    };
  }
  return {
    stackName: "citadel-backend-dev",
    capturedAt: new Date().toISOString(),
    resources: {},
    resolvers,
    dataSources: {},
    lambdaRolePolicies: {},
    exports: {},
  };
}

function templateWithFields(fieldKeys: string[]): CfnTemplate {
  const Resources: CfnTemplate["Resources"] = {};
  fieldKeys.forEach((key, i) => {
    const [typeName, fieldName] = key.split(".");
    Resources[`Resolver${i}`] = {
      Type: "AWS::AppSync::Resolver",
      Properties: { TypeName: typeName, FieldName: fieldName },
    };
  });
  return { Resources };
}

describe("rail 3 — resolver parity (positive)", () => {
  it("passes when the merged single-stack set exactly matches baseline", () => {
    const baseline = makeBaseline([
      "Query.getProject",
      "Mutation.createProject",
    ]);
    const result = runResolverParity(baseline, [
      {
        stackName: "citadel-backend-dev",
        template: templateWithFields([
          "Query.getProject",
          "Mutation.createProject",
        ]),
      },
    ]);
    expect(result.passed).toBe(true);
  });

  it("passes when a field is split across backend + satellite with no overlap", () => {
    const baseline = makeBaseline(["Query.getProject", "Query.listApps"]);
    const result = runResolverParity(baseline, [
      {
        stackName: "citadel-backend-dev",
        template: templateWithFields(["Query.getProject"]),
      },
      {
        stackName: "citadel-projects-dev",
        template: templateWithFields(["Query.listApps"]),
      },
    ]);
    expect(result.passed).toBe(true);
  });
});

describe("rail 3 — resolver parity (negative: doctored templates must FAIL correctly)", () => {
  it("FAILS when a field is attached in two stacks (double-attach)", () => {
    const baseline = makeBaseline(["Query.getProject"]);
    const result = runResolverParity(baseline, [
      {
        stackName: "citadel-backend-dev",
        template: templateWithFields(["Query.getProject"]),
      },
      {
        stackName: "citadel-projects-dev",
        template: templateWithFields(["Query.getProject"]),
      },
    ]);
    expect(result.passed).toBe(false);
    expect(
      result.violations.some(
        (v) =>
          v.logicalId === "Query.getProject" &&
          /more than one place/.test(v.message),
      ),
    ).toBe(true);
  });

  it("FAILS when a baseline field is missing from the merged set", () => {
    const baseline = makeBaseline([
      "Query.getProject",
      "Mutation.createProject",
    ]);
    const result = runResolverParity(baseline, [
      {
        stackName: "citadel-backend-dev",
        template: templateWithFields(["Query.getProject"]),
      },
    ]);
    expect(result.passed).toBe(false);
    expect(
      result.violations.some((v) => v.logicalId === "Mutation.createProject"),
    ).toBe(true);
  });

  it("FAILS when an unexpected new field appears that was not in baseline", () => {
    const baseline = makeBaseline(["Query.getProject"]);
    const result = runResolverParity(baseline, [
      {
        stackName: "citadel-backend-dev",
        template: templateWithFields([
          "Query.getProject",
          "Query.unexpectedField",
        ]),
      },
    ]);
    expect(result.passed).toBe(false);
    expect(
      result.violations.some((v) => v.logicalId === "Query.unexpectedField"),
    ).toBe(true);
  });

  it("FAILS on double-attach even for a field listed in expectedNewFields (the exemption only covers the missing/extra checks, never double-attach)", () => {
    const baseline = makeBaseline(["Query.getProject"]);
    const expectedNewFields = [
      {
        logicalId: "Mutation.resumeExecution",
        justification: "test fixture — mirrors EXPECTED_NEW_FIELDS shape",
      },
    ];
    const result = runResolverParity(
      baseline,
      [
        {
          stackName: "citadel-backend-dev",
          template: templateWithFields([
            "Query.getProject",
            "Mutation.resumeExecution",
          ]),
        },
        {
          stackName: "citadel-projects-dev",
          template: templateWithFields(["Mutation.resumeExecution"]),
        },
      ],
      expectedNewFields,
    );
    expect(result.passed).toBe(false);
    expect(
      result.violations.some(
        (v) =>
          v.logicalId === "Mutation.resumeExecution" &&
          /more than one place/.test(v.message),
      ),
    ).toBe(true);
  });

  it("passes when a field listed in expectedNewFields is present exactly once and not in baseline (the intended, non-vacuous use case)", () => {
    const baseline = makeBaseline(["Query.getProject"]);
    const expectedNewFields = [
      {
        logicalId: "Mutation.resumeExecution",
        justification: "test fixture — mirrors EXPECTED_NEW_FIELDS shape",
      },
    ];
    const result = runResolverParity(
      baseline,
      [
        {
          stackName: "citadel-backend-dev",
          template: templateWithFields([
            "Query.getProject",
            "Mutation.resumeExecution",
          ]),
        },
      ],
      expectedNewFields,
    );
    expect(result.passed).toBe(true);
  });

  it("STILL FAILS for a MISSING baseline field even though an unrelated field is listed in expectedNewFields (the manifest never weakens the missing-field check)", () => {
    const baseline = makeBaseline([
      "Query.getProject",
      "Mutation.createProject",
    ]);
    const expectedNewFields = [
      {
        logicalId: "Mutation.resumeExecution",
        justification: "test fixture — mirrors EXPECTED_NEW_FIELDS shape",
      },
    ];
    const result = runResolverParity(
      baseline,
      [
        {
          stackName: "citadel-backend-dev",
          template: templateWithFields([
            "Query.getProject",
            "Mutation.resumeExecution",
          ]),
        },
      ],
      expectedNewFields,
    );
    expect(result.passed).toBe(false);
    expect(
      result.violations.some((v) => v.logicalId === "Mutation.createProject"),
    ).toBe(true);
  });
});
