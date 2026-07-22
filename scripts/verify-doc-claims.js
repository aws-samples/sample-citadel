#!/usr/bin/env node
/**
 * verify-doc-claims.js
 *
 * Cross-checks two factual claims in README.md against the actual source of
 * truth in the codebase, so the two can never silently drift apart again:
 *
 *   1. The list of deployed CDK stacks (README's "Deployed as focused CDK
 *      stacks: ..." sentence) vs. the stack files under backend/lib/*-stack.ts
 *      that are actually instantiated in backend/bin/app.ts.
 *   2. The data store adapter count (README's "N Data Store Adapters" /
 *      "N data store adapters" claims) vs. the number of entries registered
 *      in ADAPTER_MAP in backend/src/lambda/adapters/registry.ts.
 *
 * Exit codes:
 *   0 - README claims match the codebase.
 *   1 - a mismatch was found; a diff-style message is printed to stderr.
 *
 * Zero new dependencies: uses only Node's built-in `fs`/`path`.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const README_PATH = path.join(REPO_ROOT, 'README.md');
const APP_TS_PATH = path.join(REPO_ROOT, 'backend', 'bin', 'app.ts');
const LIB_DIR = path.join(REPO_ROOT, 'backend', 'lib');
const REGISTRY_TS_PATH = path.join(
  REPO_ROOT,
  'backend',
  'src',
  'lambda',
  'adapters',
  'registry.ts',
);

function readFileOrDie(filePath, label) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    console.error(`ERROR: could not read ${label} at ${filePath}: ${err.message}`);
    process.exit(1);
  }
  return '';
}

/**
 * Extracts the set of stack short-names (e.g. "backend", "services") that
 * are actually instantiated in backend/bin/app.ts, by matching
 * `new XyzStack(app, ...)` calls against the *Stack.ts files present in
 * backend/lib/. Using the app.ts instantiations (not just the file list)
 * ensures we only count stacks that are actually wired into the app, not
 * dead/unused stack classes sitting in lib/.
 */
function getDeployedStackNames() {
  const appTsSource = readFileOrDie(APP_TS_PATH, 'backend/bin/app.ts');

  let libFiles;
  try {
    libFiles = fs.readdirSync(LIB_DIR);
  } catch (err) {
    console.error(`ERROR: could not read ${LIB_DIR}: ${err.message}`);
    process.exit(1);
  }

  const stackFileNames = libFiles.filter((f) => /-stack\.ts$/.test(f));
  const deployed = [];

  for (const fileName of stackFileNames) {
    const shortName = fileName.replace(/-stack\.ts$/, '');
    // PascalCase class name convention: services-stack.ts -> ServicesStack
    const className = `${shortName
      .split('-')
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join('')}Stack`;
    const instantiationPattern = new RegExp(`new\\s+${className}\\s*\\(`);
    if (instantiationPattern.test(appTsSource)) {
      deployed.push(shortName);
    }
  }

  return deployed.sort();
}

/**
 * Counts the number of adapter entries registered in ADAPTER_MAP by parsing
 * the object literal passed to Object.assign(ADAPTER_MAP, { ... }) and
 * counting top-level `KEY: new SomeAdapter(...)` entries (ignoring comment
 * lines).
 */
function getAdapterCount() {
  const registrySource = readFileOrDie(REGISTRY_TS_PATH, 'backend/src/lambda/adapters/registry.ts');

  const assignMatch = registrySource.match(
    /Object\.assign\(\s*ADAPTER_MAP\s*,\s*\{([\s\S]*?)\}\s*\)\s*;/,
  );
  if (!assignMatch) {
    console.error(
      'ERROR: could not locate `Object.assign(ADAPTER_MAP, { ... })` in registry.ts — ' +
        'parsing logic may be out of date.',
    );
    process.exit(1);
  }

  const body = assignMatch[1];
  const entryPattern = /^\s*[A-Z0-9_]+\s*:\s*new\s+[A-Za-z0-9_]+\(/gm;
  const entries = body.match(entryPattern) || [];
  return entries.length;
}

/**
 * Parses README.md for:
 *   - the "Deployed as focused CDK stacks: `a`, `b`, ..." sentence
 *   - every "<N> Data Store Adapters" / "<N> data store adapters" claim
 */
function parseReadmeClaims(readmeSource) {
  const stackLineMatch = readmeSource.match(
    /Deployed as focused CDK stacks:\s*([^\n]+?)\.\s*\n/,
  );
  let claimedStacks = null;
  if (stackLineMatch) {
    claimedStacks = Array.from(stackLineMatch[1].matchAll(/`([a-z0-9-]+)`/g)).map(
      (m) => m[1],
    );
  }

  const adapterCountMatches = Array.from(
    readmeSource.matchAll(/(\d+)\s+[Dd]ata [Ss]tore [Aa]dapters?/g),
  ).map((m) => parseInt(m[1], 10));

  return { claimedStacks, adapterCountMatches };
}

function main() {
  const readmeSource = readFileOrDie(README_PATH, 'README.md');
  const { claimedStacks, adapterCountMatches } = parseReadmeClaims(readmeSource);

  const actualStacks = getDeployedStackNames();
  const actualAdapterCount = getAdapterCount();

  const failures = [];

  if (!claimedStacks) {
    failures.push(
      'Could not find a "Deployed as focused CDK stacks: ..." sentence in README.md ' +
        'to verify against backend/bin/app.ts.',
    );
  } else {
    const claimedSorted = [...claimedStacks].sort();
    const actualSorted = [...actualStacks].sort();
    const same =
      claimedSorted.length === actualSorted.length &&
      claimedSorted.every((v, i) => v === actualSorted[i]);
    if (!same) {
      failures.push(
        [
          'Stack list mismatch:',
          `  README claims:        ${JSON.stringify(claimedSorted)}`,
          `  app.ts actually wires: ${JSON.stringify(actualSorted)}`,
          `  - Missing from README: ${JSON.stringify(
            actualSorted.filter((s) => !claimedSorted.includes(s)),
          )}`,
          `  - Extra in README:     ${JSON.stringify(
            claimedSorted.filter((s) => !actualSorted.includes(s)),
          )}`,
        ].join('\n'),
      );
    }
  }

  if (adapterCountMatches.length === 0) {
    failures.push(
      'Could not find any "<N> Data Store Adapters" claim in README.md to verify ' +
        'against backend/src/lambda/adapters/registry.ts.',
    );
  } else {
    const wrongClaims = adapterCountMatches.filter((n) => n !== actualAdapterCount);
    if (wrongClaims.length > 0) {
      failures.push(
        [
          'Data store adapter count mismatch:',
          `  README claims: ${JSON.stringify(adapterCountMatches)}`,
          `  ADAPTER_MAP actually has: ${actualAdapterCount} entries`,
        ].join('\n'),
      );
    }
  }

  if (failures.length > 0) {
    console.error('verify-doc-claims: README.md is out of sync with the codebase.\n');
    console.error(failures.join('\n\n'));
    process.exit(1);
  }

  console.log(
    `verify-doc-claims: OK — ${actualStacks.length} stacks (${actualStacks.join(
      ', ',
    )}) and ${actualAdapterCount} data store adapters match README.md.`,
  );
  process.exit(0);
}

main();
