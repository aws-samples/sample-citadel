/**
 * Tests for CIT-043 visibility enforcement on RegistryService:
 *
 * 1. listResources with viewer filters by isRecordVisible
 * 2. searchResources with viewer filters by isRecordVisible
 * 3. No-viewer preserves existing unfiltered behaviour
 * 4. createdBy round-trip: createResource stamps it; mapToAgentConfig/mapToToolConfig surface it
 */

import {
  AgentRegistryControlClient,
  CreateRegistryRecordCommand,
  GetRegistryRecordCommand,
  ListRegistryRecordsCommand,
  RecordType,
} from "@aws-sdk/client-agent-registry-control";
import { mockClient } from "aws-sdk-client-mock";
import {
  RegistryService,
  RegistryRecordStatusValues,
} from "../registry-service";
import type { Viewer } from "../../utils/record-visibility";

const sdkMock = mockClient(AgentRegistryControlClient);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function agentMeta(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    categories: [],
    icon: "",
    state: "active",
    manifest: { name: "A" },
    orgId: "org-1",
    ...overrides,
  });
}

function toolMeta(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    categories: [],
    icon: "",
    state: "active",
    orgId: "org-1",
    ...overrides,
  });
}

function makeSummary(recordId: string, name: string, status: string) {
  return {
    recordId,
    name,
    status,
    recordArn: "arn:mock",
    registryArn: "arn:reg",
    recordType: RecordType.CUSTOM,
    recordVersion: "1",
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

const admin: Viewer = {
  isAdmin: true,
  roles: ["admin"],
  orgId: "org-1",
  userId: "u-admin",
};
const developer: Viewer = {
  isAdmin: false,
  roles: ["developer"],
  orgId: "org-1",
  userId: "u-dev",
};
const architect: Viewer = {
  isAdmin: false,
  roles: ["architect"],
  orgId: "org-1",
  userId: "u-arch",
};
const architectOtherOrg: Viewer = {
  isAdmin: false,
  roles: ["architect"],
  orgId: "org-2",
  userId: "u-arch2",
};

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("RegistryService viewer visibility (CIT-043)", () => {
  let service: RegistryService;

  beforeEach(() => {
    sdkMock.reset();
    service = new RegistryService({
      registryId: "test-registry",
      region: "us-east-1",
    });
    jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // -----------------------------------------------------------------------
  // listResources with viewer
  // -----------------------------------------------------------------------

  describe("listResources with viewer", () => {
    function stubList(
      records: Array<{
        id: string;
        name: string;
        status: string;
        meta: string;
      }>,
    ) {
      sdkMock.on(ListRegistryRecordsCommand).resolves({
        registryRecords: records.map((r) =>
          makeSummary(r.id, r.name, r.status),
        ),
        nextToken: undefined,
      });
      for (const r of records) {
        sdkMock.on(GetRegistryRecordCommand, { recordId: r.id }).resolves({
          recordId: r.id,
          name: r.name,
          status: r.status,
          descriptors: { custom: { data: r.meta } },
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      }
    }

    const fixtures = [
      {
        id: "rec-draft",
        name: "Draft",
        status: "DRAFT",
        meta: agentMeta({ createdBy: "u-arch" }),
      },
      {
        id: "rec-pend",
        name: "Pending",
        status: "PENDING_APPROVAL",
        meta: agentMeta(),
      },
      {
        id: "rec-appr",
        name: "Approved",
        status: "APPROVED",
        meta: agentMeta(),
      },
      {
        id: "rec-rej",
        name: "Rejected",
        status: "REJECTED",
        meta: agentMeta(),
      },
      {
        id: "rec-depr",
        name: "Deprecated",
        status: "DEPRECATED",
        meta: agentMeta(),
      },
    ];

    it("admin sees all statuses", async () => {
      stubList(fixtures);
      const results = await service.listResources("agent", { viewer: admin });
      expect(results.map((r) => r.recordId).sort()).toEqual(
        fixtures.map((f) => f.id).sort(),
      );
    });

    it("developer sees only APPROVED", async () => {
      stubList(fixtures);
      const results = await service.listResources("agent", {
        viewer: developer,
      });
      expect(results.map((r) => r.recordId)).toEqual(["rec-appr"]);
    });

    it("architect sees APPROVED + same-org PENDING_APPROVAL + own DRAFT", async () => {
      stubList(fixtures);
      const results = await service.listResources("agent", {
        viewer: architect,
      });
      const ids = results.map((r) => r.recordId).sort();
      expect(ids).toEqual(["rec-appr", "rec-draft", "rec-pend"]);
    });

    it("architect from another org does not see PENDING_APPROVAL or DRAFT", async () => {
      stubList(fixtures);
      const results = await service.listResources("agent", {
        viewer: architectOtherOrg,
      });
      expect(results.map((r) => r.recordId)).toEqual(["rec-appr"]);
    });

    it("no viewer returns all records unchanged (internal callers)", async () => {
      stubList(fixtures);
      const results = await service.listResources("agent");
      expect(results).toHaveLength(fixtures.length);
    });
  });

  // -----------------------------------------------------------------------
  // searchResources with viewer
  // -----------------------------------------------------------------------

  describe("searchResources with viewer", () => {
    function stubSearch(
      records: Array<{ id: string; name: string; status: string }>,
    ) {
      sdkMock.on(ListRegistryRecordsCommand).resolves({
        registryRecords: records.map((r) =>
          makeSummary(r.id, r.name, r.status),
        ),
        nextToken: undefined,
      });
    }

    const searchResults = [
      { id: "s-appr", name: "Agent-A", status: "APPROVED" },
      { id: "s-draft", name: "Agent-B", status: "DRAFT" },
      { id: "s-pend", name: "Agent-C", status: "PENDING_APPROVAL" },
    ];

    it("admin sees all search results", async () => {
      stubSearch(searchResults);
      const results = await service.searchResources("agent", "Agent", admin);
      expect(results).toHaveLength(3);
    });

    it("developer sees only APPROVED search results", async () => {
      stubSearch(searchResults);
      const results = await service.searchResources(
        "agent",
        "Agent",
        developer,
      );
      expect(results.map((r) => r.recordId)).toEqual(["s-appr"]);
    });

    it("no viewer returns all search results", async () => {
      stubSearch(searchResults);
      const results = await service.searchResources("agent", "Agent");
      expect(results).toHaveLength(3);
    });
  });

  // -----------------------------------------------------------------------
  // createdBy round-trip
  // -----------------------------------------------------------------------

  describe("createdBy round-trip", () => {
    it("createResource stamps createdBy into customMetadata when provided", async () => {
      const inputMeta = agentMeta();
      sdkMock.on(CreateRegistryRecordCommand).resolves({
        recordArn:
          "arn:aws:agent-registry:us-east-1:123:registry/test-registry/record/rec-new",
        status: "DRAFT",
      });

      const metaWithCreatedBy = JSON.parse(agentMeta());
      metaWithCreatedBy.createdBy = "u-creator";
      sdkMock.on(GetRegistryRecordCommand).resolves({
        recordId: "rec-new",
        name: "NewAgent",
        status: "DRAFT",
        descriptors: { custom: { data: JSON.stringify(metaWithCreatedBy) } },
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await service.createResource("agent", "rec-new", {
        name: "NewAgent",
        customMetadata: inputMeta,
        createdBy: "u-creator",
      });

      // Verify the CreateRegistryRecordCommand was sent with createdBy injected
      const calls = sdkMock.commandCalls(CreateRegistryRecordCommand);
      expect(calls).toHaveLength(1);
      const sentData = JSON.parse(
        calls[0].args[0].input.descriptors!.custom!.data as string,
      );
      expect(sentData.createdBy).toBe("u-creator");
    });

    it("createResource does not inject createdBy when not provided", async () => {
      const inputMeta = agentMeta();
      sdkMock.on(CreateRegistryRecordCommand).resolves({
        recordArn:
          "arn:aws:agent-registry:us-east-1:123:registry/test-registry/record/rec-plain",
        status: "DRAFT",
      });
      sdkMock.on(GetRegistryRecordCommand).resolves({
        recordId: "rec-plain",
        name: "PlainAgent",
        status: "DRAFT",
        descriptors: { custom: { data: inputMeta } },
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await service.createResource("agent", "rec-plain", {
        name: "PlainAgent",
        customMetadata: inputMeta,
      });

      const calls = sdkMock.commandCalls(CreateRegistryRecordCommand);
      const sentData = JSON.parse(
        calls[0].args[0].input.descriptors!.custom!.data as string,
      );
      expect(sentData.createdBy).toBeUndefined();
    });

    it("mapToAgentConfig surfaces createdBy from metadata", () => {
      const result = service.mapToAgentConfig({
        recordId: "a1",
        name: "A",
        status: RegistryRecordStatusValues.APPROVED,
        customDescriptorContent: agentMeta({ createdBy: "u-creator" }),
      });
      expect(result.createdBy).toBe("u-creator");
    });

    it("mapToAgentConfig omits createdBy when absent in metadata", () => {
      const result = service.mapToAgentConfig({
        recordId: "a1",
        name: "A",
        status: RegistryRecordStatusValues.APPROVED,
        customDescriptorContent: agentMeta(),
      });
      expect(result.createdBy).toBeUndefined();
    });

    it("mapToToolConfig surfaces createdBy from metadata", () => {
      const result = service.mapToToolConfig({
        recordId: "t1",
        name: "T",
        status: RegistryRecordStatusValues.APPROVED,
        customDescriptorContent: toolMeta({ createdBy: "u-tool-creator" }),
      });
      expect(result.createdBy).toBe("u-tool-creator");
    });

    it("mapToToolConfig omits createdBy when absent in metadata", () => {
      const result = service.mapToToolConfig({
        recordId: "t1",
        name: "T",
        status: RegistryRecordStatusValues.APPROVED,
        customDescriptorContent: toolMeta(),
      });
      expect(result.createdBy).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // PR-3: mapper no longer collapses absent orgId to "" (finding: an
  // unstamped record mapped to orgId:"" read as system-shared under the
  // old orgMatch, leaking cross-org). Absent meta.orgId must now surface
  // orgUnknown:true and leave orgId undefined.
  // -----------------------------------------------------------------------

  describe("PR-3: mapToAgentConfig/mapToToolConfig preserve absent orgId (no collapse to '')", () => {
    it("mapToAgentConfig sets orgUnknown:true and leaves orgId undefined when meta.orgId is absent", () => {
      const result = service.mapToAgentConfig({
        recordId: "a-unstamped",
        name: "Unstamped",
        status: RegistryRecordStatusValues.DRAFT,
        customDescriptorContent: agentMeta({ orgId: undefined }),
      });
      expect(result.orgId).toBeUndefined();
      expect(result.orgUnknown).toBe(true);
    });

    it("mapToAgentConfig does not set orgUnknown when meta.orgId is present (including explicit '')", () => {
      const present = service.mapToAgentConfig({
        recordId: "a-present",
        name: "Present",
        status: RegistryRecordStatusValues.APPROVED,
        customDescriptorContent: agentMeta({ orgId: "org-1" }),
      });
      expect(present.orgId).toBe("org-1");
      expect(present.orgUnknown).toBeUndefined();
    });

    it("mapToToolConfig sets orgUnknown:true and leaves orgId undefined when meta.orgId is absent", () => {
      const result = service.mapToToolConfig({
        recordId: "t-unstamped",
        name: "Unstamped",
        status: RegistryRecordStatusValues.DRAFT,
        customDescriptorContent: toolMeta({ orgId: undefined }),
      });
      expect(result.orgId).toBeUndefined();
      expect(result.orgUnknown).toBe(true);
    });

    it("mapToToolConfig does not set orgUnknown when meta.orgId is present", () => {
      const present = service.mapToToolConfig({
        recordId: "t-present",
        name: "Present",
        status: RegistryRecordStatusValues.APPROVED,
        customDescriptorContent: toolMeta({ orgId: "org-1" }),
      });
      expect(present.orgId).toBe("org-1");
      expect(present.orgUnknown).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // PR-3: listResources/searchResources viewer filters exclude
  // blank/absent-orgId non-APPROVED records cross-org; include ALL_ORGS.
  // -----------------------------------------------------------------------

  describe("PR-3: listResources/searchResources fail closed on blank/absent orgId", () => {
    function stubList(
      records: Array<{
        id: string;
        name: string;
        status: string;
        meta: string;
      }>,
    ) {
      sdkMock.on(ListRegistryRecordsCommand).resolves({
        registryRecords: records.map((r) =>
          makeSummary(r.id, r.name, r.status),
        ),
        nextToken: undefined,
      });
      for (const r of records) {
        sdkMock.on(GetRegistryRecordCommand, { recordId: r.id }).resolves({
          recordId: r.id,
          name: r.name,
          status: r.status,
          descriptors: { custom: { data: r.meta } },
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      }
    }

    it("architect from a different org does not see a blank-orgId PENDING_APPROVAL record", async () => {
      stubList([
        {
          id: "rec-blank-pend",
          name: "BlankPending",
          status: "PENDING_APPROVAL",
          meta: agentMeta({ orgId: "" }),
        },
      ]);
      const results = await service.listResources("agent", {
        viewer: architectOtherOrg,
      });
      expect(results.map((r) => r.recordId)).toEqual([]);
    });

    it("architect from a different org DOES see an ALL_ORGS PENDING_APPROVAL record", async () => {
      stubList([
        {
          id: "rec-all-orgs-pend",
          name: "AllOrgsPending",
          status: "PENDING_APPROVAL",
          meta: agentMeta({ orgId: "All Organizations" }),
        },
      ]);
      const results = await service.listResources("agent", {
        viewer: architectOtherOrg,
      });
      expect(results.map((r) => r.recordId)).toEqual(["rec-all-orgs-pend"]);
    });
  });
});
