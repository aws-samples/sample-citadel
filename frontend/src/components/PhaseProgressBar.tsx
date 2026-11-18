/**
 * PhaseProgressBar — phase bars derive from currentPhase order.
 *
 * Phases before the current one render complete (green, no pulse)
 * regardless of stored pct; the current phase pulses; later phases
 * render pending. This prevents the bug where Assessment (stored 93)
 * pulsed orange during Build.
 */

import type { ProjectProgress } from '../services/projectService';

const PHASES = [
  { key: 'assessment', label: 'Assessment' },
  { key: 'design', label: 'Design' },
  { key: 'planning', label: 'Planning' },
  { key: 'implementation', label: 'Build' },
] as const;

/**
 * Maps a currentPhase string (e.g. "DESIGN_IN_PROGRESS", "ASSESSMENT_COMPLETE")
 * to the index in PHASES of the phase it refers to.
 * Returns -1 for CREATED / unknown.
 */
function currentPhaseIndex(currentPhase: string): number {
  const upper = (currentPhase || '').toUpperCase();
  for (let i = 0; i < PHASES.length; i++) {
    if (upper.includes(PHASES[i].key.toUpperCase())) return i;
  }
  return -1;
}

function isComplete(currentPhase: string): boolean {
  return currentPhase.toUpperCase().includes('_COMPLETE');
}

export interface PhaseProgressBarProps {
  progress: ProjectProgress;
}

export function PhaseProgressBar({ progress }: PhaseProgressBarProps) {
  const cpIdx = currentPhaseIndex(progress.currentPhase);
  const cpIsComplete = isComplete(progress.currentPhase);

  return (
    <div className="flex gap-1">
      {PHASES.map(({ key, label }, idx) => {
        const storedPct = (progress as any)[key] ?? 0;

        // Derive visual state from phase ordering, not stored pct.
        let state: 'complete' | 'active' | 'pending';
        let displayPct: number;

        if (idx < cpIdx) {
          // Earlier phase: always complete.
          state = 'complete';
          displayPct = 100;
        } else if (idx === cpIdx) {
          if (cpIsComplete) {
            state = 'complete';
            displayPct = 100;
          } else {
            state = 'active';
            displayPct = Math.min(storedPct, 100);
          }
        } else {
          // Later phase: pending.
          state = 'pending';
          displayPct = 0;
        }

        const labelClass =
          state === 'complete'
            ? 'text-chart-2'
            : state === 'active'
              ? 'text-primary animate-pulse font-medium'
              : 'text-muted-foreground';

        const barClass =
          state === 'complete'
            ? 'bg-chart-2'
            : state === 'active'
              ? 'bg-primary'
              : 'bg-accent';

        return (
          <div key={key} className="flex-1" title={`${label}: ${Math.round(displayPct)}%`}>
            <div
              data-testid={`phase-label-${key}`}
              className={`text-[10px] mb-0.5 text-center ${labelClass}`}
            >
              {label}
            </div>
            <div className="h-1.5 rounded-full bg-accent overflow-hidden">
              <div
                data-testid={`phase-bar-fill-${key}`}
                className={`h-full rounded-full transition-all duration-500 ${barClass}`}
                style={{ width: `${Math.min(displayPct, 100)}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
