// Feature: ui-ux-remediation, Property 2: Zero hardcoded hex color classes in components
import * as fc from 'fast-check';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Property 2: Zero hardcoded hex color classes in components
 *
 * For all TSX source files in `frontend/src/components/` and `frontend/src/pages/`,
 * the file content SHALL contain zero instances of hardcoded hex color patterns in
 * Tailwind className attributes — specifically `bg-[#`, `text-[#`, and `border-[#`
 * patterns (excluding comments and test files).
 *
 * Validates: Requirements 2.1, 2.2, 2.3
 */

// --- Helpers ---

/** Hardcoded hex color patterns that should not appear in component files */
const HARDCODED_HEX_PATTERNS = [
  /bg-\[#/,
  /text-\[#/,
  /border-\[#/,
  /hover:bg-\[#/,
  /hover:text-\[#/,
  /hover:border-\[#/,
  /from-\[#/,
  /to-\[#/,
  /via-\[#/,
  /ring-\[#/,
  /ring-offset-\[#/,
  /divide-\[#/,
];

/**
 * Recursively find all .tsx files in a directory, excluding __tests__ directories.
 */
function findTsxFiles(dir: string): string[] {
  const results: string[] = [];

  if (!fs.existsSync(dir)) return results;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      results.push(...findTsxFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.tsx') && !entry.name.includes('.test.')) {
      results.push(fullPath);
    }
  }

  return results;
}

/**
 * Strip single-line comments and multi-line comments from file content
 * so we don't flag hex patterns inside comments.
 */
function stripComments(content: string): string {
  // Remove multi-line comments
  let stripped = content.replace(/\/\*[\s\S]*?\*\//g, '');
  // Remove single-line comments
  stripped = stripped.replace(/\/\/.*$/gm, '');
  return stripped;
}

/**
 * Check a file's content for hardcoded hex color patterns.
 * Returns an array of found violations.
 */
function findHexViolations(filePath: string): Array<{ pattern: string; line: string; lineNumber: number }> {
  const content = fs.readFileSync(filePath, 'utf-8');
  const strippedContent = stripComments(content);
  const lines = strippedContent.split('\n');
  const violations: Array<{ pattern: string; line: string; lineNumber: number }> = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const pattern of HARDCODED_HEX_PATTERNS) {
      if (pattern.test(line)) {
        violations.push({
          pattern: pattern.source,
          line: line.trim(),
          lineNumber: i + 1,
        });
      }
    }
  }

  return violations;
}

// --- Discover files ---

const frontendRoot = path.resolve(__dirname, '..', '..');
const componentsDir = path.join(frontendRoot, 'components');
const pagesDir = path.join(frontendRoot, 'pages');

const allTsxFiles = [
  ...findTsxFiles(componentsDir),
  ...findTsxFiles(pagesDir),
];

// --- Tests ---

describe('Property 2: Zero hardcoded hex color classes in components', () => {
  // Sanity check: we actually found files to test
  it('should find TSX files in components/ and pages/ directories', () => {
    expect(allTsxFiles.length).toBeGreaterThan(0);
  });

  it('all TSX component files contain zero hardcoded hex color patterns', () => {
    // Use fast-check to randomly sample from the file list
    fc.assert(
      fc.property(
        fc.constantFrom(...allTsxFiles),
        (filePath: string) => {
          const violations = findHexViolations(filePath);
          if (violations.length > 0) {
            const relativePath = path.relative(frontendRoot, filePath);
            const details = violations
              .map((v) => `  L${v.lineNumber}: ${v.pattern} in "${v.line}"`)
              .join('\n');
            throw new Error(
              `File "${relativePath}" has ${violations.length} hardcoded hex color(s):\n${details}`,
            );
          }
          return true;
        },
      ),
      { numRuns: Math.max(100, allTsxFiles.length * 3) },
    );
  });
});
