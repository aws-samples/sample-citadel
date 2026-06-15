/**
 * Utility functions for the IntegrationPicker component.
 *
 * Extracts the integration filtering logic into pure, testable functions
 * that can be validated independently of React component rendering.
 *
 * @module integration-picker-utils
 */

import { Integration } from '../services/integrationService';

/**
 * Filters a list of integrations by type.
 *
 * - When `filterTypes` is undefined, null, or an empty array, all integrations are returned.
 * - When `filterTypes` contains one or more type strings, only integrations whose
 *   `category` matches one of the filter types are returned.
 * - Filtering preserves the original order and does not mutate the input array.
 *
 * @param integrations - The full list of integrations to filter
 * @param filterTypes - Optional array of integration type/category strings to include
 * @returns Filtered array of integrations
 */
export function filterIntegrationsByType(
  integrations: Integration[],
  filterTypes?: string[] | null,
): Integration[] {
  if (!filterTypes || filterTypes.length === 0) {
    return integrations;
  }

  const filterSet = new Set(filterTypes);
  return integrations.filter((integration) => filterSet.has(integration.category));
}
