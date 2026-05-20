import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..', '..');
const cssPath = path.join(ROOT, 'src/styles/custom.css');

function findFiles(dir: string, extensions: string[]): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'ui' || entry.name === 'node_modules') continue;
      results.push(...findFiles(full, extensions));
    } else if (extensions.some(ext => entry.name.endsWith(ext))) {
      results.push(full);
    }
  }
  return results;
}

const componentsDir = path.resolve(__dirname, '../components');
const pagesDir = path.resolve(__dirname, '../pages');
const srcDir = path.resolve(__dirname, '..');

function getSourceFiles(): string[] {
  // Root-level src/*.ts(x) files (e.g. App.tsx, main.tsx) — non-recursive.
  const rootFiles = fs
    .readdirSync(srcDir, { withFileTypes: true })
    .filter(
      (e) => e.isFile() && (e.name.endsWith('.ts') || e.name.endsWith('.tsx')),
    )
    .map((e) => path.join(srcDir, e.name));
  return [
    ...rootFiles,
    ...findFiles(componentsDir, ['.ts', '.tsx']),
    ...findFiles(pagesDir, ['.ts', '.tsx']),
  ];
}

describe('legacy tokens removed', () => {
  const css = fs.readFileSync(cssPath, 'utf-8');

  test('custom.css does not define legacy surface/border/text variables', () => {
    expect(css).not.toMatch(/--surface-\d/);
    expect(css).not.toMatch(/--border-(subtle|default|strong)/);
    expect(css).not.toMatch(/--text-(heading|body|subtle)/);
  });

  test('@theme inline does not contain legacy color tokens', () => {
    const themeMatch = css.match(/@theme inline\s*\{([\s\S]*?)\n\}/);
    expect(themeMatch).not.toBeNull();
    const themeBlock = themeMatch![1];
    expect(themeBlock).not.toMatch(/--color-surface-/);
    expect(themeBlock).not.toMatch(/--color-border-(subtle|default|strong)/);
    expect(themeBlock).not.toMatch(/--color-text-(heading|body|subtle)/);
  });

  test('no call-site file uses legacy utility classes', () => {
    const legacyPatterns = [
      /(?<=[\s"'`{/])bg-surface-0(?=[\s"'`}/]|$)/,
      /(?<=[\s"'`{/])bg-surface-1(?=[\s"'`}/]|$)/,
      /(?<=[\s"'`{/])bg-surface-2(?=[\s"'`}/]|$)/,
      /(?<=[\s"'`{/])border-subtle(?=[\s"'`}/]|$)/,
      /(?<=[\s"'`{/])border-default(?=[\s"'`}/]|$)/,
      /(?<=[\s"'`{/])border-strong(?=[\s"'`}/]|$)/,
      /(?<=[\s"'`{/])text-text-heading(?=[\s"'`}/]|$)/,
      /(?<=[\s"'`{/])text-text-body(?=[\s"'`}/]|$)/,
      /(?<=[\s"'`{/])text-text-subtle(?=[\s"'`}/]|$)/,
    ];
    const files = getSourceFiles();
    const violations: string[] = [];
    for (const file of files) {
      const content = fs.readFileSync(file, 'utf-8');
      for (const pat of legacyPatterns) {
        if (pat.test(content)) {
          violations.push(`${path.relative(ROOT, file)} matches ${pat.source}`);
          break;
        }
      }
    }
    expect(violations).toEqual([]);
  });

  test('custom.css still contains shadcn core tokens', () => {
    expect(css).toContain('--color-background');
    expect(css).toContain('--color-foreground');
    expect(css).toContain('--color-primary');
    expect(css).toContain('--color-card');
    expect(css).toContain('--color-chart-1');
  });

  test('custom.css starts with @import tailwindcss', () => {
    expect(css.trimStart()).toMatch(/^@import ['"]tailwindcss['"]/);
  });
});
