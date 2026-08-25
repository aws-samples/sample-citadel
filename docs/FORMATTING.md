# Formatting & Lint Gate

> `.prettierrc.json` is plain JSON (no comment syntax), so the measurement
> note that would otherwise sit inline as a comment lives here instead.

## Prettier config (`.prettierrc.json`)

The repo had no explicit prettier config; formatting relied entirely on
prettier's built-in defaults, which happened to match this codebase's
convention closely but were never pinned — a future prettier upgrade could
silently change defaults and start reformatting the whole tree.

`.prettierrc.json` at the repo root now pins the convention that was
**measured from the tree on 2026-08-25**:

- Indentation is 2-space in 1054/1064 files (4-space in exactly 1, tabs 0).
- The newest 30 files are 30/30 two-space and 30/30 double-quoted.
- Semicolons appear on 96.1% of statement lines; trailing commas are
  pervasive; arrow params are parenthesised in the large majority of cases
  (2766 parenthesised vs 454 bare).
- Line width: p50 = 29 cols, p90 = 73 cols, only 4.4% of lines exceed 80.

Resulting values: `tabWidth: 2`, `semi: true`, `singleQuote: false`,
`printWidth: 80`, `trailingComma: "all"`, `arrowParens: "always"`. These are
prettier's defaults in every field except `singleQuote`/`arrowParens`
notation — the point of this file is not to change behavior today, but to
make the behavior explicit so it can never drift out from under the project
on a prettier version bump.

## Why `lint-staged` still uses `prettier --write`, not `--check`

Running prettier with the config above in `--check` mode over the current
tree fails on **347 of 627** backend files (single-quote would fail 601;
`tabWidth: 4` would fail 624 — `--check` with the measured config is by far
the least-bad of those options, but still not clean). Switching the
`lint-staged` prettier step from `--write` to `--check` today would block
ordinary commits on pre-existing, unrelated formatting drift.

`--write` is kept for now: it silently reformats only the lines a commit
touches, so day-to-day commits are unaffected by the backlog of
nonconforming files.

**Prerequisite to ever switching to `--check`:** a single, mechanical,
format-only commit that runs `prettier --write` across the whole tree with
this config, with its SHA recorded in `.git-blame-ignore-revs` (so
`git blame` keeps attributing lines to their real authors instead of the
formatting commit). That commit has not been made — this document exists so
the decision is written down instead of being rediscovered by the next
person to touch this config.

## Lint gate parity with CI

`lint-staged` runs `eslint --fix --max-warnings 0` (previously `eslint
--fix` with no warning cap) so that a warning ESLint cannot auto-fix fails
the commit locally, matching the `npm run lint` bar CI's Backend Static job
already enforces. Previously such a warning would pass the local commit
hook silently and only be caught later in CI.
