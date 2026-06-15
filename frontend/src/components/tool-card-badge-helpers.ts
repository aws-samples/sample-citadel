import { ToolConfig, BindingDirection } from '../services/toolConfigService';

export interface BindingBadge {
  type: 'integration' | 'dataStore';
  label: string;
  direction: BindingDirection;
}

function directionArrow(direction?: BindingDirection): string {
  switch (direction) {
    case 'INPUT':
      return '←';
    case 'OUTPUT':
      return '→';
    case 'BIDIRECTIONAL':
    default:
      return '↔';
  }
}

export function extractBindingBadges(tool: ToolConfig): BindingBadge[] {
  const badges: BindingBadge[] = [];

  if (tool.integrationBindings && Array.isArray(tool.integrationBindings)) {
    for (const binding of tool.integrationBindings) {
      const dir = binding.direction || 'BIDIRECTIONAL';
      badges.push({
        type: 'integration',
        label: `${directionArrow(dir)} ${binding.integrationType}`,
        direction: dir,
      });
    }
  }

  if (tool.dataStoreBindings && Array.isArray(tool.dataStoreBindings)) {
    for (const binding of tool.dataStoreBindings) {
      const dir = binding.direction || 'BIDIRECTIONAL';
      badges.push({
        type: 'dataStore',
        label: `${directionArrow(dir)} ${binding.dataStoreType}`,
        direction: dir,
      });
    }
  }

  return badges;
}
