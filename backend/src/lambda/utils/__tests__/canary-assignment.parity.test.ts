/**
 * Cross-language parity + property guard for the canary arm-assignment
 * rule.
 *
 * The rule exists twice — here (`assignArm`) and in
 * `arbiter/governance/canary_assignment.py` (`assign_arm`). This suite
 * consumes the SHARED case table in `canary-assignment-parity-cases.json`
 * (also loaded verbatim by
 * `arbiter/governance/__tests__/test_canary_assignment_parity.py`) so both
 * languages are checked against the exact same fixture, adds a drift
 * trip-wire on each implementation's marked logic region, a MUST-BITE
 * mutant check, and fast-check properties for distribution, determinism,
 * monotonicity, and reweight stickiness.
 *
 * Do NOT hand-copy cases from the fixture — add new cases there and both
 * suites pick them up automatically.
 */
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import fc from "fast-check";
import { assignArm, CANARY_BUCKET_SPACE } from "../canary-assignment";

interface ParityCase {
  branch: string;
  description: string;
  stickinessKey: string;
  percentBasisPoints: number;
  salt: string;
  expected: "stable" | "candidate";
}

interface RegionHashEntry {
  file: string;
  beginMarker: string;
  endMarker: string;
  commentPrefix: string;
  sha256: string;
}

interface ParityFixture {
  regionHashes: {
    ts: RegionHashEntry;
    python: RegionHashEntry;
  };
  cases: ParityCase[];
}

const FIXTURE_PATH = path.join(
  __dirname,
  "..",
  "canary-assignment-parity-cases.json",
);
const REPO_ROOT = path.join(__dirname, "..", "..", "..", "..", "..");

const fixture: ParityFixture = JSON.parse(
  fs.readFileSync(FIXTURE_PATH, "utf-8"),
);

/** Identical normalization to grandfathering's parity guard: strip
 * comment/blank lines, drop a trailing line-continuation backslash,
 * canonicalize quotes, collapse whitespace, join with a single space. */
function normalizeRegion(region: string, commentPrefix: string): string {
  return region
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      if (trimmed === "") return false;
      if (trimmed.startsWith(commentPrefix)) return false;
      return true;
    })
    .map((line) =>
      line
        .trimEnd()
        .replace(/\\$/, "")
        .replace(/['"]/g, "'")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .join(" ");
}

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
    throw new Error(`Could not locate PARITY-GUARD markers in ${absPath}`);
  }
  const region = content.slice(beginIdx + beginMarker.length, endIdx);
  return crypto
    .createHash("sha256")
    .update(normalizeRegion(region, commentPrefix), "utf-8")
    .digest("hex");
}

/** Local re-implementation with the ONE mutation the MUST-BITE test
 * targets: the strict `<` becomes `<=`. A boundary case where the bucket
 * equals the threshold must disagree between this and the real rule, or
 * the parity fixture is not actually pinning the comparison operator. */
function assignArmMutantLessEqual(
  stickinessKey: string,
  percentBasisPoints: number,
  salt: string,
): "stable" | "candidate" {
  const clamped = Math.max(
    0,
    Math.min(CANARY_BUCKET_SPACE, Math.floor(percentBasisPoints)),
  );
  if (clamped <= 0) return "stable";
  if (clamped >= CANARY_BUCKET_SPACE) return "candidate";
  if (typeof stickinessKey !== "string" || stickinessKey === "")
    return "stable";
  const digest = crypto
    .createHash("sha256")
    .update(salt + ":" + stickinessKey, "utf8")
    .digest("hex");
  const bucket = parseInt(digest.slice(0, 8), 16) % CANARY_BUCKET_SPACE;
  return bucket <= clamped ? "candidate" : "stable";
}

describe("canary-assignment parity: shared fixture cases (TS)", () => {
  it("declares a unique branch id per case", () => {
    expect(fixture.cases.length).toBeGreaterThan(0);
    const branches = new Set(fixture.cases.map((c) => c.branch));
    expect(branches.size).toBe(fixture.cases.length);
  });

  describe.each(fixture.cases.map((c) => [c.branch, c] as const))(
    "branch: %s",
    (_branch, testCase) => {
      it(`${testCase.description} -> ${testCase.expected}`, () => {
        expect(
          assignArm(
            testCase.stickinessKey,
            testCase.percentBasisPoints,
            testCase.salt,
          ),
        ).toBe(testCase.expected);
      });
    },
  );
});

describe("canary-assignment parity: drift trip-wire (TS)", () => {
  it("TS logic region hash matches the fixture-recorded sha256", () => {
    const entry = fixture.regionHashes.ts;
    const absPath = path.join(REPO_ROOT, entry.file);
    expect(
      hashRegion(
        absPath,
        entry.beginMarker,
        entry.endMarker,
        entry.commentPrefix,
      ),
    ).toBe(entry.sha256);
  });

  it("Python logic region hash matches the fixture-recorded sha256", () => {
    const entry = fixture.regionHashes.python;
    const absPath = path.join(REPO_ROOT, entry.file);
    expect(
      hashRegion(
        absPath,
        entry.beginMarker,
        entry.endMarker,
        entry.commentPrefix,
      ),
    ).toBe(entry.sha256);
  });
});

describe("canary-assignment parity: MUST-BITE mutant (< vs <=)", () => {
  it("the boundary case where bucket === threshold distinguishes the real rule from a <= mutant", () => {
    const boundary = fixture.cases.find(
      (c) => c.branch === "boundary_bucket_equals_threshold_stable",
    );
    expect(boundary).toBeDefined();
    const real = assignArm(
      boundary!.stickinessKey,
      boundary!.percentBasisPoints,
      boundary!.salt,
    );
    const mutant = assignArmMutantLessEqual(
      boundary!.stickinessKey,
      boundary!.percentBasisPoints,
      boundary!.salt,
    );
    // The real rule says stable (strict <); the <= mutant says candidate.
    expect(real).toBe("stable");
    expect(mutant).toBe("candidate");
    expect(real).not.toBe(mutant);
  });
});

describe("canary-assignment properties (TS)", () => {
  it("routes approximately percent of keys to candidate", () => {
    const salt = "prop-salt";
    const percentBp = 1000; // 10%
    const n = 20000;
    let candidate = 0;
    for (let i = 0; i < n; i += 1) {
      if (assignArm(`key-${i}`, percentBp, salt) === "candidate")
        candidate += 1;
    }
    const fraction = candidate / n;
    // 10% target; generous tolerance to stay deterministic and non-flaky.
    expect(fraction).toBeGreaterThan(0.085);
    expect(fraction).toBeLessThan(0.115);
  });

  it("is deterministic — same (key,percent,salt) always yields the same arm", () => {
    fc.assert(
      fc.property(
        fc.string(),
        fc.integer({ min: 0, max: CANARY_BUCKET_SPACE }),
        fc.string({ minLength: 1 }),
        (key, pct, salt) => {
          expect(assignArm(key, pct, salt)).toBe(assignArm(key, pct, salt));
        },
      ),
    );
  });

  it("is monotone in percent for a fixed salt — raising percent never moves candidate->stable", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }),
        fc.integer({ min: 0, max: CANARY_BUCKET_SPACE }),
        fc.integer({ min: 0, max: CANARY_BUCKET_SPACE }),
        fc.string({ minLength: 1 }),
        (key, a, b, salt) => {
          const lo = Math.min(a, b);
          const hi = Math.max(a, b);
          if (assignArm(key, lo, salt) === "candidate") {
            expect(assignArm(key, hi, salt)).toBe("candidate");
          }
        },
      ),
    );
  });

  it("reweight with a preserved salt only re-buckets keys the threshold crosses (delta-band, one-way)", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }),
        fc.integer({ min: 0, max: CANARY_BUCKET_SPACE }),
        fc.integer({ min: 0, max: CANARY_BUCKET_SPACE }),
        fc.string({ minLength: 1 }),
        (key, a, b, salt) => {
          const lo = Math.min(a, b);
          const hi = Math.max(a, b);
          const armLo = assignArm(key, lo, salt);
          const armHi = assignArm(key, hi, salt);
          // A key can only move stable->candidate when percent RISES with
          // the salt held fixed; it can never move candidate->stable.
          if (armLo !== armHi) {
            expect(armLo).toBe("stable");
            expect(armHi).toBe("candidate");
          }
        },
      ),
    );
  });

  it("never throws on hostile percents and always returns a valid arm", () => {
    fc.assert(
      fc.property(
        fc.string(),
        fc.double({ noNaN: false }),
        fc.string(),
        (key, pct, salt) => {
          const arm = assignArm(key, pct, salt);
          expect(arm === "stable" || arm === "candidate").toBe(true);
        },
      ),
    );
  });
});
