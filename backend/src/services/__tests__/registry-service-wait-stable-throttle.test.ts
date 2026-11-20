/**
 * Regression tests for the registry-throttle-resume incident: the live
 * canary (`--correct-fabricator-shared --apply --limit 3 --fallback-org
 * Default`) hit UpdateRegistryRecord succeeding, then the post-write
 * waitForStableState poll (a raw GetRegistryRecordCommand with no retry
 * wrapper) throwing ThrottlingException and aborting updateResource before
 * the approval-restoration steps ever ran.
 *
 * waitForStableState is private; it is exercised here only indirectly via
 * updateResource (the only caller that reaches it from an UPDATING/CREATING
 * post-write state), matching the convention already used by
 * registry-service-crud.test.ts's "settles UPDATING to DRAFT" case.
 */
import {
  AgentRegistryControlClient,
  GetRegistryRecordCommand,
  UpdateRegistryRecordCommand,
  RecordType,
} from "@aws-sdk/client-agent-registry-control";
import { mockClient } from "aws-sdk-client-mock";
import { RegistryService } from "../registry-service";

const sdkMock = mockClient(AgentRegistryControlClient);

describe("RegistryService.updateResource — waitForStableState throttle resilience", () => {
  let service: RegistryService;

  beforeEach(() => {
    sdkMock.reset();
    service = new RegistryService({
      registryId: "test-registry",
      region: "us-east-1",
    });
  });

  it("retries a ThrottlingException thrown by the post-write stabilization poll instead of letting it abort updateResource", async () => {
    sdkMock.on(UpdateRegistryRecordCommand).resolves({
      recordId: "synthetic-agent-1",
      name: "SyntheticAgent",
      status: "UPDATING",
      recordType: RecordType.CUSTOM,
      descriptors: { custom: { data: '{"manifest":{}}' } },
    });

    // First stabilization poll throws the exact error shape observed in
    // the incident log ("Request rate exceeded. Please retry after some
    // time." under name ThrottlingException); the next poll succeeds and
    // reports the settled DRAFT status; the final re-fetch returns the
    // settled record.
    const throttleErr = Object.assign(
      new Error("Request rate exceeded. Please retry after some time."),
      { name: "ThrottlingException" },
    );
    sdkMock
      .on(GetRegistryRecordCommand)
      .rejectsOnce(throttleErr)
      .resolvesOnce({
        recordId: "synthetic-agent-1",
        name: "SyntheticAgent",
        status: "DRAFT",
        recordType: RecordType.CUSTOM,
        descriptors: { custom: { data: '{"manifest":{}}' } },
      })
      .resolvesOnce({
        recordId: "synthetic-agent-1",
        name: "SyntheticAgent",
        status: "DRAFT",
        recordType: RecordType.CUSTOM,
        descriptors: { custom: { data: '{"manifest":{}}' } },
      });

    const result = await service.updateResource("agent", "synthetic-agent-1", {
      description: "marker edit",
    });

    expect(result.status).toBe("DRAFT");
    // 1 throttled attempt (retried, not thrown) + 1 settled-state poll +
    // 1 final re-fetch = 3 GetRegistryRecordCommand calls.
    expect(sdkMock.commandCalls(GetRegistryRecordCommand)).toHaveLength(3);
  });

  it("surfaces exhausted retries on a persistently throttled stabilization poll as settleFailed instead of throwing and abandoning the record", async () => {
    // LIVE INCIDENT 2026-11-20: this test previously asserted the opposite
    // contract — that updateResource THROWS when the post-write settle
    // poll exhausts retries. That throw is exactly what the incident
    // showed to be wrong: the write (UpdateRegistryRecord) had already
    // landed, and letting the throw propagate aborted updateResource
    // before the marker-edit/corrective path's approval-restoration steps
    // (submitForApproval/decide) ever ran, leaving the record DRAFT with
    // no retry and no bucketing. The correct contract is: never throw once
    // the write has landed — return the record with `settleFailed: true`
    // so the caller can still attempt approval restoration and bucket a
    // further failure into `needsReapproval` (see marker-registry-edit.ts
    // and backfill-shared-org-marker.ts).
    sdkMock.on(UpdateRegistryRecordCommand).resolves({
      recordId: "synthetic-agent-2",
      name: "SyntheticAgent2",
      status: "UPDATING",
      recordType: RecordType.CUSTOM,
      descriptors: { custom: { data: '{"manifest":{}}' } },
    });

    const throttleErr = Object.assign(
      new Error("Request rate exceeded. Please retry after some time."),
      { name: "ThrottlingException" },
    );
    sdkMock.on(GetRegistryRecordCommand).rejects(throttleErr);

    const result = await service.updateResource("agent", "synthetic-agent-2", {
      description: "marker edit",
    });

    expect(result.settleFailed).toBe(true);
    // The write landed; the returned status is the pre-settle transitional
    // snapshot from UpdateRegistryRecordCommand's own response, since the
    // settle re-fetch never completed.
    expect(result.status).toBe("UPDATING");
    expect(result.recordId).toBe("synthetic-agent-2");
  });
});
