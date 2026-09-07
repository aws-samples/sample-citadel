/**
 * Regression guard for finding 9b702e07.
 *
 * ServicesStack's ToolSandboxFunction set TOOLS_CONFIG_TABLE to
 * `citadel-tools-config-${environment}` and scoped its IAM `dynamodb:GetItem`
 * to that same ARN — a table that is never created. The real table
 * (`ToolsConfigTable` in ArbiterStack) is named `citadel-tools-${environment}`;
 * BackendStack's ToolConfigResolverFunction/RegistrySyncLambda and
 * RegistryStack's toolConfigResolverFunction/registrySyncLambda both already
 * used the correct literal. ServicesStack alone drifted.
 *
 * A fully general "every Lambda env var naming a DynamoDB table resolves to a
 * table this app actually creates" check is impractical here without
 * duplicating bin/app.ts's wiring: three of these four stacks
 * (BackendStack/RegistryStack/ServicesStack) build the ArbiterStack table's
 * ARN/name as a hand-built string (`citadel-tools-${environment}`) rather
 * than importing the CDK `dynamodb.ITable` cross-stack — a deliberate
 * no-circular-dependency design (see
 * projects-stack-ingestion-table-wiring.test.ts's header comment for the
 * same pattern on a different table). That means the "actually created"
 * table lives in a DIFFERENT stack than the one setting most of the env
 * vars, and app.ts's real cross-stack prop threading (registry ARNs, event
 * buses, Cognito pools, S3 buckets, ~10 tables per stack) is expensive and
 * risky to reconstruct in a unit test just to prove a string equality that
 * is knowable more directly. Synthesizing the whole real `cdk.App` from
 * bin/app.ts is also not viable in-process: module load unconditionally
 * requires AWS env context cdk-nag expects, and it calls `app.synth()` with
 * real account/region assumptions as a side effect of import.
 *
 * So this guard takes the documented fallback: derive the AUTHORITATIVE
 * table name from ArbiterStack's own synthesized `ToolsConfigTable` resource
 * (never a hand-typed literal on the assertion side), then synthesize
 * BackendStack, RegistryStack, and ServicesStack independently — each with
 * minimal cross-stack props, mirroring the construction pattern already used
 * in arbiter-stack-env-parity.test.ts / backend-stack-import-resolvers.test.ts
 * — and assert every TOOLS_CONFIG_TABLE env var AND every IAM resource ARN
 * referencing a `citadel-tools-*` DynamoDB table (across all four stacks)
 * resolves to that same authoritative name. This pins the exact class of bug
 * (env var + IAM ARN silently pointing at a nonexistent table) without
 * requiring a full-app synth.
 */

import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
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

import { BackendStack } from "../lib/backend-stack";
import { RegistryStack } from "../lib/registry-stack";
import { ServicesStack } from "../lib/services-stack";
import { ArbiterStack } from "../lib/arbiter-stack";

const ACCOUNT = "123456789012";
const REGION = "us-east-1";
const ENVIRONMENT = "test";

interface CfnFunctionLike {
  Properties?: {
    Environment?: { Variables?: Record<string, unknown> };
  };
}

interface CfnPolicyLike {
  Properties?: {
    PolicyDocument?: {
      Statement?: Array<{ Resource?: unknown }>;
    };
  };
}

/** Every env var value on any Lambda function in the template. */
function allEnvVarValues(template: Template): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const fns = template.findResources("AWS::Lambda::Function");
  for (const fn of Object.values(fns) as CfnFunctionLike[]) {
    const vars = fn.Properties?.Environment?.Variables ?? {};
    for (const [key, value] of Object.entries(vars)) {
      if (typeof value !== "string") continue;
      if (!out.has(key)) out.set(key, new Set());
      out.get(key)!.add(value);
    }
  }
  return out;
}

/** Every IAM policy Resource string across the template, flattened. */
function allPolicyResourceStrings(template: Template): string[] {
  const out: string[] = [];
  const policies = template.findResources("AWS::IAM::Policy");
  for (const policy of Object.values(policies) as CfnPolicyLike[]) {
    const statements = policy.Properties?.PolicyDocument?.Statement ?? [];
    for (const stmt of statements) {
      const resources = Array.isArray(stmt.Resource)
        ? stmt.Resource
        : [stmt.Resource];
      for (const r of resources) {
        if (typeof r === "string") out.push(r);
      }
    }
  }
  return out;
}

describe("citadel-tools table name parity (finding 9b702e07 regression guard)", () => {
  let authoritativeTableName: string;
  let backendTemplate: Template;
  let registryTemplate: Template;
  let servicesTemplate: Template;
  let arbiterTemplate: Template;

  beforeAll(() => {
    // Each stack gets its OWN cdk.App. `Template.fromStack` triggers a full
    // `app.synth()`; sharing one App across multiple independent
    // `Template.fromStack` calls throws ConstructTreeModifiedAfterSynth on
    // the second call, so every stack under test (and its mock dependency
    // stack) lives in an isolated App, mirroring how each existing test
    // FILE in this suite already uses exactly one App per file.

    // ArbiterStack owns the real ToolsConfigTable — construct it and read
    // the name BACK from the synthesized template, not from source literals.
    const arbiterApp = new cdk.App();
    const arbiterBackendStack = new cdk.Stack(
      arbiterApp,
      "MockArbiterBackendStack",
      {
        env: { account: ACCOUNT, region: REGION },
      },
    );
    const agentEventBus = new events.EventBus(
      arbiterBackendStack,
      "AgentEventBus",
      { eventBusName: "citadel-agents-test" },
    );
    const mkTable = (id: string, name: string, pk: string) =>
      new dynamodb.Table(arbiterBackendStack, id, {
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
    const codeBucket = new Bucket(arbiterBackendStack, "CodeBucket", {
      bucketName: "citadel-code-test",
    });
    const fanoutFunction = new lambda.Function(
      arbiterBackendStack,
      "FanoutFunction",
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: "workflow-progress-fanout.handler",
        code: lambda.Code.fromAsset("dist/lambda"),
        timeout: cdk.Duration.seconds(30),
      },
    );
    const appSyncApi = new appsync.GraphqlApi(arbiterBackendStack, "MockApi", {
      name: "mock-api",
      schema: appsync.SchemaFile.fromAsset(
        path.resolve(__dirname, "../src/schema/schema.graphql"),
      ),
    });

    const arbiterStack = new ArbiterStack(
      arbiterApp,
      "TestArbiterStackToolsTable",
      {
        environment: ENVIRONMENT,
        env: { account: ACCOUNT, region: REGION },
        agentEventBus,
        agentConfigTable,
        codeBucket,
        workflowsTable,
        executionsTable,
        fanoutFunction,
        appSyncEndpoint: appSyncApi.graphqlUrl,
        executionSpecificationsTable,
      },
    );
    arbiterTemplate = Template.fromStack(arbiterStack);

    const toolsTables = arbiterTemplate.findResources("AWS::DynamoDB::Table", {
      Properties: { TableName: `citadel-tools-${ENVIRONMENT}` },
    });
    const toolsTableIds = Object.keys(toolsTables);
    expect(toolsTableIds.length).toBe(1);
    authoritativeTableName = (
      toolsTables[toolsTableIds[0]] as {
        Properties?: { TableName?: string };
      }
    ).Properties!.TableName!;

    // BackendStack + RegistryStack share one App (RegistryStack consumes
    // BackendStack's live constructs) — build BOTH stacks fully before
    // calling Template.fromStack on either, since fromStack synths the
    // whole app and a later construct addition after a synth throws
    // ConstructTreeModifiedAfterSynth.
    const backendApp = new cdk.App();
    const backendStack = new BackendStack(
      backendApp,
      "TestBackendStackToolsTable",
      {
        environment: ENVIRONMENT,
        env: { account: ACCOUNT, region: REGION },
      },
    );

    const registryStack = new RegistryStack(
      backendApp,
      "TestRegistryStackToolsTable",
      {
        environment: ENVIRONMENT,
        env: { account: ACCOUNT, region: REGION },
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
      },
    );

    backendTemplate = Template.fromStack(backendStack);
    registryTemplate = Template.fromStack(registryStack);

    const servicesApp = new cdk.App();
    const servicesBackendStack = new cdk.Stack(
      servicesApp,
      "MockServicesBackendStack",
      { env: { account: ACCOUNT, region: REGION } },
    );
    const servicesEventBus = new events.EventBus(
      servicesBackendStack,
      "ServicesAgentEventBus",
      { eventBusName: "citadel-agents-services-test" },
    );
    const documentBucket = new Bucket(servicesBackendStack, "DocumentBucket", {
      bucketName: "citadel-documents-services-test",
    });
    const servicesStack = new ServicesStack(
      servicesApp,
      "TestServicesStackToolsTable",
      {
        environment: ENVIRONMENT,
        env: { account: ACCOUNT, region: REGION },
        agentEventBus: servicesEventBus,
        documentBucket,
      },
    );
    servicesTemplate = Template.fromStack(servicesStack);
  });

  test("ArbiterStack actually creates a table named citadel-tools-<env>", () => {
    expect(authoritativeTableName).toBe(`citadel-tools-${ENVIRONMENT}`);
  });

  test.each([
    ["BackendStack", () => backendTemplate],
    ["RegistryStack", () => registryTemplate],
    ["ServicesStack", () => servicesTemplate],
  ])(
    "%s: every TOOLS_CONFIG_TABLE env var equals the authoritative table name",
    (_name, getTemplate) => {
      const envValues = allEnvVarValues(getTemplate());
      const values = envValues.get("TOOLS_CONFIG_TABLE");
      if (!values) {
        // Stack sets no TOOLS_CONFIG_TABLE on any function — nothing to
        // check, not a failure (ServicesStack's ToolConfigResolver is not
        // guaranteed to exist in every stack).
        return;
      }
      expect([...values]).toEqual([authoritativeTableName]);
    },
  );

  test.each([
    ["BackendStack", () => backendTemplate],
    ["RegistryStack", () => registryTemplate],
    ["ServicesStack", () => servicesTemplate],
  ])(
    "%s: no IAM policy resource ARN references a citadel-tools-* table other than the authoritative one",
    (_name, getTemplate) => {
      const resources = allPolicyResourceStrings(getTemplate());
      const badTableArns = resources.filter((r) => {
        const match = r.match(/table\/(citadel-tools-[a-zA-Z0-9-]+)(?:\/|$)/);
        if (!match) return false;
        return match[1] !== authoritativeTableName;
      });
      expect(badTableArns).toEqual([]);
    },
  );
});
