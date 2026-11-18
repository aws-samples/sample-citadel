/**
 * PhaseProgressBar — phase bars derive from currentPhase order.
 *
 * Phases before the current one render complete (green, no pulse)
 * regardless of stored pct; the current phase pulses; later phases
 * show pending. This fixes the defect where Assessment (stored 93,
 * written by the LLM from completion_pct) pulsed orange during Build.
 *
 * Extracted from the inline JSX in ProjectWorkspace.tsx into a testable
 * component: PhaseProgressBar.
 */

import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { PhaseProgressBar, type PhaseProgressBarProps } from '../PhaseProgressBar';

function renderBar(currentPhase: string, pcts: Record<string, number> = {}) {
  const progress: PhaseProgressBarProps['progress'] = {
    overall: 0,
    assessment: pcts.assessment ?? 0,
    design: pcts.design ?? 0,
    planning: pcts.planning ?? 0,
    implementation: pcts.implementation ?? 0,
    currentPhase,
  };
  return render(<PhaseProgressBar progress={progress} />);
}

describe('PhaseProgressBar', () => {
  const PHASES = ['assessment', 'design', 'planning', 'implementation'] as const;

  describe('earlier phases render complete regardless of stored pct', () => {
    it('assessment at 93 renders complete (green, no pulse) when currentPhase indicates design or later', () => {
      renderBar('DESIGN_IN_PROGRESS', { assessment: 93, design: 50 });

      const assessmentLabel = screen.getByTestId('phase-label-assessment');
      // Should be styled as complete (text-chart-2, no animate-pulse)
      expect(assessmentLabel.className).toContain('text-chart-2');
      expect(assessmentLabel.className).not.toContain('animate-pulse');
    });

    it('assessment and design render complete when currentPhase is planning', () => {
      renderBar('PLANNING_IN_PROGRESS', { assessment: 80, design: 90, planning: 30 });

      expect(screen.getByTestId('phase-label-assessment').className).toContain('text-chart-2');
      expect(screen.getByTestId('phase-label-design').className).toContain('text-chart-2');
      expect(screen.getByTestId('phase-label-assessment').className).not.toContain('animate-pulse');
      expect(screen.getByTestId('phase-label-design').className).not.toContain('animate-pulse');
    });
  });

  describe('current phase pulses', () => {
    it('design pulses when currentPhase is DESIGN_IN_PROGRESS', () => {
      renderBar('DESIGN_IN_PROGRESS', { assessment: 93, design: 50 });

      const designLabel = screen.getByTestId('phase-label-design');
      expect(designLabel.className).toContain('animate-pulse');
      expect(designLabel.className).toContain('text-primary');
    });

    it('implementation pulses when currentPhase is IMPLEMENTATION_IN_PROGRESS', () => {
      renderBar('IMPLEMENTATION_IN_PROGRESS', { assessment: 93, design: 100, planning: 100, implementation: 42 });

      const implLabel = screen.getByTestId('phase-label-implementation');
      expect(implLabel.className).toContain('animate-pulse');
    });
  });

  describe('later phases render pending', () => {
    it('planning and implementation are pending when currentPhase is design', () => {
      renderBar('DESIGN_IN_PROGRESS', { assessment: 100, design: 50 });

      const planningLabel = screen.getByTestId('phase-label-planning');
      const implLabel = screen.getByTestId('phase-label-implementation');

      expect(planningLabel.className).toContain('text-muted-foreground');
      expect(planningLabel.className).not.toContain('animate-pulse');
      expect(planningLabel.className).not.toContain('text-chart-2');

      expect(implLabel.className).toContain('text-muted-foreground');
    });
  });

  describe('complete phase progress bars show full width', () => {
    it('earlier phase bar is at 100% width even if stored pct is 93', () => {
      renderBar('IMPLEMENTATION_IN_PROGRESS', { assessment: 93, design: 100, planning: 100, implementation: 42 });

      const assessmentBar = screen.getByTestId('phase-bar-fill-assessment');
      expect(assessmentBar.style.width).toBe('100%');
    });
  });

  describe('CREATED phase (no work started)', () => {
    it('all phases render pending when currentPhase is CREATED', () => {
      renderBar('CREATED', {});

      for (const phase of PHASES) {
        const label = screen.getByTestId(`phase-label-${phase}`);
        expect(label.className).toContain('text-muted-foreground');
        expect(label.className).not.toContain('animate-pulse');
      }
    });
  });

  describe('_COMPLETE suffixed currentPhase', () => {
    it('ASSESSMENT_COMPLETE: assessment is green, design is pending', () => {
      renderBar('ASSESSMENT_COMPLETE', { assessment: 100 });

      expect(screen.getByTestId('phase-label-assessment').className).toContain('text-chart-2');
      expect(screen.getByTestId('phase-label-design').className).toContain('text-muted-foreground');
    });
  });
});
