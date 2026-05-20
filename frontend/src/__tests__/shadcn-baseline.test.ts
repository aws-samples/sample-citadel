import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..', '..');

describe('shadcn baseline infrastructure', () => {
  describe('components.json', () => {
    const filePath = path.join(ROOT, 'components.json');

    it('exists', () => {
      expect(fs.existsSync(filePath)).toBe(true);
    });

    it('has correct configuration', () => {
      const config = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      expect(config.style).toBe('default');
      expect(config.rsc).toBe(false);
      expect(config.tsx).toBe(true);
      expect(config.tailwind.css).toBe('src/styles/custom.css');
      expect(config.aliases.utils).toBe('@/components/ui/utils');
      expect(config.aliases.ui).toBe('@/components/ui');
      expect(config.iconLibrary).toBe('lucide');
    });
  });

  describe('tw-animate-css', () => {
    it('is listed in package.json dependencies', () => {
      const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
      expect(allDeps['tw-animate-css']).toBeDefined();
    });

    it('is imported as an early directive in custom.css', () => {
      const css = fs.readFileSync(path.join(ROOT, 'src/styles/custom.css'), 'utf-8');
      const lines = css.split('\n');
      const directives = lines.filter(
        (line) => line.trim() !== '' && !line.trim().startsWith('/*') && !line.trim().startsWith('*') && !line.trim().startsWith('//')
      ).slice(0, 3);
      expect(directives.join('\n')).toMatch(/@import\s+['"]tw-animate-css['"]/);
    });
  });

  describe('CSS import chain in main.tsx', () => {
    const mainPath = path.join(ROOT, 'src/main.tsx');

    it('imports ./styles/custom.css', () => {
      const content = fs.readFileSync(mainPath, 'utf-8');
      expect(content).toMatch(/import\s+['"]\.\/styles\/custom\.css['"]/);
    });

    it('does NOT import ./styles/global.css', () => {
      const content = fs.readFileSync(mainPath, 'utf-8');
      expect(content).not.toMatch(/import\s+['"]\.\/styles\/global\.css['"]/);
    });
  });

  describe('.gitignore', () => {
    it('contains src/styles/global.css', () => {
      const gitignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf-8');
      expect(
        gitignore.includes('src/styles/global.css') ||
        gitignore.includes('frontend/src/styles/global.css') ||
        gitignore.includes('/src/styles/global.css')
      ).toBe(true);
    });
  });

  describe('legacy token removal in custom.css', () => {
    const cssPath = path.join(ROOT, 'src/styles/custom.css');

    it('does NOT have --color-text-heading, --color-text-body, --color-text-subtle (removed in favour of shadcn foreground/muted-foreground)', () => {
      const css = fs.readFileSync(cssPath, 'utf-8');
      expect(css).not.toContain('--color-text-heading');
      expect(css).not.toContain('--color-text-body');
      expect(css).not.toContain('--color-text-subtle');
    });

    it('does NOT have --color-text-primary, --color-text-secondary, --color-text-muted in @theme inline', () => {
      const css = fs.readFileSync(cssPath, 'utf-8');
      const themeMatch = css.match(/@theme inline\s*\{([^}]*(?:\{[^}]*\}[^}]*)*)\}/s);
      expect(themeMatch).not.toBeNull();
      const themeBlock = themeMatch![1];
      expect(themeBlock).not.toContain('--color-text-primary');
      expect(themeBlock).not.toContain('--color-text-secondary');
      expect(themeBlock).not.toContain('--color-text-muted');
    });
  });

  describe('TooltipProvider in App.tsx', () => {
    const appPath = path.join(ROOT, 'src/App.tsx');

    it('imports TooltipProvider from @/components/ui/tooltip', () => {
      const content = fs.readFileSync(appPath, 'utf-8');
      expect(content).toMatch(/import\s*\{[^}]*TooltipProvider[^}]*\}\s*from\s*['"]@\/components\/ui\/tooltip['"]/);
    });

    it('uses TooltipProvider in JSX', () => {
      const content = fs.readFileSync(appPath, 'utf-8');
      expect(content).toMatch(/<TooltipProvider/);
    });
  });

  describe('dead code removal', () => {
    it('Integrations_Backup.tsx does NOT exist', () => {
      expect(fs.existsSync(path.join(ROOT, 'src/pages/Integrations_Backup.tsx'))).toBe(false);
    });
  });

  describe('Tailwind v4 entry directive in custom.css', () => {
    const cssPath = path.join(ROOT, 'src/styles/custom.css');

    it('has @import tailwindcss, @import tw-animate-css, and @plugin typography in first 3 directives', () => {
      const css = fs.readFileSync(cssPath, 'utf-8');
      const lines = css.split('\n');
      const directives = lines
        .filter(
          (line) =>
            line.trim() !== '' &&
            !line.trim().startsWith('/*') &&
            !line.trim().startsWith('*') &&
            !line.trim().startsWith('//')
        )
        .slice(0, 3);

      const joined = directives.join('\n');
      expect(joined).toMatch(/@import\s+['"]tailwindcss['"]/);
      expect(joined).toMatch(/@import\s+['"]tw-animate-css['"]/);
      expect(joined).toMatch(/@plugin\s+['"]@tailwindcss\/typography['"]/);
    });
  });

  describe('no old token utility classes in frontend/src', () => {
    function getAllTsxFiles(dir: string): string[] {
      const results: string[] = [];
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '__tests__') {
          results.push(...getAllTsxFiles(fullPath));
        } else if (entry.isFile() && (entry.name.endsWith('.tsx') || entry.name.endsWith('.ts'))) {
          results.push(fullPath);
        }
      }
      return results;
    }

    it('no file uses text-text-primary, text-text-secondary, or text-text-muted', () => {
      const srcDir = path.join(ROOT, 'src');
      const files = getAllTsxFiles(srcDir);
      const violations: string[] = [];
      for (const file of files) {
        const content = fs.readFileSync(file, 'utf-8');
        if (
          content.includes('text-text-primary') ||
          content.includes('text-text-secondary') ||
          content.includes('text-text-muted')
        ) {
          violations.push(path.relative(ROOT, file));
        }
      }
      expect(violations).toEqual([]);
    });
  });
});
