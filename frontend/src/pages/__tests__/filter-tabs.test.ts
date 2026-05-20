// Feature: ui-ux-remediation, Property 12: Filter produces correct subset with accurate counts
// Feature: ui-ux-remediation, Property 13: Filter round-trip restores original list
import * as fc from 'fast-check';
import { filterProjects, getFilterCounts, type FilterTab } from '../intakeFilters';
import type { Project } from '../../services/projectService';

/** Arbitrary for a valid Project status */
const projectStatusArb = fc.constantFrom(
  'CREATED' as const,
  'IN_PROGRESS' as const,
  'ASSESSMENT_COMPLETE' as const,
  'DESIGN_COMPLETE' as const,
  'PLANNING_COMPLETE' as const,
  'IMPLEMENTATION_READY' as const,
  'COMPLETED' as const,
  'ERROR' as const,
);

/** Arbitrary for a minimal Project object */
const projectArb: fc.Arbitrary<Project> = fc.record({
  id: fc.uuid(),
  name: fc.string({ minLength: 1, maxLength: 50 }),
  description: fc.string({ maxLength: 100 }),
  status: projectStatusArb,
  createdAt: fc.constant('2024-01-01T00:00:00Z'),
  updatedAt: fc.constant('2024-01-01T00:00:00Z'),
});

/** Arbitrary for a list of projects */
const projectListArb = fc.array(projectArb, { minLength: 0, maxLength: 20 });

/** Arbitrary for a FilterTab value */
const filterTabArb: fc.Arbitrary<FilterTab> = fc.constantFrom('All', 'Active', 'Completed');

/**
 * Property 12: Filter produces correct subset with accurate counts
 *
 * For any list of projects and any filter tab value (All, Active, Completed),
 * applying the filter SHALL return exactly the projects matching that status,
 * and the displayed count for each tab SHALL equal the actual number of projects
 * matching that filter.
 *
 * **Validates: Requirements 12.2, 12.3**
 */
describe('Property 12: Filter produces correct subset with accurate counts', () => {
  it('filterProjects returns correct subset for any filter', () => {
    fc.assert(
      fc.property(projectListArb, filterTabArb, (projects, filter) => {
        const result = filterProjects(projects, filter);

        if (filter === 'All') {
          if (result.length !== projects.length) {
            throw new Error(`All filter should return all ${projects.length} projects, got ${result.length}`);
          }
          return true;
        }

        for (const p of result) {
          if (filter === 'Active' && p.status === 'COMPLETED') {
            throw new Error(`Active filter returned COMPLETED project: ${p.id}`);
          }
          if (filter === 'Completed' && p.status !== 'COMPLETED') {
            throw new Error(`Completed filter returned non-COMPLETED project: ${p.id} (status=${p.status})`);
          }
        }

        // Verify no matching projects were excluded
        const expected = projects.filter(p => {
          if (filter === 'Active') return p.status !== 'COMPLETED';
          if (filter === 'Completed') return p.status === 'COMPLETED';
          return true;
        });
        if (result.length !== expected.length) {
          throw new Error(`Filter '${filter}' returned ${result.length} projects, expected ${expected.length}`);
        }

        return true;
      }),
      { numRuns: 100 },
    );
  });

  it('getFilterCounts matches actual filtered lengths', () => {
    fc.assert(
      fc.property(projectListArb, (projects) => {
        const counts = getFilterCounts(projects);

        const allCount = filterProjects(projects, 'All').length;
        const activeCount = filterProjects(projects, 'Active').length;
        const completedCount = filterProjects(projects, 'Completed').length;

        if (counts.All !== allCount) {
          throw new Error(`All count ${counts.All} !== filtered length ${allCount}`);
        }
        if (counts.Active !== activeCount) {
          throw new Error(`Active count ${counts.Active} !== filtered length ${activeCount}`);
        }
        if (counts.Completed !== completedCount) {
          throw new Error(`Completed count ${counts.Completed} !== filtered length ${completedCount}`);
        }

        return true;
      }),
      { numRuns: 100 },
    );
  });

  it('Active + Completed counts equal All count', () => {
    fc.assert(
      fc.property(projectListArb, (projects) => {
        const counts = getFilterCounts(projects);
        if (counts.Active + counts.Completed !== counts.All) {
          throw new Error(
            `Active(${counts.Active}) + Completed(${counts.Completed}) !== All(${counts.All})`,
          );
        }
        return true;
      }),
      { numRuns: 100 },
    );
  });
});

/**
 * Property 13: Filter round-trip restores original list
 *
 * For any list of projects and any filter tab, applying that filter and then
 * applying the All filter SHALL produce a list identical to the original
 * unfiltered list.
 *
 * **Validates: Requirements 12.8**
 */
describe('Property 13: Filter round-trip restores original list', () => {
  it('applying any filter then All restores original list', () => {
    fc.assert(
      fc.property(projectListArb, filterTabArb, (projects, filter) => {
        // Apply filter, then apply All to the ORIGINAL list (not the filtered one)
        // The round-trip property means: filter(All, originalList) === originalList
        // after having applied any filter first
        const filtered = filterProjects(projects, filter);
        const restored = filterProjects(projects, 'All');

        if (restored.length !== projects.length) {
          throw new Error(
            `Round-trip failed: original=${projects.length}, restored=${restored.length}`,
          );
        }

        for (let i = 0; i < projects.length; i++) {
          if (restored[i].id !== projects[i].id) {
            throw new Error(
              `Round-trip mismatch at index ${i}: expected ${projects[i].id}, got ${restored[i].id}`,
            );
          }
        }

        // Also verify that the filtered subset is a proper subset of the original
        for (const p of filtered) {
          if (!projects.some(orig => orig.id === p.id)) {
            throw new Error(`Filtered project ${p.id} not found in original list`);
          }
        }

        return true;
      }),
      { numRuns: 100 },
    );
  });
});


/**
 * Unit tests for filter tabs
 *
 * Validates: Requirements 12.1, 12.4, 12.5, 12.6, 12.7
 */
import * as fs from 'fs';
import * as path from 'path';

const intakeRequestsPath = path.resolve(__dirname, '..', 'IntakeRequests.tsx');
const intakeRequestsSource = fs.readFileSync(intakeRequestsPath, 'utf-8');
const intakeFiltersPath = path.resolve(__dirname, '..', 'intakeFilters.ts');
const intakeFiltersSource = fs.readFileSync(intakeFiltersPath, 'utf-8');

describe('Filter tabs unit tests', () => {
  // Requirement 12.1: Filter tabs are rendered with state
  it('renders All, Active, and Completed filter tabs via FILTER_TABS import', () => {
    expect(intakeRequestsSource).toContain('FILTER_TABS.map');
    expect(intakeRequestsSource).toContain('setActiveFilter(tab)');
  });

  it('imports FILTER_TABS and filter functions from intakeFilters', () => {
    expect(intakeRequestsSource).toMatch(/import.*FILTER_TABS.*from.*intakeFilters/);
    expect(intakeRequestsSource).toMatch(/import.*filterProjects.*from.*intakeFilters/);
    expect(intakeRequestsSource).toMatch(/import.*getFilterCounts.*from.*intakeFilters/);
  });

  it('intakeFilters defines FILTER_TABS with All, Active, Completed', () => {
    expect(intakeFiltersSource).toContain("'All'");
    expect(intakeFiltersSource).toContain("'Active'");
    expect(intakeFiltersSource).toContain("'Completed'");
    expect(intakeFiltersSource).toMatch(/FILTER_TABS.*FilterTab\[\].*=.*\[.*'All'.*'Active'.*'Completed'.*\]/s);
  });

  // Requirement 12.5: Default to All tab on mount
  it('defaults activeFilter to All on mount', () => {
    expect(intakeRequestsSource).toMatch(/useState<FilterTab>\s*\(\s*'All'\s*\)/);
  });

  // Requirement 12.4: Selected tab has visually distinct styling
  it('applies distinct styling to selected tab', () => {
    // Selected tab should have different classes than unselected
    expect(intakeRequestsSource).toContain('activeFilter === tab');
    expect(intakeRequestsSource).toMatch(/text-foreground.*font-semibold/);
    expect(intakeRequestsSource).toContain('text-muted-foreground hover:text-foreground');
  });

  // Requirement 12.6: Filter is client-side only (no API calls on tab click)
  it('uses useMemo for filtered projects (client-side filtering)', () => {
    expect(intakeRequestsSource).toContain('useMemo');
    expect(intakeRequestsSource).toMatch(/filterProjects\s*\(\s*projects\s*,\s*activeFilter\s*\)/);
  });

  // Requirement 12.3: Dynamic counts from actual project data
  it('displays dynamic counts from getFilterCounts', () => {
    expect(intakeRequestsSource).toContain('filterCounts[tab]');
    // No hardcoded count values
    expect(intakeRequestsSource).not.toMatch(/All\s*\(\s*\d+\s*\)/);
    expect(intakeRequestsSource).not.toMatch(/Active\s*\(\s*\d+\s*\)/);
    expect(intakeRequestsSource).not.toMatch(/Completed\s*\(\s*\d+\s*\)/);
  });

  // Requirement 12.7: Empty state when filter returns zero results
  it('shows empty state when filteredProjects is empty', () => {
    expect(intakeRequestsSource).toContain('filteredProjects.length === 0');
    expect(intakeRequestsSource).toMatch(/No.*requests match this filter/);
  });

  // Verify no hardcoded inline styles on filter buttons
  it('filter buttons have no inline styles', () => {
    // Extract the filter tabs section
    const filterTabsIdx = intakeRequestsSource.indexOf('Filter Tabs');
    expect(filterTabsIdx).toBeGreaterThan(-1);
    const filterSection = intakeRequestsSource.slice(filterTabsIdx, filterTabsIdx + 800);
    expect(filterSection).not.toContain('style={{');
  });

  // Verify tabs are wired to state with click handlers
  it('tabs have onClick handlers wired to setActiveFilter', () => {
    expect(intakeRequestsSource).toContain('onClick={() => setActiveFilter(tab)}');
  });

  // Verify filterProjects and getFilterCounts are exported (re-exported from intakeFilters)
  it('re-exports filterProjects and getFilterCounts for testing', () => {
    expect(intakeRequestsSource).toMatch(/export.*filterProjects.*from.*intakeFilters/);
    expect(intakeRequestsSource).toMatch(/export.*getFilterCounts.*from.*intakeFilters/);
  });

  // Verify filteredProjects is used in the rendering (not raw projects)
  it('renders filteredProjects in the project list, not raw projects', () => {
    expect(intakeRequestsSource).toContain('filteredProjects.map');
  });
});

describe('filterProjects pure function', () => {
  const mockProjects: Project[] = [
    { id: '1', name: 'P1', description: '', status: 'IN_PROGRESS', createdAt: '', updatedAt: '' },
    { id: '2', name: 'P2', description: '', status: 'COMPLETED', createdAt: '', updatedAt: '' },
    { id: '3', name: 'P3', description: '', status: 'CREATED', createdAt: '', updatedAt: '' },
    { id: '4', name: 'P4', description: '', status: 'COMPLETED', createdAt: '', updatedAt: '' },
  ];

  it('All returns all projects', () => {
    expect(filterProjects(mockProjects, 'All')).toHaveLength(4);
  });

  it('Active returns non-COMPLETED projects', () => {
    const result = filterProjects(mockProjects, 'Active');
    expect(result).toHaveLength(2);
    expect(result.every(p => p.status !== 'COMPLETED')).toBe(true);
  });

  it('Completed returns only COMPLETED projects', () => {
    const result = filterProjects(mockProjects, 'Completed');
    expect(result).toHaveLength(2);
    expect(result.every(p => p.status === 'COMPLETED')).toBe(true);
  });

  it('returns empty array for empty input', () => {
    expect(filterProjects([], 'All')).toHaveLength(0);
    expect(filterProjects([], 'Active')).toHaveLength(0);
    expect(filterProjects([], 'Completed')).toHaveLength(0);
  });
});

describe('getFilterCounts pure function', () => {
  it('returns correct counts', () => {
    const projects: Project[] = [
      { id: '1', name: 'P1', description: '', status: 'IN_PROGRESS', createdAt: '', updatedAt: '' },
      { id: '2', name: 'P2', description: '', status: 'COMPLETED', createdAt: '', updatedAt: '' },
      { id: '3', name: 'P3', description: '', status: 'CREATED', createdAt: '', updatedAt: '' },
    ];
    const counts = getFilterCounts(projects);
    expect(counts.All).toBe(3);
    expect(counts.Active).toBe(2);
    expect(counts.Completed).toBe(1);
  });

  it('returns all zeros for empty list', () => {
    const counts = getFilterCounts([]);
    expect(counts.All).toBe(0);
    expect(counts.Active).toBe(0);
    expect(counts.Completed).toBe(0);
  });
});
