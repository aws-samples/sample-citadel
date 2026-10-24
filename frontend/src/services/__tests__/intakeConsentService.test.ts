/**
 * Tests for the intake consent service.
 *
 * Contract:
 * - consentActionForLabel maps privileged button labels to the correct action.
 * - Non-privileged labels return null.
 * - recordIntakeConsent issues the correct GraphQL mutation.
 */
import { consentActionForLabel, recordIntakeConsent } from '../intakeConsentService';

// Mock the server service
const mockMutate = jest.fn();
jest.mock('../server', () => ({
  __esModule: true,
  default: {
    mutate: (...args: unknown[]) => mockMutate(...args),
  },
}));

describe('consentActionForLabel', () => {
  it.each([
    ['Activate the agents', 'activate_agents'],
    ['Activate 3 agents', 'activate_agents'],
    ["Create 'Acme Claims'", 'create_agent_app'],
    ['Generate blueprint', 'generate_process_blueprint'],
    ["Add it to 'Acme Claims'", 'import_blueprint_to_app'],
  ])('maps "%s" → %s', (label, expected) => {
    expect(consentActionForLabel(label)).toBe(expected);
  });

  it.each([
    'Check again',
    'Not now',
    'Stop here',
    'Try again',
    'Review the plan',
    'Done for now',
    "Open 'Acme Claims'",
    'Show me the steps first',
    'Show me how to publish',
    'Choose a different name',
  ])('returns null for non-privileged label "%s"', (label) => {
    expect(consentActionForLabel(label)).toBeNull();
  });
});

describe('recordIntakeConsent', () => {
  beforeEach(() => {
    mockMutate.mockReset();
  });

  it('issues the correct mutation', async () => {
    mockMutate.mockResolvedValue({
      recordIntakeConsent: {
        ok: true,
        action: 'activate_agents',
        expiresAt: '2026-10-24T12:35:00.000Z',
      },
    });

    const result = await recordIntakeConsent('proj-1', 'activate_agents');

    expect(result.ok).toBe(true);
    expect(result.action).toBe('activate_agents');
    expect(mockMutate).toHaveBeenCalledTimes(1);
    const [query, variables] = mockMutate.mock.calls[0];
    expect(query).toContain('recordIntakeConsent');
    expect(variables).toEqual({ projectId: 'proj-1', action: 'activate_agents' });
  });
});
