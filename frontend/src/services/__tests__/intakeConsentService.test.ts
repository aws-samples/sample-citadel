/**
 * Tests for the explicit consent catalogue binding.
 *
 * Contract:
 * - CONSENT_CATALOGUE is exported as an object keyed by action id.
 * - consentActionForId returns the catalogue entry or null.
 * - consentActionForLabel is no longer exported (regex matching removed).
 * - recordIntakeConsent issues the correct GraphQL mutation.
 * - Catalogue matches consent_catalogue.json (parity test).
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  CONSENT_CATALOGUE,
  consentActionForId,
  recordIntakeConsent,
} from '../intakeConsentService';

// Mock the server service
const mockMutate = jest.fn();
jest.mock('../server', () => ({
  __esModule: true,
  default: {
    mutate: (...args: unknown[]) => mockMutate(...args),
  },
}));

describe('CONSENT_CATALOGUE', () => {
  it('is an object with all seven consent actions', () => {
    expect(typeof CONSENT_CATALOGUE).toBe('object');
    expect(Object.keys(CONSENT_CATALOGUE)).toHaveLength(7);
    for (const entry of Object.values(CONSENT_CATALOGUE)) {
      expect(entry.label).toBeTruthy();
      expect(entry.confirmMessage).toBeTruthy();
      expect(entry.description).toBeTruthy();
    }
  });
});

describe('consentActionForId', () => {
  it('returns the catalogue entry for a known id', () => {
    const entry = consentActionForId('activate_agents');
    expect(entry).not.toBeNull();
    expect(entry!.label).toBe('✅ Activate the agents');
    expect(entry!.confirmMessage).toBe('Yes, activate the agents');
  });

  it('returns null for an unknown id', () => {
    expect(consentActionForId('bogus_action')).toBeNull();
  });
});

describe('consentActionForLabel removal', () => {
  it('does NOT export consentActionForLabel', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((require('../intakeConsentService') as any).consentActionForLabel).toBeUndefined();
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

describe('catalogue parity with consent_catalogue.json', () => {
  const jsonPath = path.resolve(
    __dirname,
    '../../../../service/agent_intake_single/tools/consent_catalogue.json',
  );

  it('consent_catalogue.json exists', () => {
    expect(fs.existsSync(jsonPath)).toBe(true);
  });

  it('CONSENT_CATALOGUE matches the JSON source', () => {
    const json = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
    expect(Object.keys(CONSENT_CATALOGUE).sort()).toEqual(Object.keys(json).sort());
    for (const [id, entry] of Object.entries(json) as [string, { label: string; confirmMessage: string; description: string }][]) {
      expect((CONSENT_CATALOGUE as Record<string, { label: string; confirmMessage: string; description: string }>)[id].label).toBe(entry.label);
      expect((CONSENT_CATALOGUE as Record<string, { label: string; confirmMessage: string; description: string }>)[id].confirmMessage).toBe(entry.confirmMessage);
      expect((CONSENT_CATALOGUE as Record<string, { label: string; confirmMessage: string; description: string }>)[id].description).toBe(entry.description);
    }
  });
});
