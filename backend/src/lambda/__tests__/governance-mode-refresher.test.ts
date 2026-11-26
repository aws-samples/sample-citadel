/**
 * Tests for governance-mode-refresher Lambda — Wave 3.A.
 *
 * Mirrors the testing style of registry-sync.test.ts: env vars set
 * before module import, aws-sdk-client-mock for Lambda + CloudWatch,
 * console mocked per-test.
 */

// Set baseline env vars before importing the module (env var reads
// happen lazily inside the handler, but keeping the pattern consistent).
process.env.ENVIRONMENT = 'test-env';

import { mockClient } from 'aws-sdk-client-mock';
import {
  LambdaClient,
  GetFunctionConfigurationCommand,
  UpdateFunctionConfigurationCommand,
} from '@aws-sdk/client-lambda';
import {
  CloudWatchClient,
  PutMetricDataCommand,
} from '@aws-sdk/client-cloudwatch';
import type { EventBridgeEvent } from 'aws-lambda';

import {
  handler,
  validateDetail,
  readGovernanceAwareFunctions,
  refreshOneFunction,
  type GovernanceModeTransitionDetail,
} from '../governance-mode-refresher';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const lambdaMock = mockClient(LambdaClient);
const cwMock = mockClient(CloudWatchClient);

beforeEach(() => {
  lambdaMock.reset();
  cwMock.reset();
  cwMock.on(PutMetricDataCommand).resolves({});
  jest.spyOn(console, 'log').mockImplementation();
  jest.spyOn(console, 'warn').mockImplementation();
  jest.spyOn(console, 'error').mockImplementation();
});

afterEach(() => {
  jest.restoreAllMocks();
  delete process.env.GOVERNANCE_AWARE_FUNCTIONS;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(
  detail: Partial<GovernanceModeTransitionDetail> = {},
): EventBridgeEvent<
  'governance.mode.transition',
  GovernanceModeTransitionDetail
> {
  return {
    version: '0',
    id: 'test-event-id',
    source: 'citadel.governance',
    'detail-type': 'governance.mode.transition',
    account: '123456789012',
    time: '2026-05-19T00:00:00Z',
    region: 'us-east-1',
    resources: [],
    detail: {
      previousMode: 'permissive',
      newMode: 'shadow',
      env: 'test-env',
      reason: 'Wave 3.A test',
      actorSub: 'admin-user',
      timestamp: '2026-05-19T00:00:00Z',
      effectiveAtUpdated: true,
      ...detail,
    },
  };
}

// ---------------------------------------------------------------------------
// validateDetail
// ---------------------------------------------------------------------------

describe('validateDetail', () => {
  test('returns null for a complete detail', () => {
    const detail: GovernanceModeTransitionDetail = {
      previousMode: 'permissive',
      newMode: 'shadow',
      env: 'dev',
      reason: null,
      actorSub: 'user',
      timestamp: '2026-05-19T00:00:00Z',
      effectiveAtUpdated: false,
    };
    expect(validateDetail(detail)).toBeNull();
  });

  test('rejects null detail', () => {
    expect(validateDetail(null)).toContain('detail is missing');
  });

  test('rejects non-object detail', () => {
    expect(validateDetail('not an object')).toContain(
      'detail is missing or not an object',
    );
  });

  test('rejects missing previousMode', () => {
    expect(
      validateDetail({
        newMode: 'shadow',
        env: 'dev',
        timestamp: '2026-05-19T00:00:00Z',
      }),
    ).toContain('previousMode');
  });

  test('rejects missing newMode', () => {
    expect(
      validateDetail({
        previousMode: 'permissive',
        env: 'dev',
        timestamp: '2026-05-19T00:00:00Z',
      }),
    ).toContain('newMode');
  });

  test('rejects missing env', () => {
    expect(
      validateDetail({
        previousMode: 'permissive',
        newMode: 'shadow',
        timestamp: '2026-05-19T00:00:00Z',
      }),
    ).toContain('env');
  });

  test('rejects missing timestamp', () => {
    expect(
      validateDetail({
        previousMode: 'permissive',
        newMode: 'shadow',
        env: 'dev',
      }),
    ).toContain('timestamp');
  });

  test('rejects empty-string previousMode', () => {
    expect(
      validateDetail({
        previousMode: '',
        newMode: 'shadow',
        env: 'dev',
        timestamp: '2026-05-19T00:00:00Z',
      }),
    ).toContain('previousMode');
  });
});

// ---------------------------------------------------------------------------
// readGovernanceAwareFunctions
// ---------------------------------------------------------------------------

describe('readGovernanceAwareFunctions', () => {
  test('returns null when env var is unset', () => {
    delete process.env.GOVERNANCE_AWARE_FUNCTIONS;
    expect(readGovernanceAwareFunctions()).toBeNull();
  });

  test('returns null when env var is empty string', () => {
    process.env.GOVERNANCE_AWARE_FUNCTIONS = '';
    expect(readGovernanceAwareFunctions()).toBeNull();
  });

  test('returns null when env var is invalid JSON', () => {
    process.env.GOVERNANCE_AWARE_FUNCTIONS = 'not json';
    expect(readGovernanceAwareFunctions()).toBeNull();
  });

  test('returns null when env var is not an array', () => {
    process.env.GOVERNANCE_AWARE_FUNCTIONS = '{"foo":"bar"}';
    expect(readGovernanceAwareFunctions()).toBeNull();
  });

  test('returns parsed array of strings', () => {
    process.env.GOVERNANCE_AWARE_FUNCTIONS = JSON.stringify([
      'fn-one',
      'fn-two',
    ]);
    expect(readGovernanceAwareFunctions()).toEqual(['fn-one', 'fn-two']);
  });

  test('filters out non-string entries', () => {
    process.env.GOVERNANCE_AWARE_FUNCTIONS = JSON.stringify([
      'fn-one',
      42,
      null,
      'fn-two',
      '',
    ]);
    expect(readGovernanceAwareFunctions()).toEqual(['fn-one', 'fn-two']);
  });

  test('returns empty array for empty JSON array', () => {
    process.env.GOVERNANCE_AWARE_FUNCTIONS = '[]';
    expect(readGovernanceAwareFunctions()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// refreshOneFunction
// ---------------------------------------------------------------------------

describe('refreshOneFunction', () => {
  test('preserves existing env vars and adds MODE_GENERATION', async () => {
    lambdaMock.on(GetFunctionConfigurationCommand).resolves({
      Environment: {
        Variables: {
          EXISTING_VAR_1: 'value1',
          EXISTING_VAR_2: 'value2',
        },
      },
    });
    lambdaMock.on(UpdateFunctionConfigurationCommand).resolves({});

    await refreshOneFunction('test-fn', '2026-05-19T01:00:00Z');

    const updateCall = lambdaMock.commandCalls(UpdateFunctionConfigurationCommand)[0];
    const input = updateCall.args[0].input;

    expect(input.FunctionName).toBe('test-fn');
    expect(input.Environment?.Variables).toEqual({
      EXISTING_VAR_1: 'value1',
      EXISTING_VAR_2: 'value2',
      MODE_GENERATION: '2026-05-19T01:00:00Z',
    });
  });

  test('handles function with no existing env vars', async () => {
    lambdaMock.on(GetFunctionConfigurationCommand).resolves({});
    lambdaMock.on(UpdateFunctionConfigurationCommand).resolves({});

    await refreshOneFunction('empty-env-fn', '2026-05-19T02:00:00Z');

    const updateCall = lambdaMock.commandCalls(UpdateFunctionConfigurationCommand)[0];
    expect(updateCall.args[0].input.Environment?.Variables).toEqual({
      MODE_GENERATION: '2026-05-19T02:00:00Z',
    });
  });

  test('overwrites existing MODE_GENERATION', async () => {
    lambdaMock.on(GetFunctionConfigurationCommand).resolves({
      Environment: {
        Variables: {
          MODE_GENERATION: 'old-value',
          OTHER: 'kept',
        },
      },
    });
    lambdaMock.on(UpdateFunctionConfigurationCommand).resolves({});

    await refreshOneFunction('overwrite-fn', 'new-value');

    const updateCall = lambdaMock.commandCalls(UpdateFunctionConfigurationCommand)[0];
    expect(updateCall.args[0].input.Environment?.Variables).toEqual({
      MODE_GENERATION: 'new-value',
      OTHER: 'kept',
    });
  });

  test('propagates GetFunctionConfiguration errors', async () => {
    lambdaMock.on(GetFunctionConfigurationCommand).rejects(
      new Error('ResourceNotFoundException'),
    );

    await expect(
      refreshOneFunction('missing-fn', '2026-05-19T00:00:00Z'),
    ).rejects.toThrow('ResourceNotFoundException');
  });

  test('propagates UpdateFunctionConfiguration errors', async () => {
    lambdaMock.on(GetFunctionConfigurationCommand).resolves({
      Environment: { Variables: {} },
    });
    lambdaMock.on(UpdateFunctionConfigurationCommand).rejects(
      new Error('AccessDeniedException'),
    );

    await expect(
      refreshOneFunction('forbidden-fn', '2026-05-19T00:00:00Z'),
    ).rejects.toThrow('AccessDeniedException');
  });
});

// ---------------------------------------------------------------------------
// handler — env var no-ops
// ---------------------------------------------------------------------------

describe('handler — env var no-ops', () => {
  test('returns no-op when GOVERNANCE_AWARE_FUNCTIONS is unset', async () => {
    delete process.env.GOVERNANCE_AWARE_FUNCTIONS;

    const result = await handler(makeEvent());

    expect(result).toEqual({
      totalAttempted: 0,
      succeeded: 0,
      failed: 0,
      errors: {},
    });
    expect(lambdaMock.commandCalls(GetFunctionConfigurationCommand)).toHaveLength(0);
    expect(lambdaMock.commandCalls(UpdateFunctionConfigurationCommand)).toHaveLength(0);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('GOVERNANCE_AWARE_FUNCTIONS unset or invalid'),
    );
  });

  test('returns no-op when GOVERNANCE_AWARE_FUNCTIONS is an empty array', async () => {
    process.env.GOVERNANCE_AWARE_FUNCTIONS = '[]';

    const result = await handler(makeEvent());

    expect(result).toEqual({
      totalAttempted: 0,
      succeeded: 0,
      failed: 0,
      errors: {},
    });
    expect(lambdaMock.commandCalls(GetFunctionConfigurationCommand)).toHaveLength(0);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('GOVERNANCE_AWARE_FUNCTIONS is empty'),
    );
  });

  test('returns no-op when GOVERNANCE_AWARE_FUNCTIONS is malformed JSON', async () => {
    process.env.GOVERNANCE_AWARE_FUNCTIONS = '{not valid';

    const result = await handler(makeEvent());

    expect(result.totalAttempted).toBe(0);
    expect(lambdaMock.commandCalls(GetFunctionConfigurationCommand)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// handler — malformed event
// ---------------------------------------------------------------------------

describe('handler — malformed event', () => {
  test('logs warning and returns no-op for missing detail fields', async () => {
    process.env.GOVERNANCE_AWARE_FUNCTIONS = JSON.stringify(['fn-one']);

    const badEvent = {
      version: '0',
      id: 'evt',
      source: 'citadel.governance',
      'detail-type': 'governance.mode.transition',
      account: '1',
      time: 't',
      region: 'us-east-1',
      resources: [],
      // missing previousMode + env + timestamp
      detail: { newMode: 'shadow' } as unknown as GovernanceModeTransitionDetail,
    } as EventBridgeEvent<'governance.mode.transition', GovernanceModeTransitionDetail>;

    const result = await handler(badEvent);

    expect(result).toEqual({
      totalAttempted: 0,
      succeeded: 0,
      failed: 0,
      errors: {},
    });
    expect(lambdaMock.commandCalls(GetFunctionConfigurationCommand)).toHaveLength(0);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('malformed event detail'),
    );
  });
});

// ---------------------------------------------------------------------------
// handler — single function
// ---------------------------------------------------------------------------

describe('handler — single function', () => {
  test('calls GetFunctionConfiguration + UpdateFunctionConfiguration once with bumped MODE_GENERATION', async () => {
    process.env.GOVERNANCE_AWARE_FUNCTIONS = JSON.stringify([
      'governance-ui-resolver',
    ]);
    lambdaMock.on(GetFunctionConfigurationCommand).resolves({
      Environment: {
        Variables: {
          ENVIRONMENT: 'test-env',
          OTHER_CONFIG: 'kept',
        },
      },
    });
    lambdaMock.on(UpdateFunctionConfigurationCommand).resolves({});

    const result = await handler(makeEvent());

    expect(result.totalAttempted).toBe(1);
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.errors).toEqual({});

    expect(
      lambdaMock.commandCalls(GetFunctionConfigurationCommand),
    ).toHaveLength(1);
    expect(
      lambdaMock.commandCalls(UpdateFunctionConfigurationCommand),
    ).toHaveLength(1);

    const getInput = lambdaMock.commandCalls(GetFunctionConfigurationCommand)[0]
      .args[0].input;
    expect(getInput.FunctionName).toBe('governance-ui-resolver');

    const updateInput = lambdaMock.commandCalls(
      UpdateFunctionConfigurationCommand,
    )[0].args[0].input;
    expect(updateInput.FunctionName).toBe('governance-ui-resolver');
    // MODE_GENERATION must be present and a non-empty string (ISO timestamp).
    const vars = updateInput.Environment?.Variables ?? {};
    expect(typeof vars.MODE_GENERATION).toBe('string');
    expect(vars.MODE_GENERATION!.length).toBeGreaterThan(0);
  });

  test('preserves all existing env vars on the merged update', async () => {
    process.env.GOVERNANCE_AWARE_FUNCTIONS = JSON.stringify(['fn-one']);
    lambdaMock.on(GetFunctionConfigurationCommand).resolves({
      Environment: {
        Variables: {
          ENVIRONMENT: 'prod',
          GOVERNANCE_LEDGER_TABLE: 'ledger',
          AUTHORITY_UNITS_TABLE: 'units',
          REGISTRY_ID: 'reg-1',
        },
      },
    });
    lambdaMock.on(UpdateFunctionConfigurationCommand).resolves({});

    await handler(makeEvent());

    const updateInput = lambdaMock.commandCalls(
      UpdateFunctionConfigurationCommand,
    )[0].args[0].input;
    const vars = updateInput.Environment?.Variables ?? {};
    expect(vars.ENVIRONMENT).toBe('prod');
    expect(vars.GOVERNANCE_LEDGER_TABLE).toBe('ledger');
    expect(vars.AUTHORITY_UNITS_TABLE).toBe('units');
    expect(vars.REGISTRY_ID).toBe('reg-1');
    expect(vars.MODE_GENERATION).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// handler — multiple functions
// ---------------------------------------------------------------------------

describe('handler — multiple functions', () => {
  test('all succeed → totalAttempted = N, succeeded = N, failed = 0', async () => {
    process.env.GOVERNANCE_AWARE_FUNCTIONS = JSON.stringify([
      'fn-one',
      'fn-two',
      'fn-three',
    ]);
    lambdaMock.on(GetFunctionConfigurationCommand).resolves({
      Environment: { Variables: {} },
    });
    lambdaMock.on(UpdateFunctionConfigurationCommand).resolves({});

    const result = await handler(makeEvent());

    expect(result.totalAttempted).toBe(3);
    expect(result.succeeded).toBe(3);
    expect(result.failed).toBe(0);
    expect(result.errors).toEqual({});

    expect(
      lambdaMock.commandCalls(GetFunctionConfigurationCommand),
    ).toHaveLength(3);
    expect(
      lambdaMock.commandCalls(UpdateFunctionConfigurationCommand),
    ).toHaveLength(3);
  });

  test('one function fails → succeeded = N-1, failed = 1, errors object populated', async () => {
    process.env.GOVERNANCE_AWARE_FUNCTIONS = JSON.stringify([
      'fn-good-1',
      'fn-bad',
      'fn-good-2',
    ]);
    lambdaMock.on(GetFunctionConfigurationCommand).resolves({
      Environment: { Variables: {} },
    });
    // First and third UpdateFunctionConfiguration calls succeed; second
    // (fn-bad) throws. aws-sdk-client-mock matches in declaration order
    // when no input matchers are supplied, so we use callsFake for
    // function-name-based dispatch.
    lambdaMock
      .on(UpdateFunctionConfigurationCommand)
      .callsFake((input: { FunctionName?: string }) => {
        if (input.FunctionName === 'fn-bad') {
          throw new Error('AccessDeniedException');
        }
        return {};
      });

    const result = await handler(makeEvent());

    expect(result.totalAttempted).toBe(3);
    expect(result.succeeded).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.errors['fn-bad']).toContain('AccessDeniedException');
    expect(result.errors['fn-good-1']).toBeUndefined();
    expect(result.errors['fn-good-2']).toBeUndefined();
  });

  test('all functions fail → throws so EventBridge retries', async () => {
    process.env.GOVERNANCE_AWARE_FUNCTIONS = JSON.stringify([
      'fn-one',
      'fn-two',
    ]);
    lambdaMock.on(GetFunctionConfigurationCommand).rejects(
      new Error('ServiceException'),
    );

    await expect(handler(makeEvent())).rejects.toThrow(
      'all 2 function refreshes failed',
    );
  });
});

// ---------------------------------------------------------------------------
// handler — CloudWatch metrics
// ---------------------------------------------------------------------------

describe('handler — CloudWatch metrics', () => {
  test('emits PutMetricData with correct namespace and metric names', async () => {
    process.env.GOVERNANCE_AWARE_FUNCTIONS = JSON.stringify([
      'fn-one',
      'fn-two',
      'fn-three',
    ]);
    lambdaMock.on(GetFunctionConfigurationCommand).resolves({
      Environment: { Variables: {} },
    });
    lambdaMock
      .on(UpdateFunctionConfigurationCommand)
      .callsFake((input: { FunctionName?: string }) => {
        if (input.FunctionName === 'fn-two') {
          throw new Error('Boom');
        }
        return {};
      });

    await handler(makeEvent());

    const cwCalls = cwMock.commandCalls(PutMetricDataCommand);
    expect(cwCalls).toHaveLength(1);

    const input = cwCalls[0].args[0].input;
    expect(input.Namespace).toBe('Citadel/Governance/Refresher');

    const metricNames = (input.MetricData ?? []).map((m) => m.MetricName);
    expect(metricNames).toContain('RefreshAttempt');
    expect(metricNames).toContain('RefreshSuccess');
    expect(metricNames).toContain('RefreshFailure');

    const byName = new Map(
      (input.MetricData ?? []).map((m) => [m.MetricName, m.Value]),
    );
    expect(byName.get('RefreshAttempt')).toBe(3);
    expect(byName.get('RefreshSuccess')).toBe(2);
    expect(byName.get('RefreshFailure')).toBe(1);
  });

  test('handler does not crash when CloudWatch PutMetricData fails', async () => {
    process.env.GOVERNANCE_AWARE_FUNCTIONS = JSON.stringify(['fn-one']);
    lambdaMock.on(GetFunctionConfigurationCommand).resolves({
      Environment: { Variables: {} },
    });
    lambdaMock.on(UpdateFunctionConfigurationCommand).resolves({});
    cwMock.on(PutMetricDataCommand).rejects(new Error('CW down'));

    const result = await handler(makeEvent());

    expect(result.succeeded).toBe(1);
    expect(console.error).toHaveBeenCalledWith(
      'Failed to emit refresher metrics:',
      expect.any(Error),
    );
  });

  test('does not emit metrics on no-op (empty function list)', async () => {
    process.env.GOVERNANCE_AWARE_FUNCTIONS = '[]';

    await handler(makeEvent());

    // No-op path returns before metrics emission.
    expect(cwMock.commandCalls(PutMetricDataCommand)).toHaveLength(0);
  });
});
