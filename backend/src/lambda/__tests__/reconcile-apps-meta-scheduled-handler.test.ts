/**
 * Tests for reconcile-apps-meta-scheduled-handler — verifies the handler
 * delegates to runReconciliation with apply:true, returns the summary in
 * the expected envelope on success, and re-throws on failure so the
 * Lambda retry policy / DLQ pathway can take over.
 */

const mockRunReconciliation = jest.fn();
jest.mock('../../../scripts/reconcile-apps-meta', () => ({
  runReconciliation: mockRunReconciliation,
}));

import { handler } from '../reconcile-apps-meta-scheduled-handler';

describe('reconcile-apps-meta-scheduled-handler', () => {
  let logSpy: jest.SpyInstance;
  let errSpy: jest.SpyInstance;

  beforeEach(() => {
    mockRunReconciliation.mockReset();
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it('returns statusCode 200 with the summary body on success', async () => {
    const summary = {
      mode: 'apply' as const,
      scannedRegistry: 3,
      scannedMeta: 3,
      inSync: 3,
      missing: 0,
      stale: 0,
      orphan: 0,
      fixed: 0,
      errors: 0,
    };
    mockRunReconciliation.mockResolvedValue(summary);

    const result = await handler();

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual(summary);
  });

  it('always passes apply:true to runReconciliation', async () => {
    mockRunReconciliation.mockResolvedValue({
      mode: 'apply',
      scannedRegistry: 0,
      scannedMeta: 0,
      inSync: 0,
      missing: 0,
      stale: 0,
      orphan: 0,
      fixed: 0,
      errors: 0,
    });

    await handler();

    expect(mockRunReconciliation).toHaveBeenCalledTimes(1);
    expect(mockRunReconciliation).toHaveBeenCalledWith({ apply: true });
  });

  it('re-throws and logs when runReconciliation rejects', async () => {
    const boom = new Error('registry exploded');
    mockRunReconciliation.mockRejectedValue(boom);

    await expect(handler()).rejects.toThrow('registry exploded');
    expect(errSpy).toHaveBeenCalledWith(
      '[reconcile-apps-meta-scheduled] failed:',
      boom,
    );
  });
});
