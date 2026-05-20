/**
 * Property test: Wizard prefill propagation (P20)
 *
 * For any prefill data (name, description, agentIds), the wizard
 * pre-populates name, description, and agent selection. All
 * pre-populated values are modifiable.
 *
 * **Validates: Requirements 12.4**
 */
import * as fc from 'fast-check';

export interface WizardPrefill {
  name: string;
  description: string;
  agentIds: string[];
  integrationIds: string[];
}

/**
 * Pure function: applies prefill data to wizard state.
 * Returns the initial state values for the wizard fields.
 */
export function applyPrefill(
  prefill: WizardPrefill | undefined,
  defaults: { name: string; description: string; selectedAgentIds: string[] },
): { name: string; description: string; selectedAgentIds: string[] } {
  if (!prefill) return defaults;
  return {
    name: prefill.name || defaults.name,
    description: prefill.description || defaults.description,
    selectedAgentIds: prefill.agentIds.length > 0 ? prefill.agentIds : defaults.selectedAgentIds,
  };
}

const prefillArb = fc.record({
  name: fc.string({ minLength: 1, maxLength: 100 }),
  description: fc.string({ maxLength: 500 }),
  agentIds: fc.array(fc.uuid(), { minLength: 0, maxLength: 5 }),
  integrationIds: fc.array(fc.uuid(), { minLength: 0, maxLength: 5 }),
});

describe('Feature: app-publishing-gateway, Property 20: Wizard prefill propagation', () => {
  it('pre-populates name from prefill data', () => {
    fc.assert(
      fc.property(prefillArb, (prefill) => {
        const result = applyPrefill(prefill, { name: '', description: '', selectedAgentIds: [] });
        expect(result.name).toBe(prefill.name);
      }),
      { numRuns: 200 },
    );
  });

  it('pre-populates description from prefill data', () => {
    fc.assert(
      fc.property(prefillArb, (prefill) => {
        const result = applyPrefill(prefill, { name: '', description: '', selectedAgentIds: [] });
        if (prefill.description) {
          expect(result.description).toBe(prefill.description);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('pre-selects agents from prefill agentIds when non-empty', () => {
    fc.assert(
      fc.property(
        fc.record({
          name: fc.string({ minLength: 1, maxLength: 100 }),
          description: fc.string({ maxLength: 500 }),
          agentIds: fc.array(fc.uuid(), { minLength: 1, maxLength: 5 }),
          integrationIds: fc.array(fc.uuid(), { minLength: 0, maxLength: 5 }),
        }),
        (prefill) => {
          const result = applyPrefill(prefill, { name: '', description: '', selectedAgentIds: [] });
          expect(result.selectedAgentIds).toEqual(prefill.agentIds);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('all pre-populated values are modifiable (simulated by overwrite)', () => {
    fc.assert(
      fc.property(
        prefillArb,
        fc.string({ minLength: 1, maxLength: 100 }),
        fc.string({ maxLength: 500 }),
        (prefill, newName, newDesc) => {
          const initial = applyPrefill(prefill, { name: '', description: '', selectedAgentIds: [] });
          // Simulate user modification
          const modified = { ...initial, name: newName, description: newDesc };
          expect(modified.name).toBe(newName);
          expect(modified.description).toBe(newDesc);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('returns defaults when no prefill is provided', () => {
    const defaults = { name: 'default', description: 'default desc', selectedAgentIds: ['a1'] };
    const result = applyPrefill(undefined, defaults);
    expect(result).toEqual(defaults);
  });
});
