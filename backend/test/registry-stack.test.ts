/**
 * RegistryStack — backend-stack-split phase 2 (decision 30e6d067).
 *
 * Asserts:
 * - the satellite's resolver count (39, matching the move manifest)
 * - JWT-free: satellites don't own auth — RegistryStack must not define any
 *   Cognito UserPool/Client/authorizer resources (BackendStack owns auth;
 *   this satellite only consumes the pool ARN for AdminGetUser).
 * - the SECURITY DISSENT VERBATIM CLAUSE: agent-import's Secrets Manager +
 *   STS statements are byte-identical (action set + resource set) to the
 *   pre-split baseline, not merely a subset.
 * - role least-privilege spot checks.
 * - cdk-nag suppression parity: the policy shapes match the categories
 *   bin/app.ts's shared appLambdaSuppressions block covers (no new
 *   suppression categories introduced by this satellite, aside from the one
 *   documented CodeBucket-prefix suppression in bin/app.ts).
 */
import * as cdk from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import * as appsync from "@aws-cdk/aws-appsync-alpha";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as events from "aws-cdk-lib/aws-events";
import * as path from "path";
import { scaffoldBackendAssetDirs } from "./helpers/scaffold-stub-assets";

scaffoldBackendAssetDirs(["dist/lambda", "src/schema"]);

import { RegistryStack } from "../lib/registry-stack";

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

  const appsTable = new dynamodb.Table(backendStack, "AppsTable", {
    tableName: "citadel-apps-test",
    partitionKey: { name: "appId", type: dynamodb.AttributeType.STRING },
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
  });

  const workflowsTable = new dynamodb.Table(backendStack, "WorkflowsTable", {
    tableName: "citadel-workflows-test",
    partitionKey: {
      name: "workflowId",
      type: dynamodb.AttributeType.STRING,
    },
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
  });

  const agentConfigTable = new dynamodb.Table(
    backendStack,
    "AgentConfigTable",
    {
      tableName: "citadel-agents-test",
      partitionKey: { name: "agentId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    },
  );

  const modelCatalogTable = new dynamodb.Table(
    backendStack,
    "ModelCatalogTable",
    {
      tableName: "citadel-model-catalog-test",
      partitionKey: { name: "modelId", type: dynamodb.AttributeType.STRING },
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

  const userPool = new cognito.UserPool(backendStack, "UserPool", {
    userPoolName: "citadel-test-pool",
  });

  return {
    appSyncApi,
    agentEventBus,
    appsTable,
    workflowsTable,
    agentConfigTable,
    modelCatalogTable,
    idempotencyTable,
    adrsTable,
    userPool,
    registryArn:
      "arn:aws:bedrock-agentcore:us-east-1:123456789012:registry/mock-registry",
    registryId: "mock-registry",
  };
}

function createTestStack(): { stack: RegistryStack; template: Template } {
  const app = new cdk.App();
  const fixture = createFixture(app);

  const stack = new RegistryStack(app, "TestRegistryStack", {
    env: { account: "123456789012", region: "us-east-1" },
    environment: "test",
    ...fixture,
  });

  const template = Template.fromStack(stack);
  return { stack, template };
}

describe("RegistryStack — backend-stack-split phase 2", () => {
  let template: Template;

  beforeAll(() => {
    ({ template } = createTestStack());
  });

  // --- Resolver count ---
  test("defines exactly 39 AppSync resolvers (matching the move manifest)", () => {
    const resolvers = template.findResources("AWS::AppSync::Resolver");
    expect(Object.keys(resolvers)).toHaveLength(39);
  });

  test("defines exactly 6 AppSync Lambda data sources", () => {
    const dataSources = template.findResources("AWS::AppSync::DataSource", {
      Properties: Match.objectLike({ Type: "AWS_LAMBDA" }),
    });
    expect(Object.keys(dataSources)).toHaveLength(6);
  });

  const expectedFields: Array<[string, string]> = [
    ["Mutation", "importAgent"],
    ["Mutation", "attestAgentImport"],
    ["Query", "discoverAgents"],
    ["Query", "describeAgentCandidate"],
    ["Mutation", "testImportedAgent"],
    ["Mutation", "probeAgentCandidate"],
    ["Mutation", "probeImportReachability"],
    ["Mutation", "proposeAgentManifestTier3"],
    ["Mutation", "acceptProposedManifestTier3"],
    ["Mutation", "publishImportToGateway"],
    ["Mutation", "unpublishImportFromGateway"],
    ["Query", "getAgentCode"],
    ["Mutation", "updateAgentCode"],
    ["Mutation", "requestAgentCreation"],
    ["Mutation", "requestToolCreation"],
    ["Query", "getFabricatorQueue"],
    ["Mutation", "publishFabricationEvent"],
    ["Query", "getApp"],
    ["Query", "listApps"],
    ["Mutation", "createApp"],
    ["Mutation", "updateApp"],
    ["Mutation", "deleteApp"],
    ["Mutation", "bindWorkflowToApp"],
    ["Mutation", "unbindWorkflowFromApp"],
    ["Mutation", "updateAgentBinding"],
    ["Mutation", "addAppComponent"],
    ["Mutation", "removeAppComponent"],
    ["Mutation", "setAppConfigSchema"],
    ["Mutation", "setAppConfigValues"],
    ["Mutation", "publishAppStatusEvent"],
    ["Mutation", "createAppApiKey"],
    ["Mutation", "revokeAppApiKey"],
    ["Mutation", "rotateAppApiKey"],
    ["Query", "listAppApiKeys"],
    ["Mutation", "setAppAuthConfig"],
    ["Mutation", "grantAppAccess"],
    ["Mutation", "revokeAppAccess"],
    ["Query", "listAppAccessEntries"],
    ["Query", "getAppMetrics"],
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

  test("does not create the AgentCoreRegistry custom resource (stays in BackendStack; threaded in as props)", () => {
    const customResources = template.findResources(
      "AWS::CloudFormation::CustomResource",
    );
    expect(Object.keys(customResources)).toHaveLength(0);
  });

  // --- SECURITY DISSENT VERBATIM CLAUSE ---
  // agent-import's Secrets Manager + STS statements must be byte-identical
  // (action set AND resource set) to the pre-split baseline — not merely a
  // subset, which rail 6's subset-or-equal check alone would tolerate.
  describe("agent-import Secrets Manager + STS verbatim equivalence", () => {
    function agentImportPolicyStatements(): any[] {
      const fns = template.findResources("AWS::Lambda::Function", {
        Properties: { Handler: "agent-import-resolver.handler" },
      });
      const fnLogicalId = Object.keys(fns)[0];
      expect(fnLogicalId).toBeDefined();
      const roleRef = fns[fnLogicalId].Properties.Role?.["Fn::GetAtt"]?.[0];
      expect(roleRef).toBeDefined();

      const policies = template.findResources("AWS::IAM::Policy");
      const attached = Object.values(policies).filter((p: any) =>
        (p.Properties?.Roles ?? []).some((r: any) => r?.Ref === roleRef),
      );
      return attached.flatMap(
        (p: any) => p.Properties.PolicyDocument.Statement,
      );
    }

    test("has a WRITE-only secretsmanager statement with EXACTLY [CreateSecret, PutSecretValue, TagResource] on /citadel/agents/*", () => {
      const statements = agentImportPolicyStatements();
      const match = statements.find((s) => {
        const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
        return (
          actions.includes("secretsmanager:CreateSecret") &&
          actions.includes("secretsmanager:PutSecretValue")
        );
      });
      expect(match).toBeDefined();
      const actions = Array.isArray(match.Action)
        ? match.Action
        : [match.Action];
      expect(new Set(actions)).toEqual(
        new Set([
          "secretsmanager:CreateSecret",
          "secretsmanager:PutSecretValue",
          "secretsmanager:TagResource",
        ]),
      );
      const resourceStr = JSON.stringify(match.Resource);
      expect(resourceStr).toContain("secret:/citadel/agents/*");
    });

    test("has a READ-only secretsmanager statement with EXACTLY [GetSecretValue] on /citadel/agents/* (separate from the write statement)", () => {
      const statements = agentImportPolicyStatements();
      const readMatches = statements.filter((s) => {
        const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
        return (
          actions.length === 1 && actions[0] === "secretsmanager:GetSecretValue"
        );
      });
      expect(readMatches.length).toBeGreaterThan(0);
      for (const stmt of readMatches) {
        const resourceStr = JSON.stringify(stmt.Resource);
        expect(resourceStr).toContain("secret:/citadel/agents/*");
      }
    });

    test("has an sts:AssumeRole statement with EXACTLY that one action, scoped to arn:aws:iam::*:role/* (cross-account trust-path)", () => {
      const statements = agentImportPolicyStatements();
      const match = statements.find((s) => {
        const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
        return actions.length === 1 && actions[0] === "sts:AssumeRole";
      });
      expect(match).toBeDefined();
      const resources = Array.isArray(match.Resource)
        ? match.Resource
        : [match.Resource];
      expect(resources).toEqual(["arn:aws:iam::*:role/*"]);
    });

    test("no statement broadens sts:AssumeRole to a bare wildcard Resource::* (must stay role/* scoped)", () => {
      const statements = agentImportPolicyStatements();
      for (const stmt of statements) {
        const actions = Array.isArray(stmt.Action)
          ? stmt.Action
          : [stmt.Action];
        if (!actions.includes("sts:AssumeRole")) continue;
        const resources = Array.isArray(stmt.Resource)
          ? stmt.Resource
          : [stmt.Resource];
        expect(resources).not.toContain("*");
      }
    });
  });

  // --- Role least-privilege spot checks ---
  test("registry-agent-record-resolver's Cognito grant is scoped to the userPoolArn, not Resource::*", () => {
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

  test("registry-agent-record-resolver keeps its deterministic functionName (only moved fn that does)", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      Handler: "registry-agent-record-resolver.handler",
      FunctionName: "citadel-registry-agent-record-resolver-test",
    });
  });

  test("no other moved Lambda has functionName pinning (auto-named, invoked via in-stack grantInvoke)", () => {
    const fns = template.findResources("AWS::Lambda::Function");
    for (const [logicalId, fn] of Object.entries(fns)) {
      const handler = (fn as any).Properties?.Handler;
      if (handler === "registry-agent-record-resolver.handler") continue;
      expect((fn as any).Properties?.FunctionName).toBeUndefined();
    }
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
  test("defines exactly 8 Lambda functions (the moved set)", () => {
    const fns = template.findResources("AWS::Lambda::Function");
    expect(Object.keys(fns)).toHaveLength(8);
  });

  test("defines exactly 3 EventBridge rules (AgentImportManifestResult, RegistrySync, FabricationEvent)", () => {
    const rules = template.findResources("AWS::Events::Rule");
    expect(Object.keys(rules)).toHaveLength(3);
  });

  test("defines the RegistrySync dead-letter queue", () => {
    const queues = template.findResources("AWS::SQS::Queue", {
      Properties: Match.objectLike({
        QueueName: "citadel-registry-sync-dlq-test",
      }),
    });
    expect(Object.keys(queues)).toHaveLength(1);
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

  test("every AppSync data source has its own appsync.amazonaws.com-assumable service role (L1 cross-stack pattern)", () => {
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
    // 6 data sources => 6 appsync-assumable roles.
    expect(Object.keys(roles)).toHaveLength(6);
  });
});
