// Feature: ui-ux-remediation, Property 8: Zero JS-based styling event handlers
import * as fc from 'fast-check';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Property 8: Zero JS-based styling event handlers
 *
 * For all TSX source files in `frontend/src/`, the file content SHALL contain
 * zero instances of `onMouseEnter` or `onMouseLeave` used for styling purposes
 * (i.e. paired with `style.backgroundColor` or similar style mutations), and
 * zero instances of `e.currentTarget.style.backgroundColor`.
 *
 * **Validates: Requirements 8.5, 8.6**
 */

// --- Patterns that indicate JS-based styling event handlers ---

interface ViolationPattern {
  label: string;
  regex: RegExp;
}

/**
 * Patterns detecting JS-based styling mutations in event handlers.
 * We look for:
 * - onMouseEnter/onMouseLeave paired with style.backgroundColor or style.background
 * - Direct e.currentTarget.style.backgroundColor mutations
 * - Direct e.currentTarget.style.borderColor mutations
 */
const JS_STYLING_PATTERNS: ViolationPattern[] = [
  {
    label: 'onMouseEnter with style.backgroundColor',
    regex: /onMouseEnter[^}]*style\.backgroundColor/,
  },
  {
    label: 'onMouseLeave with style.backgroundColor',
    regex: /onMouseLeave[^}]*style\.backgroundColor/,
  },
  {
    label: 'onMouseEnter with style.background',
    regex: /onMouseEnter[^}]*style\.background\b/,
  },
  {
    label: 'onMouseLeave with style.background',
    regex: /onMouseLeave[^}]*style\.background\b/,
  },
  {
    label: 'e.currentTarget.style.backgroundColor',
    regex: /e\.currentTarget\.style\.backgroundColor/,
  },
  {
    label: 'e.currentTarget.style.borderColor',
    regex: /e\.currentTarget\.style\.borderColor/,
  },
];

/**
 * Single-line patterns: onMouseEnter/onMouseLeave that set style properties
 * on the same line (common in inline arrow handlers).
 */
const SINGLE_LINE_PATTERNS: ViolationPattern[] = [
  {
    label: 'onMouseEnter inline style mutation',
    regex: /onMouseEnter\s*=\s*\{[^}]*\.style\./,
  },
  {
    label: 'onMouseLeave inline style mutation',
    regex: /onMouseLeave\s*=\s*\{[^}]*\.style\./,
  },
];

// --- Helpers ---

/**
 * Strip single-line and multi-line comments from source content
 * so we don't flag patterns inside comments.
 */
function stripComments(content: string): string {
  // Remove multi-line comments (/* ... */ and {/* ... */})
  let stripped = content.replace(/\/\*[\s\S]*?\*\//g, '');
  // Remove single-line comments
  stripped = stripped.replace(/\/\/.*$/gm, '');
  return stripped;
}

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

/**
 * Check a file for JS-based styling event handler violations.
 * Uses both multi-line scanning (for handler bodies spanning lines)
 * and single-line pattern matching.
 */
function findJsStylingViolations(
  filePath: string,
): Array<{ pattern: string; lineNumber: number; line: string }> {
  const rawContent = fs.readFileSync(filePath, 'utf-8');
  const content = stripComments(rawContent);
  const violations: Array<{ pattern: string; lineNumber: number; line: string }> = [];
  const lines = content.split('\n');

  // Check single-line patterns line by line
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const pattern of SINGLE_LINE_PATTERNS) {
      if (pattern.regex.test(line)) {
        violations.push({
          pattern: pattern.label,
          lineNumber: i + 1,
          line: line.trim(),
        });
      }
    }
  }

  // Check multi-line patterns against the full (comment-stripped) content
  // These catch cases where onMouseEnter is on one line and style mutation on another
  for (const pattern of JS_STYLING_PATTERNS) {
    if (pattern.regex.test(content)) {
      // Find approximate line number by searching raw lines
      for (let i = 0; i < lines.length; i++) {
        if (/e\.currentTarget\.style\.backgroundColor/.test(lines[i]) ||
            /e\.currentTarget\.style\.borderColor/.test(lines[i])) {
          violations.push({
            pattern: pattern.label,
            lineNumber: i + 1,
            line: lines[i].trim(),
          });
          break;
        }
      }
      // If we didn't find a specific line, report at line 0
      if (!violations.some((v) => v.pattern === pattern.label)) {
        violations.push({
          pattern: pattern.label,
          lineNumber: 0,
          line: '(multi-line pattern match)',
        });
      }
    }
  }

  // Deduplicate by pattern + lineNumber
  const seen = new Set<string>();
  return violations.filter((v) => {
    const key = `${v.pattern}:${v.lineNumber}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// --- Discover files ---

const frontendSrc = path.resolve(__dirname, '..', '..');
const allTsxFiles = findTsxFiles(frontendSrc);

// --- Property-Based Test (Task 10.2) ---

describe('Property 8: Zero JS-based styling event handlers', () => {
  it('should find TSX files in frontend/src/', () => {
    expect(allTsxFiles.length).toBeGreaterThan(0);
  });

  it('all TSX files contain zero JS-based styling event handlers', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...allTsxFiles),
        (filePath: string) => {
          const violations = findJsStylingViolations(filePath);
          if (violations.length > 0) {
            const relativePath = path.relative(frontendSrc, filePath);
            const details = violations
              .map((v) => `  L${v.lineNumber} [${v.pattern}]: ${v.line}`)
              .join('\n');
            throw new Error(
              `File "${relativePath}" has ${violations.length} JS-based styling handler(s):\n${details}`,
            );
          }
          return true;
        },
      ),
      { numRuns: Math.max(100, allTsxFiles.length * 3) },
    );
  });
});

// --- Unit Tests (Task 10.3) ---

describe('CSS pseudo-class migration', () => {
  const appSidebarPath = path.join(frontendSrc, 'components', 'AppSidebar.tsx');
  const authScreenPath = path.join(frontendSrc, 'components', 'AuthScreen.tsx');
  const sidebarUiPath = path.join(frontendSrc, 'components', 'ui', 'sidebar.tsx');

  describe('AppSidebar uses CSS hover classes, no JS handlers', () => {
    let content: string;
    let strippedContent: string;

    beforeAll(() => {
      content = fs.readFileSync(appSidebarPath, 'utf-8');
      strippedContent = stripComments(content);
    });

    // Validates: Requirement 8.1 — hover is handled by shadcn SidebarMenuButton primitive
    it('shadcn SidebarMenuButton contains hover:bg-sidebar-accent class', () => {
      const sidebarUiContent = fs.readFileSync(sidebarUiPath, 'utf-8');
      expect(sidebarUiContent).toContain('hover:bg-sidebar-accent');
    });

    // Validates: Requirement 8.1
    it('does NOT contain onMouseEnter handler', () => {
      expect(strippedContent).not.toMatch(/onMouseEnter/);
    });

    // Validates: Requirement 8.1
    it('does NOT contain onMouseLeave handler', () => {
      expect(strippedContent).not.toMatch(/onMouseLeave/);
    });

    // Validates: Requirement 8.7 — transition is handled by shadcn SidebarMenuButton primitive
    it('shadcn SidebarMenuButton contains transition class', () => {
      const sidebarUiContent = fs.readFileSync(sidebarUiPath, 'utf-8');
      expect(sidebarUiContent).toMatch(/transition-\[/);
    });
  });

  describe('AuthScreen uses CSS hover classes, no JS handlers', () => {
    let content: string;
    let strippedContent: string;

    beforeAll(() => {
      content = fs.readFileSync(authScreenPath, 'utf-8');
      strippedContent = stripComments(content);
    });

    // Validates: Requirement 8.2 — now uses hover:bg-muted (shadcn token)
    it('contains hover:bg-muted class for submit button hover', () => {
      expect(strippedContent).toContain('hover:bg-muted');
    });

    // Validates: Requirement 8.2
    it('does NOT contain onMouseEnter handler', () => {
      expect(strippedContent).not.toMatch(/onMouseEnter/);
    });

    // Validates: Requirement 8.2
    it('does NOT contain onMouseLeave handler', () => {
      expect(strippedContent).not.toMatch(/onMouseLeave/);
    });
  });
});
