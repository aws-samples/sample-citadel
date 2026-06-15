// Feature: ui-ux-remediation, Property 4: Zero prohibited inline style patterns
import * as fc from 'fast-check';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Property 4: Zero prohibited inline style patterns
 *
 * For all TSX source files in `frontend/src/`, the file content SHALL contain
 * zero instances of `style={{margin:`, `style={{padding:`, `style={{width:`
 * (for percentage values), `style={{display:"flex"}}`, `style={{fontSize:`,
 * and `style={{backgroundColor:` patterns (excluding documented exceptions
 * with explanatory comments).
 *
 * Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 5.5, 6.5
 */

// --- Prohibited inline style patterns ---

interface ProhibitedPattern {
  /** Human-readable label */
  label: string;
  /** Regex to detect the violation */
  regex: RegExp;
}

const PROHIBITED_PATTERNS: ProhibitedPattern[] = [
  { label: 'style={{margin:', regex: /style=\{\{\s*margin\s*:/ },
  { label: 'style={{padding:', regex: /style=\{\{\s*padding\s*:/ },
  { label: 'style={{width: (percentage)', regex: /style=\{\{\s*width\s*:\s*['"`]\d+%['"`]/ },
  { label: 'style={{display:"flex"}}', regex: /style=\{\{\s*display\s*:\s*['"]flex['"]/ },
  { label: 'style={{fontSize:', regex: /style=\{\{\s*fontSize\s*:/ },
  { label: 'style={{backgroundColor:', regex: /style=\{\{\s*backgroundColor\s*:/ },
];

// --- Exclusion helpers ---

/**
 * Check if a line is a documented exception (has an explanatory comment).
 * Lines with "Inline style required:" or "inline style required:" are excluded.
 */
function isDocumentedException(line: string, prevLine: string): boolean {
  const exceptionPattern = /[Ii]nline style required:/;
  return exceptionPattern.test(line) || exceptionPattern.test(prevLine);
}

/**
 * Check if a line is inside a comment block (HTML/JSX comment or JS comment).
 */
function isInsideComment(line: string): boolean {
  const trimmed = line.trim();
  // Single-line JS comment
  if (trimmed.startsWith('//')) return true;
  // Inside JSX comment block: {/* ... */}
  if (trimmed.startsWith('*') || trimmed.startsWith('/*') || trimmed.startsWith('{/*')) return true;
  return false;
}

/**
 * Check if a line is the modal.tsx dynamic width prop: style={{ width }}
 * This uses a dynamic prop variable, not a hardcoded value.
 */
function isModalDynamicWidth(line: string): boolean {
  return /style=\{\{\s*width\s*\}\}/.test(line);
}

// --- File discovery ---

/**
 * Recursively find all .tsx files in a directory, excluding __tests__,
 * node_modules, and backup files.
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
    } else if (
      entry.isFile() &&
      entry.name.endsWith('.tsx') &&
      !entry.name.includes('.test.') &&
      !entry.name.includes('_Backup')
    ) {
      results.push(fullPath);
    }
  }
  return results;
}

/** Recharts component names whose style/contentStyle/wrapperStyle props are excluded */
const RECHARTS_COMPONENTS = new Set([
  'XAxis', 'YAxis', 'ZAxis', 'Legend', 'Tooltip',
  'ResponsiveContainer', 'CartesianGrid', 'PolarGrid',
  'Pie', 'Bar', 'Line', 'Area', 'Cell', 'Scatter',
  'RadialBar', 'Treemap', 'Funnel',
]);

/**
 * Find the enclosing JSX opening tag for a given line index by scanning backwards.
 * Returns the component name (e.g. "XAxis") or null if not found.
 */
function findEnclosingJsxTag(lines: string[], lineIndex: number): string | null {
  const openTagRegex = /<(\w+)/;
  for (let j = lineIndex; j >= Math.max(0, lineIndex - 15); j--) {
    const match = openTagRegex.exec(lines[j]);
    if (match) return match[1];
  }
  return null;
}

/**
 * Check if a style prop at the given line is inside a Recharts component.
 * Handles both single-line (<XAxis style={{...}} />) and multi-line cases.
 */
function isRechartsContext(lines: string[], lineIndex: number): boolean {
  const line = lines[lineIndex];

  // contentStyle={{ and wrapperStyle={{ are always Recharts
  if (/contentStyle=\{\{/.test(line) || /wrapperStyle=\{\{/.test(line)) return true;

  // Check if the line itself has a Recharts tag
  for (const comp of RECHARTS_COMPONENTS) {
    if (line.includes(`<${comp}`)) return true;
  }

  // For multi-line JSX, look backwards for the enclosing tag
  const tag = findEnclosingJsxTag(lines, lineIndex);
  if (tag && RECHARTS_COMPONENTS.has(tag)) return true;

  return false;
}

/**
 * Check a file for prohibited inline style patterns.
 * Returns an array of violations (empty = clean file).
 */
function findInlineStyleViolations(
  filePath: string,
): Array<{ pattern: string; line: string; lineNumber: number }> {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const violations: Array<{ pattern: string; line: string; lineNumber: number }> = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const prevLine = i > 0 ? lines[i - 1] : '';

    // Skip comment lines
    if (isInsideComment(line)) continue;

    // Skip documented exceptions
    if (isDocumentedException(line, prevLine)) continue;

    // Skip modal dynamic width prop
    if (isModalDynamicWidth(line)) continue;

    // Skip Recharts component style props (single-line and multi-line)
    if (/style=\{\{/.test(line) && isRechartsContext(lines, i)) continue;

    for (const pattern of PROHIBITED_PATTERNS) {
      if (pattern.regex.test(line)) {
        violations.push({
          pattern: pattern.label,
          line: line.trim(),
          lineNumber: i + 1,
        });
      }
    }
  }

  return violations;
}

// --- Discover files ---

const frontendSrc = path.resolve(__dirname, '..', '..');
const allTsxFiles = findTsxFiles(frontendSrc);

// --- Tests ---

describe('Property 4: Zero prohibited inline style patterns', () => {
  it('should find TSX files in frontend/src/', () => {
    expect(allTsxFiles.length).toBeGreaterThan(0);
  });

  it('all TSX files contain zero prohibited inline style patterns', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...allTsxFiles),
        (filePath: string) => {
          const violations = findInlineStyleViolations(filePath);
          if (violations.length > 0) {
            const relativePath = path.relative(frontendSrc, filePath);
            const details = violations
              .map((v) => `  L${v.lineNumber} [${v.pattern}]: ${v.line}`)
              .join('\n');
            throw new Error(
              `File "${relativePath}" has ${violations.length} prohibited inline style(s):\n${details}`,
            );
          }
          return true;
        },
      ),
      { numRuns: Math.max(100, allTsxFiles.length * 3) },
    );
  });
});
