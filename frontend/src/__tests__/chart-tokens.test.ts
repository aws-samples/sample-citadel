import * as fs from 'fs';
import * as path from 'path';

const root = path.resolve(__dirname, '..');

function readFile(rel: string): string {
  return fs.readFileSync(path.join(root, rel), 'utf-8');
}

describe('Task 6 – Chart CSS variable tokens', () => {
  const chartStyles = readFile('pages/dashboard/chartStyles.ts');
  const customCss = readFile('styles/custom.css');

  describe('6.1 chartStyles.ts', () => {
    it('defines a cssVar helper function', () => {
      expect(chartStyles).toMatch(/function cssVar|const cssVar\s*=/);
    });

    it('does NOT contain any hex color literals', () => {
      // Strip comments before checking
      const noComments = chartStyles.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');
      expect(noComments).not.toMatch(/#[0-9a-fA-F]{6}\b/);
      expect(noComments).not.toMatch(/#[0-9a-fA-F]{3}\b/);
    });

    it('references --chart-1 through --chart-5', () => {
      expect(chartStyles).toContain("'--chart-1'");
      expect(chartStyles).toContain("'--chart-2'");
      expect(chartStyles).toContain("'--chart-3'");
      expect(chartStyles).toContain("'--chart-4'");
      expect(chartStyles).toContain("'--chart-5'");
    });

    it('has typeof document guard for SSR/jsdom safety', () => {
      expect(chartStyles).toMatch(/typeof document\s*===?\s*['"]undefined['"]/);
    });
  });

  describe('6.1 custom.css chart tokens', () => {
    it('defines --chart-1 through --chart-5', () => {
      expect(customCss).toMatch(/--chart-1:/);
      expect(customCss).toMatch(/--chart-2:/);
      expect(customCss).toMatch(/--chart-3:/);
      expect(customCss).toMatch(/--chart-4:/);
      expect(customCss).toMatch(/--chart-5:/);
    });
  });

  describe('6.2 ChartRow files use ChartContainer primitives', () => {
    const chartRows = ['ChartRow2.tsx', 'ChartRow3.tsx', 'ChartRow4.tsx'].map(f => ({
      name: f,
      content: readFile(`pages/dashboard/${f}`),
    }));

    for (const { name, content } of chartRows) {
      describe(name, () => {
        // ChartRow4 doesn't use recharts charts, so only check ChartContainer import for Row2/Row3
        if (name !== 'ChartRow4.tsx') {
          it('imports ChartContainer', () => {
            expect(content).toMatch(/import\s+.*ChartContainer.*from\s+['"].*chart['"]/);
          });

          it('has a ChartConfig definition or import', () => {
            expect(content).toMatch(/ChartConfig|chartConfig/);
          });
        }

        it('does NOT use contentStyle={CHART_TOOLTIP_STYLE}', () => {
          expect(content).not.toMatch(/contentStyle=\{CHART_TOOLTIP_STYLE\}/);
        });

        it('does NOT contain inline hex colors in style objects', () => {
          // Check for hex colors in style={{ backgroundColor: '#...' }} or fill: '#...'
          const styleBlocks = content.match(/style=\{\{[^}]*\}\}/g) || [];
          for (const block of styleBlocks) {
            expect(block).not.toMatch(/(?:backgroundColor|fill)\s*:\s*['"]#[0-9a-fA-F]{3,6}['"]/);
          }
        });
      });
    }
  });
});
