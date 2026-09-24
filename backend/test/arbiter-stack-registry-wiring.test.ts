/**
 * Arbiter PythonFunction Registry wiring (cross-Lambda), SSM-resolved.
 *
 * Since finding 8b7ee8af the arbiter resolves the registry id/arn from the
 * SSM parameters `/citadel/<env>/registry/{id,arn}` (published by
 * BackendStack) instead of receiving registryId/registryArn props — the
 * wiring is now unconditional, so the old with/without-props variants
 * collapsed into one.
 *
 * Coverage axes:
 *   A. Bundling commandHooks — proxy: the 4 expected PythonFunction
 *      logical-ID patterns synthesise. Precise `bundling.commandHooks`
 *      assertion is not practical via the CDK `Template` helper.
 *   B. Registry IAM policy on Supervisor/Worker/Fabricator pins Resource to
 *      the SSM-resolved registry arn (+ /*).
 *   C. REGISTRY_ID (SSM Ref) / REGISTRY_ENABLED / REGISTRY_GENERATION env
 *      on Supervisor/Worker/Fabricator.
 *   D. Activator is untouched — forward-compatible scope guard.
 *   E. The template must NOT import the backend's registry exports
 *      (Fn::ImportValue) — SSM is the only sharing channel.
 */
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as events from "aws-cdk-lib/aws-events";
import { Bucket } from "aws-cdk-lib/aws-s3";
import {
  scaffoldBackendAssetDirs,
  scaffoldArbiterStubs,
} from "./helpers/scaffold-stub-assets";
import {
  CfnPolicyResourceLike,
  CfnStatementLike,
  expectNoRegistryExportImports,
  expectRegistryGenerationBesideRegistryId,
  registrySsmParamLogicalIds,
  TemplateJson,
} from "./helpers/registry-ssm";
import { REGISTRY_GENERATION } from "../lib/registry-generation";

// CI + clean-checkout safety: stub the asset dirs that ArbiterStack expects.
scaffoldBackendAssetDirs(["dist/lambda", "src/schema"]);
scaffoldArbiterStubs();

import { ArbiterStack } from "../lib/arbiter-stack";

const PREFIXES = {
  Supervisor: "SupervisorAgent",
  Worker: "WorkerAgentWrapper",
  Fabricator: "FabricatorAgent",
  Activator: "ActivatorAgent",
} as const;

type Resources = TemplateJson["Resources"];

function buildStack(): TemplateJson {
  const app = new cdk.App({ context: { "aws:cdk:bundling-stacks": [] } });
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
    executionSpecificationsTable,
  });
  return Template.fromStack(stack).toJSON() as TemplateJson;
}

// --- Helpers over the synthesised resource graph --------------------------

function findLambdaLogicalId(resources: Resources, prefix: string): string {
  const entry = Object.entries(resources).find(
    ([key, r]) =>
      r.Type === "AWS::Lambda::Function" &&
      r.Properties?.Runtime === "python3.14" &&
      key.startsWith(prefix),
  );
  if (!entry)
    throw new Error(
      `Python 3.14 Lambda with logical-ID prefix "${prefix}" not found`,
    );
  return entry[0];
}

function getPoliciesForLambda(
  resources: Resources,
  lambdaLogicalId: string,
): CfnPolicyResourceLike[] {
  const roleRef = (
    resources[lambdaLogicalId]?.Properties?.Role as
      { "Fn::GetAtt"?: string[] } | undefined
  )?.["Fn::GetAtt"]?.[0];
  if (!roleRef) return [];
  return (Object.values(resources) as CfnPolicyResourceLike[]).filter(
    (r) =>
      r.Type === "AWS::IAM::Policy" &&
      Array.isArray(r.Properties?.Roles) &&
      r.Properties.Roles.some((role) => role.Ref === roleRef),
  );
}

function collectActions(policies: CfnPolicyResourceLike[]): string[] {
  const actions: string[] = [];
  for (const p of policies) {
    for (const stmt of p.Properties?.PolicyDocument?.Statement ?? []) {
      const stmtActions = Array.isArray(stmt.Action)
        ? stmt.Action
        : [stmt.Action];
      for (const a of stmtActions) if (typeof a === "string") actions.push(a);
    }
  }
  return actions;
}

function findGetRegistryRecordStatement(
  policies: CfnPolicyResourceLike[],
): CfnStatementLike | undefined {
  for (const p of policies) {
    for (const stmt of p.Properties?.PolicyDocument?.Statement ?? []) {
      const actions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action];
      if (actions.includes("agent-registry:GetRegistryRecord")) return stmt;
    }
  }
  return undefined;
}

function lambdaEnv(
  resources: Resources,
  lambdaLogicalId: string,
): Record<string, unknown> {
  return resources[lambdaLogicalId]?.Properties?.Environment?.Variables ?? {};
}

function countPythonFunctionsByPrefix(
  resources: Resources,
  prefix: string,
): number {
  return Object.keys(resources).filter(
    (key) =>
      resources[key].Type === "AWS::Lambda::Function" &&
      resources[key].Properties?.Runtime === "python3.14" &&
      key.startsWith(prefix),
  ).length;
}

// --- Tests ----------------------------------------------------------------

const positive: ReadonlyArray<readonly [string, string]> = [
  ["Supervisor", PREFIXES.Supervisor],
  ["Worker", PREFIXES.Worker],
  ["Fabricator", PREFIXES.Fabricator],
];
const allFour: ReadonlyArray<readonly [string, string]> = [
  ...positive,
  ["Activator", PREFIXES.Activator],
];

describe("ArbiterStack — Registry wiring across arbiter PythonFunctions (SSM-resolved)", () => {
  let template: TemplateJson;
  let resources: Resources;
  let idParam: string;
  let arnParam: string;

  beforeAll(() => {
    template = buildStack();
    resources = template.Resources;
    ({ idParam, arnParam } = registrySsmParamLogicalIds(template, "test"));
  });

  describe("A. Bundling surface — 4 PythonFunction logical IDs present", () => {
    test.each(allFour)(
      "%s Lambda (prefix %s) synthesises as python3.14",
      (_label, prefix) => {
        expect(
          countPythonFunctionsByPrefix(resources, prefix),
        ).toBeGreaterThanOrEqual(1);
      },
    );
  });

  describe("B. Registry IAM policy on Supervisor/Worker/Fabricator", () => {
    test.each(positive)(
      "%s role statement includes agent-registry:GetRegistryRecord",
      (_label, prefix) => {
        const stmt = findGetRegistryRecordStatement(
          getPoliciesForLambda(
            resources,
            findLambdaLogicalId(resources, prefix),
          ),
        );
        expect(stmt).toBeDefined();
        expect(stmt.Effect).toBe("Allow");
      },
    );

    test.each(positive)(
      "%s role statement pins Resource to the SSM-resolved registry arn (+ /*)",
      (_label, prefix) => {
        const stmt = findGetRegistryRecordStatement(
          getPoliciesForLambda(
            resources,
            findLambdaLogicalId(resources, prefix),
          ),
        );
        expect(stmt).toBeDefined();
        const resourceList = Array.isArray(stmt.Resource)
          ? stmt.Resource
          : [stmt.Resource];
        expect(resourceList).toEqual(
          expect.arrayContaining([
            { Ref: arnParam },
            { "Fn::Join": ["", [{ Ref: arnParam }, "/*"]] },
          ]),
        );
      },
    );

    test("Fabricator retains full Registry CRUD action surface (unchanged by T1)", () => {
      const actions = collectActions(
        getPoliciesForLambda(
          resources,
          findLambdaLogicalId(resources, PREFIXES.Fabricator),
        ),
      );
      for (const action of [
        "agent-registry:CreateRegistryRecord",
        "agent-registry:UpdateRegistryRecord",
        "agent-registry:UpdateRegistryRecordStatus",
        "agent-registry:DeleteRegistryRecord",
        "agent-registry:GetRegistryRecord",
        "agent-registry:ListRegistryRecords",
      ]) {
        expect(actions).toContain(action);
      }
    });
  });

  describe("C. REGISTRY_ID / REGISTRY_ENABLED / REGISTRY_GENERATION env on Supervisor/Worker/Fabricator", () => {
    test.each(positive)(
      "%s env.REGISTRY_ID Refs the SSM registry-id parameter",
      (_label, prefix) => {
        expect(
          lambdaEnv(resources, findLambdaLogicalId(resources, prefix))
            .REGISTRY_ID,
        ).toEqual({ Ref: idParam });
      },
    );
    test.each(positive)(
      '%s env.REGISTRY_ENABLED === "true"',
      (_label, prefix) => {
        expect(
          lambdaEnv(resources, findLambdaLogicalId(resources, prefix))
            .REGISTRY_ENABLED,
        ).toBe("true");
      },
    );
    test.each(positive)(
      "%s env.REGISTRY_GENERATION pins the current generation",
      (_label, prefix) => {
        expect(
          lambdaEnv(resources, findLambdaLogicalId(resources, prefix))
            .REGISTRY_GENERATION,
        ).toBe(REGISTRY_GENERATION);
      },
    );
    test("every function with REGISTRY_ID also carries REGISTRY_GENERATION", () => {
      expectRegistryGenerationBesideRegistryId(template);
    });
  });

  describe("D. Activator is NOT wired to Registry (scope guard)", () => {
    test("Activator role has zero agent-registry:* actions", () => {
      const agentcore = collectActions(
        getPoliciesForLambda(
          resources,
          findLambdaLogicalId(resources, PREFIXES.Activator),
        ),
      ).filter((a) => a.startsWith("agent-registry:"));
      expect(agentcore).toEqual([]);
    });
    test("Activator env has no REGISTRY_ID", () => {
      expect(
        lambdaEnv(resources, findLambdaLogicalId(resources, PREFIXES.Activator))
          .REGISTRY_ID,
      ).toBeUndefined();
    });
    test("Activator env has no REGISTRY_ENABLED", () => {
      expect(
        lambdaEnv(resources, findLambdaLogicalId(resources, PREFIXES.Activator))
          .REGISTRY_ENABLED,
      ).toBeUndefined();
    });
  });

  describe("E. No cross-stack import of the backend registry exports", () => {
    test("template contains no Fn::ImportValue of *-RegistryArn / *-RegistryId", () => {
      expectNoRegistryExportImports(template);
    });
  });
});
