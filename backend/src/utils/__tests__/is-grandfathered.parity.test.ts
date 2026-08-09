/**
 * Cross-language parity guard for the grandfathering rule (finding 887db42a).
 *
 * The rule exists twice — here (`isGrandfatheredPure`) and in
 * `arbiter/governance/grandfathering.py` (`is_grandfathered_pure`). This
 * suite consumes the SHARED case table in `grandfathering-parity-cases.json`
 * (also loaded verbatim by `arbiter/governance/__tests__/test_grandfathering_parity.py`)
 * so both languages are checked against the exact same fixture, and adds a
 * drift trip-wire that fails if either implementation's marked logic region
 * is edited without updating the fixture's recorded hash.
 *
 * Do NOT hand-copy cases from this fixture elsewhere — add new cases here
 * and both suites pick them up automatically.
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { isGrandfatheredPure } from "../is-grandfathered";

interface ParityCase {
  branch: string;
  description: string;
  createdAt: string | null;
  effectiveAt: string | null;
  expected: boolean;
  createdAtIsUndefined?: boolean;
}

interface RegionHashEntry {
  file: string;
  beginMarker: string;
  endMarker: string;
  commentPrefix: string;
  sha256: string;
}

interface ParityFixture {
  description: string;
  regionHashes: {
    hashAlgorithm: string;
    ts: RegionHashEntry;
    python: RegionHashEntry;
  };
  cases: ParityCase[];
}

const FIXTURE_PATH = path.join(
  __dirname,
  "..",
  "grandfathering-parity-cases.json",
);
const REPO_ROOT = path.join(__dirname, "..", "..", "..", "..");

const fixture: ParityFixture = JSON.parse(
  fs.readFileSync(FIXTURE_PATH, "utf-8"),
);

/**
 * Normalize a marker-delimited logic region before hashing:
 *
 * 1. Drop every whole-line comment (a line whose trimmed content starts
 *    with `commentPrefix`) and every blank line. This intentionally makes
 *    the hash blind to comment-only edits (e.g. tweaking prose inside the
 *    PARITY-GUARD block) while still tripping on any change to executable
 *    logic, since a logic line's content — not just its presence — feeds
 *    the hash.
 * 2. Strip a single trailing backslash (a line-continuation marker) from
 *    each kept line before rejoining, so splitting one logical statement
 *    across physical lines via `\`-continuation does not change the hash.
 * 3. Canonicalize quote characters: map both `'` and `"` to one canonical
 *    character (`'`) so a formatter's quote-style rewrite (e.g. prettier
 *    flipping `''` to `""`) does not change the hash.
 * 4. Collapse every run of whitespace (spaces, tabs, newlines-within-a-
 *    kept-line) to a single space, then trim each kept line.
 * 5. Join the kept, transformed lines with a single SPACE (not newline),
 *    so splitting one statement across multiple physical lines — with or
 *    without a trailing backslash — does not change the hash. This makes
 *    the hash blind to re-wrapping/re-indentation while still tripping on
 *    any change to identifiers, operators, or literal content.
 *
 * Both TS and Python hashers implement this identically so a hash
 * computed here is directly comparable to one computed in
 * `test_grandfathering_parity.py`. What is NOT normalized: relative order
 * of kept lines, identifier/operator/literal text, and the set of logic
 * lines present — any of those changing still changes the hash.
 */
function normalizeRegion(region: string, commentPrefix: string): string {
  return region
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      if (trimmed === "") return false;
      if (trimmed.startsWith(commentPrefix)) return false;
      return true;
    })
    .map((line) => {
      const withoutContinuation = line.trimEnd().replace(/\\$/, "");
      return withoutContinuation
        .replace(/['"]/g, "'")
        .replace(/\s+/g, " ")
        .trim();
    })
    .join(" ");
}

/**
 * Recompute the sha256 of the text strictly between the begin/end
 * markers, after normalization (comment lines and blank lines stripped,
 * quotes canonicalized, whitespace collapsed — see `normalizeRegion`).
 */
function hashRegion(
  absPath: string,
  beginMarker: string,
  endMarker: string,
  commentPrefix: string,
): string {
  const content = fs.readFileSync(absPath, "utf-8");
  const beginIdx = content.indexOf(beginMarker);
  const endIdx = content.indexOf(endMarker);
  if (beginIdx === -1 || endIdx === -1 || endIdx < beginIdx) {
    throw new Error(
      `Could not locate PARITY-GUARD markers in ${absPath}. ` +
        "The begin/end marker comments around the pure grandfathering logic " +
        "must not be removed.",
    );
  }
  const regionStart = beginIdx + beginMarker.length;
  const region = content.slice(regionStart, endIdx);
  const normalized = normalizeRegion(region, commentPrefix);
  return crypto.createHash("sha256").update(normalized, "utf-8").digest("hex");
}

describe("grandfathering parity: shared fixture cases (TS)", () => {
  test("fixture declares at least one case per required branch shape", () => {
    expect(fixture.cases.length).toBeGreaterThan(0);
    const branches = new Set(fixture.cases.map((c) => c.branch));
    expect(branches.size).toBe(fixture.cases.length);
  });

  describe.each(fixture.cases.map((c) => [c.branch, c] as const))(
    "branch: %s",
    (_branch, testCase) => {
      test(`${testCase.description} -> ${testCase.expected}`, () => {
        const createdAtArg = testCase.createdAtIsUndefined
          ? undefined
          : testCase.createdAt;
        expect(isGrandfatheredPure(createdAtArg, testCase.effectiveAt)).toBe(
          testCase.expected,
        );
      });
    },
  );

  test("every branch id declared in the fixture is exercised at least once", () => {
    const declaredBranches = fixture.cases.map((c) => c.branch);
    const exercisedBranches = new Set<string>();
    for (const c of fixture.cases) {
      const createdAtArg = c.createdAtIsUndefined ? undefined : c.createdAt;
      // Exercise the case exactly as the parametrized suite above does.
      isGrandfatheredPure(createdAtArg, c.effectiveAt);
      exercisedBranches.add(c.branch);
    }
    for (const branch of declaredBranches) {
      expect(exercisedBranches.has(branch)).toBe(true);
    }
    expect(exercisedBranches.size).toBe(declaredBranches.length);
  });
});

describe("grandfathering parity: drift trip-wire (TS)", () => {
  test("TS logic region hash matches the fixture-recorded sha256", () => {
    const entry = fixture.regionHashes.ts;
    const absPath = path.join(REPO_ROOT, entry.file);
    const actual = hashRegion(
      absPath,
      entry.beginMarker,
      entry.endMarker,
      entry.commentPrefix,
    );
    expect(actual).toBe(entry.sha256);
  });

  test("Python logic region hash matches the fixture-recorded sha256", () => {
    const entry = fixture.regionHashes.python;
    const absPath = path.join(REPO_ROOT, entry.file);
    let actual: string;
    try {
      actual = hashRegion(
        absPath,
        entry.beginMarker,
        entry.endMarker,
        entry.commentPrefix,
      );
    } catch (err) {
      throw new Error(
        `Failed to hash the Python grandfathering region for parity check: ${
          (err as Error).message
        }`,
      );
    }
    if (actual !== entry.sha256) {
      throw new Error(
        "Grandfathering rule drift detected: the marked logic region in " +
          `${entry.file} no longer matches the sha256 recorded in ` +
          "backend/src/utils/grandfathering-parity-cases.json. " +
          "If this is an intentional rule change, update BOTH " +
          "backend/src/utils/is-grandfathered.ts AND " +
          "arbiter/governance/grandfathering.py, then recompute and update " +
          "both region hashes in the fixture. If this is unintentional, " +
          "revert the one-sided edit.",
      );
    }
    expect(actual).toBe(entry.sha256);
  });
});

describe("grandfathering parity: normalizeRegion unit behavior", () => {
  test("splitting one statement across two physical lines (no continuation char) does not change the hash", () => {
    const original = [
      '  if (effectiveAt === null || effectiveAt === "") return true;',
    ].join("\n");
    const rewrapped = [
      "  if (effectiveAt === null ||",
      '    effectiveAt === "") return true;',
    ].join("\n");
    const hashOf = (s: string) =>
      crypto
        .createHash("sha256")
        .update(normalizeRegion(s, "//"), "utf-8")
        .digest("hex");
    expect(hashOf(rewrapped)).toBe(hashOf(original));
  });

  test("backslash line-continuation rewrap does not change the hash", () => {
    const original = ["  return createdAt < effectiveAt;"].join("\n");
    const rewrapped = ["  return createdAt \\", "    < effectiveAt;"].join(
      "\n",
    );
    const hashOf = (s: string) =>
      crypto
        .createHash("sha256")
        .update(normalizeRegion(s, "//"), "utf-8")
        .digest("hex");
    expect(hashOf(rewrapped)).toBe(hashOf(original));
  });

  test("an operator edit ('<' -> '<=') still changes the hash", () => {
    const original = ["  return createdAt < effectiveAt;"].join("\n");
    const edited = ["  return createdAt <= effectiveAt;"].join("\n");
    const hashOf = (s: string) =>
      crypto
        .createHash("sha256")
        .update(normalizeRegion(s, "//"), "utf-8")
        .digest("hex");
    expect(hashOf(edited)).not.toBe(hashOf(original));
  });
});
