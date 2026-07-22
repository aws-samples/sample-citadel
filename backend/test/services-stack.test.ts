import * as cdk from "aws-cdk-lib";
import * as events from "aws-cdk-lib/aws-events";
import * as s3 from "aws-cdk-lib/aws-s3";
import {
  scaffoldBackendAssetDirs,
  scaffoldServiceDockerfiles,
} from "./helpers/scaffold-stub-assets";

// Ensure asset directories exist for CDK synthesis
scaffoldBackendAssetDirs(["src/schema", "src/lambda/cognito-secret-handler"]);

// Ensure Dockerfiles exist for DockerImageFunction constructs
scaffoldServiceDockerfiles();

import { ServicesStack, crossRegionPrefix } from "../lib/services-stack";

describe("ServicesStack", () => {
  let app: cdk.App;
  let stack: ServicesStack;
  let template: cdk.assertions.Template;

  beforeAll(() => {
    app = new cdk.App();

    const prereqStack = new cdk.Stack(app, "PrereqStack", {
      env: { account: "123456789012", region: "us-east-1" },
    });
    const agentEventBus = new events.EventBus(prereqStack, "TestEventBus", {
      eventBusName: "test-bus",
    });
    const documentBucket = new s3.Bucket(prereqStack, "TestDocBucket");

    stack = new ServicesStack(app, "TestServicesStack", {
      environment: "test",
      agentEventBus,
      documentBucket,
      env: { account: "123456789012", region: "us-east-1" },
    });

    template = cdk.assertions.Template.fromStack(stack);
  });

  test("stack synthesizes without errors", () => {
    expect(template).toBeDefined();
  });

  test("has no duplicate Construct imports (compiles successfully)", () => {
    expect(stack).toBeInstanceOf(ServicesStack);
  });

  test("creates OpenSearch Serverless collection for KB", () => {
    template.hasResourceProperties("AWS::OpenSearchServerless::Collection", {
      Name: "citadel-kb-test",
      Type: "VECTORSEARCH",
    });
  });

  test("creates OpenSearch Serverless encryption policy", () => {
    template.hasResourceProperties(
      "AWS::OpenSearchServerless::SecurityPolicy",
      {
        Type: "encryption",
      },
    );
  });

  test("creates OpenSearch Serverless network policy", () => {
    template.hasResourceProperties(
      "AWS::OpenSearchServerless::SecurityPolicy",
      {
        Type: "network",
      },
    );
  });

  test("creates PDF notifier Lambda function", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      Handler: "pdf-created-notifier.handler",
    });
  });

  test("creates session memory DynamoDB table", () => {
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      TableName: "citadel-session-memory-test",
    });
  });

  test("creates session S3 bucket with lifecycle rules", () => {
    template.hasResourceProperties("AWS::S3::Bucket", {
      LifecycleConfiguration: {
        Rules: [
          {
            Id: "DeleteOldSessions",
            Status: "Enabled",
            ExpirationInDays: 90,
          },
        ],
      },
    });
  });

  test("creates Bedrock Knowledge Base", () => {
    template.hasResourceProperties("AWS::Bedrock::KnowledgeBase", {
      Name: "citadel-kb-sessions-test",
    });
  });

  test("creates Gateway Cognito User Pool", () => {
    template.hasResourceProperties("AWS::Cognito::UserPool", {
      UserPoolName: "citadel-gateway-test",
    });
  });

  test("does not reference undefined agent1Runtime", () => {
    // The agent1Parameter SSM block was removed since agent1Runtime was undefined.
    // Verify no SSM parameter references agent1 in its name.
    const ssmParams = template.findResources("AWS::SSM::Parameter");
    const agent1Params = Object.entries(ssmParams).filter(
      ([_, r]: [string, any]) => {
        const name = r.Properties?.Name;
        return typeof name === "string" && name.includes("agent1");
      },
    );
    expect(agent1Params).toHaveLength(0);
  });

  test("DynamoDB tables use pointInTimeRecoverySpecification instead of deprecated pointInTimeRecovery", () => {
    // Verify no deprecation warnings are emitted during synthesis.
    // The deprecated pointInTimeRecovery: true triggers a console.warn.
    const warnSpy = jest.spyOn(console, "warn");

    // Re-synthesize to capture warnings
    const testApp = new cdk.App();
    const prereq = new cdk.Stack(testApp, "DeprecPrereq", {
      env: { account: "123456789012", region: "us-east-1" },
    });
    const bus = new events.EventBus(prereq, "Bus");
    const bucket = new s3.Bucket(prereq, "Bucket");

    new ServicesStack(testApp, "DeprecTestStack", {
      environment: "test",
      agentEventBus: bus,
      documentBucket: bucket,
      env: { account: "123456789012", region: "us-east-1" },
    });

    const warnings = warnSpy.mock.calls
      .map((call) => call.join(" "))
      .filter((msg) => msg.includes("pointInTimeRecovery is deprecated"));

    warnSpy.mockRestore();
    expect(warnings).toHaveLength(0);
  });

  test("no Lambda functions use deprecated logRetention property", () => {
    // When logGroup is used instead of logRetention, CDK creates a separate
    // AWS::Logs::LogGroup resource rather than a Custom::LogRetention resource.
    const customLogRetention = template.findResources("Custom::LogRetention");
    expect(Object.keys(customLogRetention)).toHaveLength(0);
  });

  describe("server-side document ingestion (Phase 1)", () => {
    test("creates the document-ingestion jobs table with status-index GSI", () => {
      template.hasResourceProperties("AWS::DynamoDB::Table", {
        TableName: "citadel-document-ingestion-test",
        BillingMode: "PAY_PER_REQUEST",
        PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
        KeySchema: [
          { AttributeName: "projectId", KeyType: "HASH" },
          { AttributeName: "documentKey", KeyType: "RANGE" },
        ],
        GlobalSecondaryIndexes: [
          {
            IndexName: "status-index",
            KeySchema: [
              { AttributeName: "status", KeyType: "HASH" },
              { AttributeName: "updatedAt", KeyType: "RANGE" },
            ],
          },
        ],
      });
    });

    test("creates the ingest-start Lambda", () => {
      template.hasResourceProperties("AWS::Lambda::Function", {
        Handler: "document-ingestion-start.handler",
        Runtime: "nodejs24.x",
      });
    });

    test("creates the poller Lambda", () => {
      template.hasResourceProperties("AWS::Lambda::Function", {
        Handler: "document-ingestion-poller.handler",
        Runtime: "nodejs24.x",
      });
    });

    test("schedules the poller every minute", () => {
      template.hasResourceProperties("AWS::Events::Rule", {
        ScheduleExpression: "rate(1 minute)",
        State: "ENABLED",
      });
    });

    test("publishes the ingestion table name to SSM", () => {
      template.hasResourceProperties("AWS::SSM::Parameter", {
        Name: "/citadel/document-ingestion-table-test",
      });
    });

    test("grants ingestion lambdas scoped Bedrock KB access", () => {
      // Both lambdas get a policy statement allowing GetKnowledgeBaseDocuments
      // on the KB ARN (ingest-start also gets Ingest).
      template.hasResourceProperties("AWS::IAM::Policy", {
        PolicyDocument: {
          Statement: cdk.assertions.Match.arrayWith([
            cdk.assertions.Match.objectLike({
              Action: cdk.assertions.Match.arrayWith([
                "bedrock:GetKnowledgeBaseDocuments",
              ]),
            }),
          ]),
        },
      });
    });

    test("grants both ingestion lambdas StartIngestionJob + Ingest scoped to the KB ARN", () => {
      // IngestKnowledgeBaseDocuments authorizes against bedrock:StartIngestionJob,
      // so both the ingest-start role and the poller role (stale-row re-kick)
      // must carry the full action set, scoped to the KB ARN (never '*').
      const policies = template.findResources("AWS::IAM::Policy");
      const matching = Object.values(policies).filter((policy) => {
        const statements: Array<Record<string, unknown>> =
          ((
            policy.Properties as
              | { PolicyDocument?: { Statement?: unknown[] } }
              | undefined
          )?.PolicyDocument?.Statement as Array<Record<string, unknown>>) ?? [];
        return statements.some((stmt) => {
          const rawAction = stmt.Action;
          const actions: string[] = Array.isArray(rawAction)
            ? (rawAction as string[])
            : [rawAction as string];
          const resource = stmt.Resource;
          const scopedToKb =
            resource !== "*" &&
            !(Array.isArray(resource) && (resource as unknown[]).includes("*"));
          return (
            scopedToKb &&
            actions.includes("bedrock:IngestKnowledgeBaseDocuments") &&
            actions.includes("bedrock:StartIngestionJob") &&
            actions.includes("bedrock:GetKnowledgeBaseDocuments")
          );
        });
      });
      // ingest-start role + poller role each carry the full KB-scoped action set.
      expect(matching.length).toBeGreaterThanOrEqual(2);
    });
  });
});

describe("crossRegionPrefix", () => {
  // Mirrors arbiter/supervisor/index.py::_cross_region_prefix exactly.
  test('us-* regions map to "us"', () => {
    expect(crossRegionPrefix("us-west-2")).toBe("us");
    expect(crossRegionPrefix("us-east-1")).toBe("us");
  });

  test('eu-* regions map to "eu"', () => {
    expect(crossRegionPrefix("eu-west-1")).toBe("eu");
    expect(crossRegionPrefix("eu-central-1")).toBe("eu");
  });

  test('ap-southeast-2 maps to "au" (special case before the ap-* fallback)', () => {
    expect(crossRegionPrefix("ap-southeast-2")).toBe("au");
  });

  test('other ap-* regions map to "apac"', () => {
    expect(crossRegionPrefix("ap-southeast-1")).toBe("apac");
    expect(crossRegionPrefix("ap-northeast-1")).toBe("apac");
  });

  test("me-/ca-/sa- regions map to their codes", () => {
    expect(crossRegionPrefix("me-south-1")).toBe("me");
    expect(crossRegionPrefix("ca-central-1")).toBe("ca");
    expect(crossRegionPrefix("sa-east-1")).toBe("sa");
  });

  test('af-* regions map to "af"', () => {
    expect(crossRegionPrefix("af-south-1")).toBe("af");
  });

  test('unknown regions default to "us"', () => {
    expect(crossRegionPrefix("xx-unknown-9")).toBe("us");
  });
});

describe("AgentIntakeSingle runtime model identifiers (us-west-2 dev stack)", () => {
  let template: cdk.assertions.Template;
  let savedAgentModel: string | undefined;
  let savedExtractionModel: string | undefined;

  beforeAll(() => {
    // Ensure no process.env override masks the region-derived default.
    savedAgentModel = process.env.AGENT_MODEL;
    savedExtractionModel = process.env.EXTRACTION_MODEL;
    delete process.env.AGENT_MODEL;
    delete process.env.EXTRACTION_MODEL;

    const app = new cdk.App();
    const prereq = new cdk.Stack(app, "ModelPrereq", {
      env: { account: "123456789012", region: "us-west-2" },
    });
    const bus = new events.EventBus(prereq, "ModelBus", {
      eventBusName: "model-bus",
    });
    const bucket = new s3.Bucket(prereq, "ModelDocBucket");

    const stack = new ServicesStack(app, "citadel-services-dev", {
      environment: "dev",
      agentEventBus: bus,
      documentBucket: bucket,
      env: { account: "123456789012", region: "us-west-2" },
    });
    template = cdk.assertions.Template.fromStack(stack);
  });

  afterAll(() => {
    if (savedAgentModel !== undefined)
      process.env.AGENT_MODEL = savedAgentModel;
    if (savedExtractionModel !== undefined)
      process.env.EXTRACTION_MODEL = savedExtractionModel;
  });

  test("AGENT_MODEL/EXTRACTION_MODEL use the us. prefix (no au. prefix) in us-west-2", () => {
    template.hasResourceProperties("AWS::BedrockAgentCore::Runtime", {
      EnvironmentVariables: cdk.assertions.Match.objectLike({
        AGENT_MODEL: "us.anthropic.claude-sonnet-4-6",
        EXTRACTION_MODEL: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
      }),
    });
  });

  test("no runtime EnvironmentVariables retains the invalid au. inference-profile prefix", () => {
    const runtimes = template.findResources("AWS::BedrockAgentCore::Runtime");
    for (const runtime of Object.values(runtimes)) {
      const env =
        (
          runtime.Properties as
            | { EnvironmentVariables?: Record<string, unknown> }
            | undefined
        )?.EnvironmentVariables ?? {};
      for (const value of Object.values(env)) {
        if (typeof value === "string") {
          expect(value.startsWith("au.")).toBe(false);
        }
      }
    }
  });
});
