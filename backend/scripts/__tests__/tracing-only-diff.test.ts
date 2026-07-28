import { runTracingOnlyDiff } from "../split-gates/tracing-only-diff";
import { CfnTemplate } from "../split-gates/types";

function baseTemplate(): CfnTemplate {
  return {
    Resources: {
      SomeFunction: {
        Type: "AWS::Lambda::Function",
        Properties: {
          FunctionName: "citadel-some-function-dev",
          Handler: "index.handler",
          Role: { "Fn::GetAtt": ["SomeFunctionServiceRole1234ABCD", "Arn"] },
        },
      },
      SomeFunctionServiceRole1234ABCD: {
        Type: "AWS::IAM::Role",
        Properties: {
          AssumeRolePolicyDocument: { Statement: [{ Effect: "Allow" }] },
          ManagedPolicyArns: [
            {
              "Fn::Join": [
                "",
                [
                  "arn:",
                  { Ref: "AWS::Partition" },
                  ":iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
                ],
              ],
            },
          ],
        },
      },
      ChatGraphQlApi: {
        Type: "AWS::AppSync::GraphQLApi",
        Properties: {
          Name: "citadel-api-dev",
          XrayEnabled: true,
        },
      },
      ProjectsTable: {
        Type: "AWS::DynamoDB::Table",
        DeletionPolicy: "Retain",
        Properties: {
          TableName: "citadel-projects-dev",
          KeySchema: [{ AttributeName: "id", KeyType: "HASH" }],
        },
      },
    },
    Outputs: {
      GraphQLApiUrl: {
        Value: "https://example.com/graphql",
        Export: { Name: "citadel-backend-dev-GraphQLApiUrl" },
      },
    },
  };
}

function withTracingApplied(template: CfnTemplate): CfnTemplate {
  const fresh = JSON.parse(JSON.stringify(template)) as CfnTemplate;
  fresh.Resources.SomeFunction.Properties = {
    ...fresh.Resources.SomeFunction.Properties,
    TracingConfig: { Mode: "Active" },
  };
  const role = fresh.Resources.SomeFunctionServiceRole1234ABCD;
  role.Properties = {
    ...role.Properties,
    ManagedPolicyArns: [
      ...(role.Properties!.ManagedPolicyArns as unknown[]),
      {
        "Fn::Join": [
          "",
          [
            "arn:",
            { Ref: "AWS::Partition" },
            ":iam::aws:policy/AWSXRayDaemonWriteAccess",
          ],
        ],
      },
    ],
  };
  return fresh;
}

describe("tracing-only-diff — positive cases", () => {
  it("passes trivially when the fresh template is identical to baseline (no diff at all)", () => {
    const template = baseTemplate();
    const result = runTracingOnlyDiff(template, template);
    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it("passes when the ONLY deltas are TracingConfig=Active additions + AWSXRayDaemonWriteAccess managed-policy additions", () => {
    const baseline = baseTemplate();
    const fresh = withTracingApplied(baseline);
    const result = runTracingOnlyDiff(baseline, fresh);
    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
    expect(result.tracingConfigAdditions).toBe(1);
    expect(result.managedPolicyAdditions).toBe(1);
  });

  it("accepts a bare-string managed policy ARN (not just the Fn::Join CDK token form)", () => {
    const baseline = baseTemplate();
    const fresh = JSON.parse(JSON.stringify(baseline)) as CfnTemplate;
    fresh.Resources.SomeFunction.Properties!.TracingConfig = { Mode: "Active" };
    const role = fresh.Resources.SomeFunctionServiceRole1234ABCD;
    role.Properties!.ManagedPolicyArns = [
      ...(role.Properties!.ManagedPolicyArns as unknown[]),
      "arn:aws:iam::aws:policy/AWSXRayDaemonWriteAccess",
    ];
    const result = runTracingOnlyDiff(baseline, fresh);
    expect(result.passed).toBe(true);
  });

  it("passes across multiple traced functions/roles in the same template", () => {
    const baseline = baseTemplate();
    baseline.Resources.AnotherFunction = {
      Type: "AWS::Lambda::Function",
      Properties: {
        Role: { "Fn::GetAtt": ["AnotherFunctionServiceRoleABCD1234", "Arn"] },
      },
    };
    baseline.Resources.AnotherFunctionServiceRoleABCD1234 = {
      Type: "AWS::IAM::Role",
      Properties: { ManagedPolicyArns: [] },
    };
    const fresh = withTracingApplied(baseline);
    fresh.Resources.AnotherFunction.Properties = {
      ...fresh.Resources.AnotherFunction.Properties,
      TracingConfig: { Mode: "Active" },
    };
    fresh.Resources.AnotherFunctionServiceRoleABCD1234.Properties = {
      ManagedPolicyArns: ["arn:aws:iam::aws:policy/AWSXRayDaemonWriteAccess"],
    };
    const result = runTracingOnlyDiff(baseline, fresh);
    expect(result.passed).toBe(true);
    expect(result.tracingConfigAdditions).toBe(2);
    expect(result.managedPolicyAdditions).toBe(2);
  });
});

describe("tracing-only-diff — negative cases", () => {
  it("fails when an extra environment variable is changed alongside the tracing addition", () => {
    const baseline = baseTemplate();
    const fresh = withTracingApplied(baseline);
    fresh.Resources.SomeFunction.Properties = {
      ...fresh.Resources.SomeFunction.Properties,
      Environment: { Variables: { EXTRA_VAR: "unexpected" } },
    };
    const result = runTracingOnlyDiff(baseline, fresh);
    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.path.includes("Environment"))).toBe(
      true,
    );
  });

  it("fails when a property is removed from a Lambda function", () => {
    const baseline = baseTemplate();
    const fresh = withTracingApplied(baseline);
    delete fresh.Resources.SomeFunction.Properties!.Handler;
    const result = runTracingOnlyDiff(baseline, fresh);
    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.path.includes("Handler"))).toBe(
      true,
    );
  });

  it("fails on ANY change to AWS::AppSync::GraphQLApi, even a tracing-shaped one", () => {
    const baseline = baseTemplate();
    const fresh = withTracingApplied(baseline);
    fresh.Resources.ChatGraphQlApi.Properties = {
      ...fresh.Resources.ChatGraphQlApi.Properties,
      XrayEnabled: false,
    };
    const result = runTracingOnlyDiff(baseline, fresh);
    expect(result.passed).toBe(false);
    expect(
      result.violations.some((v) => v.logicalId === "ChatGraphQlApi"),
    ).toBe(true);
  });

  it("fails when a new logical ID is added", () => {
    const baseline = baseTemplate();
    const fresh = withTracingApplied(baseline);
    fresh.Resources.UnexpectedNewFunction = {
      Type: "AWS::Lambda::Function",
      Properties: {},
    };
    const result = runTracingOnlyDiff(baseline, fresh);
    expect(result.passed).toBe(false);
    expect(
      result.violations.some((v) => v.logicalId === "UnexpectedNewFunction"),
    ).toBe(true);
  });

  it("fails when a logical ID is removed", () => {
    const baseline = baseTemplate();
    const fresh = withTracingApplied(baseline);
    delete fresh.Resources.ProjectsTable;
    const result = runTracingOnlyDiff(baseline, fresh);
    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.logicalId === "ProjectsTable")).toBe(
      true,
    );
  });

  it("fails when a stateful resource's properties change", () => {
    const baseline = baseTemplate();
    const fresh = withTracingApplied(baseline);
    fresh.Resources.ProjectsTable.Properties = {
      ...fresh.Resources.ProjectsTable.Properties,
      TableName: "citadel-projects-renamed-dev",
    };
    const result = runTracingOnlyDiff(baseline, fresh);
    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.logicalId === "ProjectsTable")).toBe(
      true,
    );
  });

  it("fails when a TracingConfig value is added but is NOT Mode=Active", () => {
    const baseline = baseTemplate();
    const fresh = JSON.parse(JSON.stringify(baseline)) as CfnTemplate;
    fresh.Resources.SomeFunction.Properties!.TracingConfig = {
      Mode: "PassThrough",
    };
    const result = runTracingOnlyDiff(baseline, fresh);
    expect(result.passed).toBe(false);
  });

  it("fails when a non-X-Ray managed policy is added to a role", () => {
    const baseline = baseTemplate();
    const fresh = withTracingApplied(baseline);
    const role = fresh.Resources.SomeFunctionServiceRole1234ABCD;
    role.Properties!.ManagedPolicyArns = [
      ...(role.Properties!.ManagedPolicyArns as unknown[]),
      "arn:aws:iam::aws:policy/AdministratorAccess",
    ];
    const result = runTracingOnlyDiff(baseline, fresh);
    expect(result.passed).toBe(false);
  });

  it("fails when an existing managed policy is removed from a role", () => {
    const baseline = baseTemplate();
    const fresh = withTracingApplied(baseline);
    const role = fresh.Resources.SomeFunctionServiceRole1234ABCD;
    role.Properties!.ManagedPolicyArns = (
      role.Properties!.ManagedPolicyArns as unknown[]
    ).filter(
      (arn) => !JSON.stringify(arn).includes("AWSLambdaBasicExecutionRole"),
    );
    const result = runTracingOnlyDiff(baseline, fresh);
    expect(result.passed).toBe(false);
  });

  it("fails when an Output's Export value changes", () => {
    const baseline = baseTemplate();
    const fresh = withTracingApplied(baseline);
    fresh.Outputs!.GraphQLApiUrl.Value = "https://changed.example.com/graphql";
    const result = runTracingOnlyDiff(baseline, fresh);
    expect(result.passed).toBe(false);
  });
});
