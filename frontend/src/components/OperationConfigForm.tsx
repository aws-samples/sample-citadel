import { useState, useEffect, useCallback } from 'react';
import { Loader2, AlertCircle } from 'lucide-react';
import { Button } from './ui/button';
import { Switch } from './ui/switch';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Textarea } from './ui/textarea';
import serverService from '../services/server';

// --- Operation descriptor types ---
interface OperationParameter {
  name: string;
  type: string;
  required: boolean;
  description: string;
}

interface IntegrationOperation {
  operationId: string;
  name: string;
  description: string;
  method: string;
  parameters: OperationParameter[];
}

// --- GraphQL query ---
const listIntegrationOperationsQuery = `
  query ListIntegrationOperations($integrationType: String!) {
    listIntegrationOperations(integrationType: $integrationType) {
      operationId
      name
      description
      method
      parameters {
        name
        type
        required
        description
      }
    }
  }
`;

// --- Component Props ---
export interface OperationConfigFormProps {
  integrationType: string;
  operationId: string;
  onSubmit: (values: Record<string, any>) => void;
  onChange?: (values: Record<string, any>) => void;
}

export function OperationConfigForm({
  integrationType,
  operationId,
  onSubmit,
  onChange,
}: OperationConfigFormProps) {
  const [operation, setOperation] = useState<IntegrationOperation | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, any>>({});
  const [validationErrors, setValidationErrors] = useState<Record<string, string>>({});

  // Fetch operation descriptor
  useEffect(() => {
    const fetchOperation = async () => {
      try {
        setLoading(true);
        setError(null);
        const response = await serverService.query<{
          listIntegrationOperations: IntegrationOperation[];
        }>(listIntegrationOperationsQuery, { integrationType });

        const ops = response.listIntegrationOperations || [];
        const match = ops.find((op) => op.operationId === operationId);
        setOperation(match || null);

        // Initialize values for parameters
        if (match) {
          const initial: Record<string, any> = {};
          for (const param of match.parameters) {
            if (param.type === 'boolean') initial[param.name] = false;
            else if (param.type === 'number') initial[param.name] = '';
            else initial[param.name] = '';
          }
          setValues(initial);
        }
      } catch (err: any) {
        console.error('Failed to load operation details:', err);
        setError('No operation details are available. You can proceed without parameter configuration.');
        setOperation(null);
      } finally {
        setLoading(false);
      }
    };
    fetchOperation();
  }, [integrationType, operationId]);

  const handleFieldChange = useCallback(
    (paramName: string, value: any) => {
      setValues((prev) => {
        const next = { ...prev, [paramName]: value };
        onChange?.(next);
        return next;
      });
      // Clear validation error on change
      setValidationErrors((prev) => {
        const next = { ...prev };
        delete next[paramName];
        return next;
      });
    },
    [onChange],
  );

  const validate = (): boolean => {
    if (!operation) return true;
    const errors: Record<string, string> = {};
    for (const param of operation.parameters) {
      if (param.required) {
        const val = values[param.name];
        if (val === undefined || val === null || val === '') {
          errors[param.name] = `${param.name} is required`;
        }
      }
    }
    setValidationErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (validate()) {
      onSubmit(values);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="size-6 text-primary animate-spin" />
      </div>
    );
  }

  if (error || !operation) {
    return (
      <div className="bg-chart-4/10 border border-chart-4/30 rounded-lg p-4">
        <div className="flex items-start gap-2">
          <AlertCircle className="size-5 text-chart-4 shrink-0 mt-0.5" />
          <p className="text-chart-4 text-sm">
            {error || 'No operation details are available. You can proceed without parameter configuration.'}
          </p>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <div className="mb-4">
        <h4 className="text-foreground text-sm font-medium">{operation.name}</h4>
        <p className="text-muted-foreground text-xs mt-1">{operation.description}</p>
      </div>

      {operation.parameters.map((param) => (
        <div key={param.name} className="flex flex-col gap-1">
          <Label htmlFor={`param-${param.name}`} className="text-foreground text-sm">
            {param.name}
            {param.required && <span className="text-destructive ml-1">*</span>}
          </Label>
          {param.description && (
            <p className="text-muted-foreground text-xs">{param.description}</p>
          )}

          {param.type === 'boolean' ? (
            <Switch
              id={`param-${param.name}`}
              checked={!!values[param.name]}
              onCheckedChange={(checked) => handleFieldChange(param.name, checked)}
            />
          ) : param.type === 'number' ? (
            <Input
              id={`param-${param.name}`}
              type="number"
              value={values[param.name] ?? ''}
              onChange={(e) => handleFieldChange(param.name, e.target.value)}
              className="bg-card border-border text-foreground"
            />
          ) : param.type === 'object' ? (
            <Textarea
              id={`param-${param.name}`}
              placeholder='{ "key": "value" }'
              value={values[param.name] ?? ''}
              onChange={(e) => handleFieldChange(param.name, e.target.value)}
              className="bg-card border-border text-foreground font-mono text-sm min-h-[80px]"
            />
          ) : (
            <Input
              id={`param-${param.name}`}
              type="text"
              value={values[param.name] ?? ''}
              onChange={(e) => handleFieldChange(param.name, e.target.value)}
              className="bg-card border-border text-foreground"
            />
          )}

          {validationErrors[param.name] && (
            <p className="text-destructive text-xs">{validationErrors[param.name]}</p>
          )}
        </div>
      ))}

      <Button type="submit" className="bg-primary text-foreground hover:bg-primary/90 mt-4">
        Submit
      </Button>
    </form>
  );
}
