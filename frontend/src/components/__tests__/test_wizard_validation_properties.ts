/**
 * Property-Based Tests — Wizard Validation Utilities
 *
 * Tests for validateAppName and validateWizardStep pure functions
 * used by the App Builder Wizard.
 *
 * Uses fast-check for property-based testing.
 */

import * as fc from 'fast-check';
import { validateAppName, validateWizardStep } from '../../utils/wizardValidation';

// ---- Arbitraries ----

/** Strings with length in [3, 100] — valid app names */
const validNameArb = fc.string({ minLength: 3, maxLength: 100 });

/** Strings with length < 3 — too short */
const tooShortNameArb = fc.string({ minLength: 0, maxLength: 2 });

/** Strings with length > 100 — too long */
const tooLongNameArb = fc.string({ minLength: 101, maxLength: 200 });

/** Non-empty array of agent IDs */
const agentIdsArb = fc.array(fc.uuid(), { minLength: 1, maxLength: 10 });

/** Non-empty array of workflow IDs */
const workflowIdsArb = fc.array(fc.uuid(), { minLength: 1, maxLength: 10 });

/** Valid description (0-500 chars) */
const validDescriptionArb = fc.string({ minLength: 0, maxLength: 500 });

// ---- Property 20: Wizard name validation ----

/**
 * Feature: agent-apps-platform, Property 20: Wizard name validation
 *
 * For any string, the Name step validation should accept strings with length
 * between 3 and 100 characters (inclusive) and reject strings outside that range.
 *
 * **Validates: Requirements 10.2**
 */
describe('Property 20: Wizard name validation', () => {
  it('accepts strings with length between 3 and 100 characters', () => {
    fc.assert(
      fc.property(validNameArb, (name) => {
        const result = validateAppName(name);
        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
      }),
      { numRuns: 100 },
    );
  });

  it('rejects strings shorter than 3 characters', () => {
    fc.assert(
      fc.property(tooShortNameArb, (name) => {
        const result = validateAppName(name);
        expect(result.valid).toBe(false);
        expect(result.errors.length).toBeGreaterThan(0);
      }),
      { numRuns: 100 },
    );
  });

  it('rejects strings longer than 100 characters', () => {
    fc.assert(
      fc.property(tooLongNameArb, (name) => {
        const result = validateAppName(name);
        expect(result.valid).toBe(false);
        expect(result.errors.length).toBeGreaterThan(0);
      }),
      { numRuns: 100 },
    );
  });

  it('boundary: length 3 is accepted, length 2 is rejected', () => {
    const at3 = validateAppName('abc');
    expect(at3.valid).toBe(true);

    const at2 = validateAppName('ab');
    expect(at2.valid).toBe(false);
  });

  it('boundary: length 100 is accepted, length 101 is rejected', () => {
    const at100 = validateAppName('a'.repeat(100));
    expect(at100.valid).toBe(true);

    const at101 = validateAppName('a'.repeat(101));
    expect(at101.valid).toBe(false);
  });
});

// ---- Property 21: Wizard step navigation validation ----

/**
 * Feature: agent-apps-platform, Property 21: Wizard step navigation validation
 *
 * For any wizard state, the "Next" button should be disabled when required fields
 * for the current step are missing or invalid, and enabled when all required fields
 * are valid.
 *
 * **Validates: Requirements 10.11**
 */
describe('Property 21: Wizard step navigation validation', () => {
  it('Name step (0): valid when name is 3-100 chars, invalid otherwise', () => {
    fc.assert(
      fc.property(validNameArb, validDescriptionArb, (name, description) => {
        const result = validateWizardStep(0, { name, description });
        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
      }),
      { numRuns: 100 },
    );
  });

  it('Name step (0): invalid when name is too short', () => {
    fc.assert(
      fc.property(tooShortNameArb, (name) => {
        const result = validateWizardStep(0, { name });
        expect(result.valid).toBe(false);
        expect(result.errors.length).toBeGreaterThan(0);
      }),
      { numRuns: 100 },
    );
  });

  it('Name step (0): invalid when name is too long', () => {
    fc.assert(
      fc.property(tooLongNameArb, (name) => {
        const result = validateWizardStep(0, { name });
        expect(result.valid).toBe(false);
        expect(result.errors.length).toBeGreaterThan(0);
      }),
      { numRuns: 100 },
    );
  });

  it('Agents step (1): valid when at least one agent selected', () => {
    fc.assert(
      fc.property(agentIdsArb, (agents) => {
        const result = validateWizardStep(1, { agents });
        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
      }),
      { numRuns: 100 },
    );
  });

  it('Agents step (1): invalid when no agents selected', () => {
    const result = validateWizardStep(1, { agents: [] });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);

    const resultUndefined = validateWizardStep(1, {});
    expect(resultUndefined.valid).toBe(false);
  });

  it('Workflows step (2): valid when at least one workflow selected', () => {
    fc.assert(
      fc.property(workflowIdsArb, (workflows) => {
        const result = validateWizardStep(2, { workflows });
        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
      }),
      { numRuns: 100 },
    );
  });

  it('Workflows step (2): invalid when no workflows selected', () => {
    const result = validateWizardStep(2, { workflows: [] });
    expect(result.valid).toBe(false);

    const resultUndefined = validateWizardStep(2, {});
    expect(resultUndefined.valid).toBe(false);
  });

  it('Permissions step (3): always valid (optional step)', () => {
    fc.assert(
      fc.property(fc.anything(), (_) => {
        const result = validateWizardStep(3, {});
        expect(result.valid).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('Configuration step (4): always valid (optional step)', () => {
    fc.assert(
      fc.property(fc.anything(), (_) => {
        const result = validateWizardStep(4, {});
        expect(result.valid).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('Review step (5): always valid (summary step)', () => {
    const result = validateWizardStep(5, {});
    expect(result.valid).toBe(true);
  });

  it('unknown step returns invalid', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 6, max: 100 }),
        (step) => {
          const result = validateWizardStep(step, {});
          expect(result.valid).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('Name step (0): invalid when description exceeds 500 chars', () => {
    const longDesc = 'a'.repeat(501);
    const result = validateWizardStep(0, { name: 'Valid Name', description: longDesc });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('Description'))).toBe(true);
  });
});
