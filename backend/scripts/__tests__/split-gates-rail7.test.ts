import { runResolverEquivalence } from "../../scripts/split-gates/rails/rail7-resolver-equivalence";
import { StackBaseline } from "../../scripts/split-gates/types";

function makeBaseline(): StackBaseline {
  return {
    stackName: "citadel-backend-dev",
    capturedAt: new Date().toISOString(),
    resources: {},
    resolvers: {
      "Query.getProject": {
        logicalId: "GetProjectResolver",
        typeName: "Query",
        fieldName: "getProject",
        dataSourceName: "ProjectLambdaDataSource",
        requestMappingTemplateHash: "req-hash-abc",
        responseMappingTemplateHash: "resp-hash-def",
        requestMappingTemplateBytes: 42,
        responseMappingTemplateBytes: 17,
      },
    },
    dataSources: {
      ProjectLambdaDataSourceLogical: {
        logicalId: "ProjectLambdaDataSourceLogical",
        name: "ProjectLambdaDataSource",
        type: "AWS_LAMBDA",
        lambdaFunctionArnRef: "ProjectResolverFn",
      },
    },
    lambdaRolePolicies: {},
    exports: {},
  };
}

describe("rail 7 — resolver behavioral equivalence (positive)", () => {
  it("passes trivially with an empty move manifest", () => {
    const result = runResolverEquivalence(makeBaseline(), {}, []);
    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it("passes when the satellite resolver's hashes and datasource type match baseline exactly", () => {
    const result = runResolverEquivalence(
      makeBaseline(),
      {
        "Query.getProject": {
          requestMappingTemplateHash: "req-hash-abc",
          responseMappingTemplateHash: "resp-hash-def",
          dataSourceType: "AWS_LAMBDA",
          dataSourceLambdaFunctionArnRef: "ProjectResolverFnSat",
        },
      },
      [
        {
          fieldKey: "Query.getProject",
          satelliteStackName: "citadel-projects-dev",
        },
      ],
    );
    expect(result.passed).toBe(true);
  });
});

describe("rail 7 — resolver behavioral equivalence (negative: doctored mapping template must FAIL correctly)", () => {
  it("FAILS when the satellite's RequestMappingTemplate hash differs from baseline", () => {
    const result = runResolverEquivalence(
      makeBaseline(),
      {
        "Query.getProject": {
          requestMappingTemplateHash: "TAMPERED-HASH",
          responseMappingTemplateHash: "resp-hash-def",
          dataSourceType: "AWS_LAMBDA",
          dataSourceLambdaFunctionArnRef: "ProjectResolverFnSat",
        },
      },
      [
        {
          fieldKey: "Query.getProject",
          satelliteStackName: "citadel-projects-dev",
        },
      ],
    );
    expect(result.passed).toBe(false);
    expect(
      result.violations.some(
        (v) =>
          v.logicalId === "Query.getProject" &&
          /RequestMappingTemplate/.test(v.message),
      ),
    ).toBe(true);
  });

  it("FAILS when the satellite's ResponseMappingTemplate hash differs from baseline", () => {
    const result = runResolverEquivalence(
      makeBaseline(),
      {
        "Query.getProject": {
          requestMappingTemplateHash: "req-hash-abc",
          responseMappingTemplateHash: "TAMPERED-HASH",
          dataSourceType: "AWS_LAMBDA",
          dataSourceLambdaFunctionArnRef: "ProjectResolverFnSat",
        },
      },
      [
        {
          fieldKey: "Query.getProject",
          satelliteStackName: "citadel-projects-dev",
        },
      ],
    );
    expect(result.passed).toBe(false);
    expect(
      result.violations.some(
        (v) =>
          v.logicalId === "Query.getProject" &&
          /ResponseMappingTemplate/.test(v.message),
      ),
    ).toBe(true);
  });

  it("FAILS when the satellite's DataSource type differs from baseline", () => {
    const result = runResolverEquivalence(
      makeBaseline(),
      {
        "Query.getProject": {
          requestMappingTemplateHash: "req-hash-abc",
          responseMappingTemplateHash: "resp-hash-def",
          dataSourceType: "NONE",
          dataSourceLambdaFunctionArnRef: null,
        },
      },
      [
        {
          fieldKey: "Query.getProject",
          satelliteStackName: "citadel-projects-dev",
        },
      ],
    );
    expect(result.passed).toBe(false);
    expect(
      result.violations.some(
        (v) =>
          v.logicalId === "Query.getProject" &&
          /DataSource type mismatch/.test(v.message),
      ),
    ).toBe(true);
  });

  it("FAILS when the manifest declares a moved field with no satellite snapshot provided", () => {
    const result = runResolverEquivalence(makeBaseline(), {}, [
      {
        fieldKey: "Query.getProject",
        satelliteStackName: "citadel-projects-dev",
      },
    ]);
    expect(result.passed).toBe(false);
    expect(
      result.violations.some((v) => v.logicalId === "Query.getProject"),
    ).toBe(true);
  });
});
