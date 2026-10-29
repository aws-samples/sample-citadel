/**
 * Tests for backend-subscription-authorizer — shared connect-time gate for
 * onWorkflowProgress (executionId) and onAppStatusChange (appId).
 */
import { AppSyncResolverEvent } from "aws-lambda";
import {
  handler,
  BackendSubscriptionError,
} from "../backend-subscription-authorizer";

/* ---- mocks ---- */

const mockSend = jest.fn();
jest.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: jest.fn().mockImplementation(() => ({})),
}));
jest.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: {
    from: jest
      .fn()
      .mockReturnValue({ send: (...args: unknown[]) => mockSend(...args) }),
  },
  GetCommand: jest.fn().mockImplementation((p: unknown) => p),
}));

jest.mock("../../utils/appsync", () => ({
  getUserId: jest.fn().mockReturnValue("user-123"),
}));

const mockAssertRowOrg = jest.fn();
const mockIsAdmin = jest.fn();
jest.mock("../../utils/auth-event", () => ({
  assertRowOrg: (...args: unknown[]) => mockAssertRowOrg(...args),
  isAdminFromEvent: (...args: unknown[]) => mockIsAdmin(...args),
}));

/* ---- helpers ---- */

function makeEvent(
  fieldName: string,
  args: Record<string, unknown> = {},
): AppSyncResolverEvent<Record<string, unknown>> {
  return {
    arguments: args,
    info: {
      fieldName,
      parentTypeName: "Subscription",
      variables: {},
      selectionSetList: [],
      selectionSetGraphQL: "",
    },
    identity: { sub: "user-123" },
    source: null,
    request: { headers: {}, domainName: null },
    prev: null,
    stash: {},
  } as unknown as AppSyncResolverEvent<Record<string, unknown>>;
}

beforeEach(() => {
  jest.resetAllMocks();
  mockIsAdmin.mockReturnValue(false);
  process.env.EXECUTIONS_TABLE = "Executions";
  process.env.APPS_TABLE = "Apps";
});

afterEach(() => {
  delete process.env.EXECUTIONS_TABLE;
  delete process.env.APPS_TABLE;
});

/* ==== onWorkflowProgress ==== */

describe("onWorkflowProgress", () => {
  it("owner/member positive — returns null when assertRowOrg passes", async () => {
    mockSend.mockResolvedValue({
      Item: { executionId: "exec-1", orgId: "org-mine" },
    });
    mockAssertRowOrg.mockResolvedValue(undefined);

    await expect(
      handler(makeEvent("onWorkflowProgress", { executionId: "exec-1" })),
    ).resolves.toBeNull();
  });

  it("foreign/non-member — refused when assertRowOrg denies", async () => {
    mockSend.mockResolvedValue({
      Item: { executionId: "exec-1", orgId: "org-other" },
    });
    mockAssertRowOrg.mockRejectedValue(new Error("Access denied"));

    await expect(
      handler(makeEvent("onWorkflowProgress", { executionId: "exec-1" })),
    ).rejects.toBeInstanceOf(BackendSubscriptionError);
  });

  it("random id — refused (non-existent execution same error as foreign)", async () => {
    mockSend.mockResolvedValue({ Item: undefined });

    await expect(
      handler(
        makeEvent("onWorkflowProgress", {
          executionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        }),
      ),
    ).rejects.toBeInstanceOf(BackendSubscriptionError);
  });

  it("empty arg — refused when executionId is missing", async () => {
    await expect(
      handler(makeEvent("onWorkflowProgress", {})),
    ).rejects.toBeInstanceOf(BackendSubscriptionError);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("empty arg — refused when executionId is empty string", async () => {
    await expect(
      handler(makeEvent("onWorkflowProgress", { executionId: "" })),
    ).rejects.toBeInstanceOf(BackendSubscriptionError);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("admin bypass — returns null without DDB lookup", async () => {
    mockIsAdmin.mockReturnValue(true);

    await expect(
      handler(makeEvent("onWorkflowProgress", { executionId: "exec-any" })),
    ).resolves.toBeNull();
    expect(mockSend).not.toHaveBeenCalled();
  });
});

/* ==== onAppStatusChange ==== */

describe("onAppStatusChange", () => {
  it("owner/member positive — returns null when assertRowOrg passes", async () => {
    mockSend.mockResolvedValue({
      Item: { appId: "app-1", orgId: "org-mine" },
    });
    mockAssertRowOrg.mockResolvedValue(undefined);

    await expect(
      handler(makeEvent("onAppStatusChange", { appId: "app-1" })),
    ).resolves.toBeNull();
  });

  it("foreign/non-member — refused when assertRowOrg denies", async () => {
    mockSend.mockResolvedValue({
      Item: { appId: "app-1", orgId: "org-other" },
    });
    mockAssertRowOrg.mockRejectedValue(new Error("Access denied"));

    await expect(
      handler(makeEvent("onAppStatusChange", { appId: "app-1" })),
    ).rejects.toBeInstanceOf(BackendSubscriptionError);
  });

  it("random id — refused (non-existent app same error as foreign)", async () => {
    mockSend.mockResolvedValue({ Item: undefined });

    await expect(
      handler(
        makeEvent("onAppStatusChange", {
          appId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        }),
      ),
    ).rejects.toBeInstanceOf(BackendSubscriptionError);
  });

  it("empty arg — refused when appId is missing", async () => {
    await expect(
      handler(makeEvent("onAppStatusChange", {})),
    ).rejects.toBeInstanceOf(BackendSubscriptionError);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("empty arg — refused when appId is empty string", async () => {
    await expect(
      handler(makeEvent("onAppStatusChange", { appId: "" })),
    ).rejects.toBeInstanceOf(BackendSubscriptionError);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("admin bypass — returns null without DDB lookup", async () => {
    mockIsAdmin.mockReturnValue(true);

    await expect(
      handler(makeEvent("onAppStatusChange", { appId: "app-any" })),
    ).resolves.toBeNull();
    expect(mockSend).not.toHaveBeenCalled();
  });
});

/* ==== unknown field ==== */

describe("unknown field — refused (fail closed)", () => {
  it("rejects when fieldName is not onWorkflowProgress or onAppStatusChange", async () => {
    await expect(
      handler(makeEvent("onSomethingElse", { executionId: "exec-1" })),
    ).rejects.toBeInstanceOf(BackendSubscriptionError);
  });

  it("rejects when fieldName is undefined", async () => {
    const event = makeEvent("onWorkflowProgress", { executionId: "exec-1" });
    (event as unknown as { info: { fieldName: undefined } }).info.fieldName =
      undefined as unknown as string;

    await expect(handler(event)).rejects.toBeInstanceOf(
      BackendSubscriptionError,
    );
  });
});
