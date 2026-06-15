import * as fs from 'fs';
import * as path from 'path';

const SRC = path.resolve(__dirname, '..');

function getTsxFilesInScope(dir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'ui' || entry.name === '__tests__' || entry.name === 'node_modules') continue;
      results.push(...getTsxFilesInScope(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.tsx')) {
      results.push(fullPath);
    }
  }
  return results;
}

const SCOPE_DIRS = [
  path.join(SRC, 'components'),
  path.join(SRC, 'pages'),
];

const filesInScope = SCOPE_DIRS.flatMap((d) => getTsxFilesInScope(d));

describe('Task 5: Styling Hygiene', () => {
  describe('5.1 No space-y/x-* utilities', () => {
    it('no file contains space-y-N or space-x-N', () => {
      const pattern = /\bspace-[xy]-\d+\b/;
      const violations: string[] = [];
      for (const file of filesInScope) {
        const content = fs.readFileSync(file, 'utf-8');
        if (pattern.test(content)) {
          violations.push(path.relative(SRC, file));
        }
      }
      expect(violations).toEqual([]);
    });
  });

  describe('5.2 No w-N h-N equal-dimension pairs', () => {
    it('no file contains w-N h-N or h-N w-N with same N', () => {
      const pattern = /\b(?:w-(\d+)\s+h-\1|h-(\d+)\s+w-\2)\b/;
      const violations: string[] = [];
      for (const file of filesInScope) {
        const content = fs.readFileSync(file, 'utf-8');
        if (pattern.test(content)) {
          violations.push(path.relative(SRC, file));
        }
      }
      expect(violations).toEqual([]);
    });
  });

  describe('5.3 No overflow-hidden + text-ellipsis + whitespace-nowrap triple', () => {
    it('no className contains all three utilities together', () => {
      const violations: string[] = [];
      for (const file of filesInScope) {
        const content = fs.readFileSync(file, 'utf-8');
        // Find all className strings and check if any single one has all three
        const classNameMatches = content.match(/className="[^"]*"|className={`[^`]*`}/g) || [];
        for (const match of classNameMatches) {
          if (
            match.includes('overflow-hidden') &&
            match.includes('text-ellipsis') &&
            match.includes('whitespace-nowrap')
          ) {
            violations.push(path.relative(SRC, file));
            break;
          }
        }
      }
      expect(violations).toEqual([]);
    });
  });

  describe('5.4 No raw color utilities', () => {
    it('no file contains raw text-color-N patterns', () => {
      const pattern = /\btext-(red|green|blue|orange|yellow|purple|violet|cyan|gray|slate)-\d+\b/;
      const violations: string[] = [];
      for (const file of filesInScope) {
        // Exclude chartStyles.ts (Task 6 scope)
        if (file.includes('chartStyles')) continue;
        const content = fs.readFileSync(file, 'utf-8');
        if (pattern.test(content)) {
          violations.push(path.relative(SRC, file));
        }
      }
      expect(violations).toEqual([]);
    });

    it('no file contains raw bg-color-N patterns', () => {
      const pattern = /\bbg-(red|green|blue|orange|yellow|violet|purple)-\d+\b/;
      const violations: string[] = [];
      for (const file of filesInScope) {
        if (file.includes('chartStyles')) continue;
        const content = fs.readFileSync(file, 'utf-8');
        if (pattern.test(content)) {
          violations.push(path.relative(SRC, file));
        }
      }
      expect(violations).toEqual([]);
    });

    it('no file contains raw border-color-N patterns', () => {
      const pattern = /\bborder-(red|green|blue|slate|orange)-\d+\b/;
      const violations: string[] = [];
      for (const file of filesInScope) {
        if (file.includes('chartStyles')) continue;
        const content = fs.readFileSync(file, 'utf-8');
        if (pattern.test(content)) {
          violations.push(path.relative(SRC, file));
        }
      }
      expect(violations).toEqual([]);
    });
  });

  describe('5.5 No raw gradient color stops', () => {
    const GRADIENT_STOP = /\b(?:from|to|via)-(?:red|green|blue|orange|yellow|purple|violet|cyan|gray|slate)-\d+\b/;
    it('no file contains raw from-/to-/via-color-N gradient stops', () => {
      const violations: string[] = [];
      for (const file of filesInScope) {
        if (file.includes('chartStyles')) continue;
        const content = fs.readFileSync(file, 'utf-8');
        if (GRADIENT_STOP.test(content)) violations.push(path.relative(SRC, file));
      }
      expect(violations).toEqual([]);
    });
    it('pattern matches raw palette stops but not theme-token stops', () => {
      expect(GRADIENT_STOP.test('from-orange-500')).toBe(true);
      expect(GRADIENT_STOP.test('to-slate-900')).toBe(true);
      expect(GRADIENT_STOP.test('via-blue-400')).toBe(true);
      expect(GRADIENT_STOP.test('from-primary')).toBe(false);
      expect(GRADIENT_STOP.test('to-card')).toBe(false);
      expect(GRADIENT_STOP.test('bg-gradient-to-br')).toBe(false);
    });
  });

  describe('5.6 No manual z-[N]', () => {
    it('no file contains z-[digits]', () => {
      const pattern = /z-\[\d+\]/;
      const violations: string[] = [];
      for (const file of filesInScope) {
        const content = fs.readFileSync(file, 'utf-8');
        if (pattern.test(content)) {
          violations.push(path.relative(SRC, file));
        }
      }
      expect(violations).toEqual([]);
    });
  });

  describe('5.7 ProjectCard uses cn() not template literals', () => {
    const projectCardPath = path.join(SRC, 'components', 'ProjectCard.tsx');

    it('imports cn from @/components/ui/utils', () => {
      const content = fs.readFileSync(projectCardPath, 'utf-8');
      expect(content).toMatch(/import\s*\{[^}]*\bcn\b[^}]*\}\s*from\s*['"]@\/components\/ui\/utils['"]/);
    });

    it('does not contain template-literal className with interpolation', () => {
      const content = fs.readFileSync(projectCardPath, 'utf-8');
      // Match className={`...${...}...`}
      const pattern = /className=\{`[^`]*\$\{[^`]+\}[^`]*`\}/;
      expect(content).not.toMatch(pattern);
    });
  });
});
