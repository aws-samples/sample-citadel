/**
 * Governance-checklist markdown parser.
 *
 * Pure function: no fs, no network, no module-level side-effects. Accepts
 * the raw markdown of `backend/src/lambda/governance-checklist.md` and returns
 * a typed list of ChecklistQuestion rows in document order.
 *
 * The resolver (program-review-resolver.ts) is the I/O-bound caller that
 * fs.readFileSyncs the bundled file once at module load and memoises the
 * parsed list for the lifetime of the Lambda container.
 *
 * Markdown shape (per, commit fc2c998):
 *   - Clusters are H2 headings (`## Cluster Name`).
 *   - Questions are H3 headings matching `### Qnnn: Title`.
 *   - For each question block, the first non-empty prose paragraph
 *     before the `Required evidence:` line is captured as questionText.
 *   - The line starting `Required evidence:` contains the evidence rule.
 *   - The line starting `Source:` contains the citation.
 *
 * Invariants:
 *   - Every question MUST have a `Required evidence:` line.
 *   - Every question MUST have a `Source:` line.
 *   - Every question MUST be preceded by a cluster H2.
 * Violations throw ChecklistParseError with the offending questionId
 * named in the message — malformed input is a spec violation (QB-020).
 *
 * ReDoS safety (QB-003-1 lesson): all regexes are anchored and bounded;
 * no nested quantifiers on overlapping character classes. Uniform-byte
 * inputs cannot trigger catastrophic backtracking.
 */

/**
 * A single parsed governance-checklist question.
 */
export interface ChecklistQuestion {
  /** Stable question identifier, e.g. 'Q001'. */
  questionId: string;
  /** Cluster (H2) the question was nested under, e.g. 'Investigation Design'. */
  cluster: string;
  /** Text after the 'Qnnn:' prefix on the H3 line, e.g. 'Four-dimension assessment completed'. */
  title: string;
  /** First non-empty prose paragraph following the heading, joined with single spaces if multi-line. */
  questionText: string;
  /** Value of the 'Required evidence:' line, with the label stripped and trailing whitespace trimmed. */
  requiredEvidence: string;
  /** Value of the 'Source:' line, with the label stripped and trailing whitespace trimmed. */
  source: string;
}

/**
 * Thrown on any structural violation of the checklist markdown contract.
 * The message embeds the offending questionId (or a positional hint if no
 * question heading is reachable) so downstream logs can pinpoint the
 * offending block without re-reading the file.
 */
export class ChecklistParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChecklistParseError';
    // Restore prototype for instanceof across TS downlevel targets.
    Object.setPrototypeOf(this, ChecklistParseError.prototype);
  }
}

// Anchored, bounded regexes — safe against uniform-byte ReDoS inputs.
// H2 cluster: `## Cluster Name` — trailing whitespace tolerated.
const H2_RE = /^##\s+(.+?)\s*$/;
// H3 question: `### Qnnn: Title` — id is exactly three digits.
const H3_RE = /^###\s+(Q\d{3}):\s*(.*?)\s*$/;
// H1..H6 catch-all so we don't mistake a deeper heading for question body.
const ANY_HEADING_RE = /^#{1,6}\s+/;
// Label lines. Tolerant of trailing whitespace; the value is captured
// non-greedily and then trimmed on the caller side for safety.
const REQ_EVIDENCE_RE = /^Required evidence:\s*(.*?)\s*$/;
const SOURCE_RE = /^Source:\s*(.*?)\s*$/;

/**
 * Parse the bundled governance-checklist markdown into a typed list of
 * questions. Returns an empty array for empty/whitespace-only input and
 * for input that contains only cluster headings but no questions.
 *
 * @throws ChecklistParseError if any question block is missing a
 *         `Required evidence:` line, a `Source:` line, or a preceding
 *         cluster H2 heading.
 */
export function parseChecklist(markdown: string): ChecklistQuestion[] {
  if (typeof markdown !== 'string') {
    throw new ChecklistParseError('markdown must be a string');
  }

  // Normalise line endings so CRLF inputs parse identically to LF.
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');

  const results: ChecklistQuestion[] = [];
  let currentCluster: string | null = null;

  // We walk the file line-by-line. When we hit an H3 question heading,
  // we consume forward until the next heading (H2 or H3) and collect
  // the body, the evidence line, and the source line.
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    const h2 = H2_RE.exec(line);
    if (h2) {
      currentCluster = h2[1].trim();
      i++;
      continue;
    }

    const h3 = H3_RE.exec(line);
    if (h3) {
      const questionId = h3[1];
      const title = h3[2].trim();

      if (currentCluster === null) {
        throw new ChecklistParseError(
          `Question ${questionId} appears before any cluster heading (H2)`,
        );
      }

      // Collect body lines until the next H2 or H3 heading. We do NOT
      // treat the terminating heading as part of this question's body;
      // we leave it for the outer loop to pick up on the next iteration.
      const bodyStart = i + 1;
      let j = bodyStart;
      while (j < lines.length) {
        const next = lines[j];
        if (H2_RE.test(next) || H3_RE.test(next)) break;
        j++;
      }

      const bodyLines = lines.slice(bodyStart, j);

      // Locate Required evidence: and Source: lines.
      let requiredEvidence: string | null = null;
      let source: string | null = null;
      let evidenceLineIdx = -1;
      for (let k = 0; k < bodyLines.length; k++) {
        const bLine = bodyLines[k];
        const e = REQ_EVIDENCE_RE.exec(bLine);
        if (e && requiredEvidence === null) {
          requiredEvidence = e[1].trim();
          evidenceLineIdx = k;
          continue;
        }
        const s = SOURCE_RE.exec(bLine);
        if (s && source === null) {
          source = s[1].trim();
          continue;
        }
      }

      if (requiredEvidence === null || requiredEvidence.length === 0) {
        throw new ChecklistParseError(
          `Question ${questionId} is missing a "Required evidence:" line`,
        );
      }
      if (source === null || source.length === 0) {
        throw new ChecklistParseError(
          `Question ${questionId} is missing a "Source:" line`,
        );
      }

      // Extract the first non-empty prose paragraph that appears BEFORE
      // the evidence line. A paragraph is a maximal run of consecutive
      // non-empty, non-heading lines. We join multi-line paragraphs with
      // a single space so the result is a clean single-line string.
      const proseScanEnd =
        evidenceLineIdx >= 0 ? evidenceLineIdx: bodyLines.length;
      let questionText = '';
      let paragraph: string[] = [];
      for (let k = 0; k < proseScanEnd; k++) {
        const pLine = bodyLines[k];
        if (ANY_HEADING_RE.test(pLine)) {
          // Shouldn't happen (we stopped at heading boundaries above) but
          // guard for deeper headings we intentionally skip over.
          if (paragraph.length > 0) break;
          continue;
        }
        if (pLine.trim().length === 0) {
          if (paragraph.length > 0) break;
          continue;
        }
        // Skip the label lines themselves when they sit inside the prose
        // scan window (they can't, given proseScanEnd, but defensive).
        if (REQ_EVIDENCE_RE.test(pLine) || SOURCE_RE.test(pLine)) {
          if (paragraph.length > 0) break;
          continue;
        }
        paragraph.push(pLine.trim());
      }
      questionText = paragraph.join(' ').trim();

      results.push({
        questionId,
        cluster: currentCluster,
        title,
        questionText,
        requiredEvidence,
        source,
      });

      i = j;
      continue;
    }

    i++;
  }

  return results;
}
