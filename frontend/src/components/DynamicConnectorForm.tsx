/**
 * DynamicConnectorForm Component
 * 
 * Renders form fields dynamically based on the selected connector type.
 * Handles authentication fields, configuration fields, validation, and credential masking.
 * 
 * Requirements: 1.3, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 3.1, 3.2, 3.3, 3.4, 3.5, 3.7, 8.7
 */

import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Loader2, AlertCircle, ChevronDown } from 'lucide-react';
import {
  type ConnectorType,
  type ConnectorFormField,
  getConnectorDefinition,
} from '@/config/connectorRegistry';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';

/**
 * Form data structure for connector configuration
 *
 * Most credentials are strings; complex auth credentials (e.g. OAuth2 `scopes`)
 * may be parsed into a `string[]` on submit.
 */
export interface ConnectorFormData {
  name: string;
  credentials: Record<string, string | string[]>;
  config: Record<string, string>;
}

/**
 * Props for DynamicConnectorForm component
 */
export interface DynamicConnectorFormProps {
  connectorType: ConnectorType;
  onSubmit: (data: ConnectorFormData) => Promise<void>;
  initialValues?: Partial<ConnectorFormData>;
  mode: 'create' | 'edit';
  onCancel?: () => void;
}

/**
 * Validation error structure
 */
interface ValidationErrors {
  [fieldName: string]: string;
}

/**
 * DynamicConnectorForm Component
 * 
 * Dynamically renders form fields based on connector type definition.
 * Features:
 * - Displays auth fields from connector definition
 * - Displays config fields from connector definition
 * - Shows help text for each field
 * - Client-side validation for required fields
 * - Credential masking in edit mode
 * - Only updates credentials if user enters new value
 */
export function DynamicConnectorForm({
  connectorType,
  onSubmit,
  initialValues,
  mode,
  onCancel,
}: DynamicConnectorFormProps) {
  const connectorDef = getConnectorDefinition(connectorType.id);
  
  if (!connectorDef) {
    return (
      <Alert variant="destructive">
        <AlertCircle className="size-4" />
        <AlertDescription>
          Connector definition not found for {connectorType.name}
        </AlertDescription>
      </Alert>
    );
  }

  // Form state
  const [name, setName] = useState(initialValues?.name || '');
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [config, setConfig] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<ValidationErrors>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  // Track which sensitive fields have been modified (for edit mode)
  const [modifiedSensitiveFields, setModifiedSensitiveFields] = useState<Set<string>>(new Set());

  // Initialize form values
  useEffect(() => {
    setName(initialValues?.name || '');

    // Initialize credentials with masked values for sensitive fields in edit mode
    const initialCreds: Record<string, string> = {};
    connectorDef.formConfig.authFields.forEach((field) => {
      const provided = initialValues?.credentials?.[field.name];
      if (mode === 'edit' && field.sensitive) {
        // Show masked value to indicate credential exists
        initialCreds[field.name] = '••••••••••••';
      } else if (provided !== undefined && provided !== null) {
        // Coerce arrays (e.g. OAuth2 scopes stored as string[]) to comma-separated form input
        initialCreds[field.name] = Array.isArray(provided)
          ? provided.join(', ')
          : String(provided);
      } else if (mode === 'create' && field.defaultValue !== undefined) {
        initialCreds[field.name] = field.defaultValue;
      } else {
        initialCreds[field.name] = '';
      }
    });
    setCredentials(initialCreds);

    // Initialize config fields
    const initialConfig: Record<string, string> = {};
    connectorDef.formConfig.configFields.forEach((field) => {
      const provided = initialValues?.config?.[field.name];
      if (provided !== undefined && provided !== null && provided !== '') {
        initialConfig[field.name] = String(provided);
      } else if (mode === 'create' && field.defaultValue !== undefined) {
        initialConfig[field.name] = field.defaultValue;
      } else {
        initialConfig[field.name] = '';
      }
    });
    setConfig(initialConfig);
  }, [initialValues, connectorDef, mode]);

  /**
   * Decide whether a given field is currently visible based on
   * `conditionalOn` (single equality match) and/or `visibleWhen` (predicate).
   * Both must pass when both are present.
   */
  const isFieldVisible = (
    field: ConnectorFormField,
    isCredential: boolean,
  ): boolean => {
    const sourceValues = isCredential ? credentials : config;

    if (field.conditionalOn) {
      const conditionValue = sourceValues[field.conditionalOn.field];
      if (conditionValue !== field.conditionalOn.value) {
        return false;
      }
    }

    if (field.visibleWhen) {
      // Predicate is evaluated against the credentials map (where MCP_SERVER
      // OAuth2 fields live); fall back to config map for config-only fields.
      const valuesForPredicate = isCredential ? credentials : config;
      if (!field.visibleWhen(valuesForPredicate)) {
        return false;
      }
    }

    return true;
  };

  /**
   * Parse a comma- or whitespace-separated scopes string into a deduplicated
   * non-empty array. Used both for validation and on submit.
   */
  const parseScopes = (raw: string | undefined): string[] => {
    if (!raw) return [];
    const tokens = raw
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    return Array.from(new Set(tokens));
  };

  /**
   * Validate all required fields
   * Requirements: 2.5, 3.5, 8.5, 8.6, 8.7, 8.8
   */
  const validateForm = (): boolean => {
    const newErrors: ValidationErrors = {};

    // Validate name
    if (!name.trim()) {
      newErrors.name = 'Integration name is required';
    }

    // OAuth2 (MCP_SERVER) fields where any URL must be HTTPS.
    const httpsOnlyAuthFields = new Set([
      'discoveryUrl',
      'authorizationUrl',
      'tokenUrl',
    ]);

    // Validate auth fields
    connectorDef.formConfig.authFields.forEach((field) => {
      const value = credentials[field.name];

      // Skip validation entirely for hidden fields
      if (!isFieldVisible(field, true)) {
        return;
      }

      if (field.required) {
        // In edit mode, masked values are acceptable (means keeping existing)
        if (mode === 'edit' && field.sensitive && value === '••••••••••••') {
          // Valid - keeping existing credential
          return;
        }

        if (!value || !value.trim()) {
          newErrors[field.name] = `${field.label} is required`;
        }
      }

      // Additional validation for specific field types
      if (value && value.trim()) {
        if (field.type === 'email' && !isValidEmail(value)) {
          newErrors[field.name] = 'Please enter a valid email address';
        } else if (field.type === 'url') {
          // OAuth2 URL fields must be HTTPS; other URLs allow any valid URL
          if (httpsOnlyAuthFields.has(field.name)) {
            if (!isValidHttpsUrl(value)) {
              newErrors[field.name] = `${field.label} must be a valid https:// URL`;
            }
          } else if (!isValidUrl(value)) {
            newErrors[field.name] = 'Please enter a valid URL';
          }
        }

        // AgentCore-specific validations
        if (field.name === 'executionRoleArn' && !isValidArn(value)) {
          newErrors[field.name] = 'Invalid IAM Role ARN format. Expected: arn:aws:iam::account:role/role-name';
        }

        // OAuth2 scopes: must contain at least one non-empty entry
        if (field.name === 'scopes') {
          const parsed = parseScopes(value);
          if (parsed.length === 0) {
            newErrors[field.name] = 'At least one scope is required';
          }
        }
      }
    });

    // Validate config fields
    connectorDef.formConfig.configFields.forEach((field) => {
      const value = config[field.name];

      // Skip hidden config fields
      if (!isFieldVisible(field, false)) {
        return;
      }

      if (field.required && (!value || !value.trim())) {
        newErrors[field.name] = `${field.label} is required`;
      }

      // Additional validation for specific field types
      if (value && value.trim()) {
        if (field.type === 'email' && !isValidEmail(value)) {
          newErrors[field.name] = 'Please enter a valid email address';
        } else if (field.type === 'url' && !isValidUrl(value)) {
          newErrors[field.name] = 'Please enter a valid URL';
        }

        // AgentCore-specific validations
        if (field.name === 'lambdaArn' && !isValidArn(value)) {
          newErrors[field.name] = 'Invalid Lambda ARN format. Expected: arn:aws:lambda:region:account:function:function-name';
        } else if (field.name === 'toolSchema' && !isValidJson(value)) {
          newErrors[field.name] = 'Tool schema must be valid JSON';
        } else if (field.name === 'region' && !isValidAwsRegion(value)) {
          newErrors[field.name] = 'Invalid AWS region code. Must be a valid region like us-east-1, eu-west-1';
        } else if (field.name === 'serverUrl' && !isValidHttpsUrl(value)) {
          newErrors[field.name] = 'MCP Server URL must be a valid HTTPS URL';
        }
      }
    });

    // Cross-field rule for MCP_SERVER OAuth2:
    //   discoveryUrl OR (tokenUrl AND (grantType !== 'AUTHORIZATION_CODE' OR authorizationUrl))
    // We only check this when authMethod=OAUTH2 and individual field errors haven't already
    // surfaced (e.g., a missing required tokenUrl will already be flagged above).
    if (
      connectorDef.type === 'MCP_SERVER' &&
      credentials.authMethod === 'OAUTH2'
    ) {
      const discoveryUrl = (credentials.discoveryUrl ?? '').trim();
      const tokenUrl = (credentials.tokenUrl ?? '').trim();
      const authorizationUrl = (credentials.authorizationUrl ?? '').trim();
      const grantType = credentials.grantType;

      if (!discoveryUrl) {
        // tokenUrl required already covered by visibleWhen+required.
        // Specifically check AUTHORIZATION_CODE without authorizationUrl, since
        // its visibleWhen + required already drives the field error, but we
        // also surface a top-level rule error if both are blank.
        if (
          grantType === 'AUTHORIZATION_CODE' &&
          tokenUrl &&
          !authorizationUrl &&
          !newErrors.authorizationUrl
        ) {
          newErrors.authorizationUrl =
            'Authorization URL is required for the Authorization Code grant when no discovery URL is provided';
        }
      }
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  /**
   * Handle form submission
   */
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitError(null);

    // Validate form
    if (!validateForm()) {
      return;
    }

    setIsSubmitting(true);

    try {
      // Prepare credentials - only include modified sensitive fields in edit mode,
      // skip hidden fields, and parse scopes string to string[].
      const finalCredentials: Record<string, string | string[]> = {};

      connectorDef.formConfig.authFields.forEach((field) => {
        if (!isFieldVisible(field, true)) {
          return; // Don't submit values for fields the user can't see
        }

        const value = credentials[field.name];

        if (mode === 'edit' && field.sensitive) {
          // Only include if the field was modified (not the masked placeholder)
          if (modifiedSensitiveFields.has(field.name) && value !== '••••••••••••') {
            finalCredentials[field.name] = value;
          }
          // If not modified, don't include it (backend will keep existing value)
        } else {
          // In create mode or for non-sensitive fields, always include
          finalCredentials[field.name] = value;
        }
      });

      // Transform OAuth2 scopes from form string to string[] on submit.
      if (typeof finalCredentials.scopes === 'string') {
        finalCredentials.scopes = parseScopes(finalCredentials.scopes);
      }

      await onSubmit({
        name: name.trim(),
        credentials: finalCredentials,
        config,
      });
    } catch (error: any) {
      setSubmitError(error.message || 'Failed to save integration');
    } finally {
      setIsSubmitting(false);
    }
  };

  /**
   * Handle credential field change
   * Track modifications for sensitive fields in edit mode
   */
  const handleCredentialChange = (fieldName: string, value: string, isSensitive: boolean) => {
    // Trim whitespace from URL fields
    const trimmedValue = (fieldName === 'baseUrl' || fieldName === 'instanceUrl') 
      ? value.trim() 
      : value;
    
    setCredentials((prev) => ({ ...prev, [fieldName]: trimmedValue }));
    
    // Track that this sensitive field has been modified
    if (mode === 'edit' && isSensitive) {
      setModifiedSensitiveFields((prev) => new Set(prev).add(fieldName));
    }
    
    // Clear error for this field
    if (errors[fieldName]) {
      setErrors((prev) => {
        const newErrors = { ...prev };
        delete newErrors[fieldName];
        return newErrors;
      });
    }
  };

  /**
   * Handle config field change
   */
  const handleConfigChange = (fieldName: string, value: string) => {
    // Trim whitespace from URL fields
    const trimmedValue = (fieldName === 'baseUrl' || fieldName === 'instanceUrl') 
      ? value.trim() 
      : value;
    
    setConfig((prev) => ({ ...prev, [fieldName]: trimmedValue }));
    
    // Clear error for this field
    if (errors[fieldName]) {
      setErrors((prev) => {
        const newErrors = { ...prev };
        delete newErrors[fieldName];
        return newErrors;
      });
    }
  };

  /**
   * Render a form field
   * Requirements: 8.1, 8.2, 8.3, 9.1, 9.2, 9.3
   */
  const renderField = (field: ConnectorFormField, value: string, onChange: (value: string) => void, isCredential: boolean = false) => {
    const hasError = !!errors[field.name];
    const errorId = `${field.name}-error`;
    const describedBy = hasError ? errorId : undefined;
    const showMaskedHint = mode === 'edit' && field.sensitive && value === '••••••••••••';

    // Honor `conditionalOn` and `visibleWhen` predicates
    if (!isFieldVisible(field, isCredential)) {
      return null;
    }

    return (
      <div key={field.name} className="flex flex-col gap-2">
        <Label htmlFor={field.name} className="text-sm font-medium text-foreground">
          {field.label}
          {field.required && <span className="text-destructive ml-1">*</span>}
        </Label>
        
        {field.type === 'textarea' ? (
          <Textarea
            id={field.name}
            placeholder={field.placeholder}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className={`text-foreground placeholder:text-muted-foreground min-h-[120px] font-mono text-sm ${hasError ? 'border-destructive' : ''}`}
            style={{
              backgroundColor: 'var(--card)',
              border: hasError ? '1px solid var(--destructive)' : '1px solid var(--border)'
            }}
            disabled={isSubmitting}
            aria-required={field.required || undefined}
            aria-invalid={hasError}
            aria-describedby={describedBy}
          />
        ) : field.type === 'select' ? (
          <Select value={value} onValueChange={onChange} disabled={isSubmitting}>
            <SelectTrigger
              className={`text-foreground ${hasError ? 'border-destructive' : ''}`}
              style={{
                backgroundColor: 'var(--card)',
                border: hasError ? '1px solid var(--destructive)' : '1px solid var(--border)'
              }}
              aria-required={field.required || undefined}
              aria-invalid={hasError}
              aria-describedby={describedBy}
            >
              <SelectValue placeholder={field.placeholder} />
            </SelectTrigger>
            <SelectContent
              style={{
                backgroundColor: 'var(--card)',
                border: '1px solid var(--border)'
              }}
            >
              {field.options?.map((option) => (
                <SelectItem
                  key={option.value}
                  value={option.value}
                  className="text-foreground hover:bg-accent"
                >
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <Input
            id={field.name}
            type={field.type}
            placeholder={field.placeholder}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className={`text-foreground placeholder:text-muted-foreground ${hasError ? 'border-destructive' : ''}`}
            style={{
              backgroundColor: 'var(--card)',
              border: hasError ? '1px solid var(--destructive)' : '1px solid var(--border)'
            }}
            disabled={isSubmitting}
            autoComplete={field.name === 'email' ? 'username' : 'off'}
            data-form-type="other"
            data-lpignore="true"
            aria-required={field.required || undefined}
            aria-invalid={hasError}
            aria-describedby={describedBy}
          />
        )}
        
        {field.helpText && (
          <p className="text-xs text-muted-foreground">
            {showMaskedHint
              ? 'Current value is saved. Leave as-is to keep existing, or enter a new value to update.'
              : field.helpText}
          </p>
        )}
        {hasError && (
          <p id={errorId} role="alert" className="text-xs text-destructive">{errors[field.name]}</p>
        )}
      </div>
    );
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-6" autoComplete="off">
      {/* Integration Name */}
      <div className="flex flex-col gap-2">
        <Label htmlFor="name" className="text-sm font-medium text-foreground">
          Integration Name
          <span className="text-destructive ml-1">*</span>
        </Label>
        <Input
          id="name"
          type="text"
          placeholder={`My ${connectorType.name} Integration`}
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            if (errors.name) {
              setErrors((prev) => {
                const newErrors = { ...prev };
                delete newErrors.name;
                return newErrors;
              });
            }
          }}
          className={`text-foreground placeholder:text-muted-foreground ${errors.name ? 'border-destructive' : ''}`}
          style={{
            backgroundColor: 'var(--card)',
            border: errors.name ? '1px solid var(--destructive)' : '1px solid var(--border)'
          }}
          disabled={isSubmitting}
          autoComplete="off"
          data-form-type="other"
          data-lpignore="true"
          aria-required={true}
          aria-invalid={!!errors.name}
          aria-describedby={errors.name ? 'name-error' : undefined}
        />
        {errors.name && (
          <p id="name-error" role="alert" className="text-xs text-destructive">{errors.name}</p>
        )}
      </div>

      {/* Authentication Fields */}
      {connectorDef.formConfig.authFields.length > 0 && (
        <div className="flex flex-col gap-4">
          <div className="text-sm font-semibold text-foreground">Authentication</div>
          {connectorDef.formConfig.authFields
            .filter((field) => !field.advanced)
            .map((field) =>
              renderField(
                field,
                credentials[field.name] || '',
                (value) => handleCredentialChange(field.name, value, field.sensitive),
                true,
              ),
            )}

          {/* Advanced (collapsible) auth fields, only when at least one is currently visible */}
          {(() => {
            const advancedFields = connectorDef.formConfig.authFields.filter(
              (field) => field.advanced && isFieldVisible(field, true),
            );
            if (advancedFields.length === 0) return null;
            return (
              <Collapsible
                open={advancedOpen}
                onOpenChange={setAdvancedOpen}
                data-testid="advanced-disclosure"
              >
                <CollapsibleTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-auto self-start p-0 flex items-center gap-2 text-xs font-medium text-muted-foreground hover:bg-transparent hover:text-foreground"
                    aria-expanded={advancedOpen}
                  >
                    <ChevronDown
                      className={`size-3 transition-transform ${advancedOpen ? 'rotate-180' : ''}`}
                    />
                    Advanced
                  </Button>
                </CollapsibleTrigger>
                <CollapsibleContent className="flex flex-col gap-4 pt-2">
                  {advancedFields.map((field) =>
                    renderField(
                      field,
                      credentials[field.name] || '',
                      (value) => handleCredentialChange(field.name, value, field.sensitive),
                      true,
                    ),
                  )}
                </CollapsibleContent>
              </Collapsible>
            );
          })()}
        </div>
      )}

      {/* Configuration Fields */}
      {connectorDef.formConfig.configFields.length > 0 && (
        <div className="flex flex-col gap-4">
          <div className="text-sm font-semibold text-foreground">Configuration</div>
          {connectorDef.formConfig.configFields.map((field) =>
            renderField(
              field,
              config[field.name] || '',
              (value) => handleConfigChange(field.name, value),
              false
            )
          )}
        </div>
      )}

      {/* Submit Error */}
      {submitError && (
        <Alert variant="destructive" className="bg-destructive/20 border-destructive/50 text-destructive">
          <AlertCircle className="size-4" />
          <AlertDescription>{submitError}</AlertDescription>
        </Alert>
      )}

      {/* Form Actions */}
      <div className="flex gap-3 pt-4">
        <Button
          type="submit"
          className="flex-1 text-foreground font-medium"
          style={{
            background: 'linear-gradient(135deg, #f97316 0%, #ea580c 100%)'
          }}
          disabled={isSubmitting}
        >
          {isSubmitting && <Loader2 className="size-4 mr-2 animate-spin" />}
          {mode === 'create' ? 'Create Integration' : 'Update Integration'}
        </Button>
        {onCancel && (
          <Button
            type="button"
            variant="outline"
            onClick={onCancel}
            disabled={isSubmitting}
            className="text-muted-foreground hover:text-foreground"
            style={{
              backgroundColor: 'transparent',
              border: '1px solid var(--border)'
            }}
          >
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}

/**
 * Email validation helper
 */
function isValidEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

/**
 * URL validation helper
 */
function isValidUrl(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

/**
 * HTTPS URL validation helper
 * Requirements: 3.10, 8.8
 */
function isValidHttpsUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * ARN format validation helper
 * Requirements: 1.8, 1.9, 2.10, 4.6, 8.5, 8.6
 */
function isValidArn(arn: string): boolean {
  const arnRegex = /^arn:aws:[a-z0-9-]+:[a-z0-9-]*:\d{12}:[a-zA-Z0-9/_-]+$/;
  return arnRegex.test(arn);
}

/**
 * JSON validation helper
 * Requirements: 1.10, 8.7
 */
function isValidJson(jsonString: string): boolean {
  try {
    JSON.parse(jsonString);
    return true;
  } catch {
    return false;
  }
}

/**
 * AWS region validation helper
 * Requirements: 2.9, 8.7
 */
function isValidAwsRegion(region: string): boolean {
  const validRegions = [
    'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2',
    'af-south-1', 'ap-east-1', 'ap-south-1', 'ap-south-2',
    'ap-northeast-1', 'ap-northeast-2', 'ap-northeast-3',
    'ap-southeast-1', 'ap-southeast-2', 'ap-southeast-3', 'ap-southeast-4',
    'ca-central-1', 'eu-central-1', 'eu-central-2',
    'eu-west-1', 'eu-west-2', 'eu-west-3',
    'eu-north-1', 'eu-south-1', 'eu-south-2',
    'me-south-1', 'me-central-1', 'sa-east-1',
  ];
  return validRegions.includes(region);
}
