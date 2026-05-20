import type { Project } from '../services';

/**
 * Extracts the most recent updatedAt timestamp from a list of projects.
 * Used for efficient change detection instead of JSON.stringify comparison.
 *
 * TODO: This utility becomes unnecessary once GraphQL subscriptions
 * (onCreateProject/onUpdateProject/onDeleteProject) are available.
 */
export function getLatestUpdatedAt(projects: Project[]): string {
  if (projects.length === 0) return '';
  return projects.reduce((latest, project) => {
    return project.updatedAt > latest ? project.updatedAt : latest;
  }, '');
}
