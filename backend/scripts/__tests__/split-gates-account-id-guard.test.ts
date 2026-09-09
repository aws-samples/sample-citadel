/**
 * Permanent guard (finding 9f09e845): no committed split-gates baseline or
 * template may carry a real 12-digit AWS account id.
 *
 * This repo is cloned by customers (aws-samples), and split-baseline JSON
 * files are captured with real credentials (see the "Environment-derived
 * tokens" comment in `template-utils.ts`) — historically this leaked the
 * owner's real account id (~103 occurrences across the dev/test baselines
 * before sanitization). A future baseline refresh (`split-baseline.ts`) run
 * against a real account could silently reintroduce the disclosure if
 * nothing catches it. This test scans every committed file under
 * `split-baseline/` and asserts the ONLY 12-digit run of digits present is
 * the fixed placeholder `000000000000` (the same value CI's credential-less
 * synth uses, so it is also a legitimate token that must not itself be
 * flagged).
 */
import * as fs from "fs";
import * as path from "path";

const SPLIT_BASELINE_DIR = path.resolve(
  __dirname,
  "..",
  "..",
  "split-baseline",
);
const PLACEHOLDER = "000000000000";
// A standalone 12-digit run: not immediately preceded/followed by another
// digit OR a lowercase hex letter (a-f). Without the hex-letter exclusion,
// this regex spuriously matches a coincidental 12-digit substring embedded
// inside a much longer SHA-256 hex digest (e.g. a resolver
// `templateHash` field) and misidentifies it as an account id — observed
// in practice: `...e4991121923239...` (hash) contains `499112192323` as a
// substring, which is not an account id. Real AWS account ids in this
// baseline appear only inside ARN account fields
// (`arn:aws:SERVICE:REGION:ACCOUNT:...`) or bucket-name-style tokens, both
// of which are always digit-delimited by `:`/`-`/quotes, never by a hex
// letter.
const TWELVE_DIGIT_RUN = /(?<![a-f0-9])\d{12}(?![a-f0-9])/g;

function listBaselineFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => path.join(dir, name));
}

describe("split-gates baseline account-id guard (finding 9f09e845)", () => {
  const files = listBaselineFiles(SPLIT_BASELINE_DIR);

  it("finds at least one committed baseline file to check (sanity — guard is not vacuous)", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files.length > 0 ? files : ["__no_baselines_found__"])(
    "%s contains no 12-digit run other than the %s placeholder",
    (filePath) => {
      if (filePath === "__no_baselines_found__") {
        // Handled by the sanity test above; skip body to avoid a bogus fs read.
        return;
      }
      const content = fs.readFileSync(filePath, "utf-8");
      const matches = content.match(TWELVE_DIGIT_RUN) ?? [];
      const nonPlaceholder = matches.filter((m) => m !== PLACEHOLDER);
      expect(nonPlaceholder).toEqual([]);
    },
  );

  it("the placeholder itself is present in at least one baseline (guard checks something real)", () => {
    const anyHasPlaceholder = files.some((f) =>
      fs.readFileSync(f, "utf-8").includes(PLACEHOLDER),
    );
    expect(anyHasPlaceholder).toBe(true);
  });
});
