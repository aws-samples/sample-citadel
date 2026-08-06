/**
 * eval-adversarial-packs.ts tests — pure, AWS-free proof that the
 * injection / tool-schema-poisoning corpus is scored deterministically by
 * the existing scorers, and that a weakened sanitizer build FAILS the
 * pack.
 *
 * scoreInjectionPack is exercised with dependency-injected sanitizers so
 * the whole test stays pure: no AWS clients, no I/O, no timers.
 */
import {
  INJECTION_CORPUS,
  scoreInjectionPack,
  type InjectableSanitizeText,
  type InjectableSanitizeJson,
} from "../eval-adversarial-packs";
import { sanitizeUntrustedAgentOutput } from "../../../utils/sanitize-agent-output";
import { sanitizeUntrustedJson } from "../../../utils/sanitize-untrusted-json";

describe("INJECTION_CORPUS", () => {
  it("is non-empty and every entry carries a trigger phrase that must not survive", () => {
    expect(INJECTION_CORPUS.length).toBeGreaterThan(0);
    for (const entry of INJECTION_CORPUS) {
      expect(typeof entry.trigger).toBe("string");
      expect(entry.trigger.length).toBeGreaterThan(0);
    }
  });

  it("covers both text-carried injection and JSON tool-schema poisoning", () => {
    const kinds = INJECTION_CORPUS.map((e) => e.kind);
    expect(kinds).toContain("text");
    expect(kinds).toContain("json");
  });
});

describe("scoreInjectionPack — weakened-sanitizer acceptance", () => {
  it("yields a real ScoreVector[]-backed report and passes every case with the real sanitizer", () => {
    const result = scoreInjectionPack(
      sanitizeUntrustedAgentOutput,
      sanitizeUntrustedJson,
    );

    expect(result.failed).toBe(0);
    expect(result.passed).toBe(INJECTION_CORPUS.length);
    expect(result.report.length).toBe(INJECTION_CORPUS.length);
    for (const vector of result.report) {
      expect(Array.isArray(vector)).toBe(true);
      const taskSuccess = vector.find((d) => d.dimension === "task_success");
      expect(taskSuccess?.status).toBe("SCORED");
    }
  });

  it("fails the pack when the sanitizer is weakened to an identity function", () => {
    const identityText: InjectableSanitizeText = (text: string) => ({
      sanitized: text,
      modified: false,
      matches: [],
    });
    const identityJson: InjectableSanitizeJson = (value: unknown) => ({
      value: value as never,
      truncated: false,
      nodeCount: 0,
      matches: [],
    });

    const result = scoreInjectionPack(identityText, identityJson);

    expect(result.failed).toBeGreaterThan(0);
  });

  it("is deterministic across repeated runs with the real sanitizer", () => {
    const a = scoreInjectionPack(
      sanitizeUntrustedAgentOutput,
      sanitizeUntrustedJson,
    );
    const b = scoreInjectionPack(
      sanitizeUntrustedAgentOutput,
      sanitizeUntrustedJson,
    );
    expect(a).toEqual(b);
  });
});
