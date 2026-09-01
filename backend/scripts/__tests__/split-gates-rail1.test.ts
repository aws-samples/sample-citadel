import { runRemovalsOnlyDiff } from "../../scripts/split-gates/rails/rail1-removals-only";
import { CfnTemplate } from "../../scripts/split-gates/types";

interface DynamoTableProperties {
  TableName: string;
  KeySchema: Array<{ AttributeName: string; KeyType: string }>;
}

function baseTemplate(): CfnTemplate {
  return {
    Resources: {
      ProjectsTable: {
        Type: "AWS::DynamoDB::Table",
        DeletionPolicy: "Delete",
        UpdateReplacePolicy: "Delete",
        Properties: {
          TableName: "citadel-projects-dev",
          KeySchema: [{ AttributeName: "id", KeyType: "HASH" }],
        },
      },
      SomeResolver: {
        Type: "AWS::AppSync::Resolver",
        Properties: { TypeName: "Query", FieldName: "getProject" },
      },
      SomeFunction: {
        Type: "AWS::Lambda::Function",
        Properties: {},
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

describe("rail 1 — removals-only diff (positive)", () => {
  it("passes trivially when the fresh template is identical to baseline", () => {
    const template = baseTemplate();
    const result = runRemovalsOnlyDiff(template, template, []);
    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it("passes when a non-stateful resource is removed with an allowlist justification", () => {
    const baseline = baseTemplate();
    const fresh = baseTemplate();
    delete fresh.Resources.SomeResolver;
    const result = runRemovalsOnlyDiff(baseline, fresh, [
      {
        logicalId: "SomeResolver",
        justification: "moved to satellite in a later stage",
      },
    ]);
    expect(result.passed).toBe(true);
  });

  it("CIT-125 slice A: passes when a NEW logical ID is present in additionAllowlist", () => {
    const baseline = baseTemplate();
    const fresh = baseTemplate();
    fresh.Resources.BackendAsyncDlqB9955E40 = {
      Type: "AWS::SQS::Queue",
      Properties: { QueueName: "citadel-backend-async-dlq-dev" },
    };
    const result = runRemovalsOnlyDiff(
      baseline,
      fresh,
      [],
      [
        {
          logicalId: "BackendAsyncDlqB9955E40",
          justification: "CIT-125 slice A shared backend async DLQ",
        },
      ],
    );
    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it("CIT-125 slice A: an addition NOT in additionAllowlist still violates (guarantee preserved)", () => {
    const baseline = baseTemplate();
    const fresh = baseTemplate();
    fresh.Resources.SomeUnlistedNewQueue = {
      Type: "AWS::SQS::Queue",
      Properties: { QueueName: "citadel-unlisted-dev" },
    };
    const result = runRemovalsOnlyDiff(
      baseline,
      fresh,
      [],
      [
        {
          logicalId: "BackendAsyncDlqB9955E40",
          justification: "unrelated allowlist entry",
        },
      ],
    );
    expect(result.passed).toBe(false);
    expect(
      result.violations.some((v) => v.logicalId === "SomeUnlistedNewQueue"),
    ).toBe(true);
  });
});

describe("rail 1 — removals-only diff (negative: doctored templates must FAIL correctly)", () => {
  it("FAILS when a stateful logical ID is removed, even with an allowlist entry", () => {
    const baseline = baseTemplate();
    const fresh = baseTemplate();
    delete fresh.Resources.ProjectsTable;
    const result = runRemovalsOnlyDiff(baseline, fresh, [
      {
        logicalId: "ProjectsTable",
        justification: "attempted removal — must still fail",
      },
    ]);
    expect(result.passed).toBe(false);
    expect(
      result.violations.some(
        (v) => v.logicalId === "ProjectsTable" && /[Ss]tateful/.test(v.message),
      ),
    ).toBe(true);
  });

  it("FAILS when a non-stateful resource is removed without an allowlist entry", () => {
    const baseline = baseTemplate();
    const fresh = baseTemplate();
    delete fresh.Resources.SomeResolver;
    const result = runRemovalsOnlyDiff(baseline, fresh, []);
    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.logicalId === "SomeResolver")).toBe(
      true,
    );
  });

  it("FAILS when a new logical ID is added (removals-only violated)", () => {
    const baseline = baseTemplate();
    const fresh = baseTemplate();
    fresh.Resources.NewSurpriseFunction = {
      Type: "AWS::Lambda::Function",
      Properties: {},
    };
    const result = runRemovalsOnlyDiff(baseline, fresh, []);
    expect(result.passed).toBe(false);
    expect(
      result.violations.some((v) => v.logicalId === "NewSurpriseFunction"),
    ).toBe(true);
  });

  it("FAILS when a retained stateful table's key schema is modified", () => {
    const baseline = baseTemplate();
    const fresh = baseTemplate();
    (
      fresh.Resources.ProjectsTable
        .Properties as unknown as DynamoTableProperties
    ).KeySchema = [{ AttributeName: "orgId", KeyType: "HASH" }];
    const result = runRemovalsOnlyDiff(baseline, fresh, []);
    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.logicalId === "ProjectsTable")).toBe(
      true,
    );
  });

  it("FAILS when a stateful table's DeletionPolicy is weakened", () => {
    const baseline = baseTemplate();
    baseline.Resources.ProjectsTable.DeletionPolicy = "Retain";
    const fresh = baseTemplate();
    fresh.Resources.ProjectsTable.DeletionPolicy = "Delete";
    const result = runRemovalsOnlyDiff(baseline, fresh, []);
    expect(result.passed).toBe(false);
    expect(
      result.violations.some(
        (v) =>
          v.logicalId === "ProjectsTable" && /DeletionPolicy/.test(v.message),
      ),
    ).toBe(true);
  });

  it("FAILS when a consumed export is removed", () => {
    const baseline = baseTemplate();
    const fresh = baseTemplate();
    delete fresh.Outputs!.GraphQLApiUrl;
    const result = runRemovalsOnlyDiff(baseline, fresh, []);
    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.logicalId === "GraphQLApiUrl")).toBe(
      true,
    );
  });

  it("FAILS when an export's value changes without the name changing", () => {
    const baseline = baseTemplate();
    const fresh = baseTemplate();
    fresh.Outputs!.GraphQLApiUrl.Value = "https://evil.example.com/graphql";
    const result = runRemovalsOnlyDiff(baseline, fresh, []);
    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.logicalId === "GraphQLApiUrl")).toBe(
      true,
    );
  });
});
