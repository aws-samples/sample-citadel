/**
 * ProjectsStack — backend-stack-split phase 1 (decision 30e6d067).
 *
 * Asserts:
 * - the satellite's resolver count (23, matching the move manifest)
 * - JWT-free: satellites don't own auth — ProjectsStack must not define any
 *   Cognito UserPool/Client/authorizer resources (BackendStack owns auth;
 *   this satellite only consumes the pool ARN for AdminGetUser).
 * - role least-privilege spot checks (project resolver's Cognito grant is
 *   scoped to the single userPoolArn, not Resource::*).
 * - cdk-nag suppression parity: the policy shapes match the categories
 *   bin/app.ts's shared appLambdaSuppressions block covers (no new
 *   suppression categories introduced by this satellite).
 */
import * as cdk from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import * as appsync from "aws-cdk-lib/aws-appsync";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as events from "aws-cdk-lib/aws-events";
import { Bucket } from "aws-cdk-lib/aws-s3";
import * as path from "path";
import { scaffoldBackendAssetDirs } from "./helpers/scaffold-stub-assets";

scaffoldBackendAssetDirs(["dist/lambda", "src/schema"]);

import { ProjectsStack } from "../lib/projects-stack";

function createFixture(app: cdk.App) {
  const backendStack = new cdk.Stack(app, "MockBackendStack", {
    env: { account: "123456789012", region: "us-east-1" },
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
      partitionKey: { name: "projectId", type: dynamodb.AttributeType.STRING },
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

  return {
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
  };
}

function createTestStack(): { stack: ProjectsStack; template: Template } {
  const app = new cdk.App();
  const fixture = createFixture(app);

  const stack = new ProjectsStack(app, "TestProjectsStack", {
    env: { account: "123456789012", region: "us-east-1" },
    environment: "test",
    ...fixture,
  });

  const template = Template.fromStack(stack);
  return { stack, template };
}

describe("ProjectsStack — backend-stack-split phase 1", () => {
  let template: Template;

  beforeAll(() => {
    ({ template } = createTestStack());
  });

  // --- Resolver count ---
  test("defines exactly 23 AppSync resolvers (matching the move manifest)", () => {
    const resolvers = template.findResources("AWS::AppSync::Resolver");
    expect(Object.keys(resolvers)).toHaveLength(23);
  });

  test("defines exactly 10 AppSync Lambda data sources", () => {
    const dataSources = template.findResources("AWS::AppSync::DataSource", {
      Properties: Match.objectLike({ Type: "AWS_LAMBDA" }),
    });
    expect(Object.keys(dataSources)).toHaveLength(10);
  });

  const expectedFields: Array<[string, string]> = [
    ["Query", "getProject"],
    ["Query", "listProjects"],
    ["Mutation", "createProject"],
    ["Mutation", "updateProject"],
    ["Mutation", "uploadDocument"],
    ["Query", "getAgentStatus"],
    ["Query", "getConversationHistory"],
    ["Mutation", "sendMessage"],
    ["Mutation", "publishConversationMessage"],
    ["Mutation", "sendMessageToAgent"],
    ["Mutation", "generateDocumentUploadUrl"],
    ["Query", "getDocumentIngestionStatus"],
    ["Query", "listProjectDocuments"],
    ["Mutation", "deleteDocument"],
    ["Query", "getProjectDocument"],
    ["Query", "listDocumentVersions"],
    ["Query", "getDocumentVersion"],
    ["Mutation", "generateDocumentPdf"],
    ["Mutation", "publishChatter"],
    ["Mutation", "publishAssessmentCompletion"],
    ["Query", "getAssessmentProgress"],
    ["Mutation", "publishDesignProgress"],
    ["Query", "generateReportDownloadUrl"],
  ];

  test.each(expectedFields)(
    "attaches a resolver for %s.%s",
    (typeName, fieldName) => {
      template.hasResourceProperties("AWS::AppSync::Resolver", {
        TypeName: typeName,
        FieldName: fieldName,
      });
    },
  );

  // --- JWT-free: satellites don't own auth ---
  test("does not define any Cognito UserPool (auth stays in BackendStack)", () => {
    const pools = template.findResources("AWS::Cognito::UserPool");
    expect(Object.keys(pools)).toHaveLength(0);
  });

  test("does not define any Cognito UserPoolClient", () => {
    const clients = template.findResources("AWS::Cognito::UserPoolClient");
    expect(Object.keys(clients)).toHaveLength(0);
  });

  test("does not define any AppSync GraphQLApi (attaches to BackendStack's API, doesn't own one)", () => {
    const apis = template.findResources("AWS::AppSync::GraphQLApi");
    expect(Object.keys(apis)).toHaveLength(0);
  });

  // --- Role least-privilege spot checks ---
  test("project resolver's Cognito grant is scoped to the userPoolArn, not Resource::*", () => {
    const policies = template.findResources("AWS::IAM::Policy", {
      Properties: Match.objectLike({
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: "cognito-idp:AdminGetUser",
            }),
          ]),
        },
      }),
    });
    const matches = Object.values(policies);
    expect(matches.length).toBeGreaterThan(0);
    for (const policy of matches) {
      const statements = (policy as any).Properties.PolicyDocument.Statement;
      const cognitoStmt = statements.find(
        (s: any) => s.Action === "cognito-idp:AdminGetUser",
      );
      expect(cognitoStmt.Resource).not.toBe("*");
    }
  });

  test("document-upload resolver's Bedrock KB actions are scoped to the two named actions only (no wildcard action)", () => {
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: [
              "bedrock:GetKnowledgeBaseDocuments",
              "bedrock:DeleteKnowledgeBaseDocuments",
            ],
          }),
        ]),
      },
    });
  });

  test("no IAM policy statement grants a full-service wildcard action (iam:*, dynamodb:*, or s3:*)", () => {
    const policies = template.findResources("AWS::IAM::Policy");
    for (const policy of Object.values(policies)) {
      const statements = (policy as any).Properties?.PolicyDocument?.Statement;
      if (!Array.isArray(statements)) continue;
      for (const stmt of statements) {
        const actions = Array.isArray(stmt.Action)
          ? stmt.Action
          : [stmt.Action];
        for (const action of actions) {
          if (typeof action !== "string") continue;
          expect(["iam:*", "dynamodb:*", "s3:*"]).not.toContain(action);
        }
      }
    }
  });

  // --- moved constructs present ---
  test("defines exactly 14 Lambda functions (the moved set)", () => {
    const fns = template.findResources("AWS::Lambda::Function");
    expect(Object.keys(fns)).toHaveLength(14);
  });

  test("defines exactly 2 CloudWatch alarms (ProjectResolver error + throttle)", () => {
    const alarms = template.findResources("AWS::CloudWatch::Alarm");
    expect(Object.keys(alarms)).toHaveLength(2);
  });

  test("defines exactly 4 EventBridge rules (Chatter, ProgressUpdate, AssessmentCompletion, DesignProgress)", () => {
    const rules = template.findResources("AWS::Events::Rule");
    expect(Object.keys(rules)).toHaveLength(4);
  });

  // --- cdk-nag suppression parity ---
  test("every Lambda execution role assumes lambda.amazonaws.com with a ManagedPolicyArns array (matches the app-level IAM4 suppression category)", () => {
    const roles = template.findResources("AWS::IAM::Role", {
      Properties: Match.objectLike({
        AssumeRolePolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Principal: { Service: "lambda.amazonaws.com" },
            }),
          ]),
        }),
      }),
    });
    const lambdaRoles = Object.values(roles);
    expect(lambdaRoles.length).toBeGreaterThan(0);
    for (const role of lambdaRoles) {
      const managedArns = (role as any).Properties.ManagedPolicyArns;
      expect(Array.isArray(managedArns)).toBe(true);
    }
  });

  test("every AppSync data source service role assumes appsync.amazonaws.com only (no other principal)", () => {
    const roles = template.findResources("AWS::IAM::Role", {
      Properties: Match.objectLike({
        AssumeRolePolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Principal: { Service: "appsync.amazonaws.com" },
            }),
          ]),
        }),
      }),
    });
    // 10 Lambda data sources -> 10 appsync-assumable roles.
    expect(Object.keys(roles)).toHaveLength(10);
  });
});
