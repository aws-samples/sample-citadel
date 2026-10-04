/**
 * CIT-042 PR3 — Tag propagation tests for PolicyManager.
 *
 * Covers: CreateRole Tags merge (org + agent + policy tags), IAM tag cap (50),
 * sanitisation, tagExistingRole prefix guard, and TagRoleCommand dispatch.
 */

import {
  IAMClient,
  CreateRoleCommand,
  PutRolePolicyCommand,
  TagRoleCommand,
} from "@aws-sdk/client-iam";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { mockClient } from "aws-sdk-client-mock";
import { PolicyManager } from "../policy-manager";

const iamMock = mockClient(IAMClient);
const stsMock = mockClient(STSClient);

describe("PolicyManager tag propagation (CIT-042)", () => {
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

  const basePolicies = [{ actions: ["bedrock:InvokeModel"], resources: ["*"] }];

  describe("ensureRole with resourceTags", () => {
    test("CreateRole Tags include citadel:org and citadel:agent for agent scope", async () => {
      await manager.ensureRole(
        "agent-1",
        basePolicies,
        "123456789012",
        "agent",
        undefined,
        undefined,
        undefined,
        { orgId: "org-abc", agentId: "agent-1" },
      );

      const createCalls = iamMock.commandCalls(CreateRoleCommand);
      expect(createCalls).toHaveLength(1);
      const tags = createCalls[0].args[0].input.Tags!;
      expect(tags).toEqual(
        expect.arrayContaining([
          { Key: "ManagedBy", Value: "citadel" },
          { Key: "ResourceId", Value: "agent-1" },
          { Key: "Scope", Value: "agent" },
          { Key: "citadel:org", Value: "org-abc" },
          { Key: "citadel:agent", Value: "agent-1" },
        ]),
      );
    });

    test("CreateRole Tags include citadel:datastore for datastore scope", async () => {
      await manager.ensureRole(
        "ds-1",
        basePolicies,
        "123456789012",
        "datastore",
        undefined,
        undefined,
        undefined,
        { orgId: "org-abc", agentId: "ds-1" },
      );

      const tags =
        iamMock.commandCalls(CreateRoleCommand)[0].args[0].input.Tags!;
      expect(tags).toEqual(
        expect.arrayContaining([{ Key: "citadel:datastore", Value: "ds-1" }]),
      );
    });

    test("CreateRole Tags include citadel:integration for integration scope", async () => {
      await manager.ensureRole(
        "int-1",
        basePolicies,
        "123456789012",
        "integration",
        undefined,
        undefined,
        undefined,
        { orgId: "org-abc", agentId: "int-1" },
      );

      const tags =
        iamMock.commandCalls(CreateRoleCommand)[0].args[0].input.Tags!;
      expect(tags).toEqual(
        expect.arrayContaining([
          { Key: "citadel:integration", Value: "int-1" },
        ]),
      );
    });

    test("CreateRole Tags include user-defined policy tags", async () => {
      await manager.ensureRole(
        "agent-2",
        basePolicies,
        "123456789012",
        "agent",
        undefined,
        undefined,
        undefined,
        {
          orgId: "org-abc",
          agentId: "agent-2",
          tags: { team: "ml", department: "research" },
        },
      );

      const tags =
        iamMock.commandCalls(CreateRoleCommand)[0].args[0].input.Tags!;
      expect(tags).toEqual(
        expect.arrayContaining([
          { Key: "team", Value: "ml" },
          { Key: "department", Value: "research" },
        ]),
      );
    });

    test("tags are capped at IAM limit of 50", async () => {
      const manyTags: Record<string, string> = {};
      for (let i = 0; i < 55; i++) {
        manyTags[`tag-${i}`] = `value-${i}`;
      }

      await manager.ensureRole(
        "agent-3",
        basePolicies,
        "123456789012",
        "agent",
        undefined,
        undefined,
        undefined,
        { orgId: "org-abc", agentId: "agent-3", tags: manyTags },
      );

      const tags =
        iamMock.commandCalls(CreateRoleCommand)[0].args[0].input.Tags!;
      expect(tags.length).toBeLessThanOrEqual(50);
    });

    test("tags with invalid characters are dropped", async () => {
      const consoleSpy = jest
        .spyOn(console, "warn")
        .mockImplementation(() => {});

      await manager.ensureRole(
        "agent-4",
        basePolicies,
        "123456789012",
        "agent",
        undefined,
        undefined,
        undefined,
        {
          tags: {
            "valid-key": "valid-value",
            "invalid\x00key": "value",
          },
        },
      );

      const tags =
        iamMock.commandCalls(CreateRoleCommand)[0].args[0].input.Tags!;
      expect(tags.find((t) => t.Key === "valid-key")).toBeDefined();
      expect(tags.find((t) => t.Key === "invalid\x00key")).toBeUndefined();
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("dropped tag"),
      );

      consoleSpy.mockRestore();
    });

    test("duplicate system keys from user tags are not added", async () => {
      await manager.ensureRole(
        "agent-5",
        basePolicies,
        "123456789012",
        "agent",
        undefined,
        undefined,
        undefined,
        {
          orgId: "org-abc",
          tags: { ManagedBy: "user-override" },
        },
      );

      const tags =
        iamMock.commandCalls(CreateRoleCommand)[0].args[0].input.Tags!;
      const managedByTags = tags.filter((t) => t.Key === "ManagedBy");
      expect(managedByTags).toHaveLength(1);
      expect(managedByTags[0].Value).toBe("citadel");
    });

    test("backward compatible: no resourceTags still produces 3 base tags", async () => {
      await manager.ensureRole(
        "agent-6",
        basePolicies,
        "123456789012",
        "agent",
      );

      const tags =
        iamMock.commandCalls(CreateRoleCommand)[0].args[0].input.Tags!;
      expect(tags).toHaveLength(3);
      expect(tags).toEqual([
        { Key: "ManagedBy", Value: "citadel" },
        { Key: "ResourceId", Value: "agent-6" },
        { Key: "Scope", Value: "agent" },
      ]);
    });
  });

  describe("tagExistingRole", () => {
    test("sends TagRoleCommand with sanitised tags", async () => {
      iamMock.on(TagRoleCommand).resolves({});

      await manager.tagExistingRole("citadel-agent-agent-1", {
        team: "ml",
        env: "prod",
      });

      const tagCalls = iamMock.commandCalls(TagRoleCommand);
      expect(tagCalls).toHaveLength(1);
      expect(tagCalls[0].args[0].input.RoleName).toBe("citadel-agent-agent-1");
      expect(tagCalls[0].args[0].input.Tags).toEqual(
        expect.arrayContaining([
          { Key: "team", Value: "ml" },
          { Key: "env", Value: "prod" },
        ]),
      );
    });

    test("refuses non-vended role name prefixes", async () => {
      await expect(
        manager.tagExistingRole("some-random-role", { team: "ml" }),
      ).rejects.toThrow(/refusing to tag role/);
    });

    test("allows citadel-ds- prefix", async () => {
      iamMock.on(TagRoleCommand).resolves({});
      await expect(
        manager.tagExistingRole("citadel-ds-ds-1", { team: "ml" }),
      ).resolves.not.toThrow();
    });

    test("allows citadel-int- prefix", async () => {
      iamMock.on(TagRoleCommand).resolves({});
      await expect(
        manager.tagExistingRole("citadel-int-int-1", { team: "ml" }),
      ).resolves.not.toThrow();
    });

    test("swallows NoSuchEntityException", async () => {
      const err = new Error("NoSuchEntity");
      err.name = "NoSuchEntityException";
      iamMock.on(TagRoleCommand).rejects(err);

      await expect(
        manager.tagExistingRole("citadel-agent-agent-1", { team: "ml" }),
      ).resolves.not.toThrow();
    });

    test("rethrows non-NoSuchEntity errors", async () => {
      const err = new Error("AccessDenied");
      err.name = "AccessDeniedException";
      iamMock.on(TagRoleCommand).rejects(err);

      await expect(
        manager.tagExistingRole("citadel-agent-agent-1", { team: "ml" }),
      ).rejects.toThrow(/Failed to tag IAM role/);
    });

    test("skips TagRoleCommand when no valid tags remain after sanitisation", async () => {
      iamMock.on(TagRoleCommand).resolves({});

      await manager.tagExistingRole("citadel-agent-agent-1", {
        "invalid\x00": "value",
      });

      const tagCalls = iamMock.commandCalls(TagRoleCommand);
      expect(tagCalls).toHaveLength(0);
    });
  });
});
