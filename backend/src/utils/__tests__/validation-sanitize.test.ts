/**
 * Stress tests for sanitizeString — CodeQL js/incomplete-multi-character-sanitization (#29).
 *
 * The previous implementation stripped multi-character tokens (e.g. "<script")
 * in a loop. That class of fix is defeated by interleaved input such as
 * "<scr<script></script>ipt", which reassembles a live "<script" residue once
 * the inner block is removed. The hardened implementation escapes the
 * tag-significant characters (&, <, >) independently, so the output contains
 * no literal "<" or ">" at all and no removal step can splice neighbouring
 * characters into a new tag.
 *
 * These tests validate the fix BY EXECUTION (project rule: regex/sanitizer
 * changes must be proven by running, not by visual review).
 */

import { sanitizeString } from '../validation';

describe('sanitizeString — CodeQL #29 multi-character sanitization hardening', () => {
  // Each entry: [human label, malicious input]. These are XSS payloads that a
  // single-pass or even fixed-point strip approach can fail to neutralise.
  const BYPASS_INPUTS: Array<[string, string]> = [
    ['regression that defeated the strip loop', '<scr<script></script>ipt'],
    ['interleaved with trailing payload', '<scr<script></script>ipt>alert(1)</script>'],
    ['split open tag', '<scr<script>ipt>'],
    ['doubled brackets', '<<script>script>'],
    ['doubled brackets with payload', '<<script>script>alert(1)<</script>/script>'],
    ['mixed case', '<ScRiPt>alert(1)</ScRiPt>'],
    ['upper case', '<SCRIPT>alert(1)</SCRIPT>'],
    ['nested mixed-case interleave', '<ScR<ScRiPt></sCrIpT>iPt>'],
    ['img onerror handler', '<img src=x onerror=alert(1)>'],
    ['svg onload handler', '<svg/onload=alert(1)>'],
    ['iframe javascript URI', '<iframe src="javascript:alert(1)">'],
  ];

  describe('neutralizes XSS bypass attempts — no literal < or > survives', () => {
    test.each(BYPASS_INPUTS)('%s', (_label, input) => {
      const out = sanitizeString(input);
      expect(out).not.toContain('<');
      expect(out).not.toContain('>');
      // Explicit residual-token assertion required by the verification contract.
      expect(out.toLowerCase()).not.toContain('<script');
    });
  });

  test('the specific "<scr<script></script>ipt" regression cannot reassemble a tag', () => {
    const out = sanitizeString('<scr<script></script>ipt');
    expect(out).not.toContain('<');
    expect(out).not.toContain('>');
    expect(out.toLowerCase()).not.toContain('<script');
    // Deterministic, fully-escaped form.
    expect(out).toBe('&lt;scr&lt;script&gt;&lt;/script&gt;ipt');
  });

  describe('escaping is correct and order-safe', () => {
    test('escapes < to &lt; and > to &gt;', () => {
      expect(sanitizeString('<script>')).toBe('&lt;script&gt;');
    });

    test('escapes a bare < without double-escaping the introduced &', () => {
      expect(sanitizeString('<')).toBe('&lt;');
    });

    test('escapes a bare > without double-escaping the introduced &', () => {
      expect(sanitizeString('>')).toBe('&gt;');
    });

    test('escapes a literal ampersand to &amp;', () => {
      expect(sanitizeString('A & B')).toBe('A &amp; B');
    });

    test('escapes the ampersand of a pre-existing entity (prevents entity smuggling)', () => {
      // & is escaped first, so an incoming "&lt;" becomes inert "&amp;lt;"
      // rather than passing through as a live "<" once decoded.
      expect(sanitizeString('&lt;script&gt;')).toBe('&amp;lt;script&amp;gt;');
    });
  });

  describe('fixpoint robustness — security property holds under re-application', () => {
    test.each(BYPASS_INPUTS)('re-sanitizing output of %s still has no < or >', (_label, input) => {
      const once = sanitizeString(input);
      const twice = sanitizeString(once);
      expect(once).not.toContain('<');
      expect(once).not.toContain('>');
      // Re-running can only re-escape ampersands; it can never reintroduce
      // angle brackets — the defining contrast with the old strip loop.
      expect(twice).not.toContain('<');
      expect(twice).not.toContain('>');
    });
  });

  describe('does not over-sanitize — legitimate text containing "script" is untouched', () => {
    const SAFE_INPUTS = [
      'Please run the deployment script now',
      'a javascript developer wrote this',
      'transcript of the meeting',
      'subscription manager dashboard',
      'The script ran successfully',
      'manuscript review pending',
    ];
    test.each(SAFE_INPUTS)('leaves %j unchanged', (input) => {
      expect(sanitizeString(input)).toBe(input);
    });
  });

  describe('length and truncation', () => {
    test('output never exceeds the default maxLength of 1000', () => {
      const out = sanitizeString('a'.repeat(5000));
      expect(out.length).toBe(1000);
    });

    test('respects a custom maxLength', () => {
      expect(sanitizeString('abcdefghij', 4)).toBe('abcd');
    });

    test('escaping expansion stays bounded by maxLength and yields no < or >', () => {
      // 500 "<" -> 500 * "&lt;" = 2000 chars -> truncated to 1000.
      const out = sanitizeString('<'.repeat(500));
      expect(out.length).toBe(1000);
      expect(out).not.toContain('<');
      expect(out).not.toContain('>');
    });
  });

  describe('preserved behaviour from the original implementation', () => {
    test('trims leading and trailing whitespace', () => {
      expect(sanitizeString('   hello   ')).toBe('hello');
    });

    test('returns empty string for an empty input', () => {
      expect(sanitizeString('')).toBe('');
    });

    test.each([
      ['null', null],
      ['undefined', undefined],
      ['number', 42],
      ['object', { a: 1 }],
      ['array', ['x']],
    ])('returns "" for non-string input: %s', (_label, input) => {
      expect(sanitizeString(input as unknown as string)).toBe('');
    });
  });
});
