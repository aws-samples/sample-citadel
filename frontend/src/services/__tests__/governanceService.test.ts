/**
 * governanceService tests
 *
 * Mocks serverService.query so we can assert the GraphQL query strings,
 * variable plumbing, response mapping, and the contract-mandated error
 * behaviour (mode swallows, finding null-ok, others rethrow).
 */

jest.mock('../server', () => ({
  __esModule: true,
  default: {
    query: jest.fn(),
    mutate: jest.fn(),
    subscribe: jest.fn(),
  },
}));

import serverService from '../server';
import { governanceService } from '../governanceService';

describe('governanceService.getGovernanceMode', () => {
  beforeEach(() => jest.clearAllMocks());

  it('queries getGovernanceMode and maps the response shape', async () => {
    (serverService.query as jest.Mock).mockResolvedValue({
      getGovernanceMode: { enforce: 'shadow', effectiveAt: '2026-01-01T00:00:00Z', env: 'dev' },
    });

    const result = await governanceService.getGovernanceMode();

    expect(serverService.query).toHaveBeenCalledTimes(1);
    const [queryString] = (serverService.query as jest.Mock).mock.calls[0];
    expect(queryString).toContain('getGovernanceMode');
    expect(queryString).toContain('enforce');
    expect(queryString).toContain('effectiveAt');
    expect(queryString).toContain('env');

    expect(result).toEqual({ enforce: 'shadow', effectiveAt: '2026-01-01T00:00:00Z', env: 'dev' });
  });

  it('returns the permissive fallback (NOT throws) when the query rejects', async () => {
    (serverService.query as jest.Mock).mockRejectedValue(new Error('network down'));

    const result = await governanceService.getGovernanceMode();

    expect(result).toEqual({ enforce: 'permissive', effectiveAt: null, env: 'unknown' });
  });

  it('returns the permissive fallback when response is empty', async () => {
    (serverService.query as jest.Mock).mockResolvedValue({});

    const result = await governanceService.getGovernanceMode();

    expect(result).toEqual({ enforce: 'permissive', effectiveAt: null, env: 'unknown' });
  });
});

describe('governanceService.listGovernanceFindings', () => {
  beforeEach(() => jest.clearAllMocks());

  it('passes args through to variables and parses connection shape', async () => {
    (serverService.query as jest.Mock).mockResolvedValue({
      listGovernanceFindings: {
        items: [
          {
            findingId: 'f-1',
            workflowId: 'wf-1',
            decision: 'permit',
            reason: 'unit_match',
            requestingAgent: 'a',
            targetAgent: 'b',
            scopeEvaluated: 'scope-1',
            contractEvaluated: null,
            escalationTarget: null,
            residualAuthorityDenial: false,
            timestamp: 1700000000.5,
          },
        ],
        nextCursor: 'cur-2',
      },
    });

    const result = await governanceService.listGovernanceFindings({
      limit: 25,
      decision: 'permit',
      sinceTs: 1700000000,
      workflowId: 'wf-1',
      cursor: null,
    });

    const [queryString, variables] = (serverService.query as jest.Mock).mock.calls[0];
    expect(queryString).toContain('listGovernanceFindings');
    expect(queryString).toContain('items');
    expect(queryString).toContain('nextCursor');
    expect(queryString).toContain('residualAuthorityDenial');
    expect(variables).toEqual({
      limit: 25,
      cursor: null,
      decision: 'permit',
      workflowId: 'wf-1',
      sinceTs: 1700000000,
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0].findingId).toBe('f-1');
    expect(result.nextCursor).toBe('cur-2');
  });

  it('defaults missing args to null variables', async () => {
    (serverService.query as jest.Mock).mockResolvedValue({
      listGovernanceFindings: { items: [], nextCursor: null },
    });

    await governanceService.listGovernanceFindings();

    const [, variables] = (serverService.query as jest.Mock).mock.calls[0];
    expect(variables).toEqual({
      limit: null,
      cursor: null,
      decision: null,
      workflowId: null,
      sinceTs: null,
    });
  });

  it('rethrows GraphQL errors so the page can decide on fallback', async () => {
    (serverService.query as jest.Mock).mockRejectedValue(new Error('bad input'));

    await expect(governanceService.listGovernanceFindings({})).rejects.toThrow('bad input');
  });
});

describe('governanceService.getGovernanceFinding', () => {
  beforeEach(() => jest.clearAllMocks());

  it('passes findingId variable and returns the finding', async () => {
    const finding = {
      findingId: 'f-42',
      workflowId: 'wf-9',
      decision: 'deny',
      reason: 'rivalrous_claim:winner=X',
      requestingAgent: 'a',
      targetAgent: 'b',
      scopeEvaluated: null,
      contractEvaluated: null,
      escalationTarget: null,
      residualAuthorityDenial: true,
      timestamp: 1.5,
    };
    (serverService.query as jest.Mock).mockResolvedValue({ getGovernanceFinding: finding });

    const result = await governanceService.getGovernanceFinding('f-42');

    const [queryString, variables] = (serverService.query as jest.Mock).mock.calls[0];
    expect(queryString).toContain('getGovernanceFinding');
    expect(queryString).toContain('findingId');
    expect(variables).toEqual({ findingId: 'f-42' });
    expect(result).toEqual(finding);
  });

  it('returns null when the resolver returns no record (no throw)', async () => {
    (serverService.query as jest.Mock).mockResolvedValue({ getGovernanceFinding: null });

    const result = await governanceService.getGovernanceFinding('missing-id');

    expect(result).toBeNull();
  });

  it('rethrows GraphQL errors', async () => {
    (serverService.query as jest.Mock).mockRejectedValue(new Error('boom'));

    await expect(governanceService.getGovernanceFinding('x')).rejects.toThrow('boom');
  });
});

describe('governanceService.getReconcilerStatus', () => {
  beforeEach(() => jest.clearAllMocks());

  it('queries the resolver and returns the parsed status', async () => {
    const status = {
      lastRunAt: '2026-05-18T10:00:00Z',
      lastRunMode: 'apply',
      classifications: { inSync: 24, missing: 1, stale: 0, orphan: 2 },
      totalRecords: 27,
    };
    (serverService.query as jest.Mock).mockResolvedValue({ getReconcilerStatus: status });

    const result = await governanceService.getReconcilerStatus();

    const [queryString] = (serverService.query as jest.Mock).mock.calls[0];
    expect(queryString).toContain('getReconcilerStatus');
    expect(queryString).toContain('classifications');
    expect(queryString).toContain('inSync');
    expect(queryString).toContain('totalRecords');
    expect(result).toEqual(status);
  });

  it('returns zero-default shape when resolver returns null', async () => {
    (serverService.query as jest.Mock).mockResolvedValue({ getReconcilerStatus: null });

    const result = await governanceService.getReconcilerStatus();

    expect(result).toEqual({
      lastRunAt: null,
      lastRunMode: null,
      classifications: { inSync: 0, missing: 0, stale: 0, orphan: 0 },
      totalRecords: 0,
    });
  });

  it('rethrows on GraphQL error (admin auth violations propagate)', async () => {
    (serverService.query as jest.Mock).mockRejectedValue(new Error('Unauthorized'));

    await expect(governanceService.getReconcilerStatus()).rejects.toThrow('Unauthorized');
  });
});

describe('governanceService.getRolloutReadiness', () => {
  beforeEach(() => jest.clearAllMocks());

  it('queries getRolloutReadiness with the expected fields and maps the response', async () => {
    const report = {
      generatedAt: 1715000000000,
      currentMode: 'shadow',
      effectiveAt: '2026-05-18T10:00:00Z',
      env: 'dev',
      shadowSoakStartedAt: '2026-05-18T10:00:00Z',
      checks: [
        {
          id: 'data-1',
          label: 'Every active AuthorityUnit has a non-null registryId',
          status: 'PASS',
          detail: 'All 5 authority units have registryId',
          evidence: null,
          category: 'data-integrity',
        },
      ],
      passCount: 1,
      failCount: 0,
      warnCount: 0,
      stubCount: 10,
    };
    (serverService.query as jest.Mock).mockResolvedValue({ getRolloutReadiness: report });

    const result = await governanceService.getRolloutReadiness();

    const [queryString] = (serverService.query as jest.Mock).mock.calls[0];
    expect(queryString).toContain('getRolloutReadiness');
    expect(queryString).toContain('generatedAt');
    expect(queryString).toContain('currentMode');
    expect(queryString).toContain('shadowSoakStartedAt');
    expect(queryString).toContain('checks');
    expect(queryString).toContain('passCount');
    expect(queryString).toContain('failCount');
    expect(queryString).toContain('warnCount');
    expect(queryString).toContain('stubCount');

    expect(result).toEqual(report);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0].status).toBe('PASS');
  });

  it('rethrows GraphQL errors (does not fall back)', async () => {
    (serverService.query as jest.Mock).mockRejectedValue(new Error('Forbidden: admin required'));

    await expect(governanceService.getRolloutReadiness()).rejects.toThrow(
      'Forbidden: admin required',
    );
  });
});

describe('governanceService.getMismatchHeatmap', () => {
  beforeEach(() => jest.clearAllMocks());

  it('queries getMismatchHeatmap with the expected fields and maps the response', async () => {
    const report = {
      generatedAt: 1715000000.5,
      sinceTs: 1714400000,
      untilTs: 1715000000,
      bucketSeconds: 3600,
      totalDenials: 7,
      totalEscalations: 2,
      modeWindows: [{ startTs: 1714400000, endTs: 1715000000, mode: 'shadow' }],
      buckets: [
        {
          bucketStart: 1714400000,
          count: 3,
          decision: 'deny',
          topReason: 'rule',
        },
      ],
    };
    (serverService.query as jest.Mock).mockResolvedValue({ getMismatchHeatmap: report });

    const result = await governanceService.getMismatchHeatmap({
      sinceTs: 1714400000,
      untilTs: 1715000000,
      bucketSeconds: 3600,
    });

    const [queryString, variables] = (serverService.query as jest.Mock).mock.calls[0];
    expect(queryString).toContain('getMismatchHeatmap');
    expect(queryString).toContain('bucketStart');
    expect(queryString).toContain('topReason');
    expect(queryString).toContain('modeWindows');
    expect(queryString).toContain('totalDenials');
    expect(queryString).toContain('totalEscalations');
    expect(variables).toEqual({
      sinceTs: 1714400000,
      untilTs: 1715000000,
      bucketSeconds: 3600,
    });

    expect(result).toEqual(report);
  });

  it('defaults missing args to null variables', async () => {
    (serverService.query as jest.Mock).mockResolvedValue({
      getMismatchHeatmap: {
        generatedAt: 0,
        sinceTs: 0,
        untilTs: 0,
        bucketSeconds: 3600,
        totalDenials: 0,
        totalEscalations: 0,
        modeWindows: [],
        buckets: [],
      },
    });

    await governanceService.getMismatchHeatmap();

    const [, variables] = (serverService.query as jest.Mock).mock.calls[0];
    expect(variables).toEqual({
      sinceTs: null,
      untilTs: null,
      bucketSeconds: null,
    });
  });

  it('rethrows GraphQL errors (admin auth violations propagate)', async () => {
    (serverService.query as jest.Mock).mockRejectedValue(new Error('Forbidden: admin required'));

    await expect(governanceService.getMismatchHeatmap()).rejects.toThrow(
      'Forbidden: admin required',
    );
  });
});

describe('governanceService.getEscalationMetricSeries', () => {
  beforeEach(() => jest.clearAllMocks());

  it('queries getEscalationMetricSeries with the expected fields and maps args through to variables', async () => {
    const series = {
      namespace: 'CitadelGovernance',
      metric: 'OffFrontierEscalations',
      statistic: 'Sum',
      periodSeconds: 3600,
      sinceTs: 1714400000,
      untilTs: 1715000000,
      datapoints: [
        { timestamp: 1714400000, value: 1 },
        { timestamp: 1714403600, value: 2 },
      ],
      total: 3,
    };
    (serverService.query as jest.Mock).mockResolvedValue({
      getEscalationMetricSeries: series,
    });

    const result = await governanceService.getEscalationMetricSeries({
      sinceTs: 1714400000,
      untilTs: 1715000000,
      periodSeconds: 3600,
    });

    const [queryString, variables] = (serverService.query as jest.Mock).mock.calls[0];
    expect(queryString).toContain('getEscalationMetricSeries');
    expect(queryString).toContain('namespace');
    expect(queryString).toContain('metric');
    expect(queryString).toContain('statistic');
    expect(queryString).toContain('periodSeconds');
    expect(queryString).toContain('datapoints');
    expect(queryString).toContain('timestamp');
    expect(queryString).toContain('value');
    expect(queryString).toContain('total');
    expect(variables).toEqual({
      sinceTs: 1714400000,
      untilTs: 1715000000,
      periodSeconds: 3600,
    });

    expect(result).toEqual(series);
    expect(result.total).toBe(3);
    expect(result.datapoints).toHaveLength(2);
  });

  it('defaults missing args to null variables', async () => {
    (serverService.query as jest.Mock).mockResolvedValue({
      getEscalationMetricSeries: {
        namespace: 'CitadelGovernance',
        metric: 'OffFrontierEscalations',
        statistic: 'Sum',
        periodSeconds: 3600,
        sinceTs: 0,
        untilTs: 0,
        datapoints: [],
        total: 0,
      },
    });

    await governanceService.getEscalationMetricSeries();

    const [, variables] = (serverService.query as jest.Mock).mock.calls[0];
    expect(variables).toEqual({
      sinceTs: null,
      untilTs: null,
      periodSeconds: null,
    });
  });

  it('rethrows GraphQL errors (admin auth violations propagate)', async () => {
    (serverService.query as jest.Mock).mockRejectedValue(new Error('Forbidden: admin required'));

    await expect(governanceService.getEscalationMetricSeries()).rejects.toThrow(
      'Forbidden: admin required',
    );
  });
});

describe('governanceService.setGovernanceMode', () => {
  beforeEach(() => jest.clearAllMocks());

  it('sends the SetGovernanceMode mutation with the input variable', async () => {
    const result = {
      ok: true,
      previousMode: 'permissive',
      newMode: 'shadow',
      effectiveAt: '2026-05-19T00:00:00Z',
      noop: false,
      emittedEventDetailType: 'governance.mode.transition',
    };
    (serverService.mutate as jest.Mock).mockResolvedValue({
      setGovernanceMode: result,
    });

    const { governanceService, MODE_FLIP_ACKNOWLEDGEMENT_TEXT } =
      // Re-import to get the live constant after mocks are wired.
      await import('../governanceService');

    const out = await governanceService.setGovernanceMode({
      targetMode: 'shadow',
      acknowledgement: MODE_FLIP_ACKNOWLEDGEMENT_TEXT,
      reason: 'soak start',
    });

    expect(serverService.mutate).toHaveBeenCalledTimes(1);
    const [mutationString, variables] = (serverService.mutate as jest.Mock)
      .mock.calls[0];
    expect(mutationString).toContain('setGovernanceMode');
    expect(mutationString).toContain('previousMode');
    expect(mutationString).toContain('newMode');
    expect(mutationString).toContain('noop');
    expect(mutationString).toContain('emittedEventDetailType');
    expect(variables).toEqual({
      input: {
        targetMode: 'shadow',
        acknowledgement: MODE_FLIP_ACKNOWLEDGEMENT_TEXT,
        reason: 'soak start',
      },
    });
    expect(out).toEqual(result);
  });

  it('defaults missing reason to null', async () => {
    (serverService.mutate as jest.Mock).mockResolvedValue({
      setGovernanceMode: {
        ok: true,
        previousMode: 'permissive',
        newMode: 'shadow',
        effectiveAt: null,
        noop: false,
        emittedEventDetailType: 'governance.mode.transition',
      },
    });

    const { governanceService, MODE_FLIP_ACKNOWLEDGEMENT_TEXT } =
      await import('../governanceService');

    await governanceService.setGovernanceMode({
      targetMode: 'shadow',
      acknowledgement: MODE_FLIP_ACKNOWLEDGEMENT_TEXT,
    });

    const [, variables] = (serverService.mutate as jest.Mock).mock.calls[0];
    expect(variables.input.reason).toBeNull();
  });

  it('round-trips a noop result (newMode === previousMode, noop=true)', async () => {
    const noopResult = {
      ok: true,
      previousMode: 'shadow',
      newMode: 'shadow',
      effectiveAt: '2026-05-01T00:00:00Z',
      noop: true,
      emittedEventDetailType: null,
    };
    (serverService.mutate as jest.Mock).mockResolvedValue({
      setGovernanceMode: noopResult,
    });

    const { governanceService, MODE_FLIP_ACKNOWLEDGEMENT_TEXT } =
      await import('../governanceService');

    const out = await governanceService.setGovernanceMode({
      targetMode: 'shadow',
      acknowledgement: MODE_FLIP_ACKNOWLEDGEMENT_TEXT,
    });

    expect(out).toEqual(noopResult);
    expect(out.noop).toBe(true);
    expect(out.emittedEventDetailType).toBeNull();
  });

  it('rethrows GraphQL errors with the original message', async () => {
    (serverService.mutate as jest.Mock).mockRejectedValue(
      new Error('Decision #8: production must flip via shadow first; permissive→strict not permitted'),
    );

    const { governanceService, MODE_FLIP_ACKNOWLEDGEMENT_TEXT } =
      await import('../governanceService');

    await expect(
      governanceService.setGovernanceMode({
        targetMode: 'strict',
        acknowledgement: MODE_FLIP_ACKNOWLEDGEMENT_TEXT,
      }),
    ).rejects.toThrow(
      'Decision #8: production must flip via shadow first; permissive→strict not permitted',
    );
  });
});

describe('governanceService.markReadinessCheckVerified', () => {
  beforeEach(() => jest.clearAllMocks());

  it('sends the MarkReadinessCheckVerified mutation with the input variable', async () => {
    const result = {
      ok: true,
      checkId: 'tel-1',
      verifiedAt: '2026-05-19T08:00:00.000Z',
      expiresAt: '2026-05-26T08:00:00.000Z',
      verifiedBy: 'sub-1',
    };
    (serverService.mutate as jest.Mock).mockResolvedValue({
      markReadinessCheckVerified: result,
    });

    const { governanceService } = await import('../governanceService');

    const out = await governanceService.markReadinessCheckVerified({
      checkId: 'tel-1',
      expiresInDays: 30,
      note: 'paged Bob in #ops',
    });

    expect(serverService.mutate).toHaveBeenCalledTimes(1);
    const [mutationString, variables] = (serverService.mutate as jest.Mock)
      .mock.calls[0];
    expect(mutationString).toContain('markReadinessCheckVerified');
    expect(mutationString).toContain('checkId');
    expect(mutationString).toContain('verifiedAt');
    expect(mutationString).toContain('expiresAt');
    expect(mutationString).toContain('verifiedBy');
    expect(variables).toEqual({
      input: {
        checkId: 'tel-1',
        expiresInDays: 30,
        note: 'paged Bob in #ops',
      },
    });
    expect(out).toEqual(result);
  });

  it('defaults missing expiresInDays and note to null', async () => {
    (serverService.mutate as jest.Mock).mockResolvedValue({
      markReadinessCheckVerified: {
        ok: true,
        checkId: 'tel-2',
        verifiedAt: '2026-05-19T08:00:00.000Z',
        expiresAt: '2026-05-26T08:00:00.000Z',
        verifiedBy: 'sub-1',
      },
    });

    const { governanceService } = await import('../governanceService');

    await governanceService.markReadinessCheckVerified({ checkId: 'tel-2' });

    const [, variables] = (serverService.mutate as jest.Mock).mock.calls[0];
    expect(variables.input.expiresInDays).toBeNull();
    expect(variables.input.note).toBeNull();
  });

  it('rethrows GraphQL errors (allowlist violations propagate)', async () => {
    (serverService.mutate as jest.Mock).mockRejectedValue(
      new Error('Check ID not in manual-verification allowlist: data-1'),
    );

    const { governanceService } = await import('../governanceService');

    await expect(
      governanceService.markReadinessCheckVerified({ checkId: 'data-1' }),
    ).rejects.toThrow('Check ID not in manual-verification allowlist: data-1');
  });
});


describe('governanceService.getDecisionTrace', () => {
  beforeEach(() => jest.clearAllMocks());

  it('queries getDecisionTrace with the findingId variable and maps the response', async () => {
    const trace = {
      findingId: 'f-trace-1',
      finding: {
        findingId: 'f-trace-1',
        workflowId: 'wf-1',
        decision: 'permit',
        reason: 'scope_match:unit-1',
        requestingAgent: 'a',
        targetAgent: 'b',
        scopeEvaluated: 'unit-1',
        contractEvaluated: null,
        escalationTarget: null,
        residualAuthorityDenial: false,
        timestamp: 1715000000,
      },
      steps: [
        {
          stepNumber: 1,
          name: 'Case-law lookup',
          status: 'pass-through',
          inputs: '{}',
          outputs: null,
          detail: 'detail',
        },
      ],
      terminalDecision: 'permit',
      terminalStepNumber: 7,
      reasonTokens: ['scope_match', 'unit-1'],
      constitutionalOverride: false,
      arbitrationPattern: null,
      scopeReduction: null,
    };
    (serverService.query as jest.Mock).mockResolvedValue({
      getDecisionTrace: trace,
    });

    const result = await governanceService.getDecisionTrace('f-trace-1');

    expect(serverService.query).toHaveBeenCalledTimes(1);
    const [queryString, variables] = (serverService.query as jest.Mock).mock.calls[0];
    expect(queryString).toContain('getDecisionTrace');
    expect(queryString).toContain('terminalStepNumber');
    expect(queryString).toContain('reasonTokens');
    expect(queryString).toContain('arbitrationPattern');
    expect(queryString).toContain('scopeReduction');
    expect(queryString).toContain('constitutionalOverride');
    expect(queryString).toContain('finding {');
    expect(queryString).toContain('residualAuthorityDenial');
    expect(variables).toEqual({ findingId: 'f-trace-1' });
    expect(result).toEqual(trace);
  });

  it('returns null when the resolver returns null (no throw)', async () => {
    (serverService.query as jest.Mock).mockResolvedValue({
      getDecisionTrace: null,
    });

    const result = await governanceService.getDecisionTrace('missing');

    expect(result).toBeNull();
  });

  it('returns null when the response is empty', async () => {
    (serverService.query as jest.Mock).mockResolvedValue({});

    const result = await governanceService.getDecisionTrace('missing');

    expect(result).toBeNull();
  });

  it('rethrows GraphQL errors', async () => {
    (serverService.query as jest.Mock).mockRejectedValue(new Error('boom'));

    await expect(governanceService.getDecisionTrace('x')).rejects.toThrow('boom');
  });
});

describe('governanceService.subscribeGovernanceFindings', () => {
  beforeEach(() => jest.clearAllMocks());

  it('passes the OnGovernanceFinding query and the decision filter to serverService.subscribe', () => {
    const mockUnsubscribe = jest.fn();
    (serverService.subscribe as jest.Mock).mockReturnValue(mockUnsubscribe);

    const onFinding = jest.fn();
    const result = governanceService.subscribeGovernanceFindings(
      onFinding,
      { decision: 'deny' },
    );

    expect(serverService.subscribe).toHaveBeenCalledTimes(1);
    const [queryString, variables] = (serverService.subscribe as jest.Mock).mock
      .calls[0];
    expect(queryString).toContain('onGovernanceFinding');
    expect(queryString).toContain('findingId');
    expect(queryString).toContain('reason');
    expect(queryString).toContain('residualAuthorityDenial');
    expect(variables).toEqual({ decision: 'deny' });
    expect(result).toBe(mockUnsubscribe);
  });

  it('defaults missing decision to null when filter is omitted', () => {
    (serverService.subscribe as jest.Mock).mockReturnValue(jest.fn());

    governanceService.subscribeGovernanceFindings(jest.fn());

    const [, variables] = (serverService.subscribe as jest.Mock).mock.calls[0];
    expect(variables).toEqual({ decision: null });
  });

  it('forwards parsed onGovernanceFinding payload to the callback', () => {
    let captured: ((data: unknown) => void) = () => {};
    (serverService.subscribe as jest.Mock).mockImplementation(
      (_q: string, _v: unknown, cb: (data: unknown) => void) => {
        captured = cb;
        return jest.fn();
      },
    );

    const onFinding = jest.fn();
    governanceService.subscribeGovernanceFindings(onFinding);

    captured({
      onGovernanceFinding: {
        findingId: 'f-live-1',
        workflowId: 'wf-live',
        decision: 'deny',
        reason: 'rivalrous',
        requestingAgent: 'a',
        targetAgent: 'b',
        scopeEvaluated: null,
        contractEvaluated: null,
        escalationTarget: null,
        residualAuthorityDenial: false,
        timestamp: 1715000000.5,
      },
    });

    expect(onFinding).toHaveBeenCalledWith(
      expect.objectContaining({ findingId: 'f-live-1', decision: 'deny' }),
    );
  });

  it('skips callback invocation when payload has no onGovernanceFinding', () => {
    let captured: ((data: unknown) => void) = () => {};
    (serverService.subscribe as jest.Mock).mockImplementation(
      (_q: string, _v: unknown, cb: (data: unknown) => void) => {
        captured = cb;
        return jest.fn();
      },
    );

    const onFinding = jest.fn();
    governanceService.subscribeGovernanceFindings(onFinding);

    captured(null);
    captured({});

    expect(onFinding).not.toHaveBeenCalled();
  });

  it('forwards callback errors to the optional onError handler instead of throwing', () => {
    let captured: ((data: unknown) => void) = () => {};
    (serverService.subscribe as jest.Mock).mockImplementation(
      (_q: string, _v: unknown, cb: (data: unknown) => void) => {
        captured = cb;
        return jest.fn();
      },
    );

    const onError = jest.fn();
    governanceService.subscribeGovernanceFindings(
      () => {
        throw new Error('renderer blew up');
      },
      undefined,
      onError,
    );

    expect(() =>
      captured({
        onGovernanceFinding: {
          findingId: 'f-2',
          workflowId: 'wf',
          decision: 'permit',
          reason: 'r',
          requestingAgent: 'a',
          targetAgent: 'b',
          scopeEvaluated: null,
          contractEvaluated: null,
          escalationTarget: null,
          residualAuthorityDenial: false,
          timestamp: 1,
        },
      }),
    ).not.toThrow();

    expect(onError).toHaveBeenCalled();
  });
});


// ---------------------------------------------------------------------------
// listAuthorityUnits + listCompositionContracts
// ---------------------------------------------------------------------------

describe('governanceService.listAuthorityUnits', () => {
  beforeEach(() => jest.clearAllMocks());

  it('passes registryId + includeRevoked through as variables', async () => {
    (serverService.query as jest.Mock).mockResolvedValue({
      listAuthorityUnits: [],
    });

    await governanceService.listAuthorityUnits({
      registryId: 'reg-app-1',
      includeRevoked: true,
    });

    const [queryString, variables] = (serverService.query as jest.Mock).mock.calls[0];
    expect(queryString).toContain('listAuthorityUnits');
    expect(queryString).toContain('unitId');
    expect(queryString).toContain('agentId');
    expect(queryString).toContain('scope');
    expect(queryString).toContain('decisionType');
    expect(queryString).toContain('conditions');
    expect(queryString).toContain('limits');
    expect(queryString).toContain('specificity');
    expect(queryString).toContain('riskRating');
    expect(queryString).toContain('isValid');
    expect(variables).toEqual({
      registryId: 'reg-app-1',
      includeRevoked: true,
    });
  });

  it('defaults missing args to null variables', async () => {
    (serverService.query as jest.Mock).mockResolvedValue({
      listAuthorityUnits: [],
    });

    await governanceService.listAuthorityUnits();

    const [, variables] = (serverService.query as jest.Mock).mock.calls[0];
    expect(variables).toEqual({
      registryId: null,
      includeRevoked: null,
    });
  });

  it('returns the parsed array; conditions/limits round-trip as JSON strings', async () => {
    const unit = {
      unitId: 'u-1',
      agentId: 'agent-a',
      scope: {
        decisionType: 'invoke_agent',
        domain: 'payment',
        conditions: JSON.stringify({ tier: 'gold' }),
        limits: JSON.stringify({ max_amount: 1000 }),
        specificity: 2,
      },
      delegationSource: null,
      canRedelegate: false,
      expiryTimestamp: null,
      revoked: false,
      riskRating: 'low',
      registryId: 'reg-app-1',
      isValid: true,
    };
    (serverService.query as jest.Mock).mockResolvedValue({
      listAuthorityUnits: [unit],
    });

    const result = await governanceService.listAuthorityUnits();

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(unit);
    // conditions/limits stay as JSON strings on the wire — caller parses.
    expect(typeof result[0].scope.conditions).toBe('string');
    expect(JSON.parse(result[0].scope.conditions)).toEqual({ tier: 'gold' });
  });

  it('returns [] when resolver returns null', async () => {
    (serverService.query as jest.Mock).mockResolvedValue({
      listAuthorityUnits: null,
    });

    const result = await governanceService.listAuthorityUnits();
    expect(result).toEqual([]);
  });

  it('rethrows GraphQL errors so the page can render an error card', async () => {
    (serverService.query as jest.Mock).mockRejectedValue(
      new Error('Forbidden: admin required'),
    );

    await expect(governanceService.listAuthorityUnits()).rejects.toThrow(
      'Forbidden: admin required',
    );
  });
});

describe('governanceService.listCompositionContracts', () => {
  beforeEach(() => jest.clearAllMocks());

  it('queries the resolver with no variables and returns the array', async () => {
    const contract = {
      contractId: 'c-1',
      partyA: 'a',
      partyB: 'b',
      authorityPrecedence: 'a',
      conflictResolution: 'halt_and_escalate',
      invariants: ['inv-1'],
      stopRights: ['a'],
      scope: {
        decisionType: '*',
        domain: '*',
        conditions: '{}',
        limits: '{}',
        specificity: 0,
      },
      escalationPath: null,
    };
    (serverService.query as jest.Mock).mockResolvedValue({
      listCompositionContracts: [contract],
    });

    const result = await governanceService.listCompositionContracts();

    const [queryString] = (serverService.query as jest.Mock).mock.calls[0];
    expect(queryString).toContain('listCompositionContracts');
    expect(queryString).toContain('contractId');
    expect(queryString).toContain('partyA');
    expect(queryString).toContain('partyB');
    expect(queryString).toContain('conflictResolution');
    expect(queryString).toContain('invariants');
    expect(queryString).toContain('stopRights');
    expect(queryString).toContain('escalationPath');
    expect(result).toEqual([contract]);
  });

  it('returns [] when resolver returns null', async () => {
    (serverService.query as jest.Mock).mockResolvedValue({
      listCompositionContracts: null,
    });

    const result = await governanceService.listCompositionContracts();
    expect(result).toEqual([]);
  });

  it('rethrows GraphQL errors', async () => {
    (serverService.query as jest.Mock).mockRejectedValue(new Error('boom'));

    await expect(governanceService.listCompositionContracts()).rejects.toThrow('boom');
  });
});

// ---------------------------------------------------------------------------
// getRevokeImpact (blast-radius approximation)
// ---------------------------------------------------------------------------

describe('governanceService.getRevokeImpact', () => {
  beforeEach(() => jest.clearAllMocks());

  it('queries the resolver with unitId and time-window variables', async () => {
    (serverService.query as jest.Mock).mockResolvedValue({
      getRevokeImpact: {
        unitId: 'u-1',
        sinceTs: 100,
        untilTs: 200,
        totalPermits: 0,
        distinctWorkflows: 0,
        distinctAgentPairs: 0,
        workflows: [],
        agentPairs: [],
        truncated: false,
      },
    });

    await governanceService.getRevokeImpact({
      unitId: 'u-1',
      sinceTs: 100,
      untilTs: 200,
    });

    const [queryString, variables] = (serverService.query as jest.Mock).mock
      .calls[0];
    expect(queryString).toContain('getRevokeImpact');
    expect(queryString).toContain('unitId');
    expect(queryString).toContain('totalPermits');
    expect(queryString).toContain('distinctWorkflows');
    expect(queryString).toContain('distinctAgentPairs');
    expect(queryString).toContain('workflows');
    expect(queryString).toContain('agentPairs');
    expect(queryString).toContain('truncated');
    expect(variables).toEqual({
      unitId: 'u-1',
      sinceTs: 100,
      untilTs: 200,
    });
  });

  it('defaults missing time-window args to null variables', async () => {
    (serverService.query as jest.Mock).mockResolvedValue({
      getRevokeImpact: {
        unitId: 'u-1',
        sinceTs: 0,
        untilTs: 0,
        totalPermits: 0,
        distinctWorkflows: 0,
        distinctAgentPairs: 0,
        workflows: [],
        agentPairs: [],
        truncated: false,
      },
    });

    await governanceService.getRevokeImpact({ unitId: 'u-1' });

    const [, variables] = (serverService.query as jest.Mock).mock.calls[0];
    expect(variables).toEqual({
      unitId: 'u-1',
      sinceTs: null,
      untilTs: null,
    });
  });

  it('returns the parsed report with truncated=true round-tripped', async () => {
    const report = {
      unitId: 'u-1',
      sinceTs: 100,
      untilTs: 200,
      totalPermits: 5000,
      distinctWorkflows: 250,
      distinctAgentPairs: 30,
      workflows: [
        { workflowId: 'wf-a', permitCount: 12, lastTimestamp: 195 },
      ],
      agentPairs: [
        { requestingAgent: 'a', targetAgent: 'b', permitCount: 12 },
      ],
      truncated: true,
    };
    (serverService.query as jest.Mock).mockResolvedValue({
      getRevokeImpact: report,
    });

    const result = await governanceService.getRevokeImpact({ unitId: 'u-1' });
    expect(result).toEqual(report);
    expect(result.truncated).toBe(true);
  });

  it('rethrows GraphQL errors so the page can render an error card', async () => {
    (serverService.query as jest.Mock).mockRejectedValue(
      new Error('Forbidden: admin required'),
    );

    await expect(
      governanceService.getRevokeImpact({ unitId: 'u-1' }),
    ).rejects.toThrow('Forbidden: admin required');
  });
});

// ---------------------------------------------------------------------------
// listConstitutionalLayers + getConstitutionalRuleStats
// ---------------------------------------------------------------------------

describe('governanceService.listConstitutionalLayers', () => {
  beforeEach(() => jest.clearAllMocks());

  it('queries the resolver with no variables and returns the array', async () => {
    const layer = {
      layerId: 'global-1',
      layerType: 'global',
      appliesTo: ['*'],
      rules: [
        { field: 'pii_present', operator: 'eq', value: 'false' },
      ],
      parentLayerId: null,
    };
    (serverService.query as jest.Mock).mockResolvedValue({
      listConstitutionalLayers: [layer],
    });

    const result = await governanceService.listConstitutionalLayers();

    const [queryString] = (serverService.query as jest.Mock).mock.calls[0];
    expect(queryString).toContain('listConstitutionalLayers');
    expect(queryString).toContain('layerId');
    expect(queryString).toContain('layerType');
    expect(queryString).toContain('appliesTo');
    expect(queryString).toContain('rules');
    expect(queryString).toContain('field');
    expect(queryString).toContain('operator');
    expect(queryString).toContain('value');
    expect(queryString).toContain('parentLayerId');
    expect(result).toEqual([layer]);
  });

  it('returns [] when resolver returns null', async () => {
    (serverService.query as jest.Mock).mockResolvedValue({
      listConstitutionalLayers: null,
    });

    const result = await governanceService.listConstitutionalLayers();
    expect(result).toEqual([]);
  });

  it('round-trips JSON-encoded value strings unchanged', async () => {
    const layer = {
      layerId: 'g',
      layerType: 'global',
      appliesTo: ['*'],
      rules: [
        { field: 'tier', operator: 'eq', value: '"gold"' },
        { field: 'amount', operator: 'gt', value: '100' },
        { field: 'session_id', operator: 'exists', value: null },
      ],
      parentLayerId: null,
    };
    (serverService.query as jest.Mock).mockResolvedValue({
      listConstitutionalLayers: [layer],
    });

    const result = await governanceService.listConstitutionalLayers();
    expect(result[0].rules[0].value).toBe('"gold"');
    expect(JSON.parse(result[0].rules[0].value as string)).toBe('gold');
    expect(result[0].rules[1].value).toBe('100');
    expect(result[0].rules[2].value).toBeNull();
  });

  it('rethrows GraphQL errors so the page can render an error card', async () => {
    (serverService.query as jest.Mock).mockRejectedValue(
      new Error('Forbidden: admin required'),
    );

    await expect(governanceService.listConstitutionalLayers()).rejects.toThrow(
      'Forbidden: admin required',
    );
  });
});

describe('governanceService.getConstitutionalRuleStats', () => {
  beforeEach(() => jest.clearAllMocks());

  it('passes args through as variables', async () => {
    (serverService.query as jest.Mock).mockResolvedValue({
      getConstitutionalRuleStats: {
        generatedAt: 1700000000,
        sinceTs: 100,
        untilTs: 200,
        totalOverrides: 0,
        stats: [],
        truncated: false,
      },
    });

    await governanceService.getConstitutionalRuleStats({
      sinceTs: 100,
      untilTs: 200,
    });

    const [queryString, variables] = (serverService.query as jest.Mock).mock
      .calls[0];
    expect(queryString).toContain('getConstitutionalRuleStats');
    expect(queryString).toContain('totalOverrides');
    expect(queryString).toContain('stats');
    expect(queryString).toContain('topAffectedAgents');
    expect(queryString).toContain('truncated');
    expect(variables).toEqual({
      sinceTs: 100,
      untilTs: 200,
    });
  });

  it('defaults missing args to null variables', async () => {
    (serverService.query as jest.Mock).mockResolvedValue({
      getConstitutionalRuleStats: {
        generatedAt: 0,
        sinceTs: 0,
        untilTs: 0,
        totalOverrides: 0,
        stats: [],
        truncated: false,
      },
    });

    await governanceService.getConstitutionalRuleStats();

    const [, variables] = (serverService.query as jest.Mock).mock.calls[0];
    expect(variables).toEqual({
      sinceTs: null,
      untilTs: null,
    });
  });

  it('returns the parsed report with truncated=true round-tripped', async () => {
    const report = {
      generatedAt: 1700000000,
      sinceTs: 100,
      untilTs: 200,
      totalOverrides: 5000,
      stats: [
        {
          layerId: 'layer-a',
          field: 'field-x',
          count7d: 12,
          lastFiredAt: 195,
          firstFiredAt: 110,
          topAffectedAgents: ['agent-1', 'agent-2'],
        },
      ],
      truncated: true,
    };
    (serverService.query as jest.Mock).mockResolvedValue({
      getConstitutionalRuleStats: report,
    });

    const result = await governanceService.getConstitutionalRuleStats();
    expect(result).toEqual(report);
    expect(result.truncated).toBe(true);
  });

  it('rethrows GraphQL errors so the page can render an error card', async () => {
    (serverService.query as jest.Mock).mockRejectedValue(
      new Error('Forbidden: admin required'),
    );

    await expect(
      governanceService.getConstitutionalRuleStats(),
    ).rejects.toThrow('Forbidden: admin required');
  });
});

// ---------------------------------------------------------------------------
// listCaseLaw
// ---------------------------------------------------------------------------

describe('governanceService.listCaseLaw', () => {
  beforeEach(() => jest.clearAllMocks());

  it('queries listCaseLaw with includeRevoked variable', async () => {
    (serverService.query as jest.Mock).mockResolvedValue({
      listCaseLaw: [],
    });

    await governanceService.listCaseLaw({ includeRevoked: true });

    const [queryString, variables] = (serverService.query as jest.Mock).mock.calls[0];
    expect(queryString).toContain('listCaseLaw');
    expect(queryString).toContain('caseId');
    expect(queryString).toContain('pattern');
    expect(queryString).toContain('resolution');
    expect(queryString).toContain('encodedAt');
    expect(queryString).toContain('encodedBy');
    expect(queryString).toContain('scopeOfApplicability');
    expect(queryString).toContain('precedence');
    expect(queryString).toContain('revoked');
    expect(variables).toEqual({ includeRevoked: true });
  });

  it('defaults missing args to null variables', async () => {
    (serverService.query as jest.Mock).mockResolvedValue({
      listCaseLaw: [],
    });

    await governanceService.listCaseLaw();

    const [, variables] = (serverService.query as jest.Mock).mock.calls[0];
    expect(variables).toEqual({ includeRevoked: null });
  });

  it('returns the parsed array; pattern + scopeOfApplicability round-trip as JSON strings', async () => {
    const entry = {
      caseId: 'case-1',
      pattern: JSON.stringify({ agent: 'a', target: 'b' }),
      resolution: 'permit',
      encodedAt: '2026-05-01T10:00:00.000Z',
      encodedBy: 'operator@acme.com',
      scopeOfApplicability: JSON.stringify({ tenants: ['acme'] }),
      precedence: 5,
      revoked: false,
    };
    (serverService.query as jest.Mock).mockResolvedValue({
      listCaseLaw: [entry],
    });

    const result = await governanceService.listCaseLaw();

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(entry);
    expect(typeof result[0].pattern).toBe('string');
    expect(typeof result[0].scopeOfApplicability).toBe('string');
    expect(JSON.parse(result[0].pattern)).toEqual({ agent: 'a', target: 'b' });
    expect(JSON.parse(result[0].scopeOfApplicability)).toEqual({
      tenants: ['acme'],
    });
  });

  it('returns [] when resolver returns null', async () => {
    (serverService.query as jest.Mock).mockResolvedValue({
      listCaseLaw: null,
    });

    const result = await governanceService.listCaseLaw();
    expect(result).toEqual([]);
  });

  it('rethrows GraphQL errors so the page can render an error card', async () => {
    (serverService.query as jest.Mock).mockRejectedValue(
      new Error('Forbidden: admin required'),
    );

    await expect(governanceService.listCaseLaw()).rejects.toThrow(
      'Forbidden: admin required',
    );
  });

  it('passes includeRevoked=false explicitly through to variables', async () => {
    (serverService.query as jest.Mock).mockResolvedValue({
      listCaseLaw: [],
    });

    await governanceService.listCaseLaw({ includeRevoked: false });

    const [, variables] = (serverService.query as jest.Mock).mock.calls[0];
    expect(variables).toEqual({ includeRevoked: false });
  });
});

// ---------------------------------------------------------------------------
// addConstitutionalRule + updateConstitutionalRule + deleteConstitutionalRule
// ---------------------------------------------------------------------------

describe('governanceService.addConstitutionalRule', () => {
  beforeEach(() => jest.clearAllMocks());

  it('sends the AddConstitutionalRule mutation with the input variable + verbatim ack', async () => {
    const layer = {
      layerId: 'layer-global',
      layerType: 'global',
      appliesTo: ['*'],
      rules: [{ field: 'tier', operator: 'eq', value: '"gold"' }],
      parentLayerId: null,
    };
    const result = {
      ok: true,
      layerId: 'layer-global',
      action: 'add',
      layer,
      emittedEventDetailType: 'governance.constitutional.rule.changed',
    };
    (serverService.mutate as jest.Mock).mockResolvedValue({
      addConstitutionalRule: result,
    });

    const { governanceService, CONSTITUTIONAL_RULE_ACKNOWLEDGEMENT_TEXT } =
      await import('../governanceService');

    const out = await governanceService.addConstitutionalRule(
      'layer-global',
      { field: 'tier', operator: 'eq', value: '"gold"' },
    );

    expect(serverService.mutate).toHaveBeenCalledTimes(1);
    const [mutationString, variables] = (serverService.mutate as jest.Mock)
      .mock.calls[0];
    expect(mutationString).toContain('addConstitutionalRule');
    expect(mutationString).toContain('layerId');
    expect(mutationString).toContain('action');
    expect(mutationString).toContain('layer');
    expect(mutationString).toContain('emittedEventDetailType');
    expect(variables).toEqual({
      input: {
        layerId: 'layer-global',
        rule: { field: 'tier', operator: 'eq', value: '"gold"' },
        acknowledgement: CONSTITUTIONAL_RULE_ACKNOWLEDGEMENT_TEXT,
      },
    });
    expect(out).toEqual(result);
    // Round-trip the layer projection.
    expect(out.layer).toEqual(layer);
  });

  it('rethrows GraphQL errors with the original message', async () => {
    (serverService.mutate as jest.Mock).mockRejectedValue(
      new Error('Layer not found: missing'),
    );

    const { governanceService } = await import('../governanceService');

    await expect(
      governanceService.addConstitutionalRule('missing', {
        field: 'f',
        operator: 'eq',
        value: '"x"',
      }),
    ).rejects.toThrow('Layer not found: missing');
  });

  it('passes value: null for exists / not_exists operators', async () => {
    (serverService.mutate as jest.Mock).mockResolvedValue({
      addConstitutionalRule: {
        ok: true,
        layerId: 'l',
        action: 'add',
        layer: {
          layerId: 'l',
          layerType: 'global',
          appliesTo: [],
          rules: [],
          parentLayerId: null,
        },
        emittedEventDetailType: null,
      },
    });

    const { governanceService } = await import('../governanceService');

    await governanceService.addConstitutionalRule('l', {
      field: 'session_id',
      operator: 'exists',
      value: null,
    });

    const [, variables] = (serverService.mutate as jest.Mock).mock.calls[0];
    expect(variables.input.rule.value).toBeNull();
    expect(variables.input.rule.operator).toBe('exists');
  });
});

describe('governanceService.updateConstitutionalRule', () => {
  beforeEach(() => jest.clearAllMocks());

  it('sends the UpdateConstitutionalRule mutation with ruleIndex + newRule + verbatim ack', async () => {
    const layer = {
      layerId: 'layer-global',
      layerType: 'global',
      appliesTo: ['*'],
      rules: [{ field: 'tier', operator: 'eq', value: '"gold"' }],
      parentLayerId: null,
    };
    const result = {
      ok: true,
      layerId: 'layer-global',
      action: 'update',
      layer,
      emittedEventDetailType: 'governance.constitutional.rule.changed',
    };
    (serverService.mutate as jest.Mock).mockResolvedValue({
      updateConstitutionalRule: result,
    });

    const { governanceService, CONSTITUTIONAL_RULE_ACKNOWLEDGEMENT_TEXT } =
      await import('../governanceService');

    const out = await governanceService.updateConstitutionalRule(
      'layer-global',
      0,
      { field: 'tier', operator: 'eq', value: '"silver"' },
    );

    const [mutationString, variables] = (serverService.mutate as jest.Mock)
      .mock.calls[0];
    expect(mutationString).toContain('updateConstitutionalRule');
    expect(variables).toEqual({
      input: {
        layerId: 'layer-global',
        ruleIndex: 0,
        newRule: { field: 'tier', operator: 'eq', value: '"silver"' },
        acknowledgement: CONSTITUTIONAL_RULE_ACKNOWLEDGEMENT_TEXT,
      },
    });
    expect(out).toEqual(result);
  });

  it('rethrows GraphQL errors (out-of-range ruleIndex propagates)', async () => {
    (serverService.mutate as jest.Mock).mockRejectedValue(
      new Error('Rule index out of range: 99'),
    );

    const { governanceService } = await import('../governanceService');

    await expect(
      governanceService.updateConstitutionalRule('l', 99, {
        field: 'f',
        operator: 'eq',
        value: '"x"',
      }),
    ).rejects.toThrow('Rule index out of range: 99');
  });
});

describe('governanceService.deleteConstitutionalRule', () => {
  beforeEach(() => jest.clearAllMocks());

  it('sends the DeleteConstitutionalRule mutation with ruleIndex + verbatim ack', async () => {
    const layer = {
      layerId: 'layer-global',
      layerType: 'global',
      appliesTo: ['*'],
      rules: [],
      parentLayerId: null,
    };
    const result = {
      ok: true,
      layerId: 'layer-global',
      action: 'delete',
      layer,
      emittedEventDetailType: 'governance.constitutional.rule.changed',
    };
    (serverService.mutate as jest.Mock).mockResolvedValue({
      deleteConstitutionalRule: result,
    });

    const { governanceService, CONSTITUTIONAL_RULE_ACKNOWLEDGEMENT_TEXT } =
      await import('../governanceService');

    const out = await governanceService.deleteConstitutionalRule(
      'layer-global',
      2,
    );

    const [mutationString, variables] = (serverService.mutate as jest.Mock)
      .mock.calls[0];
    expect(mutationString).toContain('deleteConstitutionalRule');
    expect(variables).toEqual({
      input: {
        layerId: 'layer-global',
        ruleIndex: 2,
        acknowledgement: CONSTITUTIONAL_RULE_ACKNOWLEDGEMENT_TEXT,
      },
    });
    expect(out).toEqual(result);
  });

  it('rethrows GraphQL errors with the original message', async () => {
    (serverService.mutate as jest.Mock).mockRejectedValue(
      new Error('Acknowledgement string mismatch'),
    );

    const { governanceService } = await import('../governanceService');

    await expect(
      governanceService.deleteConstitutionalRule('l', 0),
    ).rejects.toThrow('Acknowledgement string mismatch');
  });
});

describe('CONSTITUTIONAL_RULE_ACKNOWLEDGEMENT_TEXT export', () => {
  it('matches the verbatim string the backend resolver enforces', async () => {
    const { CONSTITUTIONAL_RULE_ACKNOWLEDGEMENT_TEXT } = await import(
      '../governanceService'
    );
    expect(CONSTITUTIONAL_RULE_ACKNOWLEDGEMENT_TEXT).toBe(
      'I understand this changes the constitutional layer used at engine step 8',
    );
  });
});

// ---------------------------------------------------------------------------
// revokeCaseLaw + unrevokeCaseLaw + updateCaseLawPrecedence
// ---------------------------------------------------------------------------

describe('governanceService.revokeCaseLaw', () => {
  beforeEach(() => jest.clearAllMocks());

  it('sends the RevokeCaseLaw mutation with the input variable + verbatim ack', async () => {
    const entry = {
      caseId: 'case-1',
      pattern: JSON.stringify({ agent: 'a', target: 'b' }),
      resolution: 'permit',
      encodedAt: '2026-05-01T10:00:00.000Z',
      encodedBy: 'operator@acme.com',
      scopeOfApplicability: JSON.stringify({ tenants: ['acme'] }),
      precedence: 5,
      revoked: true,
    };
    const result = {
      ok: true,
      caseId: 'case-1',
      action: 'revoke',
      entry,
      emittedEventDetailType: 'governance.caselaw.changed',
    };
    (serverService.mutate as jest.Mock).mockResolvedValue({
      revokeCaseLaw: result,
    });

    const { governanceService, CASELAW_ACKNOWLEDGEMENT_TEXT } =
      await import('../governanceService');

    const out = await governanceService.revokeCaseLaw(
      'case-1',
      'precedent-superseded',
    );

    expect(serverService.mutate).toHaveBeenCalledTimes(1);
    const [mutationString, variables] = (serverService.mutate as jest.Mock)
      .mock.calls[0];
    expect(mutationString).toContain('revokeCaseLaw');
    expect(mutationString).toContain('caseId');
    expect(mutationString).toContain('action');
    expect(mutationString).toContain('entry');
    expect(mutationString).toContain('emittedEventDetailType');
    expect(variables).toEqual({
      input: {
        caseId: 'case-1',
        acknowledgement: CASELAW_ACKNOWLEDGEMENT_TEXT,
        reason: 'precedent-superseded',
      },
    });
    expect(out).toEqual(result);
    // Round-trip the entry projection.
    expect(out.entry).toEqual(entry);
  });

  it('passes reason: null when reason is omitted', async () => {
    (serverService.mutate as jest.Mock).mockResolvedValue({
      revokeCaseLaw: {
        ok: true,
        caseId: 'c',
        action: 'revoke',
        entry: {
          caseId: 'c',
          pattern: '{}',
          resolution: 'permit',
          encodedAt: '2026-01-01T00:00:00.000Z',
          encodedBy: 'op',
          scopeOfApplicability: '{}',
          precedence: 0,
          revoked: true,
        },
        emittedEventDetailType: null,
      },
    });

    const { governanceService } = await import('../governanceService');
    await governanceService.revokeCaseLaw('c');

    const [, variables] = (serverService.mutate as jest.Mock).mock.calls[0];
    expect(variables.input.reason).toBeNull();
  });

  it('rethrows GraphQL errors with the original message', async () => {
    (serverService.mutate as jest.Mock).mockRejectedValue(
      new Error('Case-law entry not found: case-1'),
    );

    const { governanceService } = await import('../governanceService');

    await expect(
      governanceService.revokeCaseLaw('case-1'),
    ).rejects.toThrow('Case-law entry not found: case-1');
  });
});

describe('governanceService.unrevokeCaseLaw', () => {
  beforeEach(() => jest.clearAllMocks());

  it('sends the UnrevokeCaseLaw mutation with the verbatim ack', async () => {
    (serverService.mutate as jest.Mock).mockResolvedValue({
      unrevokeCaseLaw: {
        ok: true,
        caseId: 'case-1',
        action: 'unrevoke',
        entry: {
          caseId: 'case-1',
          pattern: '{}',
          resolution: 'permit',
          encodedAt: '2026-01-01T00:00:00.000Z',
          encodedBy: 'op',
          scopeOfApplicability: '{}',
          precedence: 5,
          revoked: false,
        },
        emittedEventDetailType: 'governance.caselaw.changed',
      },
    });

    const { governanceService, CASELAW_ACKNOWLEDGEMENT_TEXT } =
      await import('../governanceService');

    await governanceService.unrevokeCaseLaw('case-1', 'restoration-approved');

    const [mutationString, variables] = (serverService.mutate as jest.Mock)
      .mock.calls[0];
    expect(mutationString).toContain('unrevokeCaseLaw');
    expect(variables).toEqual({
      input: {
        caseId: 'case-1',
        acknowledgement: CASELAW_ACKNOWLEDGEMENT_TEXT,
        reason: 'restoration-approved',
      },
    });
  });

  it('rethrows GraphQL errors with the original message', async () => {
    (serverService.mutate as jest.Mock).mockRejectedValue(
      new Error('Acknowledgement string mismatch'),
    );

    const { governanceService } = await import('../governanceService');

    await expect(
      governanceService.unrevokeCaseLaw('case-1'),
    ).rejects.toThrow('Acknowledgement string mismatch');
  });
});

describe('governanceService.updateCaseLawPrecedence', () => {
  beforeEach(() => jest.clearAllMocks());

  it('sends the UpdateCaseLawPrecedence mutation with input + verbatim ack', async () => {
    (serverService.mutate as jest.Mock).mockResolvedValue({
      updateCaseLawPrecedence: {
        ok: true,
        caseId: 'case-1',
        action: 'update-precedence',
        entry: {
          caseId: 'case-1',
          pattern: '{}',
          resolution: 'permit',
          encodedAt: '2026-01-01T00:00:00.000Z',
          encodedBy: 'op',
          scopeOfApplicability: '{}',
          precedence: 42,
          revoked: false,
        },
        emittedEventDetailType: 'governance.caselaw.changed',
      },
    });

    const { governanceService, CASELAW_ACKNOWLEDGEMENT_TEXT } =
      await import('../governanceService');

    const out = await governanceService.updateCaseLawPrecedence(
      'case-1',
      42,
      'shifted-priority',
    );

    const [mutationString, variables] = (serverService.mutate as jest.Mock)
      .mock.calls[0];
    expect(mutationString).toContain('updateCaseLawPrecedence');
    expect(mutationString).toContain('precedence');
    expect(variables).toEqual({
      input: {
        caseId: 'case-1',
        newPrecedence: 42,
        acknowledgement: CASELAW_ACKNOWLEDGEMENT_TEXT,
        reason: 'shifted-priority',
      },
    });
    expect(out.entry.precedence).toBe(42);
  });

  it('passes reason: null when reason is omitted', async () => {
    (serverService.mutate as jest.Mock).mockResolvedValue({
      updateCaseLawPrecedence: {
        ok: true,
        caseId: 'c',
        action: 'update-precedence',
        entry: {
          caseId: 'c',
          pattern: '{}',
          resolution: 'permit',
          encodedAt: '2026-01-01T00:00:00.000Z',
          encodedBy: 'op',
          scopeOfApplicability: '{}',
          precedence: 7,
          revoked: false,
        },
        emittedEventDetailType: null,
      },
    });

    const { governanceService } = await import('../governanceService');
    await governanceService.updateCaseLawPrecedence('c', 7);

    const [, variables] = (serverService.mutate as jest.Mock).mock.calls[0];
    expect(variables.input.reason).toBeNull();
    expect(variables.input.newPrecedence).toBe(7);
  });

  it('rethrows GraphQL errors with the original message', async () => {
    (serverService.mutate as jest.Mock).mockRejectedValue(
      new Error('newPrecedence 5000 is out of range [-1000, 1000]'),
    );

    const { governanceService } = await import('../governanceService');

    await expect(
      governanceService.updateCaseLawPrecedence('case-1', 5000),
    ).rejects.toThrow('out of range');
  });
});

describe('CASELAW_ACKNOWLEDGEMENT_TEXT export', () => {
  it('matches the verbatim string the backend resolver enforces', async () => {
    const { CASELAW_ACKNOWLEDGEMENT_TEXT } = await import(
      '../governanceService'
    );
    expect(CASELAW_ACKNOWLEDGEMENT_TEXT).toBe(
      'I understand this changes the case-law precedent used at engine step 1',
    );
  });
});


// ---------------------------------------------------------------------------
// authority graph history settings
// ---------------------------------------------------------------------------

describe('governanceService.getAuthorityGraphHistorySettings', () => {
  beforeEach(() => jest.clearAllMocks());

  it('queries getAuthorityGraphHistorySettings and maps the response', async () => {
    const settings = {
      enabled: true,
      retentionDays: 90,
      captureMode: 'daily',
      lastSnapshotAt: '2026-05-19T03:00:00.000Z',
      snapshotCountInWindow: 5,
      storageEstimate: '~40KB',
    };
    (serverService.query as jest.Mock).mockResolvedValue({
      getAuthorityGraphHistorySettings: settings,
    });

    const { governanceService } = await import('../governanceService');
    const result = await governanceService.getAuthorityGraphHistorySettings();

    const [queryString] = (serverService.query as jest.Mock).mock.calls[0];
    expect(queryString).toContain('getAuthorityGraphHistorySettings');
    expect(queryString).toContain('enabled');
    expect(queryString).toContain('retentionDays');
    expect(queryString).toContain('captureMode');
    expect(queryString).toContain('lastSnapshotAt');
    expect(queryString).toContain('snapshotCountInWindow');
    expect(queryString).toContain('storageEstimate');
    expect(result).toEqual(settings);
  });

  it('rethrows GraphQL errors', async () => {
    (serverService.query as jest.Mock).mockRejectedValue(
      new Error('Forbidden: admin required'),
    );
    const { governanceService } = await import('../governanceService');
    await expect(
      governanceService.getAuthorityGraphHistorySettings(),
    ).rejects.toThrow('Forbidden: admin required');
  });
});

describe('governanceService.updateAuthorityGraphHistorySettings', () => {
  beforeEach(() => jest.clearAllMocks());

  it('sends the mutation with input variable + verbatim ack constant', async () => {
    const result = {
      ok: true,
      settings: {
        enabled: true,
        retentionDays: 90,
        captureMode: 'daily',
        lastSnapshotAt: null,
        snapshotCountInWindow: 0,
        storageEstimate: '—',
      },
      emittedEventDetailType:
        'governance.authority-graph-history.config.changed',
    };
    (serverService.mutate as jest.Mock).mockResolvedValue({
      updateAuthorityGraphHistorySettings: result,
    });

    const {
      governanceService,
      AUTHORITY_GRAPH_HISTORY_ACKNOWLEDGEMENT_TEXT,
    } = await import('../governanceService');

    const out = await governanceService.updateAuthorityGraphHistorySettings({
      enabled: true,
      retentionDays: 90,
      captureMode: 'daily',
      reason: 'enabling-history',
    });

    expect(serverService.mutate).toHaveBeenCalledTimes(1);
    const [mutationString, variables] = (serverService.mutate as jest.Mock)
      .mock.calls[0];
    expect(mutationString).toContain('updateAuthorityGraphHistorySettings');
    expect(mutationString).toContain('settings');
    expect(mutationString).toContain('emittedEventDetailType');
    expect(variables).toEqual({
      input: {
        enabled: true,
        retentionDays: 90,
        captureMode: 'daily',
        acknowledgement: AUTHORITY_GRAPH_HISTORY_ACKNOWLEDGEMENT_TEXT,
        reason: 'enabling-history',
      },
    });
    expect(out).toEqual(result);
  });

  it('passes reason: null when reason is omitted', async () => {
    (serverService.mutate as jest.Mock).mockResolvedValue({
      updateAuthorityGraphHistorySettings: {
        ok: true,
        settings: {
          enabled: false,
          retentionDays: 30,
          captureMode: 'daily',
          lastSnapshotAt: null,
          snapshotCountInWindow: 0,
          storageEstimate: '—',
        },
        emittedEventDetailType: null,
      },
    });
    const { governanceService } = await import('../governanceService');
    await governanceService.updateAuthorityGraphHistorySettings({
      enabled: false,
      retentionDays: 30,
      captureMode: 'daily',
    });

    const [, variables] = (serverService.mutate as jest.Mock).mock.calls[0];
    expect(variables.input.reason).toBeNull();
  });

  it('rethrows GraphQL errors with the original message', async () => {
    (serverService.mutate as jest.Mock).mockRejectedValue(
      new Error('Capture mode on-change ships in Wave 4.E.A.2'),
    );
    const { governanceService } = await import('../governanceService');
    await expect(
      governanceService.updateAuthorityGraphHistorySettings({
        enabled: true,
        retentionDays: 30,
        // The TypeScript signature only allows 'daily' so this is a
        // runtime path we exercise only by casting. The resolver's
        // rejection path is what we are asserting on.
        captureMode: 'on-change' as unknown as 'daily',
      }),
    ).rejects.toThrow('Wave 4.E.A.2');
  });
});

describe('AUTHORITY_GRAPH_HISTORY_ACKNOWLEDGEMENT_TEXT export', () => {
  it('matches the verbatim string the backend resolver enforces', async () => {
    const { AUTHORITY_GRAPH_HISTORY_ACKNOWLEDGEMENT_TEXT } = await import(
      '../governanceService'
    );
    expect(AUTHORITY_GRAPH_HISTORY_ACKNOWLEDGEMENT_TEXT).toBe(
      'I understand this changes governance history retention and storage costs',
    );
  });
});


// ---------------------------------------------------------------------------
// authority graph history scrubber
// ---------------------------------------------------------------------------

describe('governanceService.listAuthorityGraphSnapshots', () => {
  beforeEach(() => jest.clearAllMocks());

  it('queries the resolver and returns the parsed array', async () => {
    const summary = {
      snapshotId: 's-1',
      timestamp: 1715000000,
      expiresAt: 1715000000 + 30 * 86400,
      kind: 'full',
      partial: false,
      authorityUnitsCount: 5,
      compositionContractsCount: 2,
      constitutionalLayersCount: 1,
      caseLawCount: 0,
    };
    (serverService.query as jest.Mock).mockResolvedValue({
      listAuthorityGraphSnapshots: [summary],
    });

    const { governanceService } = await import('../governanceService');
    const result = await governanceService.listAuthorityGraphSnapshots({
      sinceTs: 100,
      untilTs: 200,
    });

    const [queryString, variables] = (serverService.query as jest.Mock).mock
      .calls[0];
    expect(queryString).toContain('listAuthorityGraphSnapshots');
    expect(queryString).toContain('snapshotId');
    expect(queryString).toContain('authorityUnitsCount');
    expect(queryString).toContain('compositionContractsCount');
    expect(queryString).toContain('constitutionalLayersCount');
    expect(queryString).toContain('caseLawCount');
    expect(variables).toEqual({ sinceTs: 100, untilTs: 200 });
    expect(result).toEqual([summary]);
  });

  it('defaults missing time-window args to null variables', async () => {
    (serverService.query as jest.Mock).mockResolvedValue({
      listAuthorityGraphSnapshots: [],
    });

    const { governanceService } = await import('../governanceService');
    await governanceService.listAuthorityGraphSnapshots();

    const [, variables] = (serverService.query as jest.Mock).mock.calls[0];
    expect(variables).toEqual({ sinceTs: null, untilTs: null });
  });

  it('returns [] when resolver returns null', async () => {
    (serverService.query as jest.Mock).mockResolvedValue({
      listAuthorityGraphSnapshots: null,
    });
    const { governanceService } = await import('../governanceService');
    const result = await governanceService.listAuthorityGraphSnapshots();
    expect(result).toEqual([]);
  });

  it('rethrows GraphQL errors', async () => {
    (serverService.query as jest.Mock).mockRejectedValue(
      new Error('Forbidden: admin required'),
    );
    const { governanceService } = await import('../governanceService');
    await expect(
      governanceService.listAuthorityGraphSnapshots(),
    ).rejects.toThrow('Forbidden: admin required');
  });
});

describe('governanceService.getAuthorityGraphSnapshot', () => {
  beforeEach(() => jest.clearAllMocks());

  it('queries the resolver with snapshotId and returns the parsed snapshot', async () => {
    const snapshot = {
      snapshotId: 's-1',
      timestamp: 1715000000,
      expiresAt: 1715000000 + 30 * 86400,
      kind: 'full',
      partial: false,
      authorityUnits: [],
      compositionContracts: [],
    };
    (serverService.query as jest.Mock).mockResolvedValue({
      getAuthorityGraphSnapshot: snapshot,
    });
    const { governanceService } = await import('../governanceService');
    const result = await governanceService.getAuthorityGraphSnapshot('s-1');

    const [queryString, variables] = (serverService.query as jest.Mock).mock
      .calls[0];
    expect(queryString).toContain('getAuthorityGraphSnapshot');
    expect(queryString).toContain('authorityUnits');
    expect(queryString).toContain('compositionContracts');
    // Constitutional layers + case law are intentionally NOT projected.
    expect(queryString).not.toContain('constitutionalLayers ');
    expect(queryString).not.toContain('caseLaw ');
    expect(variables).toEqual({ snapshotId: 's-1' });
    expect(result).toEqual(snapshot);
  });

  it('returns null when resolver returns null (snapshot not found)', async () => {
    (serverService.query as jest.Mock).mockResolvedValue({
      getAuthorityGraphSnapshot: null,
    });
    const { governanceService } = await import('../governanceService');
    const result = await governanceService.getAuthorityGraphSnapshot(
      's-missing',
    );
    expect(result).toBeNull();
  });

  it('rethrows GraphQL errors', async () => {
    (serverService.query as jest.Mock).mockRejectedValue(new Error('boom'));
    const { governanceService } = await import('../governanceService');
    await expect(
      governanceService.getAuthorityGraphSnapshot('s-1'),
    ).rejects.toThrow('boom');
  });
});

// ---------------------------------------------------------------------------
// getD4RetrospectiveReport
// ---------------------------------------------------------------------------

describe('governanceService.getD4RetrospectiveReport', () => {
  beforeEach(() => jest.clearAllMocks());

  it('queries getD4RetrospectiveReport with the expected fields and maps the response', async () => {
    const report = {
      generatedAt: 1715000000,
      windowStart: 1712408000,
      windowEnd: 1715000000,
      windowDays: 30,
      insufficientEvidence: false,
      counts: {
        preFilterTotal: 12,
        toolHandlerTotal: 8,
        distinctPreFilter: 10,
        distinctToolHandler: 6,
        overlap: 5,
      },
      overlapRatio: 0.5,
      recommendation: 'keep-both',
      truncated: false,
    };
    (serverService.query as jest.Mock).mockResolvedValue({
      getD4RetrospectiveReport: report,
    });

    const result = await governanceService.getD4RetrospectiveReport(30);

    const [queryString, variables] = (serverService.query as jest.Mock).mock
      .calls[0];
    expect(queryString).toContain('getD4RetrospectiveReport');
    expect(queryString).toContain('windowDays');
    expect(queryString).toContain('insufficientEvidence');
    expect(queryString).toContain('preFilterTotal');
    expect(queryString).toContain('toolHandlerTotal');
    expect(queryString).toContain('distinctPreFilter');
    expect(queryString).toContain('distinctToolHandler');
    expect(queryString).toContain('overlap');
    expect(queryString).toContain('overlapRatio');
    expect(queryString).toContain('recommendation');
    expect(queryString).toContain('truncated');
    expect(variables).toEqual({ windowDays: 30 });
    expect(result).toEqual(report);
  });

  it('passes windowDays=null when arg omitted', async () => {
    (serverService.query as jest.Mock).mockResolvedValue({
      getD4RetrospectiveReport: {
        generatedAt: 0,
        windowStart: 0,
        windowEnd: 0,
        windowDays: 30,
        insufficientEvidence: false,
        counts: {
          preFilterTotal: 0,
          toolHandlerTotal: 0,
          distinctPreFilter: 0,
          distinctToolHandler: 0,
          overlap: 0,
        },
        overlapRatio: 0,
        recommendation: 'keep-both-strong-evidence',
        truncated: false,
      },
    });

    await governanceService.getD4RetrospectiveReport();

    const [, variables] = (serverService.query as jest.Mock).mock.calls[0];
    expect(variables).toEqual({ windowDays: null });
  });

  it.each([
    'keep-both',
    'keep-both-strong-evidence',
    're-debate',
    'deferred-90d',
  ])(
    'recommendation enum %s round-trips through the service',
    async (recommendation) => {
      (serverService.query as jest.Mock).mockResolvedValue({
        getD4RetrospectiveReport: {
          generatedAt: 1715000000,
          windowStart: 0,
          windowEnd: 0,
          windowDays: 30,
          insufficientEvidence: recommendation === 'deferred-90d',
          counts: {
            preFilterTotal: 0,
            toolHandlerTotal: 0,
            distinctPreFilter: 0,
            distinctToolHandler: 0,
            overlap: 0,
          },
          overlapRatio: 0,
          recommendation,
          truncated: false,
        },
      });

      const result = await governanceService.getD4RetrospectiveReport(30);
      expect(result.recommendation).toBe(recommendation);
    },
  );

  it('rethrows GraphQL errors so the page can render an error card', async () => {
    (serverService.query as jest.Mock).mockRejectedValue(
      new Error('Forbidden: admin required'),
    );

    await expect(
      governanceService.getD4RetrospectiveReport(7),
    ).rejects.toThrow('Forbidden: admin required');
  });
});

// ---------------------------------------------------------------------------
// getTrustPath
// ---------------------------------------------------------------------------

describe('governanceService.getTrustPath', () => {
  beforeEach(() => jest.clearAllMocks());

  function makeReport(overrides: Partial<any> = {}): any {
    return {
      resourceType: 'datastore',
      resourceId: 'ds-1',
      generatedAt: 1715000000,
      hops: [
        {
          arn: 'arn:aws:iam::123:role/lambda-exec',
          name: 'lambda-exec',
          scope: 'lambda',
          trustPolicyPrincipals: ['arn:aws:iam::123:role/x'],
          inlinePolicy: [],
          inlinePolicyName: null,
          totalActions: 0,
          totalResources: 0,
        },
        {
          arn: 'arn:aws:iam::123:role/citadel-ds-ds-1',
          name: 'citadel-ds-ds-1',
          scope: 'datastore',
          trustPolicyPrincipals: ['arn:aws:iam::123:role/lambda-exec'],
          inlinePolicy: [
            {
              effect: 'Allow',
              actions: ['s3:GetObject'],
              resources: ['arn:aws:s3:::b/*'],
              conditionsJson: null,
            },
          ],
          inlinePolicyName: 'DataStoreAccess',
          totalActions: 1,
          totalResources: 1,
        },
      ],
      notes: [],
      ...overrides,
    };
  }

  it('queries getTrustPath with the expected fields and round-trips the response', async () => {
    (serverService.query as jest.Mock).mockResolvedValue({
      getTrustPath: makeReport(),
    });

    const result = await governanceService.getTrustPath('datastore', 'ds-1');

    const [queryString, variables] = (serverService.query as jest.Mock).mock
      .calls[0];
    expect(queryString).toContain('getTrustPath');
    expect(queryString).toContain('resourceType');
    expect(queryString).toContain('resourceId');
    expect(queryString).toContain('hops');
    expect(queryString).toContain('inlinePolicy');
    expect(queryString).toContain('trustPolicyPrincipals');
    expect(queryString).toContain('conditionsJson');
    expect(queryString).toContain('totalActions');
    expect(queryString).toContain('totalResources');
    expect(queryString).toContain('notes');
    expect(variables).toEqual({ resourceType: 'datastore', resourceId: 'ds-1' });
    expect(result.hops).toHaveLength(2);
    expect(result.hops[0].scope).toBe('lambda');
    expect(result.hops[1].scope).toBe('datastore');
  });

  it('passes args through verbatim for the agent path', async () => {
    (serverService.query as jest.Mock).mockResolvedValue({
      getTrustPath: makeReport({
        resourceType: 'agent',
        resourceId: 'agent-xyz',
        hops: [makeReport().hops[0]],
      }),
    });

    await governanceService.getTrustPath('agent', 'agent-xyz');

    const [, variables] = (serverService.query as jest.Mock).mock.calls[0];
    expect(variables).toEqual({ resourceType: 'agent', resourceId: 'agent-xyz' });
  });

  it('round-trips hop count for the cross-account case (3 hops)', async () => {
    (serverService.query as jest.Mock).mockResolvedValue({
      getTrustPath: makeReport({
        hops: [
          makeReport().hops[0],
          {
            arn: 'arn:aws:iam::999:role/cross',
            name: 'cross',
            scope: 'cross-account',
            trustPolicyPrincipals: [],
            inlinePolicy: [],
            inlinePolicyName: null,
            totalActions: 0,
            totalResources: 0,
          },
          makeReport().hops[1],
        ],
      }),
    });

    const result = await governanceService.getTrustPath('datastore', 'ds-1');
    expect(result.hops).toHaveLength(3);
    expect(result.hops[1].scope).toBe('cross-account');
  });

  it('rethrows GraphQL errors so the page can render an inline banner', async () => {
    (serverService.query as jest.Mock).mockRejectedValue(
      new Error('Forbidden: admin required'),
    );

    await expect(
      governanceService.getTrustPath('datastore', 'ds-1'),
    ).rejects.toThrow('Forbidden: admin required');
  });
});
