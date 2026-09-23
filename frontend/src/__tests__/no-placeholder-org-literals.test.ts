/**
 * Tripwire: placeholder org literals must never flow into a GraphQL/API
 * argument again (finding 51772063, finding d8fb2286). The server (Wave 3A)
 * rejects any client-supplied orgId that does not match the caller's own
 * organization, so a placeholder can never succeed — it only produces a
 * confusing "access denied" or a silent wrong-org write. Fixed call sites
 * must source the org from the caller's own useOrganization() context
 * (currentUser.organization) instead.
 *
 * Scans every frontend/src/**\/*.ts(x) file (excluding __tests__ directories)
 * for the literals 'default-org' and 'All Organizations' used as an argument
 * value — i.e. `identifier: 'literal'` / `identifier: "literal"` or
 * `fn('literal')` / `fn("literal")` — and fails with file:line on any hit.
 *
 * UI copy/labels (e.g. a dropdown option's display text) are not the target
 * of this guard; only literals shaped like an argument value are flagged.
 */
import * as fs from 'fs';
import * as path from 'path';

const srcDir = path.resolve(__dirname, '..');
const ROOT = path.resolve(__dirname, '..', '..');

const PLACEHOLDER_LITERALS = ['default-org', 'All Organizations'];

function findSourceFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findSourceFiles(full));
    } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
      results.push(full);
    }
  }
  return results;
}

/**
 * Build one regex per placeholder literal that matches it only when used as
 * an argument value: either as an object-property value (`key: 'literal'`)
 * or as a bare call argument (`('literal'` / `, 'literal'`). This
 * deliberately excludes plain string-literal usage elsewhere (comments,
 * prose, JSX text) which is not a client argument.
 */
function argumentValuePatterns(literal: string): RegExp[] {
  const escaped = literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [
    // key: 'literal' / key: "literal"
    new RegExp(`:\\s*['"]${escaped}['"]`),
    // ('literal' / , 'literal'  (call argument position)
    new RegExp(`[(,]\\s*['"]${escaped}['"]`),
  ];
}

describe('no placeholder org literals flow into API arguments', () => {
  const files = findSourceFiles(srcDir);

  for (const literal of PLACEHOLDER_LITERALS) {
    test(`'${literal}' is never used as an argument value outside tests`, () => {
      const patterns = argumentValuePatterns(literal);
      const violations: string[] = [];

      for (const file of files) {
        const relPath = path.relative(ROOT, file);
        const lines = fs.readFileSync(file, 'utf-8').split('\n');

        lines.forEach((line, idx) => {
          // The ORGLESS_CALLER_ORG sentinel definition (if present in this
          // codebase) is an intentional, documented exemption per finding
          // d8fb2286 — never a placeholder submitted to the server. Likewise
          // a line explicitly marked tripwire-exempt is a documented,
          // reviewed non-argument use (e.g. an admin filter-scope literal
          // that never reaches a GraphQL call).
          if (line.includes('ORGLESS_CALLER_ORG') || line.includes('tripwire-exempt')) return;

          if (patterns.some((pat) => pat.test(line))) {
            violations.push(`${relPath}:${idx + 1}: ${line.trim()}`);
          }
        });
      }

      expect(violations).toEqual([]);
    });
  }
});
