/**
 * Tests that mirrorToRegistry logs the underlying registry error details
 * (error class, message, operation, attempt count) instead of swallowing
 * them (fix for the 2026-11-14T02:38Z live incident on app 17XwYJQvRlax).
 */
import {
  DynamoDBDocumentClient,
  GetCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { mockClient } from "aws-sdk-client-mock";

import {
  bind,
  unbind,
  type BindingServiceDeps,
  type RegistryLike,
  type RegistryRecordLike,
} from "../../services/app-workflow-binding";

// ---------------------------------------------------------------------------
// Minimal fakes — only what mirror-error tests need
// ---------------------------------------------------------------------------

const ddbMock = mockClient(DynamoDBDocumentClient);

function makeDeps(registryService: RegistryLike): BindingServiceDeps {
  return {
    docClient: DynamoDBDocumentClient.from(new DynamoDBClient({})),
    workflowsTable: "test-workflows",
    appsTable: "test-apps",
    registryService,
  };
}

const APP_ID = "app-mirror-err";
const WF_ID = "wf-mirror-err";

function wireMinimalDdb(): void {
  ddbMock.reset();

  ddbMock.on(GetCommand).callsFake((input) => {
    if (input.TableName === "test-workflows") {
      if (input.Key.workflowId === WF_ID) {
        return { Item: { workflowId: WF_ID, orgId: "org-1", appId: undefined } };
      }
      return { Item: undefined };
    }
    if (input.TableName === "test-apps") {
      if (input.Key.appId === APP_ID) {
        return { Item: { appId: APP_ID, orgId: "org-1", workflowIds: [] } };
      }
      return { Item: undefined };
    }
    return { Item: undefined };
  });

  ddbMock.on(TransactWriteCommand).callsFake(() => ({}));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  wireMinimalDdb();
  jest.restoreAllMocks();
});

describe("mirrorToRegistry structured error logging", () => {
  it("bind: logs error class, message, operation, and attempt on registry updateResource failure", async () => {
    const registryError = new TypeError("Cannot read properties of undefined (reading 'version')");

    const fakeRegistry: RegistryLike = {
      async getResource(_type: string, id: string): Promise<RegistryRecordLike | null> {
        return {
          recordId: id,
          name: "Test",
          customDescriptorContent: JSON.stringify({ manifest: { workflowIds: [], version: 1 } }),
        };
      },
      async updateResource(): Promise<RegistryRecordLike> {
        throw registryError;
      },
    };

    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    await bind(makeDeps(fakeRegistry), APP_ID, WF_ID, { userId: "u1" });

    // The mirrorToRegistry error log must include structured error details
    const mirrorCall = errorSpy.mock.calls.find(
      (args) => typeof args[0] === "string" && args[0].includes("mirrorToRegistry"),
    );
    expect(mirrorCall).toBeDefined();
    const logPayload = mirrorCall![1] as Record<string, unknown>;
    // Must include error class name
    expect(logPayload).toHaveProperty("errorClass", "TypeError");
    // Must include the error message
    expect(logPayload).toHaveProperty("error", registryError.message);
    // Must include the registry operation that failed
    expect(logPayload).toHaveProperty("operation", "updateResource");
    // Must include the attempt count (3 = maxRetries)
    expect(logPayload).toHaveProperty("attempt", 3);
  });

  it("bind: logs error class, message, operation, and attempt on registry getResource failure", async () => {
    const registryError = new Error("ThrottlingException: Rate exceeded");
    registryError.name = "ThrottlingException";

    const fakeRegistry: RegistryLike = {
      async getResource(): Promise<RegistryRecordLike | null> {
        throw registryError;
      },
      async updateResource(): Promise<RegistryRecordLike> {
        throw new Error("should not be called");
      },
    };

    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    await bind(makeDeps(fakeRegistry), APP_ID, WF_ID, { userId: "u1" });

    const mirrorCall = errorSpy.mock.calls.find(
      (args) => typeof args[0] === "string" && args[0].includes("mirrorToRegistry"),
    );
    expect(mirrorCall).toBeDefined();
    const logPayload = mirrorCall![1] as Record<string, unknown>;
    expect(logPayload).toHaveProperty("errorClass", "ThrottlingException");
    expect(logPayload).toHaveProperty("error", registryError.message);
    expect(logPayload).toHaveProperty("operation", "getResource");
    expect(logPayload).toHaveProperty("attempt", 3);
  });

  it("unbind: logs structured error details on registry mirror failure", async () => {
    // Setup: workflow bound to app so unbind has work to do
    ddbMock.reset();
    ddbMock.on(GetCommand).callsFake((input) => {
      if (input.TableName === "test-workflows") {
        return { Item: { workflowId: WF_ID, orgId: "org-1", appId: APP_ID } };
      }
      if (input.TableName === "test-apps") {
        return { Item: { appId: APP_ID, orgId: "org-1", workflowIds: [WF_ID] } };
      }
      return { Item: undefined };
    });
    ddbMock.on(TransactWriteCommand).callsFake(() => ({}));

    const registryError = new Error("ConflictException: record is UPDATING");
    registryError.name = "ConflictException";

    const fakeRegistry: RegistryLike = {
      async getResource(_type: string, id: string): Promise<RegistryRecordLike | null> {
        return {
          recordId: id,
          name: "Test",
          customDescriptorContent: JSON.stringify({ manifest: { workflowIds: [WF_ID], version: 2 } }),
        };
      },
      async updateResource(): Promise<RegistryRecordLike> {
        throw registryError;
      },
    };

    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    await unbind(makeDeps(fakeRegistry), APP_ID, WF_ID, { userId: "u1" });

    const mirrorCall = errorSpy.mock.calls.find(
      (args) => typeof args[0] === "string" && args[0].includes("mirrorToRegistry"),
    );
    expect(mirrorCall).toBeDefined();
    const logPayload = mirrorCall![1] as Record<string, unknown>;
    expect(logPayload).toHaveProperty("errorClass", "ConflictException");
    expect(logPayload).toHaveProperty("operation", "updateResource");
    expect(logPayload).toHaveProperty("attempt", 3);
  });
});
