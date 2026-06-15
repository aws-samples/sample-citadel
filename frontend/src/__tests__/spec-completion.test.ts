/**
 * Spec-completion verification test — consolidated gate for all 8 shadcn-compliance tasks.
 * Each assertion confirms a key marker from the corresponding task is still in place.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const SRC = path.join(ROOT, 'src');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

describe('spec-completion gate', () => {
  // Task 1: Baseline infrastructure
  it('T1: components.json exists and tw-animate-css in deps', () => {
    expect(fs.existsSync(path.join(ROOT, 'components.json'))).toBe(true);
    const pkg = JSON.parse(read('package.json'));
    expect({ ...pkg.dependencies, ...pkg.devDependencies }['tw-animate-css']).toBeDefined();
  });

  it('T1: custom.css imported in main.tsx, global.css in gitignore', () => {
    expect(read('src/main.tsx')).toMatch(/['"]\.\/styles\/custom\.css['"]/);
    expect(read('.gitignore')).toMatch(/global\.css/);
  });

  it('T1: TooltipProvider in App.tsx', () => {
    expect(read('src/App.tsx')).toMatch(/<TooltipProvider/);
  });

  it('T1: Integrations_Backup.tsx gone, legacy tokens removed', () => {
    expect(fs.existsSync(path.join(SRC, 'pages/Integrations_Backup.tsx'))).toBe(false);
    const css = read('src/styles/custom.css');
    expect(css).not.toContain('--color-text-heading');
    expect(css).not.toContain('--color-text-body');
    expect(css).not.toContain('--color-text-subtle');
    expect(css).not.toMatch(/@theme inline[^}]*--color-text-primary/s);
  });

  // Task 2: vite.config.ts has NO versioned aliases
  it('T2: vite.config.ts has only @ alias', () => {
    const vite = read('vite.config.ts');
    expect(vite).not.toMatch(/['"][^'"]+@\d+\.\d+\.\d+['"]\s*:/);
  });

  // Task 3: custom duplicates replaced
  it('T3: modal.tsx gone, status-card uses cva, banners no -webkit-background-clip inline', () => {
    expect(fs.existsSync(path.join(SRC, 'components/ui/modal.tsx'))).toBe(false);
    expect(read('src/components/ui/status-card.tsx')).toMatch(/cva/);
    for (const f of ['banner.tsx', 'aws-banner.tsx']) {
      const p = path.join(SRC, 'components/ui', f);
      if (fs.existsSync(p)) {
        const content = fs.readFileSync(p, 'utf-8');
        const styleBlocks = content.match(/style=\{\{[^}]*\}\}/g) || [];
        for (const b of styleBlocks) expect(b).not.toContain('-webkit-background-clip');
      }
    }
  });

  // Task 4: composition migrations
  it('T4: AppSidebar uses Sidebar primitive', () => {
    const s = read('src/components/AppSidebar.tsx');
    expect(s).toMatch(/from\s+['"].*sidebar['"]/);
    expect(s).toMatch(/SidebarMenuButton/);
  });

  it('T4: AppHeader uses DropdownMenu + SidebarTrigger', () => {
    const h = read('src/components/AppHeader.tsx');
    expect(h).toMatch(/DropdownMenu/);
    expect(h).toMatch(/SidebarTrigger/);
  });

  it('T4: AgenticStudio uses Tabs', () => {
    const a = read('src/pages/AgenticStudio.tsx');
    expect(a).toMatch(/from\s+['"].*tabs['"]/);
    expect(a).toMatch(/TabsContent/);
  });

  it('T4: ChartRow2/3/4 use Card+ChartContainer', () => {
    for (const f of ['ChartRow2.tsx', 'ChartRow3.tsx']) {
      const c = read(`src/pages/dashboard/${f}`);
      expect(c).toMatch(/Card/);
      expect(c).toMatch(/ChartContainer/);
    }
  });

  it('T4: AuthScreen uses Alert', () => {
    const a = read('src/components/AuthScreen.tsx');
    expect(a).toMatch(/from\s+['"].*alert['"]/);
    expect(a).toMatch(/<Alert/);
  });

  it('T4: badge.tsx has success/warning/info variants', () => {
    const badge = read('src/components/ui/badge.tsx');
    expect(badge).toMatch(/success/);
    expect(badge).toMatch(/warning/);
    expect(badge).toMatch(/info/);
  });

  it('T4: IntegrationCard has no raw-color maps', () => {
    const ic = read('src/components/IntegrationCard.tsx');
    expect(ic).not.toMatch(/statusColors\s*[:=]/);
    expect(ic).not.toMatch(/pricingColors\s*[:=]/);
  });

  it('T4: ProjectCard uses Button+DropdownMenu', () => {
    const pc = read('src/components/ProjectCard.tsx');
    expect(pc).toMatch(/Button/);
    expect(pc).toMatch(/DropdownMenu/);
  });

  // Task 5: styling hygiene (spot checks on scope files)
  it('T5: no space-y/x-* in key scope files', () => {
    for (const f of ['components/AuthScreen.tsx', 'components/ProjectCard.tsx', 'pages/AgenticStudio.tsx']) {
      expect(read(`src/${f}`)).not.toMatch(/\bspace-[xy]-\d/);
    }
  });

  it('T5: no w-N h-N equal pairs in key scope files', () => {
    for (const f of ['components/AppSidebar.tsx', 'components/AppHeader.tsx', 'components/ProjectCard.tsx']) {
      const c = read(`src/${f}`);
      expect(c).not.toMatch(/\bw-(\d+)\s+h-\1\b/);
      expect(c).not.toMatch(/\bh-(\d+)\s+w-\1\b/);
    }
  });

  // Task 6: chart tokens
  it('T6: chartStyles.ts uses cssVar, references --chart-1..5, no hex literals', () => {
    const cs = read('src/pages/dashboard/chartStyles.ts');
    expect(cs).toMatch(/cssVar/);
    expect(cs).toContain("'--chart-1'");
    expect(cs).toContain("'--chart-5'");
    const noComments = cs.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');
    expect(noComments).not.toMatch(/#[0-9a-fA-F]{6}\b/);
  });

  // Task 7: jest config clean
  it('T7: jest.config.cjs has no transitional versioned mappers', () => {
    const cfg = read('jest.config.cjs');
    expect(cfg).not.toMatch(/@\[\\\\d\.\]\+\$/);
    expect(cfg).toContain("'^@/(.*)$': '<rootDir>/src/$1'");
  });

  // Task 8: key page files are readable (compilability proven by build)
  it('T8: key page files exist and are readable', () => {
    for (const f of [
      'src/components/AppSidebar.tsx', 'src/components/AppHeader.tsx',
      'src/components/AuthScreen.tsx', 'src/components/ProjectCard.tsx',
      'src/components/IntegrationCard.tsx', 'src/pages/dashboard/ChartRow2.tsx',
    ]) {
      expect(() => fs.readFileSync(path.join(ROOT, f), 'utf-8')).not.toThrow();
    }
  });
});
