/**
 * user-org-membership-owner-lookup.test.ts — CIT-216.
 *
 * The intake-orchestration resolver (ServicesStack) and the release resolver
 * (GovernanceStack) resolve an org-less project's organization from the
 * project OWNER's membership row in BackendStack's UserOrgMembershipTable
 * (GetItem by the owner's `sub`), replacing the retired
 * cognito-idp:AdminGetUser `custom:organization` lookup
 * (`lookupUserOrganization`).
 *
 * Pins the CDK wiring both Lambdas need for that path:
 *   - env `USER_ORG_MEMBERSHIP_TABLE` set from the table prop;
 *   - a dynamodb:GetItem grant on exactly that table.
 *
 * The release resolver runs under the SHARED, backend-owned
 * AgentReleaseWriterRole, so its grant lands in the backend template's
 * DefaultPolicy for that role (not in the governance template) — the
 * assertion therefore looks at the mock backend stack, mirroring
 * governance-stack-agent-release.test.ts.
 */
import * as cdk from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import * as appsync from "aws-cdk-lib/aws-appsync";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as events from "aws-cdk-lib/aws-events";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sns from "aws-cdk-lib/aws-sns";
import * as path from "path";
import {
  scaffoldBackendAssetDirs,
  scaffoldServiceDockerfiles,
} from "./helpers/scaffold-stub-assets";

scaffoldBackendAssetDirs([
  "src/schema",
  "src/lambda/cognito-secret-handler",
  "dist/lambda",
]);
scaffoldServiceDockerfiles();

import { ServicesStack } from "../lib/services-stack";
import { GovernanceStack } from "../lib/governance-stack";

const ENV = { account: "123456789012", region: "us-west-2" };
const MEMBERSHIP_TABLE_NAME = "citadel-user-org-membership-test";

function membershipTable(scope: cdk.Stack): dynamodb.Table {
  return new dynamodb.Table(scope, "UserOrgMembershipTable", {
    tableName: MEMBERSHIP_TABLE_NAME,
    partitionKey: { name: "sub", type: dynamodb.AttributeType.STRING },
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
  });
}

function mockTable(scope: cdk.Stack, id: string): dynamodb.Table {
  return new dynamodb.Table(scope, id, {
    tableName: `citadel-${id}-test`,
    partitionKey: { name: `${id}Id`, type: dynamodb.AttributeType.STRING },
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
  });
}

function lambdaByHandler(
  template: Template,
  handler: string,
): Record<string, any> {
  const fns = template.findResources("AWS::Lambda::Function", {
    Properties: { Handler: handler },
  });
  const entries = Object.entries(fns);
  expect(entries).toHaveLength(1);
  return entries[0][1];
}

/** All IAM policy statements in a template whose Action includes `action`. */
function statementsWithAction(
  template: Template,
  action: string,
): Record<string, any>[] {
  const out: Record<string, any>[] = [];
  for (const res of Object.values(
    template.findResources("AWS::IAM::Policy"),
  ) as Record<string, any>[]) {
    for (const st of res.Properties.PolicyDocument.Statement as Record<
      string,
      any
    >[]) {
      const actions = Array.isArray(st.Action) ? st.Action : [st.Action];
      if (actions.includes(action)) out.push(st);
    }
  }
  return out;
}

describe("CIT-216 — intake-orchestration resolver reads UserOrgMembershipTable", () => {
  let servicesTemplate: Template;
  let fn: Record<string, any>;

  beforeAll(() => {
    const app = new cdk.App();
    const prereq = new cdk.Stack(app, "OwnerLookupPrereqServices", {
      env: ENV,
    });
    const bus = new events.EventBus(prereq, "Bus", {
      eventBusName: "owner-lookup-bus",
    });
    const bucket = new s3.Bucket(prereq, "DocBucket");
    const table = membershipTable(prereq);

    const stack = new ServicesStack(app, "citadel-services-ownerlookup", {
      environment: "test",
      agentEventBus: bus,
      documentBucket: bucket,
      appSyncApiArn: `arn:aws:appsync:us-west-2:123456789012:apis/api123`,
      appSyncApiId: "api123",
      appSyncGraphqlUrl:
        "https://api123.appsync-api.us-west-2.amazonaws.com/graphql",
      userOrgMembershipTable: table,
      env: ENV,
    });
    servicesTemplate = Template.fromStack(stack);
    fn = lambdaByHandler(
      servicesTemplate,
      "intake-orchestration-resolver.handler",
    );
  });

  test("sets USER_ORG_MEMBERSHIP_TABLE from the table prop (cross-stack import)", () => {
    const env = fn.Properties.Environment.Variables;
    expect(env.USER_ORG_MEMBERSHIP_TABLE).toBeDefined();
    // The table is prereq-owned, so the name arrives as an ImportValue.
    expect(JSON.stringify(env.USER_ORG_MEMBERSHIP_TABLE)).toMatch(
      /Fn::ImportValue.*UserOrgMembershipTable/,
    );
  });

  test("holds a dynamodb:GetItem grant on the membership table", () => {
    const hit = statementsWithAction(servicesTemplate, "dynamodb:GetItem").find(
      (st) => /UserOrgMembershipTable.*Arn/.test(JSON.stringify(st.Resource)),
    );
    expect(hit).toBeDefined();
    expect(hit!.Effect).toBe("Allow");
    // Read-only: grantReadData must not have been widened to a write grant.
    expect(hit!.Action).not.toEqual(
      expect.arrayContaining([
        "dynamodb:PutItem",
        "dynamodb:UpdateItem",
        "dynamodb:DeleteItem",
      ]),
    );
  });
});

describe("CIT-216 — release resolver reads UserOrgMembershipTable", () => {
  let governanceTemplate: Template;
  let backendTemplate: Template;
  let fn: Record<string, any>;

  beforeAll(() => {
    const app = new cdk.App();
    const backendStack = new cdk.Stack(app, "OwnerLookupMockBackend", {
      env: ENV,
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
    const accessLogsBucket = new s3.Bucket(backendStack, "AccessLogsBucket");
    const alarmTopic = new sns.Topic(backendStack, "AlarmTopic");
    const lambdaRole = (id: string) =>
      new iam.Role(backendStack, id, {
        assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      });
    const table = membershipTable(backendStack);

    const stack = new GovernanceStack(app, "citadel-governance-ownerlookup", {
      env: ENV,
      environment: "test",
      appSyncApi,
      agentEventBus,
      accessLogsBucket,
      alarmTopic,
      adrsTable: mockTable(backendStack, "Adrs"),
      adrReopenAttemptsTable: mockTable(backendStack, "AdrReopenAttempts"),
      executionSpecificationsTable: mockTable(
        backendStack,
        "ExecutionSpecifications",
      ),
      interrogationRoundsTable: mockTable(backendStack, "InterrogationRounds"),
      agentDesignAssessmentsTable: mockTable(
        backendStack,
        "AgentDesignAssessments",
      ),
      programReviewsTable: mockTable(backendStack, "ProgramReviews"),
      projectsTable: mockTable(backendStack, "Projects"),
      evalSuitesTable: mockTable(backendStack, "EvalSuites"),
      evalCasesTable: mockTable(backendStack, "EvalCases"),
      evalRunsTable: mockTable(backendStack, "EvalRuns"),
      evalRunCaseResultsTable: mockTable(backendStack, "EvalRunCaseResults"),
      evalBaselinesTable: mockTable(backendStack, "EvalBaselines"),
      evalComparisonsTable: mockTable(backendStack, "EvalComparisons"),
      evalComparisonConfigTable: mockTable(
        backendStack,
        "EvalComparisonConfig",
      ),
      executionsTable: mockTable(backendStack, "Executions"),
      conversationsTable: mockTable(backendStack, "Conversations"),
      agentReleasesTable: mockTable(backendStack, "AgentReleases"),
      agentReleaseWriterRole: lambdaRole("AgentReleaseWriterRole"),
      environmentReleasePointersTable: mockTable(
        backendStack,
        "EnvironmentReleasePointers",
      ),
      environmentReleasePointerWriterRole: lambdaRole(
        "EnvironmentReleasePointerWriterRole",
      ),
      promotionPolicyConfigTable: mockTable(
        backendStack,
        "PromotionPolicyConfig",
      ),
      promotionPolicyConfigWriterRole: lambdaRole(
        "PromotionPolicyConfigWriterRole",
      ),
      userOrgMembershipTable: table,
    });
    governanceTemplate = Template.fromStack(stack);
    backendTemplate = Template.fromStack(backendStack);
    fn = lambdaByHandler(governanceTemplate, "release-resolver.handler");
  });

  test("sets USER_ORG_MEMBERSHIP_TABLE from the table prop (cross-stack import)", () => {
    const value = fn.Properties.Environment.Variables.USER_ORG_MEMBERSHIP_TABLE;
    expect(value).toBeDefined();
    expect(JSON.stringify(value)).toMatch(
      /Fn::ImportValue.*UserOrgMembershipTable/,
    );
  });

  test("the shared AgentReleaseWriterRole gains a dynamodb:GetItem grant on the membership table (backend template)", () => {
    const tableIds = Object.keys(
      backendTemplate.findResources("AWS::DynamoDB::Table", {
        Properties: { TableName: MEMBERSHIP_TABLE_NAME },
      }),
    );
    expect(tableIds).toHaveLength(1);
    const tableId = tableIds[0];

    const hit = statementsWithAction(backendTemplate, "dynamodb:GetItem").find(
      (st) =>
        JSON.stringify(st.Resource).includes(`"Fn::GetAtt":["${tableId}","Arn"]`),
    );
    expect(hit).toBeDefined();
    expect(hit!.Effect).toBe("Allow");
    expect(hit!.Action).not.toEqual(
      expect.arrayContaining([
        "dynamodb:PutItem",
        "dynamodb:UpdateItem",
        "dynamodb:DeleteItem",
      ]),
    );

    // ...and that policy is attached to the writer role the Lambda assumes.
    const roleIds = Object.keys(
      backendTemplate.findResources("AWS::IAM::Role"),
    ).filter((id) => id.startsWith("AgentReleaseWriterRole"));
    expect(roleIds).toHaveLength(1);
    backendTemplate.hasResourceProperties("AWS::IAM::Policy", {
      Roles: Match.arrayWith([{ Ref: roleIds[0] }]),
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(["dynamodb:GetItem"]),
            Resource: Match.arrayWith([{ "Fn::GetAtt": [tableId, "Arn"] }]),
          }),
        ]),
      }),
    });
  });
});
