import * as cdk from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as events from "aws-cdk-lib/aws-events";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as appsync from "@aws-cdk/aws-appsync-alpha";
import { Bucket } from "aws-cdk-lib/aws-s3";
import * as path from "path";
import {
  scaffoldBackendAssetDirs,
  scaffoldArbiterStubs,
} from "./helpers/scaffold-stub-assets";

// Ensure asset directories exist for CDK synthesis
scaffoldBackendAssetDirs(["dist/lambda", "src/schema"]);
scaffoldArbiterStubs();

import { ArbiterStack } from "../lib/arbiter-stack";

describe("ArbiterStack — Step Runner Lambda and EventBridge rules (Task 1.6)", () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();

    // Create a mock BackendStack to provide cross-stack references
    const backendStack = new cdk.Stack(app, "MockBackendStack", {
      env: { account: "123456789012", region: "us-east-1" },
    });

    const agentEventBus = new events.EventBus(backendStack, "AgentEventBus", {
      eventBusName: "citadel-agents-test",
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

    const codeBucket = new Bucket(backendStack, "CodeBucket", {
      bucketName: "citadel-code-test",
    });

    const workflowsTable = new dynamodb.Table(backendStack, "WorkflowsTable", {
      tableName: "citadel-workflows-test",
      partitionKey: { name: "workflowId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const executionsTable = new dynamodb.Table(
      backendStack,
      "ExecutionsTable",
      {
        tableName: "citadel-executions-test",
        partitionKey: {
          name: "executionId",
          type: dynamodb.AttributeType.STRING,
        },
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      },
    );

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

    // executionSpecificationsTable is now a required prop.
    // Provide a mock table so the stack synthesises. The test body doesn't
    // interrogate this table's wiring — it's just a dependency the
    // fabricator/worker Lambdas need.
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

  // --- StepRunnerFunction ---
  describe("StepRunnerFunction", () => {
    test("exists with Python 3.14 runtime, 300s timeout, 1024MB memory", () => {
      template.hasResourceProperties("AWS::Lambda::Function", {
        Runtime: "python3.14",
        Timeout: 300,
        MemorySize: 1024,
        Handler: "index.handler",
      });
    });

    test("has X-Ray active tracing enabled", () => {
      const functions = template.findResources("AWS::Lambda::Function", {
        Properties: {
          Handler: "index.handler",
          Runtime: "python3.14",
          Timeout: 300,
        },
      });
      const logicalIds = Object.keys(functions);
      expect(logicalIds.length).toBeGreaterThanOrEqual(1);
      // Find the step runner specifically (300s timeout, python3.14)
      const stepRunnerEntry = Object.entries(functions).find(
        ([, fn]: [string, any]) =>
          fn.Properties.Timeout === 300 &&
          fn.Properties.Runtime === "python3.14",
      );
      expect(stepRunnerEntry).toBeDefined();
      expect(stepRunnerEntry![1].Properties.TracingConfig).toEqual({
        Mode: "Active",
      });
    });

    test("has correct environment variables", () => {
      template.hasResourceProperties("AWS::Lambda::Function", {
        Runtime: "python3.14",
        Timeout: 300,
        Environment: {
          Variables: Match.objectLike({
            EXECUTIONS_TABLE: Match.anyValue(),
            WORKFLOWS_TABLE: Match.anyValue(),
            AGENT_CONFIG_TABLE: Match.anyValue(),
            TOOLS_CONFIG_TABLE: Match.anyValue(),
            EVENT_BUS_NAME: Match.anyValue(),
            APPSYNC_ENDPOINT: Match.anyValue(),
          }),
        },
      });
    });

    test("has the shared arbiter catalog layer attached", () => {
      // Resolve the catalog layer's logical id from its LayerName so the
      // shared `common`/`catalog` packages resolve at runtime.
      const layers = template.findResources("AWS::Lambda::LayerVersion", {
        Properties: { LayerName: "citadel-arbiter-catalog-test" },
      });
      const catalogLayerId = Object.keys(layers)[0];
      expect(catalogLayerId).toBeDefined();

      // Find the step runner function (python3.14, 300s timeout) and assert it
      // references the catalog layer.
      const functions = template.findResources("AWS::Lambda::Function", {
        Properties: {
          Handler: "index.handler",
          Runtime: "python3.14",
          Timeout: 300,
        },
      });
      const stepRunnerEntry = Object.entries(functions).find(
        ([, fn]: [string, any]) =>
          fn.Properties.Timeout === 300 &&
          fn.Properties.Runtime === "python3.14",
      );
      expect(stepRunnerEntry).toBeDefined();
      const stepRunnerLayers =
        (stepRunnerEntry![1] as any).Properties.Layers || [];
      const referencesCatalogLayer = stepRunnerLayers.some(
        (l: any) => l && l.Ref === catalogLayerId,
      );
      expect(referencesCatalogLayer).toBe(true);
    });
  });

  // --- EventBridge Rules targeting StepRunner ---
  describe("EventBridge Rules — StepRunner targets", () => {
    test("StepRunnerStartRule matches execution.start.requested", () => {
      template.hasResourceProperties("AWS::Events::Rule", {
        EventPattern: {
          "detail-type": ["execution.start.requested"],
        },
      });
    });

    test("StepRunnerNodeCompletedRule matches workflow.node.completed", () => {
      template.hasResourceProperties("AWS::Events::Rule", {
        EventPattern: {
          "detail-type": ["workflow.node.completed"],
        },
      });
    });

    test("StepRunnerNodeFailedRule matches workflow.node.failed", () => {
      template.hasResourceProperties("AWS::Events::Rule", {
        EventPattern: {
          "detail-type": ["workflow.node.failed"],
        },
      });
    });

    test("StepRunnerCancelRule matches execution.cancel.requested", () => {
      template.hasResourceProperties("AWS::Events::Rule", {
        EventPattern: {
          "detail-type": ["execution.cancel.requested"],
        },
      });
    });
  });

  // --- WorkflowProgressFanoutRule ---
  describe("WorkflowProgressFanoutRule", () => {
    test("matches workflow.* events from citadel.workflows source", () => {
      template.hasResourceProperties("AWS::Events::Rule", {
        EventPattern: {
          source: ["citadel.workflows"],
          "detail-type": Match.arrayWith([
            "workflow.started",
            "workflow.node.started",
            "workflow.node.completed",
            "workflow.node.failed",
            "workflow.node.retrying",
            "workflow.completed",
            "workflow.failed",
          ]),
        },
      });
    });
  });

  // --- IAM Policies (least-privilege per design 8.2) ---
  describe("IAM Policies — Step Runner least-privilege", () => {
    test("Step Runner has DynamoDB read/write on executions table", () => {
      // Cross-stack table refs use Fn::ImportValue, so we check that a policy
      // grants DynamoDB read/write actions (grantReadWriteData generates these)
      const policies = template.findResources("AWS::IAM::Policy");
      const hasDynamoDBReadWrite = Object.values(policies).some((p: any) => {
        const statements = p.Properties?.PolicyDocument?.Statement || [];
        return statements.some((s: any) => {
          const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
          return (
            actions.includes("dynamodb:BatchGetItem") &&
            actions.includes("dynamodb:BatchWriteItem") &&
            actions.includes("dynamodb:PutItem") &&
            actions.includes("dynamodb:DeleteItem") &&
            actions.includes("dynamodb:GetItem")
          );
        });
      });
      expect(hasDynamoDBReadWrite).toBe(true);
    });

    test("Step Runner has DynamoDB read on workflows table", () => {
      // grantReadData generates GetItem, BatchGetItem, Query, Scan, etc.
      const policies = template.findResources("AWS::IAM::Policy");
      const hasDynamoDBRead = Object.values(policies).some((p: any) => {
        const statements = p.Properties?.PolicyDocument?.Statement || [];
        return statements.some((s: any) => {
          const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
          // grantReadData includes these actions but NOT PutItem/DeleteItem
          return (
            actions.includes("dynamodb:GetItem") &&
            actions.includes("dynamodb:Query") &&
            actions.includes("dynamodb:Scan") &&
            !actions.includes("dynamodb:PutItem")
          );
        });
      });
      expect(hasDynamoDBRead).toBe(true);
    });

    test("Step Runner has EventBridge PutEvents permission", () => {
      const policies = template.findResources("AWS::IAM::Policy");
      const hasPutEvents = Object.values(policies).some((p: any) => {
        const statements = p.Properties?.PolicyDocument?.Statement || [];
        return statements.some((s: any) => {
          const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
          return actions.includes("events:PutEvents");
        });
      });
      expect(hasPutEvents).toBe(true);
    });

    test("Step Runner has DynamoDB read on agent config table", () => {
      // The agent config table is also cross-stack, so check for read-only actions
      // We verify there are at least 2 read-only policies (workflows + agent config)
      const policies = template.findResources("AWS::IAM::Policy");
      const readOnlyPolicies = Object.values(policies).filter((p: any) => {
        const statements = p.Properties?.PolicyDocument?.Statement || [];
        return statements.some((s: any) => {
          const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
          return (
            actions.includes("dynamodb:GetItem") &&
            actions.includes("dynamodb:Query") &&
            !actions.includes("dynamodb:PutItem")
          );
        });
      });
      // At least 2 read-only DynamoDB policies: workflows table + agent config table
      // (tools config table also gets grantReadData, so could be 3+)
      expect(readOnlyPolicies.length).toBeGreaterThanOrEqual(2);
    });
  });

  // --- Workflow metric grants + timeout watchdog ---
  // Collect every IAM action attached to roles whose logical id contains the
  // given substring (grantX + addToRolePolicy all land on the same DefaultPolicy).
  function actionsForRole(roleSubstring: string): Set<string> {
    const policies = template.findResources("AWS::IAM::Policy");
    const actions = new Set<string>();
    for (const p of Object.values(policies) as any[]) {
      const roles = p.Properties?.Roles || [];
      const matches = roles.some((r: any) =>
        (r?.Ref || "").includes(roleSubstring),
      );
      if (!matches) continue;
      for (const s of p.Properties?.PolicyDocument?.Statement || []) {
        const acts = Array.isArray(s.Action) ? s.Action : [s.Action];
        acts.forEach((a: string) => actions.add(a));
      }
    }
    return actions;
  }

  // Collect the resources (as strings) of every statement on roles matching
  // `roleSubstring` that include `action`. Non-string resources (Fn::Join /
  // Fn::ImportValue tokens) are JSON-serialised so prefix assertions work.
  function resourcesForRoleAction(
    roleSubstring: string,
    action: string,
  ): string[] {
    const policies = template.findResources("AWS::IAM::Policy");
    const out: string[] = [];
    for (const p of Object.values(policies) as any[]) {
      const roles = p.Properties?.Roles || [];
      if (!roles.some((r: any) => (r?.Ref || "").includes(roleSubstring)))
        continue;
      for (const s of p.Properties?.PolicyDocument?.Statement || []) {
        const acts = Array.isArray(s.Action) ? s.Action : [s.Action];
        if (!acts.includes(action)) continue;
        const res = Array.isArray(s.Resource) ? s.Resource : [s.Resource];
        res.forEach((r: any) =>
          out.push(typeof r === "string" ? r : JSON.stringify(r)),
        );
      }
    }
    return out;
  }

  // Resources of statements granting any s3:PutObject* action on the given role.
  function s3PutResourcesForRole(roleSubstring: string): string[] {
    const policies = template.findResources("AWS::IAM::Policy");
    const out: string[] = [];
    for (const p of Object.values(policies) as any[]) {
      const roles = p.Properties?.Roles || [];
      if (!roles.some((r: any) => (r?.Ref || "").includes(roleSubstring)))
        continue;
      for (const s of p.Properties?.PolicyDocument?.Statement || []) {
        const acts = Array.isArray(s.Action) ? s.Action : [s.Action];
        if (
          !acts.some(
            (a: any) => typeof a === "string" && a.startsWith("s3:PutObject"),
          )
        )
          continue;
        const res = Array.isArray(s.Resource) ? s.Resource : [s.Resource];
        res.forEach((r: any) =>
          out.push(typeof r === "string" ? r : JSON.stringify(r)),
        );
      }
    }
    return out;
  }

  describe("Worker Bedrock least-privilege", () => {
    test("worker InvokeModel is scoped to the shared model ARNs, not Resource::*", () => {
      const resources = resourcesForRoleAction(
        "WorkerAgentWrapper",
        "bedrock:InvokeModel",
      );
      expect(resources.length).toBeGreaterThan(0);
      // No blanket wildcard — the whole point of the finding.
      expect(resources).not.toContain("*");
      // Scoped to the same three model families the supervisor/fabricator use.
      expect(
        resources.some((r) =>
          r.includes("foundation-model/anthropic.claude-*"),
        ),
      ).toBe(true);
      expect(
        resources.some((r) => r.includes("foundation-model/amazon.*")),
      ).toBe(true);
      expect(resources.some((r) => r.includes("inference-profile/"))).toBe(
        true,
      );
    });
  });

  describe("Seed S3 write least-privilege", () => {
    test("seed PutObject is path-scoped to agents/*, not the whole bucket", () => {
      const resources = s3PutResourcesForRole("SeedAgentConfig");
      expect(resources.length).toBeGreaterThan(0);
      // Every PutObject resource is the agents/* object-key prefix. A bucket-
      // wide grant would render the suffix as ".../*" with no agents/ segment.
      expect(resources.every((r) => r.includes("agents/*"))).toBe(true);
    });
  });

  describe("Workflow node-metric grants (PutMetricData)", () => {
    test("Step Runner role can PutMetricData (node duration/failure metrics)", () => {
      expect(
        actionsForRole("StepRunnerFunction").has("cloudwatch:PutMetricData"),
      ).toBe(true);
    });

    test("Worker role can PutMetricData (node duration/failure metrics)", () => {
      expect(
        actionsForRole("WorkerAgentWrapper").has("cloudwatch:PutMetricData"),
      ).toBe(true);
    });
  });

  describe("Workflow timeout watchdog", () => {
    test("watchdog Lambda exists with timeout_watchdog.handler on Python 3.14", () => {
      template.hasResourceProperties("AWS::Lambda::Function", {
        Handler: "timeout_watchdog.handler",
        Runtime: "python3.14",
      });
    });

    test("watchdog runs on a 5-minute EventBridge schedule", () => {
      template.hasResourceProperties("AWS::Events::Rule", {
        ScheduleExpression: "rate(5 minutes)",
      });
    });

    test("watchdog DynamoDB grant is least-privilege: Scan + UpdateItem only, not full read/write", () => {
      const actions = actionsForRole("WorkflowTimeoutWatchdog");
      // The watchdog only Scans for running executions and conditionally
      // UpdateItems the stuck ones to failed (timeout_watchdog.py).
      expect(actions.has("dynamodb:Scan")).toBe(true);
      expect(actions.has("dynamodb:UpdateItem")).toBe(true);
      // grantReadWriteData artifacts must be gone — no put/delete/batch, and no
      // read-by-key (the watchdog never GetItems; it reads startedAt off Scan).
      expect(actions.has("dynamodb:PutItem")).toBe(false);
      expect(actions.has("dynamodb:DeleteItem")).toBe(false);
      expect(actions.has("dynamodb:BatchWriteItem")).toBe(false);
      expect(actions.has("dynamodb:GetItem")).toBe(false);
      expect(actions.has("dynamodb:BatchGetItem")).toBe(false);
      // Unchanged grants remain.
      expect(actions.has("events:PutEvents")).toBe(true);
      expect(actions.has("cloudwatch:PutMetricData")).toBe(true);
    });
  });

  // --- Execution-path Lambda error-rate alarms ---
  // Mirror the existing Supervisor/Fabricator error-alarm pattern
  // (metricErrors, 5-minute period, NOT_BREACHING) for the workflow
  // dispatch/execution path: the worker, the step runner, and the
  // timeout watchdog. The worker SQS DLQ depth alarm already exists
  // (WorkerDLQDepthAlarm) and is intentionally NOT duplicated here.
  describe("Execution-path Lambda error-rate alarms", () => {
    function alarmByName(name: string): any {
      const alarms = template.findResources("AWS::CloudWatch::Alarm");
      return Object.values(alarms).find(
        (a: any) => a.Properties?.AlarmName === name,
      );
    }

    function functionNameDimensionRef(alarm: any): string {
      const dims = alarm?.Properties?.Dimensions || [];
      const fn = dims.find((d: any) => d.Name === "FunctionName");
      return fn?.Value?.Ref || "";
    }

    test("Worker Lambda error-rate alarm exists (AWS/Lambda Errors, 5-min, NOT_BREACHING)", () => {
      template.hasResourceProperties("AWS::CloudWatch::Alarm", {
        AlarmName: "citadel-worker-errors-test",
        Namespace: "AWS/Lambda",
        MetricName: "Errors",
        Period: 300,
        Threshold: 3,
        ComparisonOperator: "GreaterThanOrEqualToThreshold",
        TreatMissingData: "notBreaching",
      });
    });

    test("Worker error alarm is dimensioned on the WorkerAgentWrapper function", () => {
      const alarm = alarmByName("citadel-worker-errors-test");
      expect(alarm).toBeDefined();
      expect(functionNameDimensionRef(alarm)).toContain("WorkerAgentWrapper");
    });

    test("Step Runner Lambda error-rate alarm exists (AWS/Lambda Errors, 5-min, NOT_BREACHING)", () => {
      template.hasResourceProperties("AWS::CloudWatch::Alarm", {
        AlarmName: "citadel-step-runner-errors-test",
        Namespace: "AWS/Lambda",
        MetricName: "Errors",
        Period: 300,
        Threshold: 3,
        ComparisonOperator: "GreaterThanOrEqualToThreshold",
        TreatMissingData: "notBreaching",
      });
    });

    test("Step Runner error alarm is dimensioned on the StepRunnerFunction", () => {
      const alarm = alarmByName("citadel-step-runner-errors-test");
      expect(alarm).toBeDefined();
      expect(functionNameDimensionRef(alarm)).toContain("StepRunnerFunction");
    });

    test("Watchdog Lambda error-rate alarm exists (AWS/Lambda Errors, 5-min, NOT_BREACHING)", () => {
      template.hasResourceProperties("AWS::CloudWatch::Alarm", {
        AlarmName: "citadel-workflow-timeout-watchdog-errors-test",
        Namespace: "AWS/Lambda",
        MetricName: "Errors",
        Period: 300,
        Threshold: 1,
        ComparisonOperator: "GreaterThanOrEqualToThreshold",
        TreatMissingData: "notBreaching",
      });
    });

    test("Watchdog error alarm is dimensioned on the WorkflowTimeoutWatchdog function", () => {
      const alarm = alarmByName(
        "citadel-workflow-timeout-watchdog-errors-test",
      );
      expect(alarm).toBeDefined();
      expect(functionNameDimensionRef(alarm)).toContain(
        "WorkflowTimeoutWatchdog",
      );
    });
  });
});
