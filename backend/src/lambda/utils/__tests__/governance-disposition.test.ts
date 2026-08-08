/**
 * governance-disposition.test.ts — contract tests for the shared
 * mode->disposition mapper used by the release-promotion quality gate
 * (and any future TS gate that reuses `getGovernanceEnforce`).
 *
 * Red-Green-Refactor: written before governance-disposition.ts exists.
 *
 * CONTRACT TEST (exhaustiveness): enumerates exactly the three
 * `GovernanceEnforce` literals — 'permissive' | 'shadow' | 'strict' —
 * from `../governance-flag` (the SINGLE existing mode source; this file
 * imports the type, never redefines it) and asserts each literal's
 * disposition. If either the TypeScript literal union or the Python
 * `_VALID_ENFORCEMENT_MODES` tuple (arbiter/governance/hierarchy.py)
 * gains, loses, or renames a mode, this test's exhaustive switch must be
 * updated too — the `default` branch throws rather than silently
 * defaulting, so an unhandled fourth literal fails LOUDLY here instead
 * of falling through to an unintended disposition.
 */
import {
  governanceDisposition,
  type GovernanceDisposition,
} from "../governance-disposition";
import type { GovernanceEnforce } from "../../../utils/governance-flag";

describe("governanceDisposition — exhaustive 3-literal contract", () => {
  // Driven from a `Record<GovernanceEnforce, GovernanceDisposition>`
  // rather than a plain array/tuple literal: if `GovernanceEnforce`
  // gains a fourth literal, this Record literal is missing a required
  // key and the TEST FILE ITSELF fails to compile (ts-jest / tsc
  // --noEmit) — a rename is caught the same way, since the old key
  // becomes excess and the new key becomes missing. This is in addition
  // to, not instead of, the exhaustiveness check inside
  // governanceDisposition's own `default` branch.
  const EXPECTED: Record<GovernanceEnforce, GovernanceDisposition> = {
    permissive: { recordFinding: false, block: false },
    shadow: { recordFinding: true, block: false },
    strict: { recordFinding: true, block: true },
  };
  const ALL_MODES = Object.keys(EXPECTED) as GovernanceEnforce[];

  test("recognizes exactly three mode literals — no more, no fewer", () => {
    expect(ALL_MODES).toHaveLength(3);
    expect(ALL_MODES).toEqual(
      expect.arrayContaining(["permissive", "shadow", "strict"]),
    );
  });

  test.each<[GovernanceEnforce, GovernanceDisposition]>(
    ALL_MODES.map((mode) => [mode, EXPECTED[mode]]),
  )("mode=%s maps to disposition %o", (mode, expected) => {
    expect(governanceDisposition(mode)).toEqual(expected);
  });

  test("permissive never blocks and never records — telemetry-only proceed", () => {
    const d = governanceDisposition("permissive");
    expect(d.block).toBe(false);
    expect(d.recordFinding).toBe(false);
  });

  test("shadow records the finding but never blocks — would-block visibility only", () => {
    const d = governanceDisposition("shadow");
    expect(d.block).toBe(false);
    expect(d.recordFinding).toBe(true);
  });

  test("strict both records the finding and blocks", () => {
    const d = governanceDisposition("strict");
    expect(d.block).toBe(true);
    expect(d.recordFinding).toBe(true);
  });

  test("rejects an unrecognized mode literal rather than silently defaulting", () => {
    expect(() =>
      governanceDisposition("bogus-mode" as GovernanceEnforce),
    ).toThrow(/bogus-mode/);
  });
});
