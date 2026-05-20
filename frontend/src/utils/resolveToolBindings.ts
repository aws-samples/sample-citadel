import type { AgentConfig } from '../services/agentConfigService';
import type { ToolBindingSummary } from '../types/workflow';
import { toolConfigService } from '../services/toolConfigService';
import type { BindingDirection } from '../services/toolConfigService';

function mapDirection(dir?: BindingDirection): 'input' | 'output' | 'bidirectional' {
  if (dir === 'INPUT') return 'input';
  if (dir === 'OUTPUT') return 'output';
  if (dir === 'BIDIRECTIONAL') return 'bidirectional';
  return 'bidirectional';
}

export async function resolveToolBindings(
  agentConfig: AgentConfig,
): Promise<ToolBindingSummary[]> {
  try {
    const toolIds: string[] = agentConfig.config?.tools ?? [];
    if (toolIds.length === 0) return [];

    const allToolConfigs = await toolConfigService.listToolConfigs();
    const toolIdSet = new Set(toolIds);
    const matchingConfigs = allToolConfigs.filter((tc) => toolIdSet.has(tc.toolId));

    const summaries: ToolBindingSummary[] = [];

    for (const toolConfig of matchingConfigs) {
      const toolName = toolConfig.config?.name ?? toolConfig.toolId;

      for (const binding of toolConfig.integrationBindings ?? []) {
        summaries.push({
          toolId: toolConfig.toolId,
          toolName,
          resourceName: binding.integrationId,
          resourceType: 'integration',
          direction: mapDirection(binding.direction),
        });
      }

      for (const binding of toolConfig.dataStoreBindings ?? []) {
        summaries.push({
          toolId: toolConfig.toolId,
          toolName,
          resourceName: binding.dataStoreId,
          resourceType: 'datastore',
          direction: mapDirection(binding.direction),
        });
      }
    }

    return summaries;
  } catch (error) {
    console.warn('Failed to resolve tool bindings:', error);
    return [];
  }
}
