import * as fs from 'fs';
import * as path from 'path';

const uiDir = path.resolve(__dirname, '../components/ui');
const viteConfig = path.resolve(__dirname, '../../vite.config.ts');

const uiFiles = fs.readdirSync(uiDir).filter((f) => f.endsWith('.tsx'));

describe('UI primitive imports', () => {
  it.each(uiFiles)(
    '%s has no versioned import specifiers',
    (file) => {
      const content = fs.readFileSync(path.join(uiDir, file), 'utf-8');
      const versionedImport = /from\s+['"][^'"]+@\d+\.\d+\.\d+['"]/;
      expect(content).not.toMatch(versionedImport);
    },
  );

  it.each(uiFiles)(
    '%s does not start with a "use client" directive',
    (file) => {
      const content = fs.readFileSync(path.join(uiDir, file), 'utf-8');
      const useClient = /^(['"])use client\1;?\s*\n/;
      expect(content).not.toMatch(useClient);
    },
  );
});

describe('vite.config.ts aliases', () => {
  const content = fs.readFileSync(viteConfig, 'utf-8');

  it('contains the @ path alias', () => {
    expect(content).toMatch(/'@':\s*path\.resolve/);
  });

  it('has no versioned alias entries', () => {
    const versionedAlias = /['"][a-z@/-]+@\d+\.\d+\.\d+['"]\s*:/;
    expect(content).not.toMatch(versionedAlias);
  });
});
