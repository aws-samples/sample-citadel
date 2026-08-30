import * as fs from "fs";

/**
 * Loads KEY=VALUE pairs from a dotenv-style file into process.env,
 * WITHOUT overriding any variable already present in process.env.
 *
 * This intentionally mirrors deploy.sh's `load_env` bash function
 * line-for-line so the two loaders can never disagree:
 *   - Blank lines and lines whose first non-space char is `#` are skipped.
 *   - An inline `#` truncates the rest of the line (bash `${line%%#*}`).
 *   - The remaining line is trimmed of leading/trailing whitespace via a
 *     `xargs`-equivalent pass, which ALSO strips one layer of surrounding
 *     single or double quotes from the trimmed value (`xargs` re-tokenizes
 *     with shell word-splitting/quote-removal semantics).
 *   - Only lines matching `^[A-Za-z_][A-Za-z0-9_]*=.*$` are treated as
 *     KEY=VALUE pairs. This means, matching deploy.sh's real behavior:
 *       * an `export ` prefix is NOT special-cased and causes the whole
 *         line to be skipped (it doesn't start with a bare identifier);
 *       * a space before `=` (e.g. `KEY = value`) also fails to match
 *         and is skipped.
 *   - Existing process.env keys are never overwritten (load-if-absent).
 *
 * A missing file is a silent no-op — never throws, never logs. This is
 * required so CI (which has no backend/.env) is unaffected.
 */
export function loadDotenvIfPresent(envFile: string): void {
  let raw: string;
  try {
    raw = fs.readFileSync(envFile, "utf8");
  } catch {
    // Missing (or unreadable) file: silent no-op, matching deploy.sh's
    // `[ ! -f "$env_file" ]` early return.
    return;
  }

  const lines = raw.split(/\r?\n/);
  for (const rawLine of lines) {
    // Skip blank lines and comment lines (first non-space char `#`).
    if (/^\s*$/.test(rawLine) || /^\s*#/.test(rawLine)) {
      continue;
    }

    // Strip inline comments: bash `${line%%#*}` removes from the first `#`
    // to the end of the line.
    const hashIndex = rawLine.indexOf("#");
    const withoutComment =
      hashIndex === -1 ? rawLine : rawLine.slice(0, hashIndex);

    // `xargs`-equivalent trim: collapse leading/trailing whitespace, and
    // strip one layer of surrounding quotes from the trimmed result.
    const trimmed = xargsTrim(withoutComment);

    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed);
    if (!match) {
      continue;
    }
    const [, key, rawVal] = match;
    const val = stripSurroundingQuotes(rawVal);

    // Load-if-absent: never override a variable already set (explicit env,
    // deploy.sh export, or `CDK_DOCKER=docker npx cdk ...`).
    if (process.env[key] === undefined) {
      process.env[key] = val;
    }
  }
}

// Mirrors `echo "$line" | xargs` for the plain-word case: trims outer
// whitespace. `xargs` also collapses internal runs of whitespace between
// words, but that only matters for lines with no `=` sign at all (which
// are dropped by the KEY=VALUE match below regardless), so a simple
// leading/trailing trim reproduces the observable behavior here.
function xargsTrim(s: string): string {
  return s.trim();
}

// `xargs` removes one layer of surrounding quotes as part of its own
// word-splitting/quote-removal when the value is passed through the
// no-arg `echo ... | xargs` idiom. Reproduce that specifically for a
// value that is ENTIRELY wrapped in a single matching quote pair.
function stripSurroundingQuotes(s: string): string {
  if (
    s.length >= 2 &&
    ((s[0] === '"' && s[s.length - 1] === '"') ||
      (s[0] === "'" && s[s.length - 1] === "'"))
  ) {
    return s.slice(1, -1);
  }
  return s;
}
