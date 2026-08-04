/**
 * eval-no-composite.guard.test.ts (CIT-103 Pass A) — mechanical guard
 * against ever collapsing the 7-dimension ScoreVector into a single
 * composite number. Modeled on empty-catch-guard.test.ts's scanning
 * precedent (steering: "Never use empty catch{} around DB writes" —
 * same technique, different forbidden pattern).
 *
 * Two independent checks:
 *  (a) STATIC SCAN — every curated eval-scoring source file must not
 *      contain an identifier matching /composite|overallScore|
 *      weightedScore|totalScore\b/i.
 *  (b) BEHAVIORAL — a real aggregate built from sample ScoreVectors is
 *      asserted to be an array of per-dimension objects with no
 *      top-level numeric "total" field anywhere in the result.
 *
 * The "prove it bites" requirement: a companion negative test below
 * plants a composite field into a SCRATCH copy of the source and asserts
 * the scanner FAILS on it — demonstrating the guard is not a no-op.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  aggregateScoreVectors,
  type CaseScoreRowForAggregation,
} from "../src/lambda/utils/eval-score-aggregate";
import type { DimensionScore } from "../src/lambda/utils/eval-scoring";

// Matches identifier-style occurrences (camelCase/PascalCase field or
// variable names), not plain-English prose. Word-boundary-anchored so a
// doc comment sentence like "never a composite number" does not false-
// positive, while `compositeScore`, `overallScore`, `weightedScore`, and
// `totalScore` (as identifiers) are caught. `composite` alone must be
// followed by an identifier-continuation character (upper-case letter or
// underscore then a letter) to count as a planted field/identifier rather
// than the common-English word.
const FORBIDDEN_IDENTIFIER_RE =
  /\b(composite[A-Z_]\w*|overallScore|weightedScore|totalScore)\b/;

// Curated file list — every file that participates in producing or
// persisting a ScoreVector/aggregate. Extend this list as CIT-103's
// scoring surface grows (eval-case-scorer.ts, eval-run-aggregator.ts are
// added once they exist in this pass).
const CURATED_FILES = [
  "src/lambda/utils/eval-scoring.ts",
  "src/lambda/utils/eval-score-aggregate.ts",
  "src/lambda/utils/eval-trajectory.ts",
  "src/lambda/eval-case-scorer.ts",
  "src/lambda/eval-run-aggregator.ts",
];

function scanFileForForbiddenIdentifiers(absPath: string): string[] {
  if (!fs.existsSync(absPath)) return [];
  const content = fs.readFileSync(absPath, "utf-8");
  const hits: string[] = [];
  for (const line of content.split("\n")) {
    if (FORBIDDEN_IDENTIFIER_RE.test(line)) {
      hits.push(line.trim());
    }
  }
  return hits;
}

describe("eval-no-composite guard — static scan", () => {
  it("no curated eval-scoring source file contains a composite/overallScore/weightedScore/totalScore identifier", () => {
    const repoRoot = path.resolve(__dirname, "..");
    const allHits: Record<string, string[]> = {};

    for (const relPath of CURATED_FILES) {
      const hits = scanFileForForbiddenIdentifiers(
        path.join(repoRoot, relPath),
      );
      if (hits.length > 0) allHits[relPath] = hits;
    }

    expect(allHits).toEqual({});
  });

  it("bites: the scanner FAILS when a composite field is planted in a scratch copy", () => {
    const scratchDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "eval-no-composite-guard-"),
    );
    const scratchFile = path.join(scratchDir, "planted-composite.ts");
    try {
      fs.writeFileSync(
        scratchFile,
        [
          "export interface RunAggregate {",
          "  dimension: string;",
          "  compositeScore: number; // planted violation",
          "}",
        ].join("\n"),
      );

      const hits = scanFileForForbiddenIdentifiers(scratchFile);
      // The bite-proof: hits must be NON-EMPTY, i.e. the scanner
      // correctly flags this planted violation. If this assertion ever
      // fails, the regex itself is broken and the guard is a no-op.
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0]).toMatch(/compositeScore/);
    } finally {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    }
  });
});

describe("eval-no-composite guard — behavioral (real aggregate shape)", () => {
  function dim(overrides: Partial<DimensionScore>): DimensionScore {
    return {
      dimension: "task_success",
      status: "SCORED",
      basis: "DETERMINISTIC",
      detail: "",
      ...overrides,
    } as DimensionScore;
  }

  it("aggregateScoreVectors() output has no top-level numeric total across all dimension keys", () => {
    const rows: CaseScoreRowForAggregation[] = [
      {
        caseId: "c1",
        scoreVector: [
          dim({
            dimension: "task_success",
            verdict: { kind: "boolean", pass: true },
          }),
          dim({
            dimension: "tool_accuracy",
            verdict: { kind: "score", score: 1 },
          }),
          dim({ dimension: "latency", measurement: 500 }),
          dim({ dimension: "cost", measurement: 0.05 }),
        ],
      },
    ];

    const result = aggregateScoreVectors(rows);

    // Result must be an array keyed per-dimension — never a single object
    // with an aggregate top-level number.
    expect(Array.isArray(result)).toBe(true);

    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(FORBIDDEN_IDENTIFIER_RE);

    // Every object key across every dimension aggregate must belong to
    // the known per-dimension aggregate shape — no stray top-level
    // composite/overall key can have snuck in.
    const ALLOWED_KEYS = new Set([
      "dimension",
      "scoredCount",
      "notApplicableCount",
      "unknownCount",
      "pendingCount",
      "passedCount",
      "passRate",
      "meanScore",
      "p50",
      "p95",
      "sumUsd",
      "meanUsd",
    ]);
    for (const agg of result) {
      for (const key of Object.keys(agg)) {
        expect(ALLOWED_KEYS.has(key)).toBe(true);
      }
    }
  });
});
