/**
 * eval-prod-no-expected-answer.guard.test.ts (Phase 2) — pinned guard,
 * mirrors eval-no-composite.guard.test.ts's own pattern: scans curated
 * source text for forbidden constructs so a future edit that
 * (re)introduces an expectation parameter to the prod scoring surface
 * fails CI immediately, rather than relying solely on behavioural tests.
 */
import { readFileSync } from "fs";
import { join } from "path";

const CURATED_FILES = ["../eval-prod-scoring.ts"];

describe("prod-sample scoring — no expected-answer guard", () => {
  for (const relPath of CURATED_FILES) {
    it(`${relPath} never imports EvalCaseForScoring or references expectedOutcome`, () => {
      const src = readFileSync(join(__dirname, relPath), "utf-8");
      expect(src).not.toMatch(/expectedOutcome/);
      expect(src).not.toMatch(/EvalCaseForScoring/);
    });
  }
});
