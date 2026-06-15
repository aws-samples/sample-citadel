// Unit tests for Dashboard dark theme (Task 4.2)
// Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.6
import * as fs from 'fs';
import * as path from 'path';

const dashboardPath = path.resolve(__dirname, '..', 'Dashboard.tsx');
const dashboardSource = fs.readFileSync(dashboardPath, 'utf-8');

// Chart rows extracted into separate modules for lazy loading
const chartRow2Path = path.resolve(__dirname, '..', 'dashboard', 'ChartRow2.tsx');
const chartRow2Source = fs.readFileSync(chartRow2Path, 'utf-8');
const chartRow3Path = path.resolve(__dirname, '..', 'dashboard', 'ChartRow3.tsx');
const chartRow3Source = fs.readFileSync(chartRow3Path, 'utf-8');
const chartRow4Path = path.resolve(__dirname, '..', 'dashboard', 'ChartRow4.tsx');
const chartRow4Source = fs.readFileSync(chartRow4Path, 'utf-8');
const chartDataPath = path.resolve(__dirname, '..', 'dashboard', 'chartStyles.ts');
const chartDataSource = fs.readFileSync(chartDataPath, 'utf-8');

// Combined source for tests that need to check across all dashboard files
const allDashboardSource = [dashboardSource, chartRow2Source, chartRow3Source, chartRow4Source, chartDataSource].join('\n');

describe('Dashboard dark theme', () => {
  // Requirement 4.3 — Tooltip must NOT use light-mode colors
  describe('Tooltip contentStyle uses dark theme (Req 4.3)', () => {
    it('does not contain light-mode tooltip background #ffffff', () => {
      // CHART_TOOLTIP_STYLE is now defined in chartStyles.ts using CSS variables
      expect(chartDataSource).not.toContain('#ffffff');
    });

    it('does not contain light-mode tooltip border #d5dbdb', () => {
      expect(chartDataSource).not.toContain('#d5dbdb');
    });

    it('does not contain light-mode tooltip text color #232f3e', () => {
      expect(chartDataSource).not.toContain('#232f3e');
    });
  });

  // Requirement 4.3 — All Tooltip components use the shared constant
  describe('All Tooltip components use CHART_TOOLTIP_STYLE (Req 4.3)', () => {
    it('every <Tooltip contentStyle=... uses CHART_TOOLTIP_STYLE', () => {
      // Find all Tooltip contentStyle assignments
      const tooltipContentStyles = allDashboardSource.match(
        /<Tooltip[\s\S]*?contentStyle=\{([^}]+)\}/g,
      );
      expect(tooltipContentStyles).not.toBeNull();
      expect(tooltipContentStyles!.length).toBeGreaterThan(0);

      for (const match of tooltipContentStyles!) {
        expect(match).toContain('CHART_TOOLTIP_STYLE');
      }
    });
  });

  // Requirement 4.4 — Grid lines use dark theme stroke
  describe('CartesianGrid and PolarGrid use CHART_GRID_STROKE (Req 4.4)', () => {
    it('all CartesianGrid components use CHART_GRID_STROKE', () => {
      const cartesianGrids = allDashboardSource.match(
        /<CartesianGrid[^>]*stroke=\{([^}]+)\}[^>]*\/?>/g,
      );
      expect(cartesianGrids).not.toBeNull();
      for (const match of cartesianGrids!) {
        expect(match).toContain('CHART_GRID_STROKE');
      }
    });

    it('PolarGrid uses CHART_GRID_STROKE', () => {
      const polarGrids = allDashboardSource.match(
        /<PolarGrid[^>]*stroke=\{([^}]+)\}[^>]*\/?>/g,
      );
      expect(polarGrids).not.toBeNull();
      for (const match of polarGrids!) {
        expect(match).toContain('CHART_GRID_STROKE');
      }
    });
  });

  // Requirement 4.4 — Axis labels use dark theme stroke
  describe('XAxis/YAxis use CHART_AXIS_STROKE (Req 4.4)', () => {
    it('all XAxis components use CHART_AXIS_STROKE', () => {
      const xAxes = allDashboardSource.match(
        /<XAxis[^>]*stroke=\{([^}]+)\}[^>]*>/g,
      );
      expect(xAxes).not.toBeNull();
      for (const match of xAxes!) {
        expect(match).toContain('CHART_AXIS_STROKE');
      }
    });

    it('all YAxis components use CHART_AXIS_STROKE', () => {
      const yAxes = allDashboardSource.match(
        /<YAxis[^>]*stroke=\{([^}]+)\}[^>]*>/g,
      );
      expect(yAxes).not.toBeNull();
      for (const match of yAxes!) {
        expect(match).toContain('CHART_AXIS_STROKE');
      }
    });
  });

  // Requirement 4.1 — Quick Actions buttons use dark surface token
  describe('Quick Actions buttons use bg-accent (Req 4.1)', () => {
    it('Quick Actions section does not use bg-white', () => {
      const qabIdx = allDashboardSource.indexOf('function QuickActionButton');
      expect(qabIdx).toBeGreaterThan(-1);
      const qabSection = allDashboardSource.slice(qabIdx, qabIdx + 500);
      expect(qabSection).not.toContain('bg-white');
    });

    it('Quick Actions buttons use bg-accent', () => {
      const qabIdx = allDashboardSource.indexOf('function QuickActionButton');
      expect(qabIdx).toBeGreaterThan(-1);
      const qabSection = allDashboardSource.slice(qabIdx, qabIdx + 500);
      expect(qabSection).toContain('bg-accent');
    });
  });

  // Requirement 4.6 — Monthly Cost Trend metric boxes use surface tokens
  describe('Monthly Cost Trend metric boxes use bg-accent (Req 4.6)', () => {
    it('metric boxes do not use hardcoded oklch values', () => {
      const costMetricsIdx = allDashboardSource.indexOf('Monthly Cost Metrics');
      if (costMetricsIdx === -1) {
        const currentMonthIdx = allDashboardSource.indexOf('Current Month');
        expect(currentMonthIdx).toBeGreaterThan(-1);
        const metricSection = allDashboardSource.slice(
          Math.max(0, currentMonthIdx - 500),
          currentMonthIdx + 500,
        );
        expect(metricSection).not.toMatch(/oklch\s*\(\s*0\.27/);
      } else {
        const metricSection = allDashboardSource.slice(costMetricsIdx, costMetricsIdx + 1000);
        expect(metricSection).not.toMatch(/oklch\s*\(\s*0\.27/);
      }
    });

    it('metric boxes use bg-accent', () => {
      const currentMonthIdx = allDashboardSource.indexOf('Current Month');
      expect(currentMonthIdx).toBeGreaterThan(-1);
      const metricSection = allDashboardSource.slice(
        Math.max(0, currentMonthIdx - 500),
        currentMonthIdx + 500,
      );
      expect(metricSection).toContain('bg-accent');
    });
  });

  // Requirement 4.3 — CHART_TOOLTIP_STYLE uses CSS variables (theme-aware, not hardcoded)
  describe('CHART_TOOLTIP_STYLE uses CSS variables for theme colors (Req 4.3)', () => {
    it('uses cssVar() for backgroundColor (theme-aware, not hardcoded hex)', () => {
      // Search the full chartStyles source for the CHART_TOOLTIP_STYLE definition
      expect(chartDataSource).toContain('CHART_TOOLTIP_STYLE');
      expect(chartDataSource).toMatch(/backgroundColor:\s*cssVar\(/);
      // Should NOT have hardcoded hex for backgroundColor
      expect(chartDataSource).not.toMatch(/backgroundColor:\s*['"]#/);
    });

    it('uses cssVar() for text color (theme-aware, not hardcoded hex)', () => {
      // color property should use cssVar()
      expect(chartDataSource).toMatch(/color:\s*cssVar\(/);
    });
  });
});
