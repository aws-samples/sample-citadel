/**
 * Chart style tokens resolved from CSS variables.
 * Values are read once at module load. Theme switches (light/dark)
 * require a component re-render to pick up updated variable values.
 */

export function cssVar(name: string): string {
  if (typeof document === 'undefined') return '';
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export const CHART_TOOLTIP_STYLE = {
  backgroundColor: cssVar('--popover') || cssVar('--card'),
  border: `1px solid ${cssVar('--border')}`,
  borderRadius: '8px',
  color: cssVar('--popover-foreground') || cssVar('--foreground'),
};
export const CHART_GRID_STROKE = cssVar('--border') || cssVar('--muted');
export const CHART_AXIS_STROKE = cssVar('--muted-foreground');
export const CHART_LEGEND_STYLE = { fontSize: '12px', paddingTop: '20px', color: cssVar('--muted-foreground') };
export const STATUS_COLORS = [cssVar('--chart-1'), cssVar('--chart-2'), cssVar('--chart-3'), cssVar('--chart-4')];
export const AGENT_COLORS = [cssVar('--chart-1'), cssVar('--chart-2'), cssVar('--chart-3'), cssVar('--chart-4'), cssVar('--chart-5')];
