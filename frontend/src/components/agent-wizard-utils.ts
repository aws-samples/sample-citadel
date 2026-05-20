/**
 * Utility functions for the Create Agent Wizard.
 *
 * Extracts the auto-selection logic into pure, testable functions.
 */

import { ToolConfig } from '../services/toolConfigService';

/**
 * Computes the data store IDs and integration IDs that should be auto-selected
 * based on the bindings declared by the selected tools.
 *
 * @param selectedToolIds - The tool IDs currently selected in the wizard
 * @param allTools - All available tool configs (with binding metadata)
 * @returns Object with unique dataStoreIds and integrationIds arrays
 */
export function computeAutoSelectedResources(
  selectedToolIds: string[],
  allTools: ToolConfig[],
): { dataStoreIds: string[]; integrationIds: string[] } {
  const dataStoreIds = new Set<string>();
  const integrationIds = new Set<string>();

  for (const tool of allTools) {
    if (!selectedToolIds.includes(tool.toolId)) continue;

    if (tool.dataStoreBindings && Array.isArray(tool.dataStoreBindings)) {
      for (const binding of tool.dataStoreBindings) {
        dataStoreIds.add(binding.dataStoreId);
      }
    }

    if (tool.integrationBindings && Array.isArray(tool.integrationBindings)) {
      for (const binding of tool.integrationBindings) {
        integrationIds.add(binding.integrationId);
      }
    }
  }

  return {
    dataStoreIds: Array.from(dataStoreIds),
    integrationIds: Array.from(integrationIds),
  };
}
