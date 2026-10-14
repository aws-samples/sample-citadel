/**
 * Guard: every `XCommand` imported from `@aws-sdk/client-agent-registry-control`
 * in the registry provisioner lambda MUST have a corresponding
 * `agent-registry:X` IAM action in the provisioner role's policy.
 *
 * Catches drift between the SDK calls the handler makes and the IAM grants
 * the stack provisions — the root cause of the UPDATE_FAILED rollback that
 * prompted this file (UpdateRegistry was called but never granted).
 */
import * as cdk from "aws-cdk-lib";
import * as path from "path";
import * as fs from "fs";

// Ensure asset directories exist for CDK synthesis
const assetDirs = [
  path.resolve(__dirname, "../src/schema"),
  path.resolve(__dirname, "../dist/lambda"),
  path.resolve(__dirname, "../src/lambda/seed-admin-user"),
  path.resolve(__dirname, "../src/lambda/seed-organizations"),
];
for (const dir of assetDirs) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

import { BackendStack } from "../lib/backend-stack";

/** Parse `XCommand` identifiers imported from the agent-registry SDK. */
function parseAgentRegistryCommands(filePath: string): string[] {
  const source = fs.readFileSync(filePath, "utf-8");

  // Match the import block from @aws-sdk/client-agent-registry-control
  const importMatch = source.match(
    /import\s*\{([^}]+)\}\s*from\s*["']@aws-sdk\/client-agent-registry-control["']/s,
  );
  if (!importMatch) {
    throw new Error(
      `No import from @aws-sdk/client-agent-registry-control found in ${filePath}`,
    );
  }

  const importBlock = importMatch[1];
  const commands: string[] = [];
  for (const token of importBlock.split(",")) {
    const trimmed = token.trim();
    if (trimmed.endsWith("Command")) {
      // Strip "Command" suffix → IAM action name
      commands.push(trimmed.replace(/Command$/, ""));
    }
  }
  return commands;
}

/** Collect all IAM actions from every policy attached to the provisioner role. */
function collectProvisionerActions(
  template: ReturnType<cdk.assertions.Template["toJSON"]>,
): Set<string> {
  const resources = (
    template as {
      Resources: Record<
        string,
        { Type: string; Properties?: Record<string, unknown> }
      >;
    }
  ).Resources;

  // Find the provisioner role logical ID
  const provisionerRoleLogicalId = Object.keys(resources).find(
    (id) =>
      id.startsWith("RegistryProvisionerFunction") &&
      resources[id].Type === "AWS::IAM::Role",
  );
  if (!provisionerRoleLogicalId) {
    throw new Error(
      "RegistryProvisionerFunction IAM role not found in template",
    );
  }

  // Find all AWS::IAM::Policy resources attached to this role
  const actions = new Set<string>();
  for (const [, resource] of Object.entries(resources)) {
    if (resource.Type !== "AWS::IAM::Policy") continue;
    const props = resource.Properties as {
      Roles?: Array<{ Ref?: string }>;
      PolicyDocument?: { Statement?: Array<{ Action?: string | string[] }> };
    };
    const attachedToRole = props?.Roles?.some(
      (r) => r.Ref === provisionerRoleLogicalId,
    );
    if (!attachedToRole) continue;

    for (const stmt of props?.PolicyDocument?.Statement ?? []) {
      const stmtActions = Array.isArray(stmt.Action)
        ? stmt.Action
        : stmt.Action
          ? [stmt.Action]
          : [];
      for (const a of stmtActions) {
        actions.add(a);
      }
    }
  }

  return actions;
}

describe("registry-provisioner IAM parity guard", () => {
  const provisionerSource = path.resolve(
    __dirname,
    "../src/lambda/registry-provisioner.ts",
  );

  const requiredActions = parseAgentRegistryCommands(provisionerSource);

  let grantedActions: Set<string>;

  beforeAll(() => {
    const app = new cdk.App();
    const stack = new BackendStack(app, "TestRegistryIamParity", {
      environment: "test",
      env: { account: "123456789012", region: "us-east-1" },
    });
    const template = cdk.assertions.Template.fromStack(stack).toJSON();
    grantedActions = collectProvisionerActions(template);
  });

  test("at least one agent-registry Command is parsed from the provisioner source", () => {
    expect(requiredActions.length).toBeGreaterThanOrEqual(1);
  });

  test("every agent-registry SDK Command has a matching IAM action in the provisioner policy", () => {
    const missing: string[] = [];
    for (const action of requiredActions) {
      const iamAction = `agent-registry:${action}`;
      if (!grantedActions.has(iamAction)) {
        missing.push(iamAction);
      }
    }
    expect(missing).toEqual([]);
  });
});
