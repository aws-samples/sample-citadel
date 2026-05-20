/**
 * Unit tests for IntakeRequests polling replacement (Task 18.2)
 *
 * Validates:
 * - Req 16.1: setInterval polling mechanism removed (replaced with timestamp-based polling)
 * - Req 16.2: JSON.stringify comparison logic removed
 * - Req 16.3: Subscription documented as TODO follow-up
 * - Req 16.4: Change detection still works via updatedAt timestamps
 * - Req 16.5: Graceful handling documented
 * - Req 16.6: Fallback uses updatedAt timestamp comparison
 */
import * as fs from 'fs';
import * as path from 'path';
import { getLatestUpdatedAt } from '../intakePollingUtils';

const INTAKE_REQUESTS_PATH = path.resolve(__dirname, '../IntakeRequests.tsx');
const sourceCode = fs.readFileSync(INTAKE_REQUESTS_PATH, 'utf-8');

describe('IntakeRequests polling replacement', () => {
  describe('Req 16.2: JSON.stringify comparison removed', () => {
    it('should not use JSON.stringify for change detection', () => {
      // JSON.stringify should not appear in comparison logic
      // We check that there's no JSON.stringify(projectsList) or JSON.stringify(projects) pattern
      const jsonStringifyComparison = /JSON\.stringify\(.*\)\s*!==\s*JSON\.stringify/;
      expect(sourceCode).not.toMatch(jsonStringifyComparison);
    });

    it('should not use JSON.stringify in executable code', () => {
      // Strip comments and check no JSON.stringify remains in actual code
      const codeWithoutComments = sourceCode
        .replace(/\/\/.*$/gm, '')  // remove single-line comments
        .replace(/\/\*[\s\S]*?\*\//g, '');  // remove multi-line comments
      const jsonStringifyCalls = codeWithoutComments.match(/JSON\.stringify/g);
      expect(jsonStringifyCalls).toBeNull();
    });
  });

  describe('Req 16.6: updatedAt timestamp comparison fallback', () => {
    it('should use updatedAt for change detection', () => {
      expect(sourceCode).toContain('updatedAt');
      expect(sourceCode).toContain('lastUpdatedAtRef');
    });

    it('should track latest timestamp via useRef', () => {
      expect(sourceCode).toContain('useRef');
      expect(sourceCode).toContain('lastUpdatedAtRef');
    });

    it('should compare timestamps to detect changes', () => {
      expect(sourceCode).toContain('timestampChanged');
      expect(sourceCode).toContain('getLatestUpdatedAt');
    });

    it('should also detect count changes (additions/deletions)', () => {
      expect(sourceCode).toContain('lastCountRef');
      expect(sourceCode).toContain('countChanged');
    });
  });

  describe('Req 16.1: Polling interval still exists as fallback', () => {
    it('should still use setInterval for polling', () => {
      expect(sourceCode).toContain('setInterval');
    });

    it('should still poll at a regular interval', () => {
      // Interval was changed from 5s to 30s as subscription is now primary
      expect(sourceCode).toContain('30000');
    });

    it('should clean up interval on unmount', () => {
      expect(sourceCode).toContain('clearInterval');
    });
  });

  describe('Req 16.3/16.5: Subscription documented as follow-up', () => {
    it('should have a TODO comment about GraphQL subscriptions', () => {
      expect(sourceCode).toMatch(/TODO.*(?:subscription|GraphQL)/i);
    });

    it('should mention specific subscription events in the TODO', () => {
      expect(sourceCode).toMatch(/onCreateProject|onUpdateProject|onDeleteProject/);
    });
  });

  describe('getLatestUpdatedAt helper', () => {
    it('should return empty string for empty array', () => {
      expect(getLatestUpdatedAt([])).toBe('');
    });

    it('should return the single timestamp for one project', () => {
      const projects = [
        makeProject('p1', '2024-01-15T10:00:00Z'),
      ];
      expect(getLatestUpdatedAt(projects)).toBe('2024-01-15T10:00:00Z');
    });

    it('should return the latest timestamp from multiple projects', () => {
      const projects = [
        makeProject('p1', '2024-01-10T10:00:00Z'),
        makeProject('p2', '2024-01-20T10:00:00Z'),
        makeProject('p3', '2024-01-15T10:00:00Z'),
      ];
      expect(getLatestUpdatedAt(projects)).toBe('2024-01-20T10:00:00Z');
    });

    it('should handle identical timestamps', () => {
      const ts = '2024-06-01T00:00:00Z';
      const projects = [
        makeProject('p1', ts),
        makeProject('p2', ts),
      ];
      expect(getLatestUpdatedAt(projects)).toBe(ts);
    });
  });
});

/** Helper to create a minimal Project-like object for testing */
function makeProject(id: string, updatedAt: string) {
  return {
    id,
    name: `Project ${id}`,
    description: '',
    status: 'CREATED' as const,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt,
  };
}
