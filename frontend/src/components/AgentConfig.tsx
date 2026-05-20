import React from 'react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { AgentConfig as AgentConfigType } from '../services/agentConfigService';

interface AgentConfigProps {
  agent: AgentConfigType | null;
  isCreating: boolean;
  isEditing: boolean;
  formData: {
    agentId: string;
    config: any;
  };
  onFormDataChange: (data: { agentId: string; config: any }) => void;
  onStartEdit: () => void;
  onSave: () => void;
  onCancel: () => void;
  isFabricator?: boolean;
}

export const AgentConfigTab: React.FC<AgentConfigProps> = ({
  agent,
  isCreating,
  isEditing,
  formData,
  onFormDataChange,
  onStartEdit,
  onSave,
  onCancel,
  isFabricator = false,
}) => {
  const updateConfigField = (path: string[], value: any) => {
    const newConfig = JSON.parse(JSON.stringify(formData.config));
    let current = newConfig;
    
    for (let i = 0; i < path.length - 1; i++) {
      if (!current[path[i]]) {
        current[path[i]] = {};
      }
      current = current[path[i]];
    }
    
    current[path[path.length - 1]] = value;
    onFormDataChange({ ...formData, config: newConfig });
  };

  const renderConfigField = (key: string, value: any, path: string[] = []): JSX.Element | null => {
    const currentPath = [...path, key];
    const fieldId = currentPath.join('.');

    // Skip if value is undefined or null
    if (value === undefined || value === null) {
      return null;
    }

    const valueType = typeof value;
    const isArray = Array.isArray(value);
    const isObject = valueType === 'object' && !isArray;

    // Handle nested objects (but not arrays)
    if (isObject) {
      const entries = Object.entries(value);
      if (entries.length === 0) {
        // Empty object - show as JSON input
        return (
          <div key={fieldId} className="config-field-group">
            <label className="config-field-label">{key}</label>
            <Input
              type="text"
              value={JSON.stringify(value)}
              onChange={(e) => {
                try {
                  const parsed = JSON.parse(e.target.value);
                  updateConfigField(currentPath, parsed);
                } catch {
                  // Invalid JSON, ignore
                }
              }}
              disabled={!isEditing && !isCreating}
              className="bg-accent border-border text-foreground font-mono text-sm"
              placeholder="{}"
            />
          </div>
        );
      }

      return (
        <div key={fieldId} className="config-field-group">
          <label className="config-field-label">{key}</label>
          <div className="config-nested-fields">
            {entries.map(([nestedKey, nestedValue]) =>
              renderConfigField(nestedKey, nestedValue, currentPath)
            )}
          </div>
        </div>
      );
    }

    // Handle arrays
    if (isArray) {
      return (
        <div key={fieldId} className="config-field-group">
          <label className="config-field-label">{key}</label>
          <div className="config-array-field">
            <Input
              type="text"
              value={JSON.stringify(value)}
              onChange={(e) => {
                try {
                  const parsed = JSON.parse(e.target.value);
                  updateConfigField(currentPath, parsed);
                } catch {
                  // Invalid JSON, ignore
                }
              }}
              disabled={!isEditing && !isCreating}
              className="bg-accent border-border text-foreground font-mono text-sm"
              placeholder="[]"
            />
          </div>
        </div>
      );
    }

    // Handle primitive values (string, number, boolean)
    return (
      <div key={fieldId} className="config-field-group">
        <label className="config-field-label" htmlFor={fieldId}>
          {key}
        </label>
        <Input
          id={fieldId}
          type="text"
          value={value.toString()}
          onChange={(e) => updateConfigField(currentPath, e.target.value)}
          disabled={!isEditing && !isCreating}
          className="bg-accent border-border text-foreground"
          placeholder={`Enter ${key}`}
        />
      </div>
    );
  };

  return (
    <div className="agent-details-form">
      <div className="form-group">
        <label className="form-label">Agent ID</label>
        <Input
          type="text"
          value={formData.agentId}
          onChange={(e) => onFormDataChange({ ...formData, agentId: e.target.value })}
          disabled={!isCreating}
          className="bg-accent border-border text-foreground"
        />
      </div>

      {/* Dynamic Configuration Fields */}
      <div className="config-fields-container">
        <div className="config-section-header">
          <h3 className="config-section-title">Configuration</h3>
          <div className="config-section-actions">
            {/* Hide edit button for fabricator agent */}
            {!isCreating && !isEditing && !isFabricator && (
              <Button
                variant="outline"
                onClick={onStartEdit}
                className="border-border text-foreground hover:bg-accent"
                size="sm"
              >
                Edit
              </Button>
            )}
            {(isEditing || isCreating) && (
              <>
                <Button
                  onClick={onSave}
                  className="bg-chart-2 text-foreground hover:bg-chart-2"
                  size="sm"
                >
                  Save
                </Button>
                <Button
                  variant="outline"
                  onClick={onCancel}
                  className="border-border text-foreground hover:bg-accent"
                  size="sm"
                >
                  Cancel
                </Button>
              </>
            )}
          </div>
        </div>
        {formData.config && typeof formData.config === 'object' && !Array.isArray(formData.config) ? (
          Object.entries(formData.config).map(([key, value]) =>
            renderConfigField(key, value)
          )
        ) : (
          <div className="config-error">
            <p>Invalid configuration format. Expected an object.</p>
            <pre>{JSON.stringify(formData.config, null, 2)}</pre>
          </div>
        )}
      </div>

      {agent && !isCreating && (
        <div className="agent-details-metadata">
          <p>
            <strong>Created:</strong>{' '}
            {agent.createdAt
              ? new Date(agent.createdAt).toLocaleString()
              : 'N/A'}
          </p>
          <p>
            <strong>Updated:</strong>{' '}
            {agent.updatedAt
              ? new Date(agent.updatedAt).toLocaleString()
              : 'N/A'}
          </p>
        </div>
      )}
    </div>
  );
};
