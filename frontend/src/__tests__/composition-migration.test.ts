import * as fs from 'fs';
import * as path from 'path';

function readSrc(relativePath: string): string {
  return fs.readFileSync(path.resolve(__dirname, '..', relativePath), 'utf-8');
}

describe('Task 4: Call-Site Composition Migrations', () => {
  describe('4.1 AppSidebar → Sidebar + DropdownMenu', () => {
    let src: string;
    beforeAll(() => { src = readSrc('components/AppSidebar.tsx'); });

    it('imports Sidebar from @/components/ui/sidebar', () => {
      expect(src).toMatch(/from\s+['"](@\/components\/ui\/sidebar|\.\/ui\/sidebar)['"]/);
    });
    it('imports DropdownMenu from @/components/ui/dropdown-menu', () => {
      expect(src).toMatch(/from\s+['"](@\/components\/ui\/dropdown-menu|\.\/ui\/dropdown-menu)['"]/);
    });
    it('does not contain z-50', () => {
      expect(src).not.toContain('z-50');
    });
  });

  describe('4.2 AppHeader → DropdownMenu + SidebarTrigger', () => {
    let src: string;
    beforeAll(() => { src = readSrc('components/AppHeader.tsx'); });

    it('imports DropdownMenu from @/components/ui/dropdown-menu', () => {
      expect(src).toMatch(/from\s+['"](@\/components\/ui\/dropdown-menu|\.\/ui\/dropdown-menu)['"]/);
    });
    it('imports SidebarTrigger from @/components/ui/sidebar', () => {
      expect(src).toMatch(/SidebarTrigger/);
      expect(src).toMatch(/from\s+['"](@\/components\/ui\/sidebar|\.\/ui\/sidebar)['"]/);
    });
    it('does not contain z-[9998] or z-[9999]', () => {
      expect(src).not.toContain('z-[9998]');
      expect(src).not.toContain('z-[9999]');
    });
  });

  describe('4.3 AgenticStudio → Tabs', () => {
    let src: string;
    beforeAll(() => { src = readSrc('pages/AgenticStudio.tsx'); });

    it('imports Tabs, TabsList, TabsTrigger, TabsContent', () => {
      expect(src).toMatch(/Tabs/);
      expect(src).toMatch(/TabsList/);
      expect(src).toMatch(/TabsTrigger/);
      expect(src).toMatch(/TabsContent/);
    });
    it('does not contain border-blue-500', () => {
      expect(src).not.toContain('border-blue-500');
    });
    it('does not contain text-gray-400', () => {
      expect(src).not.toContain('text-gray-400');
    });
  });

  describe('4.4 Dashboard → Card + ChartContainer', () => {
    const files = ['pages/dashboard/ChartRow2.tsx', 'pages/dashboard/ChartRow3.tsx', 'pages/dashboard/ChartRow4.tsx'];

    it.each(files)('%s imports Card, CardHeader, CardContent', (file) => {
      const src = readSrc(file);
      expect(src).toMatch(/Card/);
      expect(src).toMatch(/CardHeader/);
      expect(src).toMatch(/CardContent/);
    });

    it.each(['pages/dashboard/ChartRow2.tsx', 'pages/dashboard/ChartRow3.tsx'])('%s imports ChartContainer from @/components/ui/chart', (file) => {
      const src = readSrc(file);
      expect(src).toMatch(/ChartContainer/);
      expect(src).toMatch(/from\s+['"](@\/components\/ui\/chart|\.\.\/\.\.\/components\/ui\/chart)['"]/);
    });

    it.each(files)('%s does not contain border border-border rounded-lg p-5 as className', (file) => {
      const src = readSrc(file);
      expect(src).not.toContain('border border-border rounded-lg p-5');
    });
  });

  describe('4.5 AuthScreen → Alert', () => {
    let src: string;
    beforeAll(() => { src = readSrc('components/AuthScreen.tsx'); });

    it('imports Alert, AlertTitle, AlertDescription', () => {
      expect(src).toMatch(/Alert/);
      expect(src).toMatch(/AlertTitle/);
      expect(src).toMatch(/AlertDescription/);
    });
    it('does not contain bg-red-50', () => { expect(src).not.toContain('bg-red-50'); });
    it('does not contain bg-green-50', () => { expect(src).not.toContain('bg-green-50'); });
    it('does not contain text-red-600', () => { expect(src).not.toContain('text-red-600'); });
    it('does not contain text-green-600', () => { expect(src).not.toContain('text-green-600'); });
    it('does not contain border-red-200', () => { expect(src).not.toContain('border-red-200'); });
    it('does not contain border-green-200', () => { expect(src).not.toContain('border-green-200'); });
  });

  describe('4.6 Badge variants', () => {
    let src: string;
    beforeAll(() => { src = readSrc('components/ui/badge.tsx'); });

    it('contains success variant', () => { expect(src).toContain('success:'); });
    it('contains warning variant', () => { expect(src).toContain('warning:'); });
    it('contains info variant', () => { expect(src).toContain('info:'); });
  });

  describe('4.6 IntegrationCard raw colors removed', () => {
    let src: string;
    beforeAll(() => { src = readSrc('components/IntegrationCard.tsx'); });

    it('does not contain raw statusColors string', () => {
      expect(src).not.toContain('bg-transparent text-green-400 border border-green-500/50');
    });
  });

  describe('4.7 ProjectCard fixes', () => {
    let src: string;
    beforeAll(() => { src = readSrc('components/ProjectCard.tsx'); });

    it('imports Button from @/components/ui/button', () => {
      expect(src).toMatch(/Button/);
      expect(src).toMatch(/from\s+['"](@\/components\/ui\/button|\.\/ui\/button)['"]/);
    });
    it('imports DropdownMenu', () => {
      expect(src).toMatch(/DropdownMenu/);
    });
    it('does not contain text-violet-500', () => { expect(src).not.toContain('text-violet-500'); });
    it('does not contain text-blue-500', () => { expect(src).not.toContain('text-blue-500'); });
    it('does not contain bg-violet-500/20', () => { expect(src).not.toContain('bg-violet-500/20'); });
    it('does not contain bg-blue-500/20', () => { expect(src).not.toContain('bg-blue-500/20'); });
    it('does not contain space-y-2', () => { expect(src).not.toContain('space-y-2'); });
    it('does not contain space-y-3', () => { expect(src).not.toContain('space-y-3'); });
    it('does not contain w-6 h-6', () => { expect(src).not.toContain('w-6 h-6'); });
    it('does not contain w-4 h-4', () => { expect(src).not.toContain('w-4 h-4'); });
  });
});
