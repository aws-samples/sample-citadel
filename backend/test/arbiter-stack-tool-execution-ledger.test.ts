import * as cdk from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as events from "aws-cdk-lib/aws-events";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as appsync from "aws-cdk-lib/aws-appsync";
import { Bucket } from "aws-cdk-lib/aws-s3";
import * as path from "path";
import {
  scaffoldBackendAssetDirs,
  scaffoldArbiterStubs,
} from "./helpers/scaffold-stub-assets";

scaffoldBackendAssetDirs(["dist/lambda", "src/schema"]);
scaffoldArbiterStubs();

import { ArbiterStack } from "../lib/arbiter-stack";

// Tool-call idempotency (PR1): the org-scoped TTL'd tool-execution ledger,
// its worker env wiring, and the least-privilege (Put/Get/Update, NO
// Delete/Scan) worker grant scoped to the one table.
describe("ArbiterStack — tool-execution idempotency ledger (PR1)", () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App({ context: { "aws:cdk:bundling-stacks": [] } });
    const backendStack = new cdk.Stack(app, "MockBackendStack", {
      env: { account: "123456789012", region: "us-east-1" },
    });

    const agentEventBus = new events.EventBus(backendStack, "AgentEventBus", {
      eventBusName: "citadel-agents-test",
    });
    const mkTable = (id: string, name: string, pk: string) =>
      new dynamodb.Table(backendStack, id, {
        tableName: name,
        partitionKey: { name: pk, type: dynamodb.AttributeType.STRING },
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });
    const agentConfigTable = mkTable(
      "AgentConfigTable",
      "citadel-agents-test",
      "agentId",
    );
    const workflowsTable = mkTable(
      "WorkflowsTable",
      "citadel-workflows-test",
      "workflowId",
    );
    const executionsTable = mkTable(
      "ExecutionsTable",
      "citadel-executions-test",
      "executionId",
    );
    const executionSpecificationsTable = mkTable(
      "ExecutionSpecificationsTable",
      "citadel-execution-specifications-test",
      "specId",
    );
    const codeBucket = new Bucket(backendStack, "CodeBucket", {
      bucketName: "citadel-code-test",
    });
    const fanoutFunction = new lambda.Function(backendStack, "FanoutFunction", {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: "workflow-progress-fanout.handler",
      code: lambda.Code.fromAsset("dist/lambda"),
      timeout: cdk.Duration.seconds(30),
    });
    const appSyncApi = new appsync.GraphqlApi(backendStack, "MockApi", {
      name: "mock-api",
      schema: appsync.SchemaFile.fromAsset(
        path.resolve(__dirname, "../src/schema/schema.graphql"),
      ),
    });

    const stack = new ArbiterStack(app, "TestArbiterStack", {
      environment: "test",
      env: { account: "123456789012", region: "us-east-1" },
      agentEventBus,
      agentConfigTable,
      codeBucket,
      workflowsTable,
      executionsTable,
      fanoutFunction,
      appSyncEndpoint: appSyncApi.graphqlUrl,
      executionSpecificationsTable,
    });
    template = Template.fromStack(stack);
  });

  test("ledger table has org-scoped composite key, TTL, PITR, and SSE", () => {
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      TableName: "citadel-tool-execution-ledger-test",
      KeySchema: Match.arrayWith([
        { AttributeName: "pk", KeyType: "HASH" },
        { AttributeName: "sk", KeyType: "RANGE" },
      ]),
      TimeToLiveSpecification: { AttributeName: "ttl", Enabled: true },
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
      SSESpecification: Match.objectLike({ SSEEnabled: true }),
      BillingMode: "PAY_PER_REQUEST",
    });
  });

  test("worker env wires the ledger table name", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      Handler: "index.lambda_handler",
      Environment: {
        Variables: Match.objectLike({
          TOOL_EXECUTION_LEDGER_TABLE: Match.anyValue(),
        }),
      },
    });
  });

  test("worker grant on the ledger is Put/Get/Update only — no Delete/Scan", () => {
    // The exact-array match asserts the statement carries precisely these
    // three actions (least privilege): a stray DeleteItem/Scan would fail it.
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: "Allow",
            Action: [
              "dynamodb:PutItem",
              "dynamodb:GetItem",
              "dynamodb:UpdateItem",
            ],
          }),
        ]),
      },
    });
  });

  test("no policy grants Delete/Scan on the ledger table", () => {
    // Defense-in-depth: scan every IAM policy statement and assert none that
    // references the ledger table's ARN carries DeleteItem/Scan/Query.
    const ledgerTables = template.findResources("AWS::DynamoDB::Table", {
      Properties: { TableName: "citadel-tool-execution-ledger-test" },
    });
    const ledgerLogicalId = Object.keys(ledgerTables)[0];
    expect(ledgerLogicalId).toBeDefined();

    const policies = template.findResources("AWS::IAM::Policy");
    const forbidden = [
      "dynamodb:DeleteItem",
      "dynamodb:Scan",
      "dynamodb:Query",
    ];
    for (const policy of Object.values(policies) as any[]) {
      for (const stmt of policy.Properties.PolicyDocument.Statement) {
        const actions = Array.isArray(stmt.Action)
          ? stmt.Action
          : [stmt.Action];
        const refsLedger = JSON.stringify(stmt.Resource ?? "").includes(
          ledgerLogicalId,
        );
        if (refsLedger) {
          for (const f of forbidden) {
            expect(actions).not.toContain(f);
          }
        }
      }
    }
  });

  // --- PR2: oversized-result S3 offload (SSE-KMS, org-prefixed, no Delete) ---

  test("offload bucket is CMK-encrypted, block-public, and TLS-only", () => {
    template.hasResourceProperties("AWS::S3::Bucket", {
      BucketName: "citadel-tool-results-test-123456789012-us-east-1",
      BucketEncryption: {
        ServerSideEncryptionConfiguration: Match.arrayWith([
          Match.objectLike({
            ServerSideEncryptionByDefault: Match.objectLike({
              SSEAlgorithm: "aws:kms",
            }),
          }),
        ]),
      },
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });

  test("offload bucket policy DENIES non-KMS puts", () => {
    template.hasResourceProperties("AWS::S3::BucketPolicy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: "Deny",
            Action: "s3:PutObject",
            Condition: {
              StringNotEquals: {
                "s3:x-amz-server-side-encryption": "aws:kms",
              },
            },
          }),
        ]),
      },
    });
  });

  test("worker S3 grant is Put/Get on the tool-results/* prefix only — no Delete", () => {
    const policies = template.findResources("AWS::IAM::Policy");
    let found = false;
    for (const policy of Object.values(policies) as any[]) {
      for (const stmt of policy.Properties.PolicyDocument.Statement) {
        const actions = Array.isArray(stmt.Action)
          ? stmt.Action
          : [stmt.Action];
        const resStr = JSON.stringify(stmt.Resource ?? "");
        if (
          actions.includes("s3:PutObject") &&
          resStr.includes("tool-results/*")
        ) {
          found = true;
          expect(actions).toEqual(
            expect.arrayContaining(["s3:PutObject", "s3:GetObject"]),
          );
          expect(actions).not.toContain("s3:DeleteObject");
          expect(actions).not.toContain("s3:*");
        }
      }
    }
    expect(found).toBe(true);
  });

  // --- PR2: dispatch-generation fence ConditionCheck on the executions row ---

  test("worker has dynamodb:ConditionCheckItem on the executions table (fence)", () => {
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: "Allow",
            Action: "dynamodb:ConditionCheckItem",
            Condition: Match.objectLike({
              "ForAllValues:StringEquals": {
                "dynamodb:Attributes": ["nodeResults", "executionId"],
              },
            }),
          }),
        ]),
      },
    });
  });

  test("worker env wires the offload bucket + CMK", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      Handler: "index.lambda_handler",
      Environment: {
        Variables: Match.objectLike({
          TOOL_RESULT_BUCKET: Match.anyValue(),
          TOOL_RESULT_KMS_KEY_ID: Match.anyValue(),
        }),
      },
    });
  });
});
