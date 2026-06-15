import * as fs from 'fs';
import * as path from 'path';

function findFiles(dir: string, ext: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'ui' || entry.name === 'node_modules') continue;
      results.push(...findFiles(full, ext));
    } else if (entry.name.endsWith(ext)) {
      results.push(full);
    }
  }
  return results;
}

const componentsDir = path.resolve(__dirname, '../components');
const pagesDir = path.resolve(__dirname, '../pages');

function getSourceFiles(): string[] {
  return [...findFiles(componentsDir, '.tsx'), ...findFiles(pagesDir, '.tsx')];
}

// Whole-word boundary pattern for class names
const classWordBoundary = /(?<=[\s"'`{])text-secondary(?=[\s"'`}]|$)/;
// text-muted but NOT text-muted-foreground
const mutedWordBoundary = /(?<=[\s"'`{])text-muted(?!-)(?=[\s"'`}]|$)/;
const strongWordBoundary = /(?<=[\s"'`{])text-strong(?=[\s"'`}]|$)/;

describe('text-contrast: no legacy text-color classes in call-site code', () => {
  const files = getSourceFiles();

  test('no file uses text-secondary as a whole word', () => {
    const violations: string[] = [];
    for (const file of files) {
      const content = fs.readFileSync(file, 'utf-8');
      if (classWordBoundary.test(content)) {
        violations.push(path.relative(componentsDir + '/..', file));
      }
    }
    expect(violations).toEqual([]);
  });

  test('no file uses text-muted (not text-muted-foreground) as a whole word', () => {
    const violations: string[] = [];
    for (const file of files) {
      const content = fs.readFileSync(file, 'utf-8');
      if (mutedWordBoundary.test(content)) {
        violations.push(path.relative(componentsDir + '/..', file));
      }
    }
    expect(violations).toEqual([]);
  });

  test('no file uses text-strong as a whole word', () => {
    const violations: string[] = [];
    for (const file of files) {
      const content = fs.readFileSync(file, 'utf-8');
      if (strongWordBoundary.test(content)) {
        violations.push(path.relative(componentsDir + '/..', file));
      }
    }
    expect(violations).toEqual([]);
  });

  test('SearchInput.tsx uses bg-input-background (not bg-transparent)', () => {
    const content = fs.readFileSync(path.join(componentsDir, 'SearchInput.tsx'), 'utf-8');
    expect(content).toContain('bg-input-background');
    expect(content).not.toMatch(/['"`].*bg-transparent.*['"`]/);
  });

  test('TaskRunner.tsx submit Button does not have bg-white', () => {
    const content = fs.readFileSync(path.join(componentsDir, 'TaskRunner.tsx'), 'utf-8');
    // The Button with type="submit" should not have bg-white in its className
    expect(content).not.toMatch(/Button[\s\S]*?type="submit"[\s\S]*?bg-white/);
  });

  test('AppHeader.tsx does not pass bg-surface-0 className override to SearchInput', () => {
    const content = fs.readFileSync(path.join(componentsDir, 'AppHeader.tsx'), 'utf-8');
    expect(content).not.toMatch(/bg-surface-0.*border-surface-2/);
  });

  test('AppSidebar.tsx org trigger disabled only depends on loading', () => {
    const content = fs.readFileSync(path.join(componentsDir, 'AppSidebar.tsx'), 'utf-8');
    expect(content).toMatch(/disabled=\{loading\}/);
    expect(content).not.toMatch(/disabled=\{loading \|\| organizations\.length === 0\}/);
  });
});
