/**
 * useGovernanceEngine tests
 *
 * Mocks `governanceService` and asserts:
 *   - Subscribes to the 4 service queries on mount.
 *   - Returns engine = null while any query is pending.
 *   - Returns a constructed GovernanceEngine when all 4 succeed.
 *   - Surfaces an error string when any one query rejects.
 *   - refresh() re-fetches and rebuilds a NEW engine instance.
 */

import { renderHook, act, waitFor } from '@testing-library/react';

jest.mock('@/services/governanceService', () => ({
  governanceService: {
    listAuthorityUnits: jest.fn(),
    listCompositionContracts: jest.fn(),
    listConstitutionalLayers: jest.fn(),
    listCaseLaw: jest.fn(),
  },
}));

import { governanceService } from '@/services/governanceService';
import { useGovernanceEngine } from '@/hooks/useGovernanceEngine';
import { GovernanceEngine } from '@/lib/governance-engine';

const mockedService = governanceService as jest.Mocked<typeof governanceService>;

function setAllEmpty(): void {
  mockedService.listAuthorityUnits.mockResolvedValue([]);
  mockedService.listCompositionContracts.mockResolvedValue([]);
  mockedService.listConstitutionalLayers.mockResolvedValue([]);
  mockedService.listCaseLaw.mockResolvedValue([]);
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('useGovernanceEngine', () => {
  it('subscribes to the 4 service queries on mount', async () => {
    setAllEmpty();
    const { result } = renderHook(() => useGovernanceEngine());
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(mockedService.listAuthorityUnits).toHaveBeenCalledTimes(1);
    expect(mockedService.listCompositionContracts).toHaveBeenCalledTimes(1);
    expect(mockedService.listConstitutionalLayers).toHaveBeenCalledTimes(1);
    expect(mockedService.listCaseLaw).toHaveBeenCalledTimes(1);
  });

  it('returns engine = null and loading = true while any of the 4 are pending', async () => {
    // Authority units never settles in this test (the other three resolve
    // immediately). The hook should remain in loading state, engine = null.
    let resolveUnits: (() => void) | null = null;
    mockedService.listAuthorityUnits.mockReturnValue(
      new Promise(() => {
        // never resolves
      }),
    );
    mockedService.listCompositionContracts.mockResolvedValue([]);
    mockedService.listConstitutionalLayers.mockResolvedValue([]);
    mockedService.listCaseLaw.mockResolvedValue([]);

    const { result } = renderHook(() => useGovernanceEngine());

    // Initial render: loading is true and engine is null.
    expect(result.current.loading).toBe(true);
    expect(result.current.engine).toBeNull();
    expect(result.current.error).toBeNull();

    // Suppress the unused-binding warning — we declared the resolver
    // for parity with the symmetric tests below but never invoke it.
    void resolveUnits;
  });

  it('returns a constructed GovernanceEngine when all 4 queries succeed', async () => {
    setAllEmpty();
    const { result } = renderHook(() => useGovernanceEngine());

    await waitFor(() => {
      expect(result.current.engine).toBeInstanceOf(GovernanceEngine);
    });
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('surfaces an error string when any one query rejects (engine remains null)', async () => {
    mockedService.listAuthorityUnits.mockResolvedValue([]);
    mockedService.listCompositionContracts.mockResolvedValue([]);
    mockedService.listConstitutionalLayers.mockRejectedValue(
      new Error('SSM read failed for layers'),
    );
    mockedService.listCaseLaw.mockResolvedValue([]);

    const { result } = renderHook(() => useGovernanceEngine());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.error).toBe('SSM read failed for layers');
    expect(result.current.engine).toBeNull();
  });

  it('refresh() re-fetches all 4 queries and rebuilds a fresh engine', async () => {
    setAllEmpty();
    const { result } = renderHook(() => useGovernanceEngine());

    await waitFor(() => {
      expect(result.current.engine).toBeInstanceOf(GovernanceEngine);
    });
    const firstEngine = result.current.engine;

    // refresh triggers a new fetch cycle.
    await act(async () => {
      result.current.refresh();
    });
    await waitFor(() => {
      expect(result.current.engine).toBeInstanceOf(GovernanceEngine);
    });

    expect(mockedService.listAuthorityUnits).toHaveBeenCalledTimes(2);
    expect(mockedService.listCompositionContracts).toHaveBeenCalledTimes(2);
    expect(mockedService.listConstitutionalLayers).toHaveBeenCalledTimes(2);
    expect(mockedService.listCaseLaw).toHaveBeenCalledTimes(2);

    // Critically, refresh constructs a NEW engine — engines are designed
    // as effectively immutable and the slice contract requires this.
    expect(result.current.engine).not.toBe(firstEngine);
  });

  it('refresh() while errored re-fetches and recovers when queries succeed', async () => {
    mockedService.listAuthorityUnits.mockRejectedValueOnce(
      new Error('transient SSM failure'),
    );
    mockedService.listCompositionContracts.mockResolvedValue([]);
    mockedService.listConstitutionalLayers.mockResolvedValue([]);
    mockedService.listCaseLaw.mockResolvedValue([]);

    const { result } = renderHook(() => useGovernanceEngine());

    await waitFor(() => {
      expect(result.current.error).toBe('transient SSM failure');
    });
    expect(result.current.engine).toBeNull();

    // Subsequent listAuthorityUnits resolves cleanly.
    mockedService.listAuthorityUnits.mockResolvedValue([]);

    await act(async () => {
      result.current.refresh();
    });

    await waitFor(() => {
      expect(result.current.engine).toBeInstanceOf(GovernanceEngine);
    });
    expect(result.current.error).toBeNull();
  });
});
