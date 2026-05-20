// Feature: ui-ux-remediation, Property 18: Zero mock notification data in codebase
import * as fc from 'fast-check';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Property 18: Zero mock notification data in codebase
 *
 * For all source files in `frontend/src/`, the file content SHALL contain
 * zero instances of the `mockNotifications` array declaration or reference.
 *
 * **Validates: Requirements 17.7**
 */

/**
 * Recursively find all .ts and .tsx source files in a directory,
 * excluding __tests__, node_modules, and backup files.
 */
function findSourceFiles(dir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      results.push(...findSourceFiles(fullPath));
    } else if (
      entry.isFile() &&
      (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) &&
      !entry.name.includes('.test.') &&
      !entry.name.includes('_Backup')
    ) {
      results.push(fullPath);
    }
  }
  return results;
}

/**
 * Strip comments from source content so we only check actual code.
 */
function stripComments(content: string): string {
  let stripped = content.replace(/\/\*[\s\S]*?\*\//g, '');
  stripped = stripped.replace(/\/\/.*$/gm, '');
  return stripped;
}

// --- Discover files ---
const frontendSrc = path.resolve(__dirname, '..', '..');
const allSourceFiles = findSourceFiles(frontendSrc);

// --- Patterns detecting mockNotifications references ---
const MOCK_NOTIFICATION_PATTERNS = [
  /\bmockNotifications\b/,
  /\bMockNotifications\b/,
  /\bmock_notifications\b/,
];

describe('Property 18: Zero mock notification data in codebase', () => {
  it('should find source files in frontend/src/', () => {
    expect(allSourceFiles.length).toBeGreaterThan(0);
  });

  it('all source files contain zero instances of mockNotifications', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...allSourceFiles),
        (filePath: string) => {
          const rawContent = fs.readFileSync(filePath, 'utf-8');
          const content = stripComments(rawContent);
          const relativePath = path.relative(frontendSrc, filePath);

          for (const pattern of MOCK_NOTIFICATION_PATTERNS) {
            if (pattern.test(content)) {
              throw new Error(
                `File "${relativePath}" contains mockNotifications reference matching pattern: ${pattern}`,
              );
            }
          }
          return true;
        },
      ),
      { numRuns: Math.max(100, allSourceFiles.length * 3) },
    );
  });
});
