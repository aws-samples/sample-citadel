/**
 * Structural test: the intake-orchestration resolver Lambda's role must
 * include dynamodb:Query on the agents table's sourceProjectId-index GSI.
 *
 * Live bug: activateProjectAgents → findProjectAgentRecords issues a GSI
 * Query. The services-stack grants table-level actions only (GetItem,
 * BatchGetItem, PutItem) — the index ARN is missing, so the Query fails
 * with AccessDeniedException at runtime.
 */
import * as cdk from "aws-cdk-lib";
import { Match } from "aws-cdk-lib/assertions";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as events from "aws-cdk-lib/aws-events";
import * as s3 from "aws-cdk-lib/aws-s3";
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
import { AGENTS_TABLE_GSI_NAME } from "../lib/backend-stack";

const APPSYNC_API_ID = "api123abc";
const APPSYNC_API_ARN = `arn:aws:appsync:us-west-2:123456789012:apis/${APPSYNC_API_ID}`;
const APPSYNC_URL =
  "https://api123abc.appsync-api.us-west-2.amazonaws.com/graphql";

function buildTemplate(): cdk.assertions.Template {
  const app = new cdk.App();
  const prereq = new cdk.Stack(app, "GsiGrantPrereq", {
    env: { account: "123456789012", region: "us-west-2" },
  });
  const bus = new events.EventBus(prereq, "Bus", { eventBusName: "gsi-bus" });
  const bucket = new s3.Bucket(prereq, "DocBucket");
  const membershipTable = new dynamodb.Table(prereq, "UserOrgMembership", {
    tableName: "citadel-user-org-membership-test",
    partitionKey: { name: "sub", type: dynamodb.AttributeType.STRING },
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
  });
  const stack = new ServicesStack(app, "citadel-services-gsi-grant-test", {
    environment: "test",
    agentEventBus: bus,
    documentBucket: bucket,
    userOrgMembershipTable: membershipTable,
    appSyncApiArn: APPSYNC_API_ARN,
    appSyncApiId: APPSYNC_API_ID,
    appSyncGraphqlUrl: APPSYNC_URL,
    env: { account: "123456789012", region: "us-west-2" },
  });
  return cdk.assertions.Template.fromStack(stack);
}

describe("intake-orchestration resolver — GSI grant on agents table", () => {
  let template: cdk.assertions.Template;

  beforeAll(() => {
    template = buildTemplate();
  });

  test("grants dynamodb:Query on the agents table GSI index ARN", () => {
    // The resolver calls activateProjectAgents → findProjectAgentRecords,
    // which issues a Query against sourceProjectId-index. The role must
    // include dynamodb:Query with the index ARN as a resource.
    const agentsGsiArn = `arn:aws:dynamodb:us-west-2:123456789012:table/citadel-agents-test/index/${AGENTS_TABLE_GSI_NAME}`;

    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: "Allow",
            Action: "dynamodb:Query",
            Resource: agentsGsiArn,
          }),
        ]),
      },
    });
  });

  test("the GSI index name constant matches the expected value", () => {
    expect(AGENTS_TABLE_GSI_NAME).toBe("sourceProjectId-index");
  });
});
