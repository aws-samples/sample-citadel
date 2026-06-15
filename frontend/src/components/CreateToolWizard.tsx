import { useState, useEffect } from 'react';
import { ArrowLeft, Wrench, Loader2, Check, LucideIcon } from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Textarea } from './ui/textarea';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { Badge } from './ui/badge';
import { fabricatorService } from '../services/fabricatorService';
import { integrationServiceBackend, Integration as BackendIntegration } from '../services/integrationServiceBackend';
import { datastoreService, DataStore, DataStoreStatus } from '../services/datastoreService';
import { getConnectorDefinition } from '../config/connectorRegistry';
import { useOrganization } from '../contexts/OrganizationContext';
import {
  MessageSquare,
  Mail,
  Users,
  CreditCard,
  Cloud,
  Settings,
  Database,
  BarChart3,
  FileText,
  Zap,
  GitBranch,
  Brain,
  Key,
  UserCheck,
  Lock,
  BookOpen,
  Layers,
  MessageCircle,
  AlertCircle,
  Plug,
} from 'lucide-react';

interface CreateToolWizardProps {
  onBack: () => void;
  onComplete: () => void;
  onRequestSubmitted: (requestId: string, toolName: string, toolDescription: string) => void;
}

// UI-facing integration shape used by the wizard
interface Integration {
  id: string;
  name: string;
  description: string;
  icon: string;
}

// Icon mapping helper
const iconMap: Record<string, LucideIcon> = {
  MessageSquare,
  Mail,
  Users,
  CreditCard,
  Cloud,
  Settings,
  Database,
  BarChart3,
  FileText,
  Zap,
  GitBranch,
  Brain,
  Key,
  UserCheck,
  Lock,
  BookOpen,
  Layers,
  MessageCircle,
  AlertCircle,
  Plug,
};

// Map LucideIcon component to its string name for the icon lookup
const iconToName = new Map<LucideIcon, string>();
Object.entries(iconMap).forEach(([name, icon]) => iconToName.set(icon as LucideIcon, name));

function mapBackendIntegration(b: BackendIntegration): Integration {
  const def = getConnectorDefinition(b.integrationType as any);
  const iconName = def?.icon ? (iconToName.get(def.icon) ?? 'Cloud') : 'Cloud';
  return {
    id: b.integrationId,
    name: def?.name ?? b.name ?? b.integrationType,
    description: def?.description ?? `${b.integrationType} integration`,
    icon: iconName,
  };
}

const getIconComponent = (iconName: string): LucideIcon => {
  return iconMap[iconName] || Cloud;
};

export function CreateToolWizard({ onBack, onComplete, onRequestSubmitted }: CreateToolWizardProps) {
  const { selectedOrganization } = useOrganization();
  const orgId = selectedOrganization || 'default';
  const integrationOrgId = 'default'; // Integrations are always stored under 'default' org
  const [availableIntegrations, setAvailableIntegrations] = useState<Integration[]>([]);
  const [availableDataStores, setAvailableDataStores] = useState<DataStore[]>([]);
  const [loadingData, setLoadingData] = useState(true);
  const [toolName, setToolName] = useState('');
  const [toolDescription, setToolDescription] = useState('');
  const [selectedIntegrations, setSelectedIntegrations] = useState<string[]>([]);
  const [selectedDataStores, setSelectedDataStores] = useState<string[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load integrations and data stores on mount
  useEffect(() => {
    const loadData = async () => {
      try {
        setLoadingData(true);
        const [integrations, dataStores] = await Promise.all([
          integrationServiceBackend.listIntegrations(integrationOrgId, 'CONNECTED'),
          datastoreService.listDataStores(orgId)
        ]);
        setAvailableIntegrations(integrations.map(mapBackendIntegration));
        setAvailableDataStores(dataStores.filter(ds => ds.status === DataStoreStatus.CONNECTED));
      } catch (err) {
        console.error('Failed to load integrations and data stores:', err);
      } finally {
        setLoadingData(false);
      }
    };

    loadData();
  }, [orgId]);

  const toggleIntegration = (integrationId: string) => {
    setSelectedIntegrations((prev) =>
      prev.includes(integrationId)
        ? prev.filter((id) => id !== integrationId)
        : [...prev, integrationId]
    );
  };

  const toggleDataStore = (dataStoreId: string) => {
    setSelectedDataStores((prev) =>
      prev.includes(dataStoreId)
        ? prev.filter((id) => id !== dataStoreId)
        : [...prev, dataStoreId]
    );
  };

  const handleSubmit = async () => {
    // Validation
    if (!toolName.trim()) {
      setError('Tool name is required');
      return;
    }

    if (!toolDescription.trim()) {
      setError('Tool description is required');
      return;
    }

    try {
      setIsSubmitting(true);
      setError(null);

      // Build enhanced description with integrations and data stores
      let enhancedDescription = toolDescription.trim();
      
      if (selectedIntegrations.length > 0) {
        const integrationNames = selectedIntegrations
          .map((id) => availableIntegrations.find((i) => i.id === id)?.name)
          .filter(Boolean)
          .join(', ');
        enhancedDescription += `\n\nIntegrations: ${integrationNames}`;
      }

      if (selectedDataStores.length > 0) {
        const dataStoreNames = selectedDataStores
          .map((id) => availableDataStores.find((d) => d.dataStoreId === id)?.name)
          .filter(Boolean)
          .join(', ');
        enhancedDescription += `\n\nData Stores: ${dataStoreNames}`;
      }

      // Submit the tool creation request
      const response = await fabricatorService.requestToolCreation({
        toolName: toolName.trim(),
        toolDescription: enhancedDescription,
      });

      console.log('Tool creation request submitted:', response);

      // Notify parent component
      onRequestSubmitted(response.requestId, toolName.trim(), toolDescription.trim());

      // Complete the wizard
      onComplete();
    } catch (err: any) {
      console.error('Failed to submit tool creation request:', err);
      setError(err.message || 'Failed to submit tool creation request');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-card p-6">
      {/* Header */}
      <div className="mb-6">
        <Button
          variant="ghost"
          className="text-muted-foreground hover:text-foreground mb-4"
          onClick={onBack}
        >
          <ArrowLeft className="size-4 mr-2" />
          Back to Tools
        </Button>
        <div className="flex items-center gap-3">
          <div className="size-12 rounded-lg bg-accent border border-border flex items-center justify-center">
            <Wrench className="size-6 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-foreground">Create New Tool</h1>
            <p className="text-muted-foreground text-sm">
              Define a custom tool for your agents
            </p>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="max-w-3xl">
        <Card className="bg-accent border-border">
          <CardHeader>
            <CardTitle className="text-foreground">Tool Details</CardTitle>
            <CardDescription className="text-muted-foreground">
              Provide information about the tool you want to create
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-6">
            {/* Tool Name */}
            <div className="flex flex-col gap-2">
              <Label htmlFor="toolName" className="text-foreground">
                Tool Name <span className="text-destructive">*</span>
              </Label>
              <Input
                id="toolName"
                placeholder="e.g., validate_email, calculate_tax, format_date"
                value={toolName}
                onChange={(e) => setToolName(e.target.value)}
                className="bg-card border-border text-foreground placeholder:text-muted-foreground"
              />
              <p className="text-xs text-muted-foreground">
                Use snake_case for the tool function name
              </p>
            </div>

            {/* Tool Description */}
            <div className="flex flex-col gap-2">
              <Label htmlFor="toolDescription" className="text-foreground">
                Tool Description <span className="text-destructive">*</span>
              </Label>
              <Textarea
                id="toolDescription"
                placeholder="Describe what this tool does, what parameters it accepts, and what it returns. Be as detailed as possible to help the AI generate accurate code."
                value={toolDescription}
                onChange={(e) => setToolDescription(e.target.value)}
                className="bg-card border-border text-foreground placeholder:text-muted-foreground min-h-[200px]"
              />
              <p className="text-xs text-muted-foreground">
                Include details about parameters, return values, and any special requirements
              </p>
            </div>

            {/* Integrations */}
            <div className="flex flex-col gap-3">
              <div>
                <Label className="text-foreground">Integrations</Label>
                <p className="text-xs text-muted-foreground mt-1">
                  Select external services this tool will integrate with
                </p>
              </div>
              {loadingData ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="size-6 text-muted-foreground animate-spin" />
                </div>
              ) : availableIntegrations.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  No connected integrations available
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {availableIntegrations.map((integration) => {
                    const Icon = getIconComponent(integration.icon);
                    const isSelected = selectedIntegrations.includes(integration.id);
                    
                    return (
                      <Button
                        key={integration.id}
                        type="button"
                        variant="outline"
                        onClick={() => toggleIntegration(integration.id)}
                        className={`relative flex h-auto items-start gap-3 whitespace-normal justify-start p-3 rounded-lg border transition-all text-left ${
                          isSelected
                            ? 'bg-primary/10 border-primary'
                            : 'bg-card border-border hover:border-input'
                        }`}
                      >
                        <div className={`size-10 rounded-lg flex items-center justify-center shrink-0 ${
                          isSelected ? 'bg-primary/20' : 'bg-accent'
                        }`}>
                          <Icon className={`size-5 ${isSelected ? 'text-primary' : 'text-muted-foreground'}`} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <h4 className="text-foreground text-sm font-medium">{integration.name}</h4>
                            {isSelected && (
                              <Check className="size-4 text-primary shrink-0" />
                            )}
                          </div>
                          <p className="text-muted-foreground text-xs mt-0.5">{integration.description}</p>
                        </div>
                      </Button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Data Stores */}
            <div className="flex flex-col gap-3">
              <div>
                <Label className="text-foreground">Data Stores</Label>
                <p className="text-xs text-muted-foreground mt-1">
                  Select data stores this tool will access
                </p>
              </div>
              {loadingData ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="size-6 text-muted-foreground animate-spin" />
                </div>
              ) : availableDataStores.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  No connected data stores available
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {availableDataStores.map((dataStore) => {
                    const Icon = getIconComponent(dataStore.icon);
                    const isSelected = selectedDataStores.includes(dataStore.dataStoreId);
                    
                    return (
                      <Button
                        key={dataStore.dataStoreId}
                        type="button"
                        variant="outline"
                        onClick={() => toggleDataStore(dataStore.dataStoreId)}
                        className={`relative flex h-auto items-start gap-3 whitespace-normal justify-start p-3 rounded-lg border transition-all text-left ${
                          isSelected
                            ? 'bg-primary/10 border-primary'
                            : 'bg-card border-border hover:border-input'
                        }`}
                      >
                        <div className={`size-10 rounded-lg flex items-center justify-center shrink-0 ${
                          isSelected ? 'bg-primary/20' : 'bg-accent'
                        }`}>
                          <Icon className={`size-5 ${isSelected ? 'text-primary' : 'text-muted-foreground'}`} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <h4 className="text-foreground text-sm font-medium">{dataStore.name}</h4>
                            {isSelected && (
                              <Check className="size-4 text-primary shrink-0" />
                            )}
                          </div>
                          <p className="text-muted-foreground text-xs mt-0.5">{dataStore.description}</p>
                          <Badge 
                            variant="secondary" 
                            className="mt-1.5 text-xs bg-accent text-muted-foreground border-border"
                          >
                            {dataStore.type.replace('-', ' ')}
                          </Badge>
                        </div>
                      </Button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Example */}
            <Card className="rounded-lg p-4 gap-0">
              <h4 className="text-foreground font-medium mb-2">Example Description:</h4>
              <p className="text-muted-foreground text-sm">
                "Create a tool that validates email addresses. It should accept a single string parameter 
                called 'email' and return a boolean value (True if the email is valid, False otherwise). 
                The validation should check for proper format including @ symbol and domain extension."
              </p>
            </Card>

            {/* Error Message */}
            {error && (
              <div className="bg-destructive/10 border border-destructive/50 rounded-lg p-4">
                <p className="text-destructive text-sm">{error}</p>
              </div>
            )}

            {/* Action Buttons */}
            <div className="flex gap-3 pt-4">
              <Button
                variant="outline"
                className="flex-1 border-border text-foreground hover:bg-accent"
                onClick={onBack}
                disabled={isSubmitting}
              >
                Cancel
              </Button>
              <Button
                className="flex-1 bg-primary text-foreground hover:bg-primary/90"
                onClick={handleSubmit}
                disabled={isSubmitting}
              >
                {isSubmitting ? (
                  <>
                    <Loader2 className="size-4 mr-2 animate-spin" />
                    Creating Tool...
                  </>
                ) : (
                  <>
                    <Wrench className="size-4 mr-2" />
                    Create Tool
                  </>
                )}
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
