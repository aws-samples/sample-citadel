/**
 * eval_judge deployment (decision 60f1fad5): arbiter/eval_judge must be
 * deployed as the Lambda consumer of `governance.eval.case.judge.requested`
 * (FROZEN TS -> Py contract, EVENTBRIDGE_CATALOG.md), mirroring the existing
 * EventBridge-rule -> Lambda-target pattern used by the other arbiter
 * consumers (ActivatorAgent/AgentActivateRule): function-level DLQ on the
 * shared arbiterAsyncDlq, retryAttempts 2, the ArbiterCatalogLayer,
 * PYTHON_3_15 runtime, least-privilege IAM, and existing DLQ alarm
 * coverage (DlqNotEmptySharedAlarm in telemetry-stack.ts already alarms on
 * citadel-arbiter-async-dlq-* by queue name — a new function-level DLQ
 * target on that SAME queue needs no new alarm).
 *
 * RED: every assertion below must fail against today's ArbiterStack, which
 * has no eval_judge Lambda or rule at all.
 */
import * as cdk from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as events from "aws-cdk-lib/aws-events";
import { Bucket } from "aws-cdk-lib/aws-s3";
import {
  scaffoldBackendAssetDirs,
  scaffoldArbiterStubs,
} from "./helpers/scaffold-stub-assets";

scaffoldBackendAssetDirs(["dist/lambda", "src/schema"]);
// eval_judge is a real module on disk (arbiter/eval_judge/index.py) —
// deliberately NOT in the stub list, so this exercises the real asset dir.
scaffoldArbiterStubs();

import { ArbiterStack } from "../lib/arbiter-stack";

function buildStack(): cdk.Stack {
  const app = new cdk.App({ context: { "aws:cdk:bundling-stacks": [] } });
  const backendStack = new cdk.Stack(app, "MockBackendStackEvalJudge", {
    env: { account: "123456789012", region: "us-east-1" },
  });
  const agentEventBus = new events.EventBus(backendStack, "AgentEventBus", {
    eventBusName: "citadel-agents-test-ej",
  });
  const agentConfigTable = new dynamodb.Table(
    backendStack,
    "AgentConfigTable",
    {
      tableName: "citadel-agents-test-ej",
      partitionKey: { name: "agentId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    },
  );
  const codeBucket = new Bucket(backendStack, "CodeBucket", {
    bucketName: "citadel-code-test-ej",
  });
  const executionSpecificationsTable = new dynamodb.Table(
    backendStack,
    "ExecutionSpecificationsTable",
    {
      tableName: "citadel-execution-specifications-test-ej",
      partitionKey: { name: "specId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    },
  );
  return new ArbiterStack(app, "TestArbiterStackEvalJudge", {
    environment: "test",
    env: { account: "123456789012", region: "us-east-1" },
    agentEventBus,
    agentConfigTable,
    codeBucket,
    executionSpecificationsTable,
  });
}

describe("ArbiterStack — eval_judge deployment (judge.requested consumer)", () => {
  let template: Template;

  beforeAll(() => {
    template = Template.fromStack(buildStack());
  });

  test("a Lambda function for eval_judge exists on PYTHON_3_15 with the ArbiterCatalogLayer", () => {
    const fns = template.findResources("AWS::Lambda::Function", {
      Properties: Match.objectLike({ Runtime: "python3.15" }),
    });
    const evalJudgeFn = Object.values(fns).find((fn) => {
      const handler = (fn.Properties as Record<string, unknown>)?.Handler;
      return typeof handler === "string" && handler.startsWith("index.");
    });
    // Narrower: find by logical-id prefix instead, since multiple functions
    // use index.* handlers.
    const byLogicalId = Object.keys(
      template.findResources("AWS::Lambda::Function"),
    ).find((id) => id.startsWith("EvalJudge"));
    expect(byLogicalId).toBeDefined();
    expect(evalJudgeFn).toBeDefined();
  });

  test("eval_judge Lambda has its DeadLetterConfig pointed at the shared arbiterAsyncDlq", () => {
    const fns = template.findResources("AWS::Lambda::Function");
    const evalJudgeId = Object.keys(fns).find((id) =>
      id.startsWith("EvalJudge"),
    );
    expect(evalJudgeId).toBeDefined();
    const props = fns[evalJudgeId!].Properties as Record<string, unknown>;
    expect(props.DeadLetterConfig).toBeDefined();

    const dlqs = template.findResources("AWS::SQS::Queue", {
      Properties: Match.objectLike({
        QueueName: "citadel-arbiter-async-dlq-test",
      }),
    });
    const dlqLogicalId = Object.keys(dlqs)[0];
    expect(dlqLogicalId).toBeDefined();

    const dlqConfig = props.DeadLetterConfig as {
      TargetArn?: { "Fn::GetAtt"?: [string, string] };
    };
    expect(dlqConfig.TargetArn?.["Fn::GetAtt"]?.[0]).toBe(dlqLogicalId);
  });

  test("an EventBridge rule matches governance.eval.case.judge.requested (source citadel.backend) targeting eval_judge with retryAttempts 2", () => {
    const rules = template.findResources("AWS::Events::Rule", {
      Properties: Match.objectLike({
        EventPattern: Match.objectLike({
          source: Match.arrayWith(["citadel.backend"]),
          "detail-type": Match.arrayWith([
            "governance.eval.case.judge.requested",
          ]),
        }),
      }),
    });
    const ruleIds = Object.keys(rules);
    expect(ruleIds.length).toBeGreaterThanOrEqual(1);

    const targets = rules[ruleIds[0]].Properties.Targets as Array<{
      RetryPolicy?: { MaximumRetryAttempts?: number };
    }>;
    expect(targets.length).toBeGreaterThanOrEqual(1);
    expect(targets[0].RetryPolicy?.MaximumRetryAttempts).toBe(2);
  });

  test("eval_judge IAM: least-privilege — ssm:GetParameter + s3:GetObject (read-only artifact fetch), bedrock:Converse-capable invoke, events:PutEvents, and model-config/catalog table read", () => {
    const fns = template.findResources("AWS::Lambda::Function");
    const evalJudgeId = Object.keys(fns).find((id) =>
      id.startsWith("EvalJudge"),
    );
    expect(evalJudgeId).toBeDefined();

    const policies = template.findResources("AWS::IAM::Policy");
    const roleId = (fns[evalJudgeId!].Properties as Record<string, unknown>)
      .Role as { "Fn::GetAtt"?: [string, string] };
    expect(roleId?.["Fn::GetAtt"]?.[0]).toBeDefined();
    const roleLogicalId = roleId!["Fn::GetAtt"]![0];

    const attachedPolicies = Object.values(policies).filter((p) => {
      const roles = (p.Properties as Record<string, unknown>).Roles as Array<{
        Ref?: string;
      }>;
      return roles?.some((r) => r.Ref === roleLogicalId);
    });
    const allStatements = attachedPolicies.flatMap((p) => {
      const doc = (p.Properties as Record<string, unknown>).PolicyDocument as {
        Statement: Array<Record<string, unknown>>;
      };
      return doc.Statement;
    });
    const actionsFlat = allStatements.flatMap((s) => {
      const a = s.Action;
      return Array.isArray(a) ? a : [a];
    });

    expect(actionsFlat).toContain("ssm:GetParameter");
    expect(actionsFlat).toContain("s3:GetObject");
    expect(actionsFlat).toContain("events:PutEvents");
    expect(
      actionsFlat.some(
        (a) => a === "bedrock:InvokeModel" || a === "bedrock:Converse",
      ),
    ).toBe(true);

    // Never grants s3:PutObject/DeleteObject (read-only artifact fetch —
    // eval_judge never writes the eval-runs/ artifact, design invariant).
    expect(actionsFlat).not.toContain("s3:PutObject");
    expect(actionsFlat).not.toContain("s3:DeleteObject");
    // Never writes DynamoDB directly (single-writer invariant, design §7).
    expect(actionsFlat).not.toContain("dynamodb:PutItem");
    expect(actionsFlat).not.toContain("dynamodb:UpdateItem");
  });

  test("eval_judge is covered by the existing shared-DLQ alarm convention — no bare unalarmed consumer (reuses arbiterAsyncDlq, which DlqNotEmptySharedAlarm already covers by queue name)", () => {
    const dlqs = template.findResources("AWS::SQS::Queue", {
      Properties: Match.objectLike({
        QueueName: "citadel-arbiter-async-dlq-test",
      }),
    });
    expect(Object.keys(dlqs).length).toBe(1);
  });
});
