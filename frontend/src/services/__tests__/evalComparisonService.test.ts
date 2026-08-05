/**
 * evalComparisonService tests (CIT-105 UI).
 *
 * Mocks the AppSync `serverService` singleton and asserts each exported
 * function issues the correct GraphQL operation name + variables and
 * returns the unwrapped payload. Field names mirror
 * backend/src/schema/schema.graphql verbatim.
 */

import serverService from '../server';

jest.mock('../server', () => ({
  __esModule: true,
  default: {
    query: jest.fn(),
    mutate: jest.fn(),
  },
}));

import { evalComparisonService } from '../evalComparisonService';

const mockQuery = serverService.query as jest.Mock;
const mockMutate = serverService.mutate as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
});

describe('evalComparisonService', () => {
  it('getEvalBaseline queries with orgId/agentTargetId/suiteId and unwraps the payload', async () => {
    const baseline = { orgId: 'o1', agentTargetId: 'a1', suiteId: 's1', baselineEvalRunId: 'r1' };
    mockQuery.mockResolvedValue({ getEvalBaseline: baseline });

    const result = await evalComparisonService.getEvalBaseline('o1', 'a1', 's1');

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('getEvalBaseline'),
      { orgId: 'o1', agentTargetId: 'a1', suiteId: 's1' },
    );
    expect(result).toEqual(baseline);
  });

  it('getEvalBaseline returns null when no baseline is designated', async () => {
    mockQuery.mockResolvedValue({ getEvalBaseline: null });
    const result = await evalComparisonService.getEvalBaseline('o1', 'a1', 's1');
    expect(result).toBeNull();
  });

  it('listEvalBaselines queries with orgId only', async () => {
    mockQuery.mockResolvedValue({ listEvalBaselines: [] });
    const result = await evalComparisonService.listEvalBaselines('o1');
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('listEvalBaselines'),
      { orgId: 'o1' },
    );
    expect(result).toEqual([]);
  });

  it('getEvalComparison queries by comparisonId', async () => {
    const verdict = { comparisonId: 'c1', verdictStatus: 'PASS' };
    mockQuery.mockResolvedValue({ getEvalComparison: verdict });
    const result = await evalComparisonService.getEvalComparison('c1');
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('getEvalComparison'),
      { comparisonId: 'c1' },
    );
    expect(result).toEqual(verdict);
  });

  it('listEvalComparisons queries with orgId and optional suiteId', async () => {
    mockQuery.mockResolvedValue({ listEvalComparisons: [] });
    await evalComparisonService.listEvalComparisons('o1', 's1');
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('listEvalComparisons'),
      { orgId: 'o1', suiteId: 's1' },
    );
  });

  it('listEvalComparisons omits suiteId when not provided', async () => {
    mockQuery.mockResolvedValue({ listEvalComparisons: [] });
    await evalComparisonService.listEvalComparisons('o1');
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('listEvalComparisons'),
      { orgId: 'o1', suiteId: undefined },
    );
  });

  it('getEvalComparisonThresholdConfig queries with orgId/suiteId', async () => {
    mockQuery.mockResolvedValue({ getEvalComparisonThresholdConfig: null });
    const result = await evalComparisonService.getEvalComparisonThresholdConfig('o1', 's1');
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('getEvalComparisonThresholdConfig'),
      { orgId: 'o1', suiteId: 's1' },
    );
    expect(result).toBeNull();
  });

  it('designateEvalBaseline mutates with the input and unwraps the result', async () => {
    const input = {
      orgId: 'o1',
      agentTargetId: 'a1',
      suiteId: 's1',
      baselineEvalRunId: 'r1',
      reason: 'promote',
    };
    const baseline = { ...input, designatedAt: '2026-01-01T00:00:00Z', designatedBy: 'u1', version: 1 };
    mockMutate.mockResolvedValue({ designateEvalBaseline: baseline });

    const result = await evalComparisonService.designateEvalBaseline(input);

    expect(mockMutate).toHaveBeenCalledWith(
      expect.stringContaining('designateEvalBaseline'),
      { input },
    );
    expect(result).toEqual(baseline);
  });

  it('computeEvalComparison mutates with the input and unwraps the verdict', async () => {
    const input = {
      orgId: 'o1',
      suiteId: 's1',
      candidateEvalRunIds: ['r2'],
      idempotencyKey: 'key-1',
    };
    const verdict = { comparisonId: 'c1', verdictStatus: 'PASS' };
    mockMutate.mockResolvedValue({ computeEvalComparison: verdict });

    const result = await evalComparisonService.computeEvalComparison(input);

    expect(mockMutate).toHaveBeenCalledWith(
      expect.stringContaining('computeEvalComparison'),
      { input },
    );
    expect(result).toEqual(verdict);
  });

  it('setEvalComparisonThresholdConfig mutates with orgId/suiteId/input', async () => {
    const thresholds = { passRateDropThreshold: 0.2 };
    const row = { orgId: 'o1', suiteId: 's1', thresholds, version: 1 };
    mockMutate.mockResolvedValue({ setEvalComparisonThresholdConfig: row });

    const result = await evalComparisonService.setEvalComparisonThresholdConfig(
      'o1',
      's1',
      { thresholds },
    );

    expect(mockMutate).toHaveBeenCalledWith(
      expect.stringContaining('setEvalComparisonThresholdConfig'),
      { orgId: 'o1', suiteId: 's1', input: { thresholds } },
    );
    expect(result).toEqual(row);
  });

  it('propagates query errors (e.g. cross-org / unauthorized) verbatim', async () => {
    mockQuery.mockRejectedValue(new Error('UnauthorizedError: eval:run permission required'));
    await expect(evalComparisonService.getEvalComparison('c1')).rejects.toThrow(
      'UnauthorizedError: eval:run permission required',
    );
  });
});
