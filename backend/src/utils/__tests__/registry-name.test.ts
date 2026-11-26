/**
 * Property-based + shared-vector tests for sanitizeRegistryName.
 *
 * The AgentCore Registry CreateRegistryRecord/UpdateRegistryRecord `name`
 * field must satisfy: ^[a-zA-Z0-9][a-zA-Z0-9_\-./]*$ (live-verified
 * ValidationException on 'Test - Ingest'). The sanitizer derives a
 * registry-safe name from any human input:
 *  - legal inputs pass through unchanged
 *  - illegal chars map to '-', consecutive '-' collapse, leading
 *    non-alphanumeric and trailing '-' are stripped
 *  - never empty (deterministic fallback 'app')
 *
 * The SHARED_VECTORS table is duplicated byte-for-byte in the Python twin
 * (service/agent_intake_single/tests/test_registry_name.py) so the TS and
 * Python implementations provably agree — update BOTH when changing either.
 */
import * as fc from 'fast-check';
import {
  REGISTRY_NAME_PATTERN,
  sanitizeRegistryName,
} from '../registry-name';

/** Must match the registry constraint exactly. */
const CONSTRAINT = /^[a-zA-Z0-9][a-zA-Z0-9_\-./]*$/;

/** Keep in sync with test_registry_name.py SHARED_VECTORS. */
const SHARED_VECTORS: Array<[string, string]> = [
  ['Test - Ingest', 'Test-Ingest'],
  ['Test Ingest 1', 'Test-Ingest-1'],
  ['  café app! ', 'caf-app'],
  ['---', 'app'],
  ['9lives', '9lives'],
  ['ok_name-1.2/x', 'ok_name-1.2/x'],
];

describe('sanitizeRegistryName', () => {
  it('exports a pattern identical to the registry constraint', () => {
    expect(REGISTRY_NAME_PATTERN.source).toBe(CONSTRAINT.source);
  });

  it.each(SHARED_VECTORS)('shared vector: %j → %j', (input, expected) => {
    expect(sanitizeRegistryName(input)).toBe(expected);
  });

  it('property: output matches the registry regex for arbitrary unicode strings', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (s) => {
        const out = sanitizeRegistryName(s);
        expect(out.length).toBeGreaterThan(0);
        expect(CONSTRAINT.test(out)).toBe(true);
      }),
      { numRuns: 500 },
    );
  });

  it('property: idempotent — sanitize(sanitize(s)) === sanitize(s)', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (s) => {
        const once = sanitizeRegistryName(s);
        expect(sanitizeRegistryName(once)).toBe(once);
      }),
      { numRuns: 500 },
    );
  });

  it('property: legal inputs pass through unchanged', () => {
    const alnum =
      'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const rest = alnum + '_-./';
    const legalArb = fc
      .tuple(
        fc.constantFrom(...alnum.split('')),
        fc.string({ unit: fc.constantFrom(...rest.split('')), maxLength: 60 }),
      )
      .map(([first, tail]) => first + tail);
    fc.assert(
      fc.property(legalArb, (s) => {
        expect(CONSTRAINT.test(s)).toBe(true); // generator sanity
        expect(sanitizeRegistryName(s)).toBe(s);
      }),
      { numRuns: 500 },
    );
  });

  it('empty and whitespace-only inputs fall back deterministically', () => {
    expect(sanitizeRegistryName('')).toBe('app');
    expect(sanitizeRegistryName('   ')).toBe('app');
    expect(sanitizeRegistryName('!!!')).toBe('app');
  });
});
