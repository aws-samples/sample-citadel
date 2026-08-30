/**
 * Phase 1 activation — document-upload resolver jobs-table read path.
 *
 * The authoritative DynamoDB jobs table `citadel-document-ingestion-${env}` is
 * created in ServicesStack. The document-upload resolver (handler
 * 'document-upload-resolver.handler') reads it as source of truth via the
 * INGESTION_TABLE env var, falling back to a direct Bedrock KB query when the
 * var/table is absent.
 *
 * These assertions verify that ProjectsStack (the document-upload
 * resolver's home since the backend-stack-split phase 1, decision
 * 30e6d067) ACTIVATES that path:
 *  - INGESTION_TABLE is set to the deterministic table name.
 *  - The resolver role has a scoped, READ-ONLY dynamodb policy
 *    (GetItem/Query) on the table ARN and its `status-index` GSI ARN.
 *  - No write actions are granted on the jobs table (least privilege).
 *
 * The ARNs are built from account/region/name (NOT a cross-stack construct
 * import) to avoid a circular dependency: ServicesStack already depends ON
 * BackendStack (it consumes props.documentBucket / props.agentEventBus), so
 * ProjectsStack (which itself depends on BackendStack) must not reference a
 * ServicesStack construct either.
 */

import * as cdk from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import * as appsync from "aws-cdk-lib/aws-appsync";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as events from "aws-cdk-lib/aws-events";
import * as sns from "aws-cdk-lib/aws-sns";
import { Bucket } from "aws-cdk-lib/aws-s3";
import * as path from "path";
import { scaffoldBackendAssetDirs } from "./helpers/scaffold-stub-assets";

scaffoldBackendAssetDirs(["dist/lambda", "src/schema"]);

import { ProjectsStack } from "../lib/projects-stack";

describe("ProjectsStack — document-upload resolver jobs-table read path", () => {
  const account = "123456789012";
  const region = "us-east-1";
  const tableName = "citadel-document-ingestion-test";
  const tableArn = `arn:aws:dynamodb:${region}:${account}:table/${tableName}`;
  const gsiArn = `${tableArn}/index/status-index`;

  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const backendStack = new cdk.Stack(app, "MockBackendStack", {
      env: { account, region },
    });

    const agentEventBus = new events.EventBus(backendStack, "AgentEventBus", {
      eventBusName: "citadel-agents-test",
    });
    const appSyncApi = new appsync.GraphqlApi(backendStack, "MockApi", {
      name: "mock-api",
      schema: appsync.SchemaFile.fromAsset(
        path.resolve(__dirname, "../src/schema/schema.graphql"),
      ),
    });
    const projectsTable = new dynamodb.Table(backendStack, "ProjectsTable", {
      tableName: "citadel-projects-test",
      partitionKey: { name: "projectId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const conversationsTable = new dynamodb.Table(
      backendStack,
      "ConversationsTable",
      {
        tableName: "citadel-conversations-test",
        partitionKey: {
          name: "conversationId",
          type: dynamodb.AttributeType.STRING,
        },
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      },
    );
    const agentStatusTable = new dynamodb.Table(
      backendStack,
      "AgentStatusTable",
      {
        tableName: "citadel-agent-status-test",
        partitionKey: {
          name: "projectId",
          type: dynamodb.AttributeType.STRING,
        },
        sortKey: { name: "agentId", type: dynamodb.AttributeType.STRING },
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      },
    );
    const idempotencyTable = new dynamodb.Table(
      backendStack,
      "IdempotencyTable",
      {
        tableName: "citadel-idempotency-test",
        partitionKey: { name: "eventId", type: dynamodb.AttributeType.STRING },
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      },
    );
    const adrsTable = new dynamodb.Table(backendStack, "AdrsTable", {
      tableName: "citadel-adrs-test",
      partitionKey: { name: "adrId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const executionSpecificationsTable = new dynamodb.Table(
      backendStack,
      "ExecutionSpecificationsTable",
      {
        tableName: "citadel-execution-specifications-test",
        partitionKey: { name: "specId", type: dynamodb.AttributeType.STRING },
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      },
    );
    const agentDesignAssessmentsTable = new dynamodb.Table(
      backendStack,
      "AgentDesignAssessmentsTable",
      {
        tableName: "citadel-agent-design-assessments-test",
        partitionKey: {
          name: "assessmentId",
          type: dynamodb.AttributeType.STRING,
        },
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      },
    );
    const documentBucket = new Bucket(backendStack, "DocumentBucket", {
      bucketName: "citadel-documents-test",
    });
    const userPool = new cognito.UserPool(backendStack, "UserPool", {
      userPoolName: "citadel-test-pool",
    });

    const stack = new ProjectsStack(app, "TestProjectsStackIngestionWiring", {
      environment: "test",
      env: { account, region },
      appSyncApi,
      agentEventBus,
      projectsTable,
      conversationsTable,
      agentStatusTable,
      documentBucket,
      idempotencyTable,
      adrsTable,
      executionSpecificationsTable,
      agentDesignAssessmentsTable,
      userPool,
      alarmTopic: new sns.Topic(backendStack, "AlarmTopic", {
        topicName: "citadel-alarms-test",
      }),
    });
    template = Template.fromStack(stack);
  });

  test("document-upload resolver has INGESTION_TABLE set to the deterministic jobs-table name", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      Handler: "document-upload-resolver.handler",
      Environment: {
        Variables: Match.objectLike({
          INGESTION_TABLE: tableName,
        }),
      },
    });
  });

  test("document-upload resolver role grants read-only dynamodb on the jobs table + status-index GSI", () => {
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: "Allow",
            Action: Match.arrayWith(["dynamodb:GetItem", "dynamodb:Query"]),
            Resource: Match.arrayWith([tableArn, gsiArn]),
          }),
        ]),
      },
    });
  });

  test("document-upload resolver jobs-table policy grants NO write actions (least privilege)", () => {
    const policies = template.findResources("AWS::IAM::Policy");
    type PolicyStmtLike = { Action?: string | string[]; Resource?: unknown };
    type CfnPolicyLike = {
      Properties?: { PolicyDocument?: { Statement?: PolicyStmtLike[] } };
    };
    const hasWriteOnJobsTable = Object.values(policies).some((policy) =>
      (
        (policy as CfnPolicyLike).Properties?.PolicyDocument?.Statement ?? []
      ).some((stmt) => {
        const resourceStr = JSON.stringify(stmt.Resource ?? "");
        if (!resourceStr.includes(tableName)) return false;
        const actions: string[] = Array.isArray(stmt.Action)
          ? stmt.Action
          : [stmt.Action ?? ""];
        return actions.some((a) =>
          [
            "dynamodb:PutItem",
            "dynamodb:UpdateItem",
            "dynamodb:DeleteItem",
            "dynamodb:BatchWriteItem",
          ].includes(a),
        );
      }),
    );
    expect(hasWriteOnJobsTable).toBe(false);
  });
});
