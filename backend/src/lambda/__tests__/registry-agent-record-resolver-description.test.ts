/**
 * Unit tests for `extractHumanDescription` in
 * ../registry-agent-record-resolver.ts.
 *
 * Context: the Fabricator stores the entire agent manifest JSON in the
 * Registry record's `description` field. The UI previously rendered that raw
 * JSON verbatim. `extractHumanDescription` is the projection-layer helper
 * that unwraps the nested human description (either `.description` or
 * `.info.description`) and falls back to the raw value for plain-text
 * descriptions, malformed JSON, or manifests that lack a description field.
 *
 * These tests exercise the helper in isolation; they do not import the
 * resolver handler to keep the suite free of AWS SDK wiring.
 */
import { extractHumanDescription, toIntVersion } from '../registry-agent-record-resolver';

describe('extractHumanDescription', () => {
  describe('empty / missing input', () => {
    it('returns empty string for null', () => {
      expect(extractHumanDescription(null)).toBe('');
    });

    it('returns empty string for undefined', () => {
      expect(extractHumanDescription(undefined)).toBe('');
    });

    it('returns empty string for empty string', () => {
      expect(extractHumanDescription('')).toBe('');
    });
  });

  describe('plain-text passthrough', () => {
    it('returns plain text unchanged', () => {
      expect(extractHumanDescription('A simple description')).toBe(
        'A simple description',
      );
    });

    it('returns plain text unchanged even when it starts with a brace-like character but is not JSON', () => {
      expect(extractHumanDescription('{not json}')).toBe('{not json}');
    });
  });

  describe('JSON manifest extraction', () => {
    it('extracts nested .description from the fabricator-shaped manifest', () => {
      const raw = JSON.stringify({
        name: 'TestPostGovAgent',
        filename: 'TestPostGovAgent.py',
        schema: {
          openapi: '3.0.0',
          info: {
            title: 'TestPostGovAgent',
            version: '1.0.0',
            description: 'Reviews S3 data inputs...',
          },
        },
        version: '1',
        description:
          'Reviews data retrieved from an S3 source, confirms that a governance framework is applied...',
      });

      expect(extractHumanDescription(raw)).toBe(
        'Reviews data retrieved from an S3 source, confirms that a governance framework is applied...',
      );
    });

    it('extracts .info.description from an OpenAPI-style manifest when only the nested description is populated', () => {
      const raw = JSON.stringify({
        openapi: '3.0.0',
        info: {
          title: 'SomeOpenAPITool',
          version: '1.0.0',
          description: 'An OpenAPI tool that does something useful.',
        },
        paths: {},
      });

      expect(extractHumanDescription(raw)).toBe(
        'An OpenAPI tool that does something useful.',
      );
    });

    it('prefers top-level .description over .info.description when both exist', () => {
      const raw = JSON.stringify({
        description: 'Top-level human description',
        info: {
          description: 'Nested OpenAPI description',
        },
      });

      expect(extractHumanDescription(raw)).toBe('Top-level human description');
    });

    it('returns the raw JSON unchanged if it parses but has no usable description field', () => {
      const raw = '{"foo":"bar"}';
      expect(extractHumanDescription(raw)).toBe(raw);
    });
  });
});

describe('toIntVersion', () => {
  describe('numeric input', () => {
    it('returns an integer unchanged when it is a valid positive integer', () => {
      expect(toIntVersion(3)).toBe(3);
    });

    it('truncates a positive float (1.9 → 1)', () => {
      expect(toIntVersion(1.9)).toBe(1);
    });

    it('floors zero to 1', () => {
      expect(toIntVersion(0)).toBe(1);
    });

    it('floors a negative number to 1', () => {
      expect(toIntVersion(-5)).toBe(1);
    });
  });

  describe('string input', () => {
    it('parses "1" to 1', () => {
      expect(toIntVersion('1')).toBe(1);
    });

    it('parses "2" to 2', () => {
      expect(toIntVersion('2')).toBe(2);
    });

    it('parses "1.0" to 1 (parseInt stops at the dot)', () => {
      expect(toIntVersion('1.0')).toBe(1);
    });

    it('parses "1.5" to 1 (parseInt truncates)', () => {
      expect(toIntVersion('1.5')).toBe(1);
    });

    it('returns 1 for a non-numeric string', () => {
      expect(toIntVersion('abc')).toBe(1);
    });

    it('returns 1 for an empty string', () => {
      expect(toIntVersion('')).toBe(1);
    });
  });

  describe('nullish / non-version input', () => {
    it('returns 1 for undefined', () => {
      expect(toIntVersion(undefined)).toBe(1);
    });

    it('returns 1 for null', () => {
      expect(toIntVersion(null)).toBe(1);
    });

    it('returns 1 for a boolean true', () => {
      expect(toIntVersion(true)).toBe(1);
    });

    it('returns 1 for an empty object', () => {
      expect(toIntVersion({})).toBe(1);
    });
  });
});
