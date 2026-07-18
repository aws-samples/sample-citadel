/**
 * Tests for governance-graph-snapshot Lambda — Wave 4.E.A.
 *
 * Mirrors the style of the governance-mode-refresher test: env vars
 * set before imports, mocks for SSM / DDB / CloudWatch via
 * aws-sdk-client-mock. We assert the early-skip path, the success
 * path, partial-failure handling, and the all-fail-throws contract.
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

import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBDocumentClient,
  PutCommand,
  ScanCommand,
  type ScanCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import {
  CloudWatchClient,
  PutMetricDataCommand,
} from '@aws-sdk/client-cloudwatch';

const ddbMock = mockClient(DynamoDBDocumentClient);
const ssmMock = mockClient(SSMClient);
const cwMock = mockClient(CloudWatchClient);

import { handler } from '../governance-graph-snapshot';

beforeEach(() => {
  ddbMock.reset();
  ssmMock.reset();
  cwMock.reset();
  jest.spyOn(console, 'error').mockImplementation();
  jest.spyOn(console, 'log').mockImplementation();
});

afterEach(() => {
  jest.restoreAllMocks();
});

function stubSettings(value: string) {
  ssmMock.on(GetParameterCommand).resolves({
    Parameter: { Value: value },
  });
}

/** Shape of the snapshot row the handler writes — typed view for assertions. */
interface SnapshotRow {
  snapshotId: string;
  kind: string;
  timestamp: number;
  expiresAt: number;
  env: string;
  partial: boolean;
  authorityUnits: Array<Record<string, unknown>>;
  compositionContracts: Array<Record<string, unknown>>;
  constitutionalLayers: Array<Record<string, unknown>>;
  caseLaw: Array<Record<string, unknown>>;
}

describe('governance-graph-snapshot handler', () => {
  test('skips early when settings.enabled === false', async () => {
    stubSettings(
      '{"enabled":false,"retentionDays":30,"captureMode":"daily"}',
    );
    const result = await handler();

    expect(result.ok).toBe(true);
    expect(result.snapshotId).toBeNull();
    expect(result.reason).toBe('disabled');
    // No DDB scans + no PutItem.
    expect(ddbMock.commandCalls(ScanCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    // No metric emit on the skip path.
    expect(cwMock.commandCalls(PutMetricDataCommand)).toHaveLength(0);
  });

  test('reads all 4 source tables when enabled', async () => {
    stubSettings(
      '{"enabled":true,"retentionDays":30,"captureMode":"daily"}',
    );
    ddbMock.on(ScanCommand).resolves({ Items: [] });
    ddbMock.on(PutCommand).resolves({});

    await handler();

    const scanCalls = ddbMock.commandCalls(ScanCommand);
    expect(scanCalls.length).toBeGreaterThanOrEqual(4);
    const tables = new Set(
      scanCalls.map((c) => c.args[0].input.TableName),
    );
    expect(tables).toContain('citadel-authority-units-test');
    expect(tables).toContain('citadel-composition-contracts-test');
    expect(tables).toContain('citadel-constitutional-layers-test');
    expect(tables).toContain('citadel-case-law-test');
  });

  test('composes snapshot with correct shape (snapshotId, kind, timestamp, expiresAt, all 4 source arrays)', async () => {
    stubSettings(
      '{"enabled":true,"retentionDays":7,"captureMode":"daily"}',
    );
    ddbMock.on(ScanCommand).callsFake((input: ScanCommandInput) => {
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
    const result = await handler();
    const after = Math.floor(Date.now() / 1000);

    expect(result.ok).toBe(true);
    expect(typeof result.snapshotId).toBe('string');

    // Inspect the snapshot row written.
    const puts = ddbMock.commandCalls(PutCommand);
    expect(puts).toHaveLength(1);
    const item = puts[0].args[0].input.Item as unknown as SnapshotRow;
    expect(item.kind).toBe('full');
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

  test('PutItem writes to the snapshots table', async () => {
    stubSettings(
      '{"enabled":true,"retentionDays":30,"captureMode":"daily"}',
    );
    ddbMock.on(ScanCommand).resolves({ Items: [] });
    ddbMock.on(PutCommand).resolves({});

    await handler();

    const puts = ddbMock.commandCalls(PutCommand);
    expect(puts).toHaveLength(1);
    expect(puts[0].args[0].input.TableName).toBe(
      'citadel-governance-graph-snapshots-test',
    );
  });

  test('emits CloudWatch success metric on a clean snapshot write', async () => {
    stubSettings(
      '{"enabled":true,"retentionDays":30,"captureMode":"daily"}',
    );
    ddbMock.on(ScanCommand).resolves({ Items: [] });
    ddbMock.on(PutCommand).resolves({});

    await handler();

    const metrics = cwMock.commandCalls(PutMetricDataCommand);
    expect(metrics).toHaveLength(1);
    const md = metrics[0].args[0].input.MetricData![0];
    expect(md.MetricName).toBe('Count');
    expect(md.Value).toBe(1);
    const dims = md.Dimensions ?? [];
    const statusDim = dims.find((d) => d.Name === 'Status');
    expect(statusDim?.Value).toBe('Success');
    const partialDim = dims.find((d) => d.Name === 'Partial');
    expect(partialDim?.Value).toBe('false');
  });

  test('single-table read failure → snapshot marked partial:true and continues', async () => {
    stubSettings(
      '{"enabled":true,"retentionDays":30,"captureMode":"daily"}',
    );
    ddbMock.on(ScanCommand).callsFake((input: ScanCommandInput) => {
      const t: string = input?.TableName ?? '';
      if (t === 'citadel-case-law-test') {
        return Promise.reject(new Error('throttled'));
      }
      return Promise.resolve({ Items: [] });
    });
    ddbMock.on(PutCommand).resolves({});

    const result = await handler();

    expect(result.ok).toBe(true);
    expect(result.partial).toBe(true);

    // Snapshot row records partial:true and an empty caseLaw array.
    const puts = ddbMock.commandCalls(PutCommand);
    expect(puts).toHaveLength(1);
    const item = puts[0].args[0].input.Item as unknown as SnapshotRow;
    expect(item.partial).toBe(true);
    expect(item.caseLaw).toEqual([]);

    // The success metric still fires (we did write a snapshot), but the
    // Partial dimension is true.
    const metrics = cwMock.commandCalls(PutMetricDataCommand);
    expect(metrics).toHaveLength(1);
    const dims =
      metrics[0].args[0].input.MetricData![0].Dimensions ?? [];
    const statusDim = dims.find((d) => d.Name === 'Status');
    expect(statusDim?.Value).toBe('Success');
    const partialDim = dims.find((d) => d.Name === 'Partial');
    expect(partialDim?.Value).toBe('true');
  });

  test('all 4 tables fail → emits failure metric and throws', async () => {
    stubSettings(
      '{"enabled":true,"retentionDays":30,"captureMode":"daily"}',
    );
    ddbMock
      .on(ScanCommand)
      .rejects(new Error('table outage'));

    await expect(handler()).rejects.toThrow(
      'all 4 source-table reads failed',
    );

    // No PutItem (we never reached the write step).
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    // Failure metric emitted.
    const metrics = cwMock.commandCalls(PutMetricDataCommand);
    expect(metrics).toHaveLength(1);
    const dims =
      metrics[0].args[0].input.MetricData![0].Dimensions ?? [];
    const statusDim = dims.find((d) => d.Name === 'Status');
    expect(statusDim?.Value).toBe('Failure');
  });

  test('returns safe-default settings (skip path) when SSM read throws', async () => {
    ssmMock
      .on(GetParameterCommand)
      .rejects(new Error('ParameterNotFound'));
    const result = await handler();

    // Defaults are enabled=false, so the skip path runs.
    expect(result.ok).toBe(true);
    expect(result.reason).toBe('disabled');
    expect(ddbMock.commandCalls(ScanCommand)).toHaveLength(0);
  });

  test('skips when captureMode === "on-change"', async () => {
    stubSettings(
      '{"enabled":true,"retentionDays":30,"captureMode":"on-change"}',
    );

    const result = await handler();

    expect(result.ok).toBe(true);
    expect(result.snapshotId).toBeNull();
    expect(result.reason).toBe('captureMode-skipped');
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

    const result = await handler();

    expect(result.ok).toBe(true);
    expect(typeof result.snapshotId).toBe('string');

    const scanCalls = ddbMock.commandCalls(ScanCommand);
    expect(scanCalls.length).toBeGreaterThanOrEqual(4);
    const tables = new Set(
      scanCalls.map((c) => c.args[0].input.TableName),
    );
    expect(tables).toContain('citadel-authority-units-test');
    expect(tables).toContain('citadel-composition-contracts-test');
    expect(tables).toContain('citadel-constitutional-layers-test');
    expect(tables).toContain('citadel-case-law-test');

    const puts = ddbMock.commandCalls(PutCommand);
    expect(puts).toHaveLength(1);
  });
});
