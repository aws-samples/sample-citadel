import { getDashboardMetrics } from "../app-metrics-handler";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { QueryCommand } from "@aws-sdk/lib-dynamodb";

// Mock DynamoDB. getDashboardMetrics now queries in two steps (finding
// 615aa5bb — org scoping): first AppsTable.OrgIndex to resolve the org's
// own appIds, then AppsTable.GroupIndex per appId for METRICS# rows.
// mockAppsAndMetrics wires both steps behind a single mockSend so existing
// test bodies only need to supply the per-app metrics rows.
const mockSend = jest.fn();
const mockDeps = {
  docClient: { send: mockSend } as unknown as DynamoDBDocumentClient,
  appsTable: "test-apps-table",
};

/** Registers the OrgIndex response (appIds) and a metrics-row lookup keyed
 * by appId for the GroupIndex step. */
function mockAppsAndMetrics(
  appIds: string[],
  metricsByAppId: Record<string, unknown[]>,
) {
  mockSend.mockImplementation(async (command: QueryCommand) => {
    const input = command.input as {
      IndexName?: string;
      ExpressionAttributeValues?: Record<string, string>;
    };
    if (input.IndexName === "OrgIndex") {
      return { Items: appIds.map((appId) => ({ appId })) };
    }
    if (input.IndexName === "GroupIndex") {
      const gid = input.ExpressionAttributeValues?.[":gid"] ?? "";
      const appId = gid.replace("APP#", "");
      return { Items: metricsByAppId[appId] ?? [] };
    }
    return { Items: [] };
  });
}

beforeEach(() => {
  mockSend.mockReset();
});

describe("getDashboardMetrics", () => {
  it("returns zero totals when no METRICS# items exist", async () => {
    mockAppsAndMetrics(["app1"], { app1: [] });
    const result = await getDashboardMetrics(
      "org1",
      "2026-04-01T00:00:00Z",
      "2026-04-07T23:59:59Z",
      mockDeps,
    );
    expect(result.totalRequests).toBe(0);
    expect(result.successRate).toBe(0);
    expect(result.avgLatency).toBe(0);
    expect(result.dailyActivity).toEqual([]);
  });

  it("returns zero totals when the org owns no apps", async () => {
    mockAppsAndMetrics([], {});
    const result = await getDashboardMetrics(
      "org1",
      "2026-04-01T00:00:00Z",
      "2026-04-07T23:59:59Z",
      mockDeps,
    );
    expect(result.totalRequests).toBe(0);
    expect(result.dailyActivity).toEqual([]);
  });

  it("groups metrics by UTC calendar day across multiple apps", async () => {
    mockAppsAndMetrics(["app1", "app2"], {
      app1: [
        {
          groupId: "APP#app1",
          sortId: "METRICS#2026-04-06-10",
          totalRequests: 100,
          successCount: 90,
          clientErrorCount: 5,
          serverErrorCount: 5,
          p50Latency: 50,
        },
        {
          groupId: "APP#app1",
          sortId: "METRICS#2026-04-07-08",
          totalRequests: 50,
          successCount: 48,
          clientErrorCount: 1,
          serverErrorCount: 1,
          p50Latency: 30,
        },
      ],
      app2: [
        {
          groupId: "APP#app2",
          sortId: "METRICS#2026-04-06-14",
          totalRequests: 200,
          successCount: 180,
          clientErrorCount: 10,
          serverErrorCount: 10,
          p50Latency: 100,
        },
      ],
    });

    const result = await getDashboardMetrics(
      "org1",
      "2026-04-06T00:00:00Z",
      "2026-04-07T23:59:59Z",
      mockDeps,
    );

    expect(result.totalRequests).toBe(350);
    expect(result.dailyActivity).toHaveLength(2);

    const day1 = result.dailyActivity.find((d) => d.date === "2026-04-06");
    expect(day1).toBeDefined();
    expect(day1!.successCount).toBe(270);
    expect(day1!.errorCount).toBe(30);

    const day2 = result.dailyActivity.find((d) => d.date === "2026-04-07");
    expect(day2).toBeDefined();
    expect(day2!.successCount).toBe(48);
    expect(day2!.errorCount).toBe(2);
  });

  it("computes successRate as percentage", async () => {
    mockAppsAndMetrics(["app1"], {
      app1: [
        {
          groupId: "APP#app1",
          sortId: "METRICS#2026-04-06-10",
          totalRequests: 100,
          successCount: 75,
          clientErrorCount: 15,
          serverErrorCount: 10,
          p50Latency: 50,
        },
      ],
    });
    const result = await getDashboardMetrics(
      "org1",
      "2026-04-06T00:00:00Z",
      "2026-04-06T23:59:59Z",
      mockDeps,
    );
    expect(result.successRate).toBe(75);
  });

  it("computes weighted average latency", async () => {
    mockAppsAndMetrics(["app1", "app2"], {
      app1: [
        {
          groupId: "APP#app1",
          sortId: "METRICS#2026-04-06-10",
          totalRequests: 100,
          successCount: 100,
          clientErrorCount: 0,
          serverErrorCount: 0,
          p50Latency: 50,
        },
      ],
      app2: [
        {
          groupId: "APP#app2",
          sortId: "METRICS#2026-04-06-14",
          totalRequests: 100,
          successCount: 100,
          clientErrorCount: 0,
          serverErrorCount: 0,
          p50Latency: 150,
        },
      ],
    });
    const result = await getDashboardMetrics(
      "org1",
      "2026-04-06T00:00:00Z",
      "2026-04-06T23:59:59Z",
      mockDeps,
    );
    expect(result.avgLatency).toBe(100); // (50*100 + 150*100) / 200
  });

  it("sorts dailyActivity by date ascending", async () => {
    mockAppsAndMetrics(["app1"], {
      app1: [
        {
          groupId: "APP#app1",
          sortId: "METRICS#2026-04-07-10",
          totalRequests: 10,
          successCount: 10,
          clientErrorCount: 0,
          serverErrorCount: 0,
          p50Latency: 50,
        },
        {
          groupId: "APP#app1",
          sortId: "METRICS#2026-04-05-10",
          totalRequests: 20,
          successCount: 20,
          clientErrorCount: 0,
          serverErrorCount: 0,
          p50Latency: 50,
        },
      ],
    });
    const result = await getDashboardMetrics(
      "org1",
      "2026-04-05T00:00:00Z",
      "2026-04-07T23:59:59Z",
      mockDeps,
    );
    expect(result.dailyActivity[0].date).toBe("2026-04-05");
    expect(result.dailyActivity[1].date).toBe("2026-04-07");
  });
});
