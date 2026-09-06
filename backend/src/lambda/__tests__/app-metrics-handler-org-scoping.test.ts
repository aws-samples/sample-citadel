/**
 * Org-scoping regression test for getDashboardMetrics (finding 615aa5bb).
 *
 * Before the fix: getDashboardMetrics(orgId, ...) accepted orgId but never
 * used it — its ScanCommand FilterExpression only filtered on
 * begins_with(groupId, 'APP#') and the time range, so it aggregated
 * request/latency metrics across every organization's apps.
 *
 * After the fix: the caller's org's own appIds are resolved first (via
 * AppsTable.OrgIndex, the same GSI listApps/listDataStores already use),
 * and only those apps' METRICS# rows are aggregated — no ScanCommand
 * against the full table remains.
 */
import {
  DynamoDBDocumentClient,
  QueryCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { mockClient } from "aws-sdk-client-mock";

import { getDashboardMetrics, type MetricsDeps } from "../app-metrics-handler";

const ddbMock = mockClient(DynamoDBDocumentClient);

function makeDeps(): MetricsDeps {
  return {
    docClient: DynamoDBDocumentClient.from(new DynamoDBClient({})),
    appsTable: "citadel-apps-test",
  };
}

beforeEach(() => {
  ddbMock.reset();
});

describe("getDashboardMetrics — org scoping (finding 615aa5bb)", () => {
  it("only aggregates metrics for apps belonging to the caller org, never a table-wide scan", async () => {
    // OrgIndex query resolves org-a's own two apps.
    ddbMock
      .on(QueryCommand, {
        IndexName: "OrgIndex",
      })
      .resolves({
        Items: [{ appId: "app-org-a-1" }, { appId: "app-org-a-2" }],
      });

    // GroupIndex query per app returns metrics only for org-a's apps.
    ddbMock
      .on(QueryCommand, {
        IndexName: "GroupIndex",
        ExpressionAttributeValues: {
          ":gid": "APP#app-org-a-1",
          ":startSort": "METRICS#2026-04-13-00",
          ":endSort": "METRICS#2026-04-13-23",
        },
      })
      .resolves({
        Items: [
          {
            groupId: "APP#app-org-a-1",
            sortId: "METRICS#2026-04-13-10",
            totalRequests: 10,
            successCount: 10,
            clientErrorCount: 0,
            serverErrorCount: 0,
            p50Latency: 20,
            p95Latency: 30,
            p99Latency: 40,
          },
        ],
      });
    ddbMock
      .on(QueryCommand, {
        IndexName: "GroupIndex",
        ExpressionAttributeValues: {
          ":gid": "APP#app-org-a-2",
          ":startSort": "METRICS#2026-04-13-00",
          ":endSort": "METRICS#2026-04-13-23",
        },
      })
      .resolves({ Items: [] });

    const result = await getDashboardMetrics(
      "org-a",
      "2026-04-13T00:00:00Z",
      "2026-04-13T23:59:59Z",
      makeDeps(),
    );

    expect(result.totalRequests).toBe(10);

    // No unscoped ScanCommand against the apps table remains.
    const scanCalls = ddbMock.commandCalls(ScanCommand);
    expect(scanCalls.length).toBe(0);
  });

  it("returns empty aggregates when the caller org owns no apps", async () => {
    ddbMock.on(QueryCommand, { IndexName: "OrgIndex" }).resolves({ Items: [] });

    const result = await getDashboardMetrics(
      "org-with-no-apps",
      "2026-04-13T00:00:00Z",
      "2026-04-13T23:59:59Z",
      makeDeps(),
    );

    expect(result).toEqual({
      dailyActivity: [],
      totalRequests: 0,
      successRate: 0,
      avgLatency: 0,
    });
    expect(ddbMock.commandCalls(ScanCommand).length).toBe(0);
  });

  it("never leaks another org's app metrics into the aggregate", async () => {
    ddbMock.on(QueryCommand, { IndexName: "OrgIndex" }).resolves({
      Items: [{ appId: "app-org-a-1" }],
    });
    ddbMock.on(QueryCommand, { IndexName: "GroupIndex" }).resolves({
      Items: [
        {
          groupId: "APP#app-org-a-1",
          sortId: "METRICS#2026-04-13-10",
          totalRequests: 5,
          successCount: 5,
          clientErrorCount: 0,
          serverErrorCount: 0,
          p50Latency: 15,
          p95Latency: 15,
          p99Latency: 15,
        },
      ],
    });

    const result = await getDashboardMetrics(
      "org-a",
      "2026-04-13T00:00:00Z",
      "2026-04-13T23:59:59Z",
      makeDeps(),
    );

    // Only org-a's single app's 5 requests — not some other org's traffic
    // that a global scan would have also picked up.
    expect(result.totalRequests).toBe(5);
  });
});
