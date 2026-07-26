/**
 * Durable fabrication-jobs status table wiring.
 *
 * The authoritative DynamoDB table `citadel-fabrication-jobs-${env}` is created
 * in BackendStack (the dependency root: services→backend, arbiter→services→
 * backend). Owning it here guarantees the table is provisioned before any
 * cross-stack writer (services intake runtime, arbiter fabricator Lambda, and
 * — since backend-stack-split phase 2 — the two fabricator resolvers now in
 * CitadelRegistryStack) deploys, and makes circular dependencies impossible
 * because the other stacks reference the table only by deterministic name +
 * constructed ARN.
 *
 * Table-shape assertions run against BackendStack (table stays there).
 * Resolver env-var + IAM-grant assertions run against CitadelRegistryStack
 * (backend-stack-split phase 2, decision 30e6d067 — both fabricator resolvers
 * moved there, still referencing the table by the same deterministic ARN
 * pattern).
 */

import * as cdk from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import * as path from "path";
import * as fs from "fs";

const assetDirs = [
  path.resolve(__dirname, "../src/schema"),
  path.resolve(__dirname, "../dist/lambda"),
  path.resolve(__dirname, "../src/lambda/seed-admin-user"),
  path.resolve(__dirname, "../src/lambda/seed-organizations"),
];
for (const dir of assetDirs) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

import { BackendStack } from "../lib/backend-stack";
import { RegistryStack } from "../lib/registry-stack";

describe("BackendStack — fabrication-jobs table shape", () => {
  const account = "123456789012";
  const region = "us-east-1";
  const tableName = "citadel-fabrication-jobs-test";

  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const stack = new BackendStack(app, "TestBackendStackFabricationJobs", {
      environment: "test",
      env: { account, region },
    });
    template = Template.fromStack(stack);
  });

  test("creates the fabrication-jobs table with PK orchestrationId / SK agentUseId + TTL", () => {
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      TableName: tableName,
      BillingMode: "PAY_PER_REQUEST",
      KeySchema: [
        { AttributeName: "orchestrationId", KeyType: "HASH" },
        { AttributeName: "agentUseId", KeyType: "RANGE" },
      ],
      AttributeDefinitions: Match.arrayWith([
        { AttributeName: "orchestrationId", AttributeType: "S" },
        { AttributeName: "agentUseId", AttributeType: "S" },
      ]),
      TimeToLiveSpecification: { AttributeName: "ttl", Enabled: true },
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
    });
  });
});

describe("CitadelRegistryStack — fabricator resolver grants on the fabrication-jobs table", () => {
  const account = "123456789012";
  const region = "us-east-1";
  const tableName = "citadel-fabrication-jobs-test";

  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const backendStack = new BackendStack(
      app,
      "TestBackendStackFabricationJobsB",
      {
        environment: "test",
        env: { account, region },
      },
    );
    const stack = new RegistryStack(app, "TestRegistryStackFabricationJobs", {
      environment: "test",
      env: { account, region },
      appSyncApi: backendStack.appSyncApi,
      agentEventBus: backendStack.agentEventBus,
      appsTable: backendStack.appsTable,
      workflowsTable: backendStack.workflowsTable,
      agentConfigTable: backendStack.agentConfigTable,
      modelCatalogTable: backendStack.modelCatalogTable,
      idempotencyTable: backendStack.idempotencyTable,
      userPool: backendStack.userPool,
      registryArn: backendStack.registryArn,
      registryId: backendStack.registryId,
      adrsTable: backendStack.adrsTable,
    });
    template = Template.fromStack(stack);
  });

  test("request resolver has FABRICATION_JOBS_TABLE env set to the deterministic name", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      Handler: "fabricator-request-resolver.handler",
      Environment: {
        Variables: Match.objectLike({ FABRICATION_JOBS_TABLE: tableName }),
      },
    });
  });

  test("queue resolver has FABRICATION_JOBS_TABLE env set to the deterministic name", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      Handler: "fabricator-queue-resolver.handler",
      Environment: {
        Variables: Match.objectLike({ FABRICATION_JOBS_TABLE: tableName }),
      },
    });
  });

  test("queue resolver role grants scoped Query/Scan on the jobs table", () => {
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: "Allow",
            Action: Match.arrayWith(["dynamodb:Query", "dynamodb:Scan"]),
          }),
        ]),
      },
    });
  });

  test("a PutItem grant scoped to the jobs-table ARN exists (request resolver)", () => {
    const policies = template.findResources("AWS::IAM::Policy");
    const hasScopedPut = Object.values(policies).some((policy: any) =>
      (policy.Properties.PolicyDocument.Statement as any[]).some((stmt) => {
        const resourceStr = JSON.stringify(stmt.Resource ?? "");
        if (!resourceStr.includes(tableName)) return false;
        const actions: string[] = Array.isArray(stmt.Action)
          ? stmt.Action
          : [stmt.Action];
        return actions.includes("dynamodb:PutItem");
      }),
    );
    expect(hasScopedPut).toBe(true);
  });
});
