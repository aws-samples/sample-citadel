/**
 * Unit tests for registry-provisioner.ts (CDK custom resource) against the
 * GA agent-registry-control namespace:
 * - Create: sends CreateRegistryCommand with approvalConfiguration.autoApprovalRules
 *   (APPROVE_ALL for dev auto-approve-all; undefined when AutoApproval='false')
 *   instead of the old boolean autoApproval flag, and preserves the
 *   RegistryArn/RegistryId response attribute NAMES.
 * - Create conflict: falls back to ListRegistriesCommand lookup.
 * - Update: re-uses an alive registry; recreates on a dead one.
 * - Delete: checks ListRegistryRecordsCommand first — RETAINS a registry
 *   that still has records (SUCCESS without DeleteRegistryCommand, finding
 *   8b7ee8af delete-safety); only an empty registry is deleted, tolerating
 *   already-deleted.
 */
import {
  AgentRegistryControlClient,
  CreateRegistryCommand,
  DeleteRegistryCommand,
  GetRegistryCommand,
  ListRegistriesCommand,
  ListRegistryRecordsCommand,
  AutoApprovalRule,
} from "@aws-sdk/client-agent-registry-control";
import { mockClient } from "aws-sdk-client-mock";
import type { CloudFormationCustomResourceEvent } from "aws-lambda";
import { handler } from "../registry-provisioner";

const sdkMock = mockClient(AgentRegistryControlClient);

const fetchMock = jest.fn().mockResolvedValue({ ok: true });

function baseEvent(
  overrides: Partial<CloudFormationCustomResourceEvent>,
): CloudFormationCustomResourceEvent {
  return {
    ServiceToken: "arn:aws:lambda:us-east-1:123:function:provisioner",
    ResponseURL: "https://example.com/cfn-response",
    StackId: "stack-1",
    RequestId: "req-1",
    LogicalResourceId: "RegistryResource",
    ResourceType: "Custom::AgentRegistry",
    ResourceProperties: {
      ServiceToken: "arn:aws:lambda:us-east-1:123:function:provisioner",
      RegistryName: "citadel-registry-dev",
      AutoApproval: "true",
    },
    ...overrides,
  } as CloudFormationCustomResourceEvent;
}

describe("registry-provisioner handler", () => {
  beforeEach(() => {
    sdkMock.reset();
    fetchMock.mockClear();
    (global as { fetch?: typeof fetch }).fetch =
      fetchMock as unknown as typeof fetch;
    jest.spyOn(console, "log").mockImplementation(() => {});
    jest.spyOn(console, "warn").mockImplementation(() => {});
    jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("Create", () => {
    it("sends CreateRegistryCommand with approvalConfiguration.autoApprovalRules=[APPROVE_ALL] when AutoApproval=true", async () => {
      sdkMock.on(CreateRegistryCommand).resolves({
        registryArn: "arn:aws:agent-registry:us-east-1:123:registry/reg-abc123",
      });

      const event = baseEvent({
        RequestType: "Create",
      } as Partial<CloudFormationCustomResourceEvent>);
      await handler(event);

      const calls = sdkMock.commandCalls(CreateRegistryCommand);
      expect(calls).toHaveLength(1);
      expect(calls[0].args[0].input).toEqual({
        name: "citadel-registry-dev",
        description: undefined,
        approvalConfiguration: {
          autoApprovalRules: [AutoApprovalRule.APPROVE_ALL],
        },
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.Status).toBe("SUCCESS");
      // Response attribute NAMES preserved so backend-stack's getAttString keeps working.
      expect(body.Data).toEqual({
        RegistryArn: "arn:aws:agent-registry:us-east-1:123:registry/reg-abc123",
        RegistryId: "reg-abc123",
      });
    });

    it("sends approvalConfiguration.autoApprovalRules=undefined when AutoApproval=false", async () => {
      sdkMock.on(CreateRegistryCommand).resolves({
        registryArn: "arn:aws:agent-registry:us-east-1:123:registry/reg-def456",
      });

      const event = baseEvent({
        RequestType: "Create",
        ResourceProperties: {
          ServiceToken: "arn:aws:lambda:us-east-1:123:function:provisioner",
          RegistryName: "citadel-registry-prod",
          AutoApproval: "false",
        },
      } as Partial<CloudFormationCustomResourceEvent>);
      await handler(event);

      const calls = sdkMock.commandCalls(CreateRegistryCommand);
      expect(calls[0].args[0].input.approvalConfiguration).toEqual({
        autoApprovalRules: undefined,
      });
    });

    it("falls back to ListRegistriesCommand on ConflictException and reuses the existing registryArn", async () => {
      const conflictErr = new Error("exists") as Error & { name: string };
      conflictErr.name = "ConflictException";
      sdkMock.on(CreateRegistryCommand).rejects(conflictErr);
      sdkMock.on(ListRegistriesCommand).resolves({
        registries: [
          {
            name: "other-registry",
            registryArn: "arn:aws:agent-registry:us-east-1:123:registry/other",
            registryId: "other",
          },
          {
            name: "citadel-registry-dev",
            registryArn:
              "arn:aws:agent-registry:us-east-1:123:registry/reg-existing",
            registryId: "reg-existing",
          },
        ],
      });

      const event = baseEvent({
        RequestType: "Create",
      } as Partial<CloudFormationCustomResourceEvent>);
      await handler(event);

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.Status).toBe("SUCCESS");
      expect(body.Data.RegistryArn).toBe(
        "arn:aws:agent-registry:us-east-1:123:registry/reg-existing",
      );
    });
  });

  describe("Update", () => {
    it("reuses an alive registry without calling CreateRegistryCommand", async () => {
      sdkMock.on(GetRegistryCommand).resolves({ status: "READY" } as never);

      const event = baseEvent({
        RequestType: "Update",
        PhysicalResourceId:
          "arn:aws:agent-registry:us-east-1:123:registry/reg-live",
      } as Partial<CloudFormationCustomResourceEvent>);
      await handler(event);

      expect(sdkMock.commandCalls(CreateRegistryCommand)).toHaveLength(0);
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.Status).toBe("SUCCESS");
      expect(body.Data.RegistryId).toBe("reg-live");
    });

    it("recreates via CreateRegistryCommand with autoApprovalRules when the existing registry is gone", async () => {
      sdkMock.on(GetRegistryCommand).rejects(new Error("not found"));
      sdkMock.on(CreateRegistryCommand).resolves({
        registryArn: "arn:aws:agent-registry:us-east-1:123:registry/reg-new",
      });

      const event = baseEvent({
        RequestType: "Update",
        PhysicalResourceId:
          "arn:aws:agent-registry:us-east-1:123:registry/reg-dead",
      } as Partial<CloudFormationCustomResourceEvent>);
      await handler(event);

      const calls = sdkMock.commandCalls(CreateRegistryCommand);
      expect(calls[0].args[0].input.approvalConfiguration).toEqual({
        autoApprovalRules: [AutoApprovalRule.APPROVE_ALL],
      });
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.Data.RegistryId).toBe("reg-new");
    });
  });

  describe("Delete", () => {
    it("retains a registry that still has records: no DeleteRegistryCommand, reports SUCCESS", async () => {
      sdkMock.on(ListRegistryRecordsCommand).resolves({
        registryRecords: [{ registryRecordId: "rec-1" }] as never,
      });
      sdkMock.on(DeleteRegistryCommand).resolves({});

      const event = baseEvent({
        RequestType: "Delete",
        PhysicalResourceId:
          "arn:aws:agent-registry:us-east-1:123:registry/reg-populated",
      } as Partial<CloudFormationCustomResourceEvent>);
      await handler(event);

      expect(sdkMock.commandCalls(ListRegistryRecordsCommand)).toHaveLength(1);
      expect(
        sdkMock.commandCalls(ListRegistryRecordsCommand)[0].args[0].input,
      ).toEqual({ registryId: "reg-populated", maxResults: 1 });
      expect(sdkMock.commandCalls(DeleteRegistryCommand)).toHaveLength(0);
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.Status).toBe("SUCCESS");
    });

    it("sends DeleteRegistryCommand and reports SUCCESS when the registry has zero records", async () => {
      sdkMock.on(ListRegistryRecordsCommand).resolves({ registryRecords: [] });
      sdkMock.on(DeleteRegistryCommand).resolves({});

      const event = baseEvent({
        RequestType: "Delete",
        PhysicalResourceId:
          "arn:aws:agent-registry:us-east-1:123:registry/reg-todelete",
      } as Partial<CloudFormationCustomResourceEvent>);
      await handler(event);

      const calls = sdkMock.commandCalls(DeleteRegistryCommand);
      expect(calls).toHaveLength(1);
      expect(calls[0].args[0].input).toEqual({ registryId: "reg-todelete" });
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.Status).toBe("SUCCESS");
    });

    it("tolerates an already-deleted registry (ResourceNotFoundException) without failing", async () => {
      sdkMock.on(ListRegistryRecordsCommand).resolves({ registryRecords: [] });
      const err = new Error("gone") as Error & { name: string };
      err.name = "ResourceNotFoundException";
      sdkMock.on(DeleteRegistryCommand).rejects(err);

      const event = baseEvent({
        RequestType: "Delete",
        PhysicalResourceId:
          "arn:aws:agent-registry:us-east-1:123:registry/reg-gone",
      } as Partial<CloudFormationCustomResourceEvent>);
      await handler(event);

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.Status).toBe("SUCCESS");
    });
  });
});
