import * as fs from 'fs';
import * as path from 'path';

function findFiles(dir: string, ext: string[]): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== 'node_modules') {
      results.push(...findFiles(full, ext));
    } else if (ext.some(e => entry.name.endsWith(e))) {
      results.push(full);
    }
  }
  return results;
}

const srcDir = path.resolve(__dirname, '..');

describe('Task 3: Custom duplicates replaced', () => {
  test('modal.tsx does not exist', () => {
    expect(fs.existsSync(path.join(srcDir, 'components/ui/modal.tsx'))).toBe(false);
  });

  test('no file imports from ui/modal', () => {
    const files = findFiles(srcDir, ['.ts', '.tsx']).filter(f => !f.includes('__tests__'));
    const importPattern = /from\s+['"].*ui\/modal['"]/;
    const violators = files.filter(f => importPattern.test(fs.readFileSync(f, 'utf-8')));
    expect(violators).toEqual([]);
  });

  test('status-card uses cva and has no hex color literals', () => {
    const src = fs.readFileSync(path.join(srcDir, 'components/ui/status-card.tsx'), 'utf-8');
    expect(src).toMatch(/class-variance-authority|from ['"].*cva['"]/);
    expect(src).not.toMatch(/#[0-9a-fA-F]{3,6}\b/);
  });

  test('banner.tsx uses bg-clip-text and has no WebkitBackgroundClip/WebkitTextFillColor', () => {
    const src = fs.readFileSync(path.join(srcDir, 'components/ui/banner.tsx'), 'utf-8');
    expect(src).toContain('bg-clip-text');
    expect(src).not.toMatch(/WebkitBackgroundClip|WebkitTextFillColor/);
  });

  test('aws-banner.tsx uses bg-clip-text and has no WebkitBackgroundClip/WebkitTextFillColor', () => {
    const src = fs.readFileSync(path.join(srcDir, 'components/ui/aws-banner.tsx'), 'utf-8');
    expect(src).toContain('bg-clip-text');
    expect(src).not.toMatch(/WebkitBackgroundClip|WebkitTextFillColor/);
  });

  test('no file contains z-[10000] or z-[9999]', () => {
    const files = findFiles(srcDir, ['.ts', '.tsx']).filter(f => !f.includes('__tests__'));
    const pattern = /z-\[10000\]|z-\[9999\]/;
    const violators = files.filter(f => pattern.test(fs.readFileSync(f, 'utf-8')));
    expect(violators).toEqual([]);
  });
});
