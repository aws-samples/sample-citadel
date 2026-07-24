/**
 * Unit tests for backfill-app-stage-vars.ts — the idempotent StageVariables
 * backfill for apps published before the app-invoke-path fix.
 */
import {
  ApiGatewayV2Client,
  GetStageCommand,
  UpdateStageCommand,
} from "@aws-sdk/client-apigatewayv2";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";

import { runBackfill } from "../backfill-app-stage-vars";

const apiGwMock = mockClient(ApiGatewayV2Client);
const docClientMock = mockClient(DynamoDBDocumentClient);

const APPS_TABLE = "citadel-apps-test";

function makeDeps() {
  return {
    docClient: DynamoDBDocumentClient.from(new DynamoDBClient({})),
    apiGwClient: new ApiGatewayV2Client({}),
    appsTable: APPS_TABLE,
  };
}

beforeEach(() => {
  apiGwMock.reset();
  docClientMock.reset();
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("runBackfill", () => {
  test("scans only PUBLISHED #META rows with an apiId", async () => {
    docClientMock.on(ScanCommand).resolves({ Items: [] });

    await runBackfill({ apply: false }, makeDeps());

    const scanCall = docClientMock.commandCalls(ScanCommand)[0];
    const input = scanCall.args[0].input;
    expect(input.TableName).toBe(APPS_TABLE);
    expect(input.FilterExpression).toContain("sortId = :meta");
    expect(input.FilterExpression).toContain("#status = :published");
    expect(input.FilterExpression).toContain("attribute_exists(apiId)");
  });

  test("dry-run: does not call UpdateStageCommand even when a fix is needed", async () => {
    docClientMock.on(ScanCommand).resolves({
      Items: [
        {
          appId: "app-1",
          apiId: "api-1",
          status: "PUBLISHED",
          sortId: "METADATA",
        },
      ],
    });
    apiGwMock.on(GetStageCommand).resolves({ StageVariables: {} });

    const summary = await runBackfill({ apply: false }, makeDeps());

    expect(apiGwMock.commandCalls(UpdateStageCommand)).toHaveLength(0);
    expect(summary.mode).toBe("dry-run");
    expect(summary.eligible).toBe(1);
    expect(summary.alreadySet).toBe(0);
    expect(summary.fixed).toBe(0);
  });

  test("apply: calls UpdateStageCommand with StageVariables.appId when missing", async () => {
    docClientMock.on(ScanCommand).resolves({
      Items: [
        {
          appId: "app-1",
          apiId: "api-1",
          status: "PUBLISHED",
          sortId: "METADATA",
        },
      ],
    });
    apiGwMock.on(GetStageCommand).resolves({ StageVariables: {} });
    apiGwMock.on(UpdateStageCommand).resolves({});

    const summary = await runBackfill({ apply: true }, makeDeps());

    const updateCall = apiGwMock.commandCalls(UpdateStageCommand)[0];
    expect(updateCall.args[0].input).toMatchObject({
      ApiId: "api-1",
      StageName: "$default",
      StageVariables: { appId: "app-1" },
    });
    expect(summary.fixed).toBe(1);
  });

  test("idempotent: skips (no UpdateStageCommand) when StageVariables.appId is already correct", async () => {
    docClientMock.on(ScanCommand).resolves({
      Items: [
        {
          appId: "app-1",
          apiId: "api-1",
          status: "PUBLISHED",
          sortId: "METADATA",
        },
      ],
    });
    apiGwMock
      .on(GetStageCommand)
      .resolves({ StageVariables: { appId: "app-1" } });

    const summary = await runBackfill({ apply: true }, makeDeps());

    expect(apiGwMock.commandCalls(UpdateStageCommand)).toHaveLength(0);
    expect(summary.alreadySet).toBe(1);
    expect(summary.fixed).toBe(0);
  });

  test("per-app failure is logged and does not abort the run for other apps", async () => {
    docClientMock.on(ScanCommand).resolves({
      Items: [
        {
          appId: "app-bad",
          apiId: "api-bad",
          status: "PUBLISHED",
          sortId: "METADATA",
        },
        {
          appId: "app-good",
          apiId: "api-good",
          status: "PUBLISHED",
          sortId: "METADATA",
        },
      ],
    });
    apiGwMock
      .on(GetStageCommand, { ApiId: "api-bad" })
      .rejects(new Error("boom"));
    apiGwMock
      .on(GetStageCommand, { ApiId: "api-good" })
      .resolves({ StageVariables: {} });
    apiGwMock.on(UpdateStageCommand).resolves({});

    const summary = await runBackfill({ apply: true }, makeDeps());

    expect(summary.errors).toBe(1);
    expect(summary.fixed).toBe(1);
  });

  test("paginates through ScanCommand LastEvaluatedKey", async () => {
    docClientMock
      .on(ScanCommand)
      .resolvesOnce({
        Items: [
          {
            appId: "app-1",
            apiId: "api-1",
            status: "PUBLISHED",
            sortId: "METADATA",
          },
        ],
        LastEvaluatedKey: { appId: "app-1" },
      })
      .resolvesOnce({
        Items: [
          {
            appId: "app-2",
            apiId: "api-2",
            status: "PUBLISHED",
            sortId: "METADATA",
          },
        ],
      });
    apiGwMock.on(GetStageCommand).resolves({ StageVariables: {} });
    apiGwMock.on(UpdateStageCommand).resolves({});

    const summary = await runBackfill({ apply: true }, makeDeps());

    expect(docClientMock.commandCalls(ScanCommand)).toHaveLength(2);
    expect(summary.scanned).toBe(2);
    expect(summary.fixed).toBe(2);
  });
});
