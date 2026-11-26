/**
 * Unit tests for checklist-parser.
 *
 * Covers:
 *   - Real-file parse: backend/src/lambda/governance-checklist.md parses to
 *     exactly 20 questions across 5 distinct clusters, every question
 *     having non-empty requiredEvidence + source.
 *   - Synthetic minimal: 2 clusters / 3 questions → exact parsed output.
 *   - Error case: missing "Required evidence:" line throws
 *     ChecklistParseError with the offending questionId in the message.
 *   - Property (≥100 iters): arbitrary permutation of 1..20 well-formed
 *     question blocks → parser returns them in document order with
 *     correct questionIds.
 *
 * The parser is pure (no fs, no network) — it accepts a markdown string
 * and returns a typed array. The resolver is the I/O-bound caller that
 * fs.readFileSyncs the bundled file once at module load.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as fc from 'fast-check';

import {
  parseChecklist,
  ChecklistParseError,
  type ChecklistQuestion,
} from '../checklist-parser';

const REAL_CHECKLIST_PATH = path.join(
  __dirname,
  '..',
  'governance-checklist.md',
);

const CANONICAL_CLUSTERS = [
  'Investigation Design',
  'Advisory Structure',
  'Execution Design',
  'Investment Framing',
  'Partner Capability',
];

describe('checklist-parser', () => {
  // ── Real-file parse ──────────────────────────────────────────────────

  describe('real governance-checklist.md', () => {
    const markdown = fs.readFileSync(REAL_CHECKLIST_PATH, 'utf-8');
    const questions = parseChecklist(markdown);

    test('1. parses exactly 20 questions', () => {
      expect(questions).toHaveLength(20);
    });

    test('2. question IDs are Q001..Q020 in document order', () => {
      const ids = questions.map((q) => q.questionId);
      const expected = Array.from({ length: 20 }, (_, i) =>
        `Q${String(i + 1).padStart(3, '0')}`,
      );
      expect(ids).toEqual(expected);
    });

    test('3. spans exactly 5 distinct clusters', () => {
      const clusters = new Set(questions.map((q) => q.cluster));
      expect(clusters.size).toBe(5);
      for (const c of CANONICAL_CLUSTERS) {
        expect(clusters.has(c)).toBe(true);
      }
    });

    test('4. every question has non-empty requiredEvidence', () => {
      for (const q of questions) {
        expect(q.requiredEvidence.length).toBeGreaterThan(0);
        expect(q.requiredEvidence.trim()).toBe(q.requiredEvidence);
      }
    });

    test('5. every question has non-empty source', () => {
      for (const q of questions) {
        expect(q.source.length).toBeGreaterThan(0);
        expect(q.source).toMatch(/GOV-FW-CTO/);
      }
    });

    test('6. every question has non-empty title and questionText', () => {
      for (const q of questions) {
        expect(q.title.length).toBeGreaterThan(0);
        expect(q.questionText.length).toBeGreaterThan(0);
      }
    });

    test('7. cluster ordering matches document order (4+4+4+4+4)', () => {
      const clusterCounts: Record<string, number> = {};
      for (const q of questions) {
        clusterCounts[q.cluster] = (clusterCounts[q.cluster] || 0) + 1;
      }
      expect(clusterCounts).toEqual({
        'Investigation Design': 4,
        'Advisory Structure': 4,
        'Execution Design': 4,
        'Investment Framing': 4,
        'Partner Capability': 4,
      });
    });
  });

  // ── Synthetic minimal ────────────────────────────────────────────────

  describe('synthetic markdown', () => {
    test('8. minimal 2-cluster / 3-question sample parses exactly', () => {
      const md = [
        '# Governance Checklist',
        '',
        '## Cluster One',
        '',
        '### Q001: Alpha question',
        '',
        'This is the alpha question body.',
        '',
        'Required evidence: one alpha row exists.',
        '',
        'Source: [DOC §1, p1]',
        '',
        '### Q002: Beta question',
        '',
        'Beta body line.',
        '',
        'Required evidence: two beta rows exist.',
        '',
        'Source: [DOC §1, p2]',
        '',
        '## Cluster Two',
        '',
        '### Q003: Gamma question',
        '',
        'Gamma body.',
        '',
        'Required evidence: three gamma rows exist.',
        '',
        'Source: [DOC §2, p3]',
        '',
      ].join('\n');

      const questions = parseChecklist(md);
      expect(questions).toHaveLength(3);

      expect(questions[0]).toEqual<ChecklistQuestion>({
        questionId: 'Q001',
        cluster: 'Cluster One',
        title: 'Alpha question',
        questionText: 'This is the alpha question body.',
        requiredEvidence: 'one alpha row exists.',
        source: '[DOC §1, p1]',
      });
      expect(questions[1]).toEqual<ChecklistQuestion>({
        questionId: 'Q002',
        cluster: 'Cluster One',
        title: 'Beta question',
        questionText: 'Beta body line.',
        requiredEvidence: 'two beta rows exist.',
        source: '[DOC §1, p2]',
      });
      expect(questions[2]).toEqual<ChecklistQuestion>({
        questionId: 'Q003',
        cluster: 'Cluster Two',
        title: 'Gamma question',
        questionText: 'Gamma body.',
        requiredEvidence: 'three gamma rows exist.',
        source: '[DOC §2, p3]',
      });
    });

    test('9. multi-line question text uses the first non-empty paragraph only', () => {
      const md = [
        '## Cluster',
        '',
        '### Q001: The title',
        '',
        'First paragraph line one.',
        'First paragraph line two.',
        '',
        'Second paragraph that should NOT become questionText.',
        '',
        'Required evidence: evidence line.',
        '',
        'Source: [SRC]',
        '',
      ].join('\n');

      const questions = parseChecklist(md);
      expect(questions).toHaveLength(1);
      expect(questions[0].questionText).toBe(
        'First paragraph line one. First paragraph line two.',
      );
    });

    test('10. tolerant of trailing whitespace on evidence and source lines', () => {
      const md = [
        '## Cluster',
        '',
        '### Q001: Title',
        '',
        'Body.',
        '',
        'Required evidence: value with trailing spaces. ',
        '',
        'Source: [SRC]\t ',
        '',
      ].join('\n');

      const questions = parseChecklist(md);
      expect(questions[0].requiredEvidence).toBe(
        'value with trailing spaces.',
      );
      expect(questions[0].source).toBe('[SRC]');
    });
  });

  // ── Error cases ──────────────────────────────────────────────────────

  describe('error cases', () => {
    test('11. missing "Required evidence:" line throws ChecklistParseError with questionId', () => {
      const md = [
        '## Cluster',
        '',
        '### Q042: Missing evidence',
        '',
        'Body text here.',
        '',
        'Source: [SRC]',
        '',
      ].join('\n');

      expect(() => parseChecklist(md)).toThrow(ChecklistParseError);
      try {
        parseChecklist(md);
        fail('expected ChecklistParseError');
      } catch (err) {
        expect(err).toBeInstanceOf(ChecklistParseError);
        expect((err as Error).message).toMatch(/Q042/);
        expect((err as Error).message).toMatch(/Required evidence/i);
      }
    });

    test('12. missing "Source:" line throws ChecklistParseError with questionId', () => {
      const md = [
        '## Cluster',
        '',
        '### Q099: Missing source',
        '',
        'Body text.',
        '',
        'Required evidence: row exists.',
        '',
      ].join('\n');

      expect(() => parseChecklist(md)).toThrow(ChecklistParseError);
      try {
        parseChecklist(md);
        fail('expected ChecklistParseError');
      } catch (err) {
        expect((err as Error).message).toMatch(/Q099/);
        expect((err as Error).message).toMatch(/Source/i);
      }
    });

    test('13. question without a preceding cluster H2 throws ChecklistParseError', () => {
      const md = [
        '### Q001: Orphan question',
        '',
        'Body.',
        '',
        'Required evidence: row exists.',
        '',
        'Source: [SRC]',
        '',
      ].join('\n');

      expect(() => parseChecklist(md)).toThrow(ChecklistParseError);
    });

    test('14. empty markdown returns empty array', () => {
      expect(parseChecklist('')).toEqual([]);
      expect(parseChecklist('\n\n\n')).toEqual([]);
    });

    test('15. markdown with only a cluster heading returns empty array', () => {
      expect(parseChecklist('## Investigation Design\n\n')).toEqual([]);
    });
  });

  // ── Property test ────────────────────────────────────────────────────

  describe('property: permutation preserves document order + IDs', () => {
    test('16. (≥100 iters) parser returns questions in document order with correct IDs for any 1..20 permutation', () => {
      fc.assert(
        fc.property(
          // A permutation of 1..20 of any length between 1 and 20.
          fc
            .shuffledSubarray(
              Array.from({ length: 20 }, (_, i) => i + 1),
              { minLength: 1, maxLength: 20 },
            )
            // Avoid uniform-character test payloads per QB-003-1 ReDoS
            // lesson: generate varied per-question content deterministically
            // from the number so each block differs.
            .map((nums) => ({
              nums,
              // Build the markdown body from the numbers.
              md: buildSyntheticMarkdown(nums),
            })),
          ({ nums, md }) => {
            const qs = parseChecklist(md);
            expect(qs).toHaveLength(nums.length);
            const actualIds = qs.map((q) => q.questionId);
            const expectedIds = nums.map(
              (n) => `Q${String(n).padStart(3, '0')}`,
            );
            expect(actualIds).toEqual(expectedIds);
            // Also confirm requiredEvidence / source survived intact.
            for (let i = 0; i < nums.length; i++) {
              expect(qs[i].requiredEvidence).toBe(`evidence-${nums[i]}`);
              expect(qs[i].source).toBe(`[SRC-${nums[i]}]`);
            }
          },
        ),
        { numRuns: 100 },
      );
    });
  });
});

/**
 * Build synthetic checklist markdown from an array of question numbers.
 * Splits the numbers across two clusters to also exercise cluster boundaries.
 * Content varies per-number to avoid the uniform-character antipattern
 * that triggers ReDoS in naive regex implementations (QB-003-1).
 */
function buildSyntheticMarkdown(nums: number[]): string {
  const lines: string[] = ['# Header', ''];
  // First half in Cluster A, remainder in Cluster B.
  const half = Math.ceil(nums.length / 2);
  if (nums.length > 0) {
    lines.push('## Cluster A', '');
    for (const n of nums.slice(0, half)) {
      lines.push(
        `### Q${String(n).padStart(3, '0')}: Title ${n}`,
        '',
        `Body paragraph for question ${n} with variety ${n * 7 + 3}.`,
        '',
        `Required evidence: evidence-${n}`,
        '',
        `Source: [SRC-${n}]`,
        '',
      );
    }
    if (nums.length > half) {
      lines.push('## Cluster B', '');
      for (const n of nums.slice(half)) {
        lines.push(
          `### Q${String(n).padStart(3, '0')}: Title ${n}`,
          '',
          `Body paragraph for question ${n} with variety ${n * 7 + 3}.`,
          '',
          `Required evidence: evidence-${n}`,
          '',
          `Source: [SRC-${n}]`,
          '',
        );
      }
    }
  }
  return lines.join('\n');
}
