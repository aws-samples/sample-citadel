// Feature: ui-ux-remediation, Property 10: Disabled buttons for incomplete prerequisite phases
// Feature: ui-ux-remediation, Property 11: Disabled buttons prevent click handler execution
import * as fc from 'fast-check';
import { render, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { ProjectCard } from '../ProjectCard';
import type { Project } from '../../services';

/** Helper: create a Project with given progress values */
function makeProject(overrides: {
  assessment?: number;
  planning?: number;
  implementation?: number;
  overall?: number;
} = {}): Project {
  const assessment = overrides.assessment ?? 0;
  const planning = overrides.planning ?? 0;
  const implementation = overrides.implementation ?? 0;
  const overall = overrides.overall ?? ((assessment + planning + implementation) / 3);
  return {
    id: 'test-project-1',
    name: 'Test Project',
    description: 'A test project',
    status: 'IN_PROGRESS',
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    progress: {
      overall,
      assessment,
      planning,
      implementation,
      design: 0,
      currentPhase: 'Assessment',
    },
  };
}

/**
 * Helper: find the "Status & Details" button within a phase section.
 * Walks up from the h4 heading to the StatusCard container (the div rendered by StatusCard),
 * then finds the button inside it.
 */
function findPhaseButton(container: HTMLElement, phaseName: string): HTMLButtonElement {
  const headings = Array.from(container.querySelectorAll('h4'));
  const heading = headings.find(h => h.textContent === phaseName);
  if (!heading) throw new Error(`${phaseName} heading not found`);

  // The StatusCard is the ancestor div that contains both the heading and the button.
  // Walk up until we find a container that has a button with "Status & Details" text.
  let el: HTMLElement | null = heading;
  while (el && el !== container) {
    const btn = el.querySelector('button');
    if (btn && btn.textContent?.trim() === 'Status & Details') {
      return btn as HTMLButtonElement;
    }
    el = el.parentElement;
  }
  throw new Error(`${phaseName} "Status & Details" button not found`);
}

/**
 * Helper: find the StatusCard container for a phase (the element with opacity-60 class).
 */
function findPhaseContainer(container: HTMLElement, phaseName: string): HTMLElement {
  const headings = Array.from(container.querySelectorAll('h4'));
  const heading = headings.find(h => h.textContent === phaseName);
  if (!heading) throw new Error(`${phaseName} heading not found`);

  // Walk up to find the StatusCard div — it's the one with the phase-specific classes
  let el: HTMLElement | null = heading;
  while (el && el !== container) {
    // StatusCard containers have bg-card and w-1/3 classes
    if (el.className && el.className.includes('w-1/3')) {
      return el;
    }
    el = el.parentElement;
  }
  throw new Error(`${phaseName} container not found`);
}

/** Arbitrary for progress 0..99 (incomplete) */
const incompleteProgress = fc.integer({ min: 0, max: 99 });

/** Arbitrary for progress 0..100 */
const anyProgress = fc.integer({ min: 0, max: 100 });

const noop = () => {};

/**
 * Property 10: Disabled buttons for incomplete prerequisite phases
 *
 * For any Project where progress.assessment < 100, the Plan button SHALL have
 * `disabled` and `aria-disabled="true"`. For any Project where progress.planning < 100,
 * the Implement button SHALL have `disabled` and `aria-disabled="true"`.
 *
 * Validates: Requirements 10.1, 10.2, 10.4
 */
describe('Property 10: Disabled buttons for incomplete prerequisite phases', () => {
  it('Plan button is disabled with aria-disabled when assessment < 100', () => {
    fc.assert(
      fc.property(
        incompleteProgress,
        anyProgress,
        anyProgress,
        (assessment, planning, implementation) => {
          const project = makeProject({ assessment, planning, implementation });
          const { container, unmount } = render(
            <ProjectCard
              project={project}
              onSelectAssess={noop}
              onSelectPlan={noop}
              onSelectImplement={noop}
            />,
          );

          const planButton = findPhaseButton(container, 'Plan');

          if (!planButton.hasAttribute('disabled')) {
            throw new Error(`Plan button should be disabled when assessment=${assessment}`);
          }
          if (planButton.getAttribute('aria-disabled') !== 'true') {
            throw new Error(`Plan button should have aria-disabled="true" when assessment=${assessment}`);
          }

          unmount();
          return true;
        },
      ),
      { numRuns: 100 },
    );
  });

  it('Implement button is disabled with aria-disabled when planning < 100', () => {
    fc.assert(
      fc.property(
        anyProgress,
        incompleteProgress,
        anyProgress,
        (assessment, planning, implementation) => {
          const project = makeProject({ assessment, planning, implementation });
          const { container, unmount } = render(
            <ProjectCard
              project={project}
              onSelectAssess={noop}
              onSelectPlan={noop}
              onSelectImplement={noop}
            />,
          );

          const implButton = findPhaseButton(container, 'Implement');

          if (!implButton.hasAttribute('disabled')) {
            throw new Error(`Implement button should be disabled when planning=${planning}`);
          }
          if (implButton.getAttribute('aria-disabled') !== 'true') {
            throw new Error(`Implement button should have aria-disabled="true" when planning=${planning}`);
          }

          unmount();
          return true;
        },
      ),
      { numRuns: 100 },
    );
  });
});

/**
 * Property 11: Disabled buttons prevent click handler execution
 *
 * For any disabled stage button in ProjectCard, simulating a click event
 * SHALL NOT invoke the corresponding onSelectPlan or onSelectImplement callback.
 *
 * Validates: Requirements 10.3
 */
describe('Property 11: Disabled buttons prevent click handler execution', () => {
  it('clicking disabled Plan button does not invoke onSelectPlan', () => {
    fc.assert(
      fc.property(
        incompleteProgress,
        anyProgress,
        anyProgress,
        (assessment, planning, implementation) => {
          let planCalled = false;
          const onSelectPlan = () => { planCalled = true; };

          const project = makeProject({ assessment, planning, implementation });
          const { container, unmount } = render(
            <ProjectCard
              project={project}
              onSelectAssess={noop}
              onSelectPlan={onSelectPlan}
              onSelectImplement={noop}
            />,
          );

          const planButton = findPhaseButton(container, 'Plan');
          fireEvent.click(planButton);

          if (planCalled) {
            throw new Error(`onSelectPlan was called on disabled Plan button (assessment=${assessment})`);
          }

          unmount();
          return true;
        },
      ),
      { numRuns: 100 },
    );
  });

  it('clicking disabled Implement button does not invoke onSelectImplement', () => {
    fc.assert(
      fc.property(
        anyProgress,
        incompleteProgress,
        anyProgress,
        (assessment, planning, implementation) => {
          let implCalled = false;
          const onSelectImplement = () => { implCalled = true; };

          const project = makeProject({ assessment, planning, implementation });
          const { container, unmount } = render(
            <ProjectCard
              project={project}
              onSelectAssess={noop}
              onSelectPlan={noop}
              onSelectImplement={onSelectImplement}
            />,
          );

          const implButton = findPhaseButton(container, 'Implement');
          fireEvent.click(implButton);

          if (implCalled) {
            throw new Error(`onSelectImplement was called on disabled Implement button (planning=${planning})`);
          }

          unmount();
          return true;
        },
      ),
      { numRuns: 100 },
    );
  });
});

/**
 * Unit tests for ProjectCard fixes
 *
 * Validates: Requirements 10.5, 10.6, 11.1, 11.2, 11.3
 */
describe('ProjectCard unit tests', () => {
  // Requirement 10.5: disabled buttons preserve opacity-60 and cursor-not-allowed
  it('disabled Plan button has cursor-not-allowed styling', () => {
    const project = makeProject({ assessment: 50, planning: 0, implementation: 0 });
    const { container } = render(
      <ProjectCard
        project={project}
        onSelectAssess={noop}
        onSelectPlan={noop}
        onSelectImplement={noop}
      />,
    );

    const planButton = findPhaseButton(container, 'Plan');
    expect(planButton.className).toMatch(/cursor-not-allowed/);
  });

  it('disabled Implement button has cursor-not-allowed styling', () => {
    const project = makeProject({ assessment: 100, planning: 50, implementation: 0 });
    const { container } = render(
      <ProjectCard
        project={project}
        onSelectAssess={noop}
        onSelectPlan={noop}
        onSelectImplement={noop}
      />,
    );

    const implButton = findPhaseButton(container, 'Implement');
    expect(implButton.className).toMatch(/cursor-not-allowed/);
  });

  it('Plan card has opacity-60 when assessment < 100', () => {
    const project = makeProject({ assessment: 50, planning: 0, implementation: 0 });
    const { container } = render(
      <ProjectCard
        project={project}
        onSelectAssess={noop}
        onSelectPlan={noop}
        onSelectImplement={noop}
      />,
    );

    const planContainer = findPhaseContainer(container, 'Plan');
    expect(planContainer.className).toMatch(/opacity-60/);
  });

  it('Implement card has opacity-60 when planning < 100', () => {
    const project = makeProject({ assessment: 100, planning: 50, implementation: 0 });
    const { container } = render(
      <ProjectCard
        project={project}
        onSelectAssess={noop}
        onSelectPlan={noop}
        onSelectImplement={noop}
      />,
    );

    const implContainer = findPhaseContainer(container, 'Implement');
    expect(implContainer.className).toMatch(/opacity-60/);
  });

  // Requirement 10.6: Continue button routes correctly
  it('Continue button calls onSelectAssess when assessment < 100', () => {
    const onSelectAssess = jest.fn();
    const project = makeProject({ assessment: 50, planning: 0, implementation: 0 });
    const { getByText } = render(
      <ProjectCard
        project={project}
        onSelectAssess={onSelectAssess}
        onSelectPlan={noop}
        onSelectImplement={noop}
      />,
    );

    fireEvent.click(getByText('Continue'));
    expect(onSelectAssess).toHaveBeenCalledWith(project);
  });

  it('Continue button calls onSelectPlan when assessment=100 and planning < 100', () => {
    const onSelectPlan = jest.fn();
    const project = makeProject({ assessment: 100, planning: 50, implementation: 0 });
    const { getByText } = render(
      <ProjectCard
        project={project}
        onSelectAssess={noop}
        onSelectPlan={onSelectPlan}
        onSelectImplement={noop}
      />,
    );

    fireEvent.click(getByText('Continue'));
    expect(onSelectPlan).toHaveBeenCalledWith(project);
  });

  it('Continue button calls onSelectImplement when assessment=100 and planning=100', () => {
    const onSelectImplement = jest.fn();
    const project = makeProject({ assessment: 100, planning: 100, implementation: 50 });
    const { getByText } = render(
      <ProjectCard
        project={project}
        onSelectAssess={noop}
        onSelectPlan={noop}
        onSelectImplement={onSelectImplement}
      />,
    );

    fireEvent.click(getByText('Continue'));
    expect(onSelectImplement).toHaveBeenCalledWith(project);
  });

  // Requirement 11.1: cursor-pointer on Card wrapper
  it('Card wrapper has cursor-pointer class', () => {
    const project = makeProject({ assessment: 50, planning: 0, implementation: 0 });
    const { container } = render(
      <ProjectCard
        project={project}
        onSelectAssess={noop}
        onSelectPlan={noop}
        onSelectImplement={noop}
      />,
    );

    const card = container.querySelector('[data-slot="card"]');
    expect(card).toBeInTheDocument();
    expect(card!.className).toMatch(/cursor-pointer/);
  });

  // Requirement 11.3: hover:border-primary preserved
  it('Card wrapper has hover:border-primary class', () => {
    const project = makeProject({ assessment: 50, planning: 0, implementation: 0 });
    const { container } = render(
      <ProjectCard
        project={project}
        onSelectAssess={noop}
        onSelectPlan={noop}
        onSelectImplement={noop}
      />,
    );

    const card = container.querySelector('[data-slot="card"]');
    expect(card).toBeInTheDocument();
    expect(card!.className).toMatch(/hover:border-primary/);
  });

  // Requirement 11.2: no inline backgroundColor style on Card
  it('Card wrapper has no inline backgroundColor style', () => {
    const project = makeProject({ assessment: 50, planning: 0, implementation: 0 });
    const { container } = render(
      <ProjectCard
        project={project}
        onSelectAssess={noop}
        onSelectPlan={noop}
        onSelectImplement={noop}
      />,
    );

    const card = container.querySelector('[data-slot="card"]');
    expect(card).toBeInTheDocument();
    expect((card as HTMLElement).style.backgroundColor).toBe('');
  });
});
