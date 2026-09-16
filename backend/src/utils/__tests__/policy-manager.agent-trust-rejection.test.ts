/**
 * Wave 2b (branch fix/vender-org-scoping), scope (3): CDK regression variant
 * B -- ds/int scoped roles are created at RUNTIME by
 * PolicyManager.ensureRole, not by CDK, so the regression guard is a unit
 * test on ensureRole's trust-policy construction rather than a CDK
 * template assertion.
 *
 * Asserts the trust principal is EXACTLY the creating Lambda role plus any
 * explicitly supplied principals (crossArn / additionalTrustedPrincipals),
 * and that a citadel-agent-* principal is REJECTED even when passed via
 * additionalTrustedPrincipals -- ds/int roles must never trust an agent
 * role directly; agents only reach ds/int credentials through the
 * credential vender's own AssumeRole grant (computeAgentPolicies), never
 * through the ds/int role's trust policy.
 */

import {
  IAMClient,
  CreateRoleCommand,
  PutRolePolicyCommand,
} from "@aws-sdk/client-iam";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { mockClient } from "aws-sdk-client-mock";

import { PolicyManager } from "../policy-manager";

const iamMock = mockClient(IAMClient);
const stsMock = mockClient(STSClient);

describe("PolicyManager.ensureRole -- citadel-agent-* trust rejection", () => {
  let manager: PolicyManager;

  beforeEach(() => {
    iamMock.reset();
    stsMock.reset();
    stsMock.on(GetCallerIdentityCommand).resolves({
      Account: "123456789012",
      Arn: "arn:aws:sts::123456789012:assumed-role/LambdaRole/session",
    });
    iamMock.on(CreateRoleCommand).resolves({});
    iamMock.on(PutRolePolicyCommand).resolves({});
    manager = new PolicyManager();
  });

  test("trust principal is exactly the creating Lambda role when no extra principals supplied", async () => {
    await manager.ensureRole(
      "ds-1",
      [{ actions: ["s3:GetObject"], resources: ["*"] }],
      "123456789012",
      "datastore",
    );

    const createCalls = iamMock.commandCalls(CreateRoleCommand);
    const trustDoc = JSON.parse(
      createCalls[0].args[0].input.AssumeRolePolicyDocument as string,
    );
    expect(trustDoc.Statement[0].Principal.AWS).toBe(
      "arn:aws:iam::123456789012:role/LambdaRole",
    );
  });

  test("trust principal includes an explicitly supplied crossArn", async () => {
    await manager.ensureRole(
      "int-1",
      [{ actions: ["s3:GetObject"], resources: ["*"] }],
      "123456789012",
      "integration",
      "arn:aws:iam::999999999999:role/CrossAccountRole",
    );

    const createCalls = iamMock.commandCalls(CreateRoleCommand);
    const trustDoc = JSON.parse(
      createCalls[0].args[0].input.AssumeRolePolicyDocument as string,
    );
    expect(trustDoc.Statement[0].Principal.AWS).toEqual([
      "arn:aws:iam::123456789012:role/LambdaRole",
      "arn:aws:iam::999999999999:role/CrossAccountRole",
    ]);
  });

  test("trust principal includes an explicitly supplied non-agent additionalTrustedPrincipal", async () => {
    await manager.ensureRole(
      "ds-2",
      [{ actions: ["s3:GetObject"], resources: ["*"] }],
      "123456789012",
      "datastore",
      undefined,
      ["arn:aws:iam::123456789012:role/HealthMonitorRole"],
    );

    const createCalls = iamMock.commandCalls(CreateRoleCommand);
    const trustDoc = JSON.parse(
      createCalls[0].args[0].input.AssumeRolePolicyDocument as string,
    );
    expect(trustDoc.Statement[0].Principal.AWS).toEqual([
      "arn:aws:iam::123456789012:role/LambdaRole",
      "arn:aws:iam::123456789012:role/HealthMonitorRole",
    ]);
  });

  test("rejects a citadel-agent-* principal passed via additionalTrustedPrincipals for a datastore role", async () => {
    await expect(
      manager.ensureRole(
        "ds-3",
        [{ actions: ["s3:GetObject"], resources: ["*"] }],
        "123456789012",
        "datastore",
        undefined,
        ["arn:aws:iam::123456789012:role/citadel-agent-evil"],
      ),
    ).rejects.toThrow(/citadel-agent-/);

    // Never reaches CreateRole -- the rejection happens before any IAM call.
    expect(iamMock.commandCalls(CreateRoleCommand)).toHaveLength(0);
  });

  test("rejects a citadel-agent-* principal passed via additionalTrustedPrincipals for an integration role", async () => {
    await expect(
      manager.ensureRole(
        "int-2",
        [{ actions: ["s3:GetObject"], resources: ["*"] }],
        "123456789012",
        "integration",
        undefined,
        ["arn:aws:iam::123456789012:role/citadel-agent-evil"],
      ),
    ).rejects.toThrow(/citadel-agent-/);

    expect(iamMock.commandCalls(CreateRoleCommand)).toHaveLength(0);
  });

  test("rejects when a citadel-agent-* principal is mixed in among otherwise-valid principals", async () => {
    await expect(
      manager.ensureRole(
        "ds-4",
        [{ actions: ["s3:GetObject"], resources: ["*"] }],
        "123456789012",
        "datastore",
        undefined,
        [
          "arn:aws:iam::123456789012:role/HealthMonitorRole",
          "arn:aws:iam::123456789012:role/citadel-agent-sneaky",
        ],
      ),
    ).rejects.toThrow(/citadel-agent-/);

    expect(iamMock.commandCalls(CreateRoleCommand)).toHaveLength(0);
  });

  test("does not reject citadel-agent-* trust when creating an agent-scoped role itself", async () => {
    // The rejection is specific to ds/int scopes trusting an agent
    // principal; an agent role legitimately being created is unaffected.
    await expect(
      manager.ensureRole(
        "agent-9",
        [{ actions: ["bedrock:InvokeModel"], resources: ["*"] }],
        "123456789012",
        "agent",
        undefined,
        ["arn:aws:iam::123456789012:role/citadel-agent-other"],
      ),
    ).resolves.not.toThrow();
  });
});
