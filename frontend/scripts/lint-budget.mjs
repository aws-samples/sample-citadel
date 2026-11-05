#!/usr/bin/env node
/**
 * ESLint budget ratchet: fails on any error or if warnings exceed the budget
 * stored in ../.eslint-budget.json. Prints "budget can lower to N" when the
 * actual warning count is strictly below the budget.
 *
 * Ratchet-raise guard: when a base-branch budget is available (CI or local
 * with origin/main), the script fails if the PR budget is HIGHER than the
 * base — the budget may only stay the same or decrease.
 *
 * Usage:
 *   node scripts/lint-budget.mjs            # lint + budget check
 *   node scripts/lint-budget.mjs --fix      # autofix + budget check
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

// Read budget
const budgetPath = resolve(root, ".eslint-budget.json");
const budget = JSON.parse(readFileSync(budgetPath, "utf8"));

// --- Ratchet-raise guard: compare against base branch budget ---
function getBaseBudget() {
  // In GitHub Actions, GITHUB_BASE_REF is the base branch (e.g. "main")
  const baseRef = process.env.GITHUB_BASE_REF;
  let gitRef = null;

  if (baseRef) {
    // CI: use the base ref directly (GitHub fetches it as origin/<base>)
    gitRef = `origin/${baseRef}`;
  } else {
    // Local: try to find merge-base with origin/main
    try {
      gitRef = execSync("git merge-base HEAD origin/main", {
        cwd: root,
        encoding: "utf8",
        timeout: 5000,
      }).trim();
    } catch {
      // origin/main not available (shallow clone, no remote, etc.)
      gitRef = null;
    }
  }

  if (!gitRef) {
    console.log("ℹ No base ref available — skipping ratchet-raise check.");
    return null;
  }

  try {
    const raw = execSync(`git show ${gitRef}:frontend/.eslint-budget.json`, {
      cwd: resolve(root, ".."),
      encoding: "utf8",
      timeout: 5000,
    }).trim();
    return JSON.parse(raw).warnings;
  } catch {
    // File might not exist on the base branch (new project)
    console.log("ℹ Base branch has no .eslint-budget.json — skipping ratchet-raise check.");
    return null;
  }
}

const baseBudget = getBaseBudget();
if (baseBudget !== null && budget.warnings > baseBudget) {
  console.error(
    `\n✗ Budget was RAISED from ${baseBudget} → ${budget.warnings}. ` +
    `The ratchet only allows lowering the budget. Fix warnings instead.`
  );
  process.exit(1);
}

// Build eslint command
const fix = process.argv.includes("--fix") ? " --fix" : "";
const cmd = `npx eslint "src/**/*.{ts,tsx}" --format json${fix}`;

let output;
try {
  output = execSync(cmd, { cwd: root, encoding: "utf8", maxBuffer: 50 * 1024 * 1024 });
} catch (err) {
  // eslint exits 1 when it finds issues — output is in stdout
  output = err.stdout || "";
  if (!output) {
    console.error("ESLint failed unexpectedly:", err.stderr || err.message);
    process.exit(2);
  }
}

let results;
try {
  results = JSON.parse(output);
} catch {
  console.error("Failed to parse ESLint JSON output");
  console.error(output.slice(0, 500));
  process.exit(2);
}

let errors = 0;
let warnings = 0;
for (const file of results) {
  for (const msg of file.messages) {
    if (msg.severity === 2) errors++;
    else warnings++;
  }
}

console.log(`ESLint: ${errors} error(s), ${warnings} warning(s) (budget: ${budget.warnings})`);

if (errors > 0) {
  // Re-run without --format json so the developer sees human-readable output
  try {
    execSync(`npx eslint "src/**/*.{ts,tsx}"${fix}`, {
      cwd: root,
      stdio: "inherit",
    });
  } catch {
    // ignore — just for display
  }
  console.error(`\n✗ ${errors} error(s) found — fix all errors before committing.`);
  process.exit(1);
}

if (warnings > budget.warnings) {
  console.error(
    `\n✗ Warning count ${warnings} exceeds budget ${budget.warnings}. ` +
    `Fix warnings or (if justified) raise the budget in .eslint-budget.json.`
  );
  process.exit(1);
}

if (warnings < budget.warnings) {
  console.log(`\n✓ Budget can lower to ${warnings} (currently ${budget.warnings}).`);
}

console.log("✓ Lint passed.");
