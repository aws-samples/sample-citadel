/**
 * Tests for governance-graph-snapshot-on-change Lambda — Wave 4.E.A.2.
 *
 * Mirrors the style of governance-graph-snapshot.test.ts: env vars set
 * before imports, mocks for SSM / DDB / CloudWatch via
 * aws-sdk-client-mock. We assert empty-event short-circuit, the
 * settings-disabled skip path, the scan-all-4-tables happy path,
 * batch-debouncing (multiple stream records collapse to ONE snapshot),
 * partial-failure handling, the all-fail-throws contract, and the
 * Trigger=OnChange CloudWatch dimension.
 */

process.env.ENVIRONMENT = 'test';
process.env.AUTHORITY_UNITS_TABLE = 'citadel-authority-units-test';
process.env.COMPOSITION_CONTRACTS_TABLE =
  'citadel-composition-contracts-test';
process.env.CONSTITUTIONAL_LAYERS_TABLE =
  'citadel-constitutional-layers-test';
process.env.CASE_LAW_TABLE = 'citadel-case-law-test';
process.env.GRAPH_SNAPSHOTS_TABLE =
  'citadel-governance-graph-snapshots-test';

import type { DynamoDBStreamEvent } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBDocumentClient,
  PutCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import {
  CloudWatchClient,
  PutMetricDataCommand,
} from '@aws-sdk/client-cloudwatch';

const ddbMock = mockClient(DynamoDBDocumentClient);
const ssmMock = mockClient(SSMClient);
const cwMock = mockClient(CloudWatchClient);

import { handler, __resetClientsForTest } from '../governance-graph-snapshot-on-change';

beforeEach(() => {
  ddbMock.reset();
  ssmMock.reset();
  cwMock.reset();
  __resetClientsForTest();
  jest.spyOn(console, 'error').mockImplementation();
  jest.spyOn(console, 'log').mockImplementation();
});

afterEach(() => {
  jest.restoreAllMocks();
});

function stubSettings(value: string): void {
  ssmMock.on(GetParameterCommand).resolves({
    Parameter: { Value: value },
  });
}

/** Build a minimal DynamoDB stream event with N synthetic records. */
function streamEvent(n: number, eventName: 'INSERT' | 'MODIFY' | 'REMOVE' = 'MODIFY'): DynamoDBStreamEvent {
  const records = Array.from({ length: n }, (_, i) => ({
    eventID: `evt-${i}`,
    eventName,
    eventVersion: '1.1',
    eventSource: 'aws:dynamodb',
    awsRegion: 'us-east-1',
    dynamodb: {
      ApproximateCreationDateTime: 1700000000 + i,
      Keys: { unitId: { S: `u-${i}` } },
      NewImage: { unitId: { S: `u-${i}` }, name: { S: `unit-${i}` } },
      SequenceNumber: `${1000 + i}`,
      SizeBytes: 64,
      StreamViewType: 'NEW_AND_OLD_IMAGES',
    },
  }));
  return { Records: records as any };
}

describe('governance-graph-snapshot-on-change handler', () => {
  test('empty event — returns ok with reason=empty, no scans, no put, no metric', async () => {
    const result = await handler({ Records: [] } as any);

    expect(result.ok).toBe(true);
    expect(result.snapshotId).toBeNull();
    expect(result.reason).toBe('empty');
    expect(result.recordCount).toBe(0);
    expect(ddbMock.commandCalls(ScanCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    expect(ssmMock.commandCalls(GetParameterCommand)).toHaveLength(0);
    expect(cwMock.commandCalls(PutMetricDataCommand)).toHaveLength(0);
  });

  test('settings disabled — reason=disabled, no scans, no put, no metric', async () => {
    stubSettings(
      '{"enabled":false,"retentionDays":30,"captureMode":"daily"}',
    );

    const result = await handler(streamEvent(1));

    expect(result.ok).toBe(true);
    expect(result.snapshotId).toBeNull();
    expect(result.reason).toBe('disabled');
    expect(result.recordCount).toBe(1);
    expect(ddbMock.commandCalls(ScanCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    expect(cwMock.commandCalls(PutMetricDataCommand)).toHaveLength(0);
  });

  test('settings enabled, single record — scans all 4 tables, writes 1 snapshot', async () => {
    stubSettings(
      '{"enabled":true,"retentionDays":7,"captureMode":"on-change"}',
    );
    ddbMock.on(ScanCommand).callsFake((input: any) => {
      const t: string = input?.TableName ?? '';
      if (t === 'citadel-authority-units-test') {
        return Promise.resolve({ Items: [{ unitId: 'u-1' }] });
      }
      if (t === 'citadel-composition-contracts-test') {
        return Promise.resolve({ Items: [{ contractId: 'c-1' }] });
      }
      if (t === 'citadel-constitutional-layers-test') {
        return Promise.resolve({ Items: [{ layerId: 'l-1' }] });
      }
      if (t === 'citadel-case-law-test') {
        return Promise.resolve({ Items: [{ entryId: 'e-1' }] });
      }
      return Promise.resolve({ Items: [] });
    });
    ddbMock.on(PutCommand).resolves({});

    const before = Math.floor(Date.now() / 1000);
    const result = await handler(streamEvent(1));
    const after = Math.floor(Date.now() / 1000);

    expect(result.ok).toBe(true);
    expect(typeof result.snapshotId).toBe('string');
    expect(result.recordCount).toBe(1);

    const scanCalls = ddbMock.commandCalls(ScanCommand);
    const tables = new Set(
      scanCalls.map((c) => (c.args[0].input as any).TableName),
    );
    expect(tables).toContain('citadel-authority-units-test');
    expect(tables).toContain('citadel-composition-contracts-test');
    expect(tables).toContain('citadel-constitutional-layers-test');
    expect(tables).toContain('citadel-case-law-test');

    const puts = ddbMock.commandCalls(PutCommand);
    expect(puts).toHaveLength(1);
    const item = puts[0].args[0].input.Item as any;
    expect(item.kind).toBe('full');
    expect(item.trigger).toBe('OnChange');
    expect(item.snapshotId).toBe(result.snapshotId);
    expect(item.timestamp).toBeGreaterThanOrEqual(before);
    expect(item.timestamp).toBeLessThanOrEqual(after);
    expect(item.expiresAt).toBe(item.timestamp + 7 * 86400);
    expect(item.env).toBe('test');
    expect(item.authorityUnits).toEqual([{ unitId: 'u-1' }]);
    expect(item.compositionContracts).toEqual([{ contractId: 'c-1' }]);
    expect(item.constitutionalLayers).toEqual([{ layerId: 'l-1' }]);
    expect(item.caseLaw).toEqual([{ entryId: 'e-1' }]);
  });

  test('debounce — 5 stream records in one invocation produce exactly 1 snapshot row', async () => {
    stubSettings(
      '{"enabled":true,"retentionDays":30,"captureMode":"on-change"}',
    );
    ddbMock.on(ScanCommand).resolves({ Items: [] });
    ddbMock.on(PutCommand).resolves({});

    const result = await handler(streamEvent(5, 'MODIFY'));

    expect(result.ok).toBe(true);
    expect(result.recordCount).toBe(5);

    // The 4 source-table scans run regardless of record count, and the
    // result is a SINGLE snapshot row regardless of batch size.
    const puts = ddbMock.commandCalls(PutCommand);
    expect(puts).toHaveLength(1);
  });

  test('writes snapshot to GRAPH_SNAPSHOTS_TABLE', async () => {
    stubSettings(
      '{"enabled":true,"retentionDays":30,"captureMode":"on-change"}',
    );
    ddbMock.on(ScanCommand).resolves({ Items: [] });
    ddbMock.on(PutCommand).resolves({});

    await handler(streamEvent(1));

    const puts = ddbMock.commandCalls(PutCommand);
    expect(puts).toHaveLength(1);
    expect((puts[0].args[0].input as any).TableName).toBe(
      'citadel-governance-graph-snapshots-test',
    );
  });

  test('emits CloudWatch metric with Trigger=OnChange dimension on success', async () => {
    stubSettings(
      '{"enabled":true,"retentionDays":30,"captureMode":"on-change"}',
    );
    ddbMock.on(ScanCommand).resolves({ Items: [] });
    ddbMock.on(PutCommand).resolves({});

    await handler(streamEvent(1));

    const metrics = cwMock.commandCalls(PutMetricDataCommand);
    expect(metrics).toHaveLength(1);
    const md = metrics[0].args[0].input.MetricData![0];
    expect(md.MetricName).toBe('Count');
    expect(md.Value).toBe(1);
    const dims = md.Dimensions ?? [];
    const triggerDim = dims.find((d: any) => d.Name === 'Trigger');
    expect(triggerDim?.Value).toBe('OnChange');
    const statusDim = dims.find((d: any) => d.Name === 'Status');
    expect(statusDim?.Value).toBe('Success');
    const partialDim = dims.find((d: any) => d.Name === 'Partial');
    expect(partialDim?.Value).toBe('false');
  });

  test('single-table read failure — snapshot marked partial:true and continues', async () => {
    stubSettings(
      '{"enabled":true,"retentionDays":30,"captureMode":"on-change"}',
    );
    ddbMock.on(ScanCommand).callsFake((input: any) => {
      const t: string = input?.TableName ?? '';
      if (t === 'citadel-case-law-test') {
        return Promise.reject(new Error('throttled'));
      }
      return Promise.resolve({ Items: [] });
    });
    ddbMock.on(PutCommand).resolves({});

    const result = await handler(streamEvent(1));

    expect(result.ok).toBe(true);
    expect(result.partial).toBe(true);

    const puts = ddbMock.commandCalls(PutCommand);
    expect(puts).toHaveLength(1);
    const item = puts[0].args[0].input.Item as any;
    expect(item.partial).toBe(true);
    expect(item.caseLaw).toEqual([]);

    // Success metric still fires (snapshot was written), with Partial=true.
    const metrics = cwMock.commandCalls(PutMetricDataCommand);
    expect(metrics).toHaveLength(1);
    const md = metrics[0].args[0].input.MetricData![0];
    const dims = md.Dimensions ?? [];
    const statusDim = dims.find((d: any) => d.Name === 'Status');
    expect(statusDim?.Value).toBe('Success');
    const partialDim = dims.find((d: any) => d.Name === 'Partial');
    expect(partialDim?.Value).toBe('true');
  });

  test('all 4 source tables fail — throws and emits failure metric', async () => {
    stubSettings(
      '{"enabled":true,"retentionDays":30,"captureMode":"on-change"}',
    );
    ddbMock.on(ScanCommand).rejects(new Error('throttled'));

    await expect(handler(streamEvent(1))).rejects.toThrow(
      /all 4 source-table reads failed/,
    );

    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    const metrics = cwMock.commandCalls(PutMetricDataCommand);
    expect(metrics).toHaveLength(1);
    const md = metrics[0].args[0].input.MetricData![0];
    const dims = md.Dimensions ?? [];
    const statusDim = dims.find((d: any) => d.Name === 'Status');
    expect(statusDim?.Value).toBe('Failure');
  });

  test('PutCommand failure — throws and emits failure metric', async () => {
    stubSettings(
      '{"enabled":true,"retentionDays":30,"captureMode":"on-change"}',
    );
    ddbMock.on(ScanCommand).resolves({ Items: [] });
    ddbMock.on(PutCommand).rejects(new Error('write failure'));

    await expect(handler(streamEvent(1))).rejects.toThrow(/write failure/);

    const metrics = cwMock.commandCalls(PutMetricDataCommand);
    expect(metrics).toHaveLength(1);
    const md = metrics[0].args[0].input.MetricData![0];
    const dims = md.Dimensions ?? [];
    const statusDim = dims.find((d: any) => d.Name === 'Status');
    expect(statusDim?.Value).toBe('Failure');
  });

  test('skips when captureMode === "daily"', async () => {
    stubSettings(
      '{"enabled":true,"retentionDays":30,"captureMode":"daily"}',
    );

    const result = await handler(streamEvent(3));

    expect(result.ok).toBe(true);
    expect(result.snapshotId).toBeNull();
    expect(result.reason).toBe('captureMode-skipped');
    expect(result.recordCount).toBe(3);
    // No DDB scans + no PutItem.
    expect(ddbMock.commandCalls(ScanCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    // No metric emit on the captureMode-skip path.
    expect(cwMock.commandCalls(PutMetricDataCommand)).toHaveLength(0);
  });

  test('runs when captureMode === "both"', async () => {
    stubSettings(
      '{"enabled":true,"retentionDays":30,"captureMode":"both"}',
    );
    ddbMock.on(ScanCommand).resolves({ Items: [] });
    ddbMock.on(PutCommand).resolves({});

    const result = await handler(streamEvent(1));

    expect(result.ok).toBe(true);
    expect(typeof result.snapshotId).toBe('string');

    const scanCalls = ddbMock.commandCalls(ScanCommand);
    expect(scanCalls.length).toBeGreaterThanOrEqual(4);

    const puts = ddbMock.commandCalls(PutCommand);
    expect(puts).toHaveLength(1);
    const item = puts[0].args[0].input.Item as any;
    expect(item.trigger).toBe('OnChange');
  });
});
