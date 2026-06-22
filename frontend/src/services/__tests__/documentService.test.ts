/**
 * @jest-environment node
 *
 * Tests for documentService.waitForDocumentIndexed grace-window behavior.
 *
 * Regression coverage for Issue #8: NOT_FOUND right after ingestion is a transient
 * pre-indexing state (Bedrock eventual consistency), not an immediate terminal failure.
 */

jest.mock('../server', () => ({
  __esModule: true,
  default: {
    query: jest.fn(),
    mutate: jest.fn(),
  },
}));

import serverService from '../server';
import { waitForDocumentIndexed } from '../documentService';

const mockQuery = serverService.query as jest.Mock;

const statusResponse = (status: string, statusReason?: string) => ({
  getDocumentIngestionStatus: { documentKey: 'proj-1/a.pdf', status, statusReason },
});

describe('waitForDocumentIndexed', () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  test('keeps polling on NOT_FOUND within the grace window, then resolves on INDEXED', async () => {
    mockQuery
      .mockResolvedValueOnce(statusResponse('NOT_FOUND'))
      .mockResolvedValueOnce(statusResponse('NOT_FOUND'))
      .mockResolvedValueOnce(statusResponse('INDEXED'));

    const result = await waitForDocumentIndexed('proj-1', 'proj-1/a.pdf', {
      pollIntervalMs: 1,
      gracePeriodMs: 10_000,
      timeoutMs: 10_000,
    });

    expect(result.status).toBe('INDEXED');
    expect(mockQuery).toHaveBeenCalledTimes(3);
  });

  test('treats IGNORED (Bedrock dedup) as transient and resolves once INDEXED', async () => {
    mockQuery
      .mockResolvedValueOnce(statusResponse('IGNORED', 'You submitted multiple requests for the same document'))
      .mockResolvedValueOnce(statusResponse('INDEXED'));

    const result = await waitForDocumentIndexed('proj-1', 'proj-1/a.pdf', {
      pollIntervalMs: 1,
      gracePeriodMs: 10_000,
      timeoutMs: 10_000,
    });

    expect(result.status).toBe('INDEXED');
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  test('throws immediately on FAILED', async () => {
    mockQuery.mockResolvedValueOnce(statusResponse('FAILED', 'parse error'));

    await expect(
      waitForDocumentIndexed('proj-1', 'proj-1/a.pdf', {
        pollIntervalMs: 1,
        gracePeriodMs: 10_000,
        timeoutMs: 10_000,
      })
    ).rejects.toThrow('Indexing failed: FAILED');

    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  test('treats persistent NOT_FOUND as terminal once the grace window has elapsed', async () => {
    mockQuery.mockResolvedValue(statusResponse('NOT_FOUND'));

    await expect(
      waitForDocumentIndexed('proj-1', 'proj-1/a.pdf', {
        pollIntervalMs: 1,
        gracePeriodMs: 0,
        timeoutMs: 10_000,
      })
    ).rejects.toThrow('NOT_FOUND');
  });
});
