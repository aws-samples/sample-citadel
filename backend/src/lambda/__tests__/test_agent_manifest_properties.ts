/**
 * Property-based tests for agent manifest validation.
 *
 * Property 32: Agent manifest validation
 * **Validates: Requirements 15.2, 15.7**
 *
 * Tests that:
 * 1. Objects with all required fields (name, description, version as non-empty strings) are accepted
 * 2. Objects missing one or more required fields are rejected
 * 3. Objects with wrong types for required fields are rejected
 */
import * as fc from 'fast-check';
import { validateManifest } from '../agent-config-resolver';

// ── Generators ──────────────────────────────────────────────

/** Non-empty string generator for valid manifest fields */
const nonEmptyStringArb = fc.string({ minLength: 1, maxLength: 200 }).filter(s => s.trim().length > 0);

/** Valid manifest: all three required fields present as non-empty strings */
const validManifestArb = fc.record({
  name: nonEmptyStringArb,
  description: nonEmptyStringArb,
  version: nonEmptyStringArb,
});

/** Valid manifest with optional extra fields (inputSchema, outputSchema, tools, resourceRequirements) */
const validManifestWithOptionalsArb = fc.record({
  name: nonEmptyStringArb,
  description: nonEmptyStringArb,
  version: nonEmptyStringArb,
  inputSchema: fc.option(fc.jsonValue({ depthSize: 'small', maxDepth: 2 }), { nil: undefined }),
  outputSchema: fc.option(fc.jsonValue({ depthSize: 'small', maxDepth: 2 }), { nil: undefined }),
  tools: fc.option(fc.array(fc.string({ minLength: 1, maxLength: 50 }), { maxLength: 5 }), { nil: undefined }),
  resourceRequirements: fc.option(
    fc.record({
      memoryMb: fc.option(fc.integer({ min: 128, max: 10240 }), { nil: undefined }),
      timeoutSeconds: fc.option(fc.integer({ min: 1, max: 900 }), { nil: undefined }),
      permissions: fc.option(fc.array(fc.string({ minLength: 1, maxLength: 100 }), { maxLength: 5 }), { nil: undefined }),
    }),
    { nil: undefined },
  ),
});

/** Non-string type generator (anything that is not a non-empty string) */
const nonStringArb = fc.oneof(
  fc.constant(null),
  fc.constant(undefined),
  fc.integer(),
  fc.boolean(),
  fc.constant([]),
  fc.constant({}),
  fc.constant(0),
  fc.constant(''),
  fc.constant('   '),
);

const REQUIRED_FIELDS = ['name', 'description', 'version'] as const;

// ── Property 32 Tests ───────────────────────────────────────

describe('Property 32: Agent manifest validation', () => {
  /**
   * **Validates: Requirements 15.2, 15.7**
   *
   * For any object with name (non-empty string), description (non-empty string),
   * and version (non-empty string), validateManifest returns { valid: true, errors: [] }.
   */
  it('accepts any manifest with all required fields as non-empty strings', () => {
    fc.assert(
      fc.property(validManifestArb, (manifest) => {
        const result = validateManifest(manifest);

        expect(result.valid).toBe(true);
        expect(result.errors).toEqual([]);
      }),
      { numRuns: 200 },
    );
  });

  /**
   * **Validates: Requirements 15.2, 15.7**
   *
   * Valid manifests with optional extra fields are still accepted.
   */
  it('accepts valid manifests with optional fields present', () => {
    fc.assert(
      fc.property(validManifestWithOptionalsArb, (manifest) => {
        const result = validateManifest(manifest);

        expect(result.valid).toBe(true);
        expect(result.errors).toEqual([]);
      }),
      { numRuns: 200 },
    );
  });

  /**
   * **Validates: Requirements 15.7**
   *
   * For any manifest missing at least one required field, validateManifest
   * returns { valid: false } with at least one error message.
   */
  it('rejects any manifest missing one or more required fields', () => {
    // Generate a non-empty subset of required fields to remove
    const fieldsToRemoveArb = fc.subarray(
      [...REQUIRED_FIELDS],
      { minLength: 1, maxLength: 3 },
    );

    fc.assert(
      fc.property(validManifestArb, fieldsToRemoveArb, (manifest, fieldsToRemove) => {
        const incomplete: Record<string, any> = { ...manifest };
        for (const field of fieldsToRemove) {
          delete incomplete[field];
        }

        const result = validateManifest(incomplete);

        expect(result.valid).toBe(false);
        expect(result.errors.length).toBeGreaterThanOrEqual(1);
        expect(result.errors.length).toBeLessThanOrEqual(3);

        // Each removed field should produce an error mentioning that field
        for (const field of fieldsToRemove) {
          const hasFieldError = result.errors.some(e => e.includes(field));
          expect(hasFieldError).toBe(true);
        }
      }),
      { numRuns: 200 },
    );
  });

  /**
   * **Validates: Requirements 15.7**
   *
   * For any manifest where one or more required fields have wrong types
   * (not a non-empty string), validateManifest returns { valid: false }.
   */
  it('rejects any manifest with wrong types for required fields', () => {
    // Pick at least one field to corrupt with a non-string value
    const fieldsToCorruptArb = fc.subarray(
      [...REQUIRED_FIELDS],
      { minLength: 1, maxLength: 3 },
    );

    fc.assert(
      fc.property(validManifestArb, fieldsToCorruptArb, nonStringArb, (manifest, fieldsToCorrupt, badValue) => {
        const corrupted: Record<string, any> = { ...manifest };
        for (const field of fieldsToCorrupt) {
          corrupted[field] = badValue;
        }

        const result = validateManifest(corrupted);

        expect(result.valid).toBe(false);
        expect(result.errors.length).toBeGreaterThanOrEqual(1);

        // Each corrupted field should produce an error mentioning that field
        for (const field of fieldsToCorrupt) {
          const hasFieldError = result.errors.some(e => e.includes(field));
          expect(hasFieldError).toBe(true);
        }
      }),
      { numRuns: 200 },
    );
  });

  /**
   * **Validates: Requirements 15.7**
   *
   * An empty object (no fields at all) is rejected with exactly 3 errors,
   * one for each required field.
   */
  it('rejects an empty object with errors for all three required fields', () => {
    const result = validateManifest({});

    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(3);
    expect(result.errors.some(e => e.includes('name'))).toBe(true);
    expect(result.errors.some(e => e.includes('description'))).toBe(true);
    expect(result.errors.some(e => e.includes('version'))).toBe(true);
  });
});
