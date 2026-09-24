/**
 * Unit tests for RegistryService.submitForApproval (finding adde5b79).
 *
 * The AWS registry rejects a direct UpdateRegistryRecordStatus(DRAFT ->
 * APPROVED) call. The sanctioned activation path is
 * SubmitRegistryRecordForApproval, which auto-advances to APPROVED when the
 * registry has autoApproval configured, else lands on PENDING_APPROVAL.
 */
import {
  AgentRegistryControlClient,
  SubmitRegistryRecordForApprovalCommand,
  GetRegistryRecordCommand,
  UpdateRegistryRecordStatusCommand,
} from "@aws-sdk/client-agent-registry-control";
import { mockClient } from "aws-sdk-client-mock";
import { RegistryService } from "../registry-service";

const sdkMock = mockClient(AgentRegistryControlClient);

describe("RegistryService.submitForApproval", () => {
  let service: RegistryService;

  beforeEach(() => {
    sdkMock.reset();
    service = new RegistryService({
      registryId: "test-registry",
      region: "us-east-1",
    });
  });

  it("issues SubmitRegistryRecordForApprovalCommand with the registryId and recordId", async () => {
    sdkMock.on(SubmitRegistryRecordForApprovalCommand).resolves({
      recordId: "agent-1",
      status: "PENDING_APPROVAL",
    });
    sdkMock.on(GetRegistryRecordCommand).resolves({
      recordId: "agent-1",
      name: "Agent One",
      status: "PENDING_APPROVAL",
    });

    await service.submitForApproval("agent-1");

    const calls = sdkMock.commandCalls(SubmitRegistryRecordForApprovalCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0].input).toEqual({
      registryId: "test-registry",
      recordId: "agent-1",
    });
  });

  it("never issues a direct UpdateRegistryRecordStatus(APPROVED) call", async () => {
    sdkMock.on(SubmitRegistryRecordForApprovalCommand).resolves({
      recordId: "agent-1",
      status: "APPROVED",
    });
    sdkMock.on(GetRegistryRecordCommand).resolves({
      recordId: "agent-1",
      status: "APPROVED",
    });

    await service.submitForApproval("agent-1");

    expect(
      sdkMock.commandCalls(UpdateRegistryRecordStatusCommand),
    ).toHaveLength(0);
  });

  it("re-fetches the record and returns APPROVED when the registry has autoApproval", async () => {
    sdkMock.on(SubmitRegistryRecordForApprovalCommand).resolves({
      recordId: "agent-1",
      status: "APPROVED",
    });
    sdkMock.on(GetRegistryRecordCommand).resolves({
      recordId: "agent-1",
      name: "Agent One",
      status: "APPROVED",
    });

    const result = await service.submitForApproval("agent-1");

    expect(result.status).toBe("APPROVED");
    expect(sdkMock.commandCalls(GetRegistryRecordCommand)).toHaveLength(1);
  });

  it("surfaces PENDING_APPROVAL when the registry does not auto-approve", async () => {
    sdkMock.on(SubmitRegistryRecordForApprovalCommand).resolves({
      recordId: "agent-1",
      status: "PENDING_APPROVAL",
    });
    sdkMock.on(GetRegistryRecordCommand).resolves({
      recordId: "agent-1",
      name: "Agent One",
      status: "PENDING_APPROVAL",
    });

    const result = await service.submitForApproval("agent-1");

    expect(result.status).toBe("PENDING_APPROVAL");
  });

  it("propagates a rejection when the registry refuses the submit", async () => {
    sdkMock
      .on(SubmitRegistryRecordForApprovalCommand)
      .rejects(new Error("ValidationException: Invalid target status"));

    await expect(service.submitForApproval("agent-1")).rejects.toThrow(
      "ValidationException",
    );
    // Never falls through to re-fetch/return a stale record on failure.
    expect(sdkMock.commandCalls(GetRegistryRecordCommand)).toHaveLength(0);
  });
});
