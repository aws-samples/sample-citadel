import type { Project } from '../services';

export type FilterTab = 'All' | 'Active' | 'Completed';

export const FILTER_TABS: FilterTab[] = ['All', 'Active', 'Completed'];

export function filterProjects(projects: Project[], filter: FilterTab): Project[] {
  if (filter === 'All') return projects;
  return projects.filter(p => {
    if (filter === 'Active') return p.status !== 'COMPLETED';
    if (filter === 'Completed') return p.status === 'COMPLETED';
    return true;
  });
}

export function getFilterCounts(projects: Project[]): Record<FilterTab, number> {
  return {
    All: projects.length,
    Active: projects.filter(p => p.status !== 'COMPLETED').length,
    Completed: projects.filter(p => p.status === 'COMPLETED').length,
  };
}
