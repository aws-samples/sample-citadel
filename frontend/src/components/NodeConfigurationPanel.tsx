/**
 * NodeConfigurationPanel Component
 * 
 * Modal/drawer component for configuring individual agent nodes in the workflow.
 * Displays agent's configurable parameters from schema and allows users to
 * modify configuration values.
 * 
 * Requirements: 10.1, 10.2, 10.3, 10.4, 10.5
 */

import { useState, useEffect, memo, useCallback } from 'react';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from './ui/sheet';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './ui/select';
import { toast } from 'sonner';
import type { WorkflowNode } from '../types/workflow';

interface NodeConfigurationPanelProps {
  node: WorkflowNode | null;
  isOpen: boolean;
  onClose: () => void;
  onSave: (nodeId: string, configuration: Record<string, any>) => void;
}

/**
 * Renders a form input based on the parameter type
 */
const ParameterInput = memo(function ParameterInput({
  name,
  value,
  type,
  options,
  onChange,
}: {
  name: string;
  value: any;
  type: string;
  options?: string[];
  onChange: (value: any) => void;
}) {
  // Handle different parameter types
  switch (type) {
    case 'string':
    case 'text':
      return (
        <Input
          type="text"
          value={value || ''}
          onChange={(e) => onChange(e.target.value)}
          placeholder={`Enter ${name}`}
        />
      );

    case 'number':
    case 'integer':
      return (
        <Input
          type="number"
          value={value || ''}
          onChange={(e) => onChange(e.target.value ? Number(e.target.value) : '')}
          placeholder={`Enter ${name}`}
        />
      );

    case 'boolean':
      return (
        <Select
          value={value === undefined ? 'false' : String(value)}
          onValueChange={(val: string) => onChange(val === 'true')}
        >
          <SelectTrigger>
            <SelectValue placeholder="Select value" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="true">True</SelectItem>
            <SelectItem value="false">False</SelectItem>
          </SelectContent>
        </Select>
      );

    case 'select':
    case 'enum':
      return (
        <Select
          value={value || ''}
          onValueChange={onChange}
        >
          <SelectTrigger>
            <SelectValue placeholder={`Select ${name}`} />
          </SelectTrigger>
          <SelectContent>
            {options?.map((option) => (
              <SelectItem key={option} value={option}>
                {option}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );

    case 'textarea':
      return (
        <textarea
          className="flex min-h-[80px] w-full rounded-md border border-input bg-input-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
          value={value || ''}
          onChange={(e) => onChange(e.target.value)}
          placeholder={`Enter ${name}`}
        />
      );

    default:
      // Default to text input for unknown types
      return (
        <Input
          type="text"
          value={value || ''}
          onChange={(e) => onChange(e.target.value)}
          placeholder={`Enter ${name}`}
        />
      );
  }
});

/**
 * NodeConfigurationPanel component
 * 
 * Requirement 10.1: Opens on double-click of agent node
 * Requirement 10.2: Displays agent's configurable parameters
 * Requirement 10.3: Updates node configuration on save
 * Requirement 10.4: Saves configuration changes
 * Requirement 10.5: Cancels changes and closes panel
 */
export const NodeConfigurationPanel = memo(function NodeConfigurationPanel({
  node,
  isOpen,
  onClose,
  onSave,
}: NodeConfigurationPanelProps) {
  // Local state for configuration values
  const [configuration, setConfiguration] = useState<Record<string, any>>({});

  /**
   * Initialize configuration state when node changes
   * Requirement 10.2: Display agent's configurable parameters
   */
  useEffect(() => {
    if (node) {
      // Initialize with existing configuration or empty object
      setConfiguration(node.data.configuration || {});
    }
  }, [node]);

  /**
   * Handle saving configuration changes
   * Requirement 10.3, 10.4: Update and save node configuration
   */
  const handleSave = useCallback(() => {
    if (node) {
      // Validate required fields
      const schema = node.data.agentConfig.config?.schema;
      const requiredFields = schema?.required || [];
      const missingFields = requiredFields.filter(
        (field: string) => !configuration[field] || configuration[field] === ''
      );

      if (missingFields.length > 0) {
        toast.error('Missing required fields', {
          description: `Please fill in: ${missingFields.join(', ')}`,
        });
        return;
      }

      onSave(node.id, configuration);
      onClose();
      
      toast.success('Configuration saved', {
        description: `${node.data.label} configuration updated`,
      });
    }
  }, [node, configuration, onSave, onClose]);

  /**
   * Handle canceling configuration changes
   * Requirement 10.5: Discard changes and close panel
   */
  const handleCancel = useCallback(() => {
    // Reset to original configuration
    if (node) {
      setConfiguration(node.data.configuration || {});
    }
    onClose();
  }, [node, onClose]);

  /**
   * Update a specific configuration parameter
   */
  const handleParameterChange = useCallback((key: string, value: any) => {
    setConfiguration((prev) => ({
      ...prev,
      [key]: value,
    }));
  }, []);

  // Don't render if no node is selected
  if (!node) {
    return null;
  }

  // Extract schema from agent config
  const schema = node.data.agentConfig.config?.schema;
  const parameters = schema?.properties || {};
  const required = schema?.required || [];

  return (
    <Sheet open={isOpen} onOpenChange={(open: boolean) => !open && handleCancel()}>
      <SheetContent 
        side="right" 
        className="w-full sm:max-w-md overflow-y-auto"
        aria-label={`Configuration panel for ${node.data.label}`}
      >
        <SheetHeader>
          <SheetTitle>Configure Agent</SheetTitle>
          <SheetDescription>
            Configure parameters for {node.data.label}
          </SheetDescription>
        </SheetHeader>

        <div className="flex flex-col py-6 gap-6">
          {/* Agent Information */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              {node.data.icon && (
                <div className="size-8 flex items-center justify-center text-xl">
                  {node.data.icon}
                </div>
              )}
              <div>
                <div className="font-medium text-sm">{node.data.label}</div>
                <div className="text-xs text-muted-foreground">
                  {node.data.agentId}
                </div>
              </div>
            </div>
          </div>

          {/* Configuration Parameters */}
          {Object.keys(parameters).length > 0 ? (
            <div className="flex flex-col gap-4">
              <div className="text-sm font-medium">Configuration Parameters</div>
              {Object.entries(parameters).map(([key, paramSchema]: [string, any]) => {
                const isRequired = required.includes(key);
                const paramType = paramSchema.type || 'string';
                const paramOptions = paramSchema.enum;
                const paramDescription = paramSchema.description;

                return (
                  <div key={key} className="flex flex-col gap-2">
                    <Label htmlFor={key}>
                      {paramSchema.title || key}
                      {isRequired && <span className="text-destructive ml-1" aria-label="required">*</span>}
                    </Label>
                    {paramDescription && (
                      <p className="text-xs text-muted-foreground" id={`${key}-description`}>
                        {paramDescription}
                      </p>
                    )}
                    <ParameterInput
                      name={key}
                      value={configuration[key]}
                      type={paramType}
                      options={paramOptions}
                      onChange={(value) => handleParameterChange(key, value)}
                    />
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="text-sm text-muted-foreground text-center py-8">
              This agent has no configurable parameters.
            </div>
          )}

          {/* Current Configuration (for debugging/visibility) */}
          {Object.keys(configuration).length > 0 && (
            <div className="flex flex-col gap-2">
              <div className="text-sm font-medium">Current Configuration</div>
              <div className="bg-muted rounded-md p-3">
                <pre className="text-xs overflow-x-auto">
                  {JSON.stringify(configuration, null, 2)}
                </pre>
              </div>
            </div>
          )}
        </div>

        <SheetFooter className="gap-2">
          <Button 
            variant="outline" 
            onClick={handleCancel}
            aria-label="Cancel configuration changes"
          >
            Cancel
          </Button>
          <Button 
            onClick={handleSave}
            aria-label="Save configuration changes"
          >
            Save Configuration
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
});
