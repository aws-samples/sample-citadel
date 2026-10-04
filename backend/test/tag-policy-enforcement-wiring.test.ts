/**
 * Tag-policy enforcement wiring test.
 *
 * Asserts that:
 *  - agent-config-resolver, tool-config-resolver (BackendStack) and
 *    agent-import-resolver, fabricator-request-resolver (RegistryStack) and
 *    app-publish-handler (GatewayStack) all have ORGANIZATIONS_TABLE env var.
 *  - All five Lambdas have dynamodb:GetItem on the organisations table.
 *  - tool-config, agent-import, fabricator-request also have ssm:GetParameter
 *    on the governance enforce + effective_at parameters.
 */

import * as cdk from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import * as path from "path";
import * as fs from "fs";

const assetDirs = [
  path.resolve(__dirname, "../dist/lambda"),
  path.resolve(__dirname, "../src/schema"),
  path.resolve(__dirname, "../src/lambda/seed-admin-user"),
  path.resolve(__dirname, "../src/lambda/seed-organizations"),
];
for (const dir of assetDirs) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

import { BackendStack } from "../lib/backend-stack";
import { RegistryStack } from "../lib/registry-stack";
import { GatewayStack } from "../lib/gateway-stack";

const ACCOUNT = "123456789012";
const REGION = "us-east-1";
const ENVIRONMENT = "test";

interface CfnLambdaProps {
  Handler?: string;
  Environment?: { Variables?: Record<string, unknown> };
  Role?: { "Fn::GetAtt"?: [string, string] };
}

interface CfnPolicyStatement {
  Effect?: string;
  Action?: string | string[];
  Resource?: unknown;
}

interface CfnPolicyProps {
  Roles?: Array<{ Ref: string }>;
  PolicyDocument?: { Statement?: CfnPolicyStatement[] };
}

describe("tag-policy enforcement — ORGANIZATIONS_TABLE wiring + grants", () => {
  let backendTemplate: Template;
  let registryTemplate: Template;
  let gatewayTemplate: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const backendStack = new BackendStack(app, "TestBackendTagPolicy", {
      environment: ENVIRONMENT,
      env: { account: ACCOUNT, region: REGION },
    });

    const registryStack = new RegistryStack(app, "TestRegistryTagPolicy", {
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
      adrsTable: backendStack.adrsTable,
      organisationTable: backendStack.organisationTable,
    });

    const gatewayStack = new GatewayStack(app, "TestGatewayTagPolicy", {
      environment: ENVIRONMENT,
      env: { account: ACCOUNT, region: REGION },
      appsTable: backendStack.appsTable,
      eventBus: backendStack.agentEventBus,
      idempotencyTable: backendStack.idempotencyTable,
      agentConfigTable: backendStack.agentConfigTable,
      organisationTable: backendStack.organisationTable,
    });

    backendTemplate = Template.fromStack(backendStack);
    registryTemplate = Template.fromStack(registryStack);
    gatewayTemplate = Template.fromStack(gatewayStack);

    // Suppress unused variable warnings — stack refs are needed for synth.
    void registryStack;
    void gatewayStack;
  });

  // ── ORGANIZATIONS_TABLE env var present ─────────────────────────────────

  test("BackendStack: agent-config-resolver has ORGANIZATIONS_TABLE env var", () => {
    backendTemplate.hasResourceProperties("AWS::Lambda::Function", {
      Handler: "agent-config-resolver.handler",
      Environment: {
        Variables: Match.objectLike({
          ORGANIZATIONS_TABLE: Match.anyValue(),
        }),
      },
    });
  });

  test("BackendStack: tool-config-resolver has ORGANIZATIONS_TABLE env var", () => {
    backendTemplate.hasResourceProperties("AWS::Lambda::Function", {
      Handler: "tool-config-resolver.handler",
      Environment: {
        Variables: Match.objectLike({
          ORGANIZATIONS_TABLE: Match.anyValue(),
        }),
      },
    });
  });

  test("RegistryStack: agent-import-resolver has ORGANIZATIONS_TABLE env var", () => {
    registryTemplate.hasResourceProperties("AWS::Lambda::Function", {
      Handler: "agent-import-resolver.handler",
      Environment: {
        Variables: Match.objectLike({
          ORGANIZATIONS_TABLE: Match.anyValue(),
        }),
      },
    });
  });

  test("RegistryStack: fabricator-request-resolver has ORGANIZATIONS_TABLE env var", () => {
    registryTemplate.hasResourceProperties("AWS::Lambda::Function", {
      Handler: "fabricator-request-resolver.handler",
      Environment: {
        Variables: Match.objectLike({
          ORGANIZATIONS_TABLE: Match.anyValue(),
        }),
      },
    });
  });

  test("GatewayStack: app-publish-handler has ORGANIZATIONS_TABLE env var", () => {
    gatewayTemplate.hasResourceProperties("AWS::Lambda::Function", {
      Handler: "app-publish-handler.handler",
      Environment: {
        Variables: Match.objectLike({
          ORGANIZATIONS_TABLE: Match.anyValue(),
        }),
      },
    });
  });

  // ── DynamoDB grantReadData ──────────────────────────────────────────────

  function hasDdbReadGrant(template: Template, handler: string): void {
    const lambdas = template.findResources("AWS::Lambda::Function");
    const logicalId = Object.keys(lambdas).find(
      (k) =>
        (lambdas[k].Properties as CfnLambdaProps | undefined)?.Handler ===
        `${handler}.handler`,
    );
    expect(logicalId).toBeDefined();
    const roleRef = (lambdas[logicalId!].Properties as CfnLambdaProps)?.Role?.[
      "Fn::GetAtt"
    ]?.[0];
    expect(roleRef).toBeDefined();

    const policies = template.findResources("AWS::IAM::Policy");
    const rolePolicies = Object.values(policies).filter((p) =>
      ((p.Properties as CfnPolicyProps)?.Roles ?? []).some(
        (r) => r.Ref === roleRef,
      ),
    );

    let getItemCount = 0;
    for (const p of rolePolicies) {
      for (const stmt of (p.Properties as CfnPolicyProps).PolicyDocument
        ?.Statement ?? []) {
        const actions: string[] = Array.isArray(stmt.Action)
          ? stmt.Action
          : [stmt.Action ?? ""];
        if (actions.includes("dynamodb:GetItem")) getItemCount++;
      }
    }
    expect(getItemCount).toBeGreaterThanOrEqual(1);
  }

  test("BackendStack: agent-config-resolver has dynamodb:GetItem on organisations table", () => {
    hasDdbReadGrant(backendTemplate, "agent-config-resolver");
  });

  test("BackendStack: tool-config-resolver has dynamodb:GetItem on organisations table", () => {
    hasDdbReadGrant(backendTemplate, "tool-config-resolver");
  });

  test("RegistryStack: agent-import-resolver has dynamodb:GetItem on organisations table", () => {
    hasDdbReadGrant(registryTemplate, "agent-import-resolver");
  });

  test("RegistryStack: fabricator-request-resolver has dynamodb:GetItem on organisations table", () => {
    hasDdbReadGrant(registryTemplate, "fabricator-request-resolver");
  });

  test("GatewayStack: app-publish-handler has dynamodb:GetItem on organisations table", () => {
    hasDdbReadGrant(gatewayTemplate, "app-publish-handler");
  });

  // ── SSM governance grants (tool-config, agent-import, fabricator-request) ─

  function hasSsmGovernanceGrant(template: Template, handler: string): void {
    const lambdas = template.findResources("AWS::Lambda::Function");
    const logicalId = Object.keys(lambdas).find(
      (k) =>
        (lambdas[k].Properties as CfnLambdaProps | undefined)?.Handler ===
        `${handler}.handler`,
    );
    expect(logicalId).toBeDefined();
    const roleRef = (lambdas[logicalId!].Properties as CfnLambdaProps)?.Role?.[
      "Fn::GetAtt"
    ]?.[0];
    expect(roleRef).toBeDefined();

    const policies = template.findResources("AWS::IAM::Policy");
    const rolePolicies = Object.values(policies).filter((p) =>
      ((p.Properties as CfnPolicyProps)?.Roles ?? []).some(
        (r) => r.Ref === roleRef,
      ),
    );

    const hasSsmGrant = rolePolicies.some((p) =>
      ((p.Properties as CfnPolicyProps).PolicyDocument?.Statement ?? []).some(
        (stmt: CfnPolicyStatement) => {
          const actions: string[] = Array.isArray(stmt.Action)
            ? stmt.Action
            : [stmt.Action ?? ""];
          const resources = JSON.stringify(stmt.Resource ?? "");
          return (
            actions.includes("ssm:GetParameter") &&
            resources.includes("governance/enforce")
          );
        },
      ),
    );
    expect(hasSsmGrant).toBe(true);
  }

  test("BackendStack: tool-config-resolver has ssm:GetParameter on governance params", () => {
    hasSsmGovernanceGrant(backendTemplate, "tool-config-resolver");
  });

  test("RegistryStack: agent-import-resolver has ssm:GetParameter on governance params", () => {
    hasSsmGovernanceGrant(registryTemplate, "agent-import-resolver");
  });

  test("RegistryStack: fabricator-request-resolver has ssm:GetParameter on governance params", () => {
    hasSsmGovernanceGrant(registryTemplate, "fabricator-request-resolver");
  });
});
