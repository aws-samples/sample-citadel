import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/components/ui/utils";
import { 
  CheckCircle,
  FileText,
  MessageSquare,
  Mail,
  Users,
  CreditCard,
  Cloud,
  Settings,
  Database,
  BarChart3,
  Zap,
  GitBranch,
  Brain,
  Key,
  UserCheck,
  Lock,
  Globe,
  Plug,
  Search,
  AlertCircle,
  BookOpen,
  Share2,
  LucideIcon
} from "lucide-react";
import { integrationServiceBackend, Integration as BackendIntegration } from "@/services/integrationServiceBackend";
import { IntegrationCard } from "@/components/IntegrationCard";
import { ConnectorTypeSelector } from "@/components/ConnectorTypeSelector";
import { DynamicConnectorForm, type ConnectorFormData } from "@/components/DynamicConnectorForm";
import { type ConnectorType, getConnectorDefinition, type IntegrationType } from "@/config/connectorRegistry";
import { PageContainer } from "@/components/PageContainer";
import { SearchInput } from "@/components/SearchInput";

// Extended Integration type that includes UI properties
interface Integration extends Partial<BackendIntegration> {
  id: string;
  name: string;
  description: string;
  category: string;
  provider: string;
  status: "connected" | "disconnected" | "error" | "configuring" | "CONNECTED" | "DISCONNECTED" | "CREATED" | "TESTED" | "CONNECTING" | "CONNECTION_FAILED";
  icon: string;
  isPopular: boolean;
  lastSync: string;
  features: string[];
  pricing: "free" | "paid" | "freemium";
  setupComplexity: "easy" | "medium" | "advanced";
  protocol?: string;
  integrationId?: string;
  integrationType?: string;
  orgId?: string;
  config?: any;
  createdAt?: string;
  updatedAt?: string;
  errorMessage?: string;
  backendStatus?: string; // Store the raw backend status for lifecycle logic
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
  Globe,
  Plug,
  Search,
  CheckCircle,
  AlertCircle,
  BookOpen,
};

const getIconComponent = (iconName: string): LucideIcon => {
  return iconMap[iconName] || Plug;
};

// Reverse lookup: LucideIcon component → string name in iconMap
const reverseIconMap = new Map<LucideIcon, string>(
  Object.entries(iconMap).map(([name, icon]) => [icon, name])
);

const getIconName = (icon: LucideIcon | undefined): string => {
  if (!icon) return "Plug";
  return reverseIconMap.get(icon) ?? "Plug";
};

// Categories configuration
const categories = [
  { id: "all", label: "All Integrations", icon: Plug },
  { id: "communication", label: "Communication", icon: MessageSquare },
  { id: "productivity", label: "Productivity", icon: FileText },
  { id: "crm", label: "CRM", icon: Users },
  { id: "payments", label: "Payments", icon: CreditCard },
  { id: "storage", label: "Storage", icon: Cloud },
  { id: "automation", label: "Automation", icon: Settings },
  { id: "database", label: "Database", icon: Database },
  { id: "analytics", label: "Analytics", icon: BarChart3 },
  { id: "ai-services", label: "AI Services", icon: Zap },
  { id: "security", label: "Security & Identity", icon: Lock },
  { id: "aws-services", label: "AWS Services", icon: Cloud },
  { id: "integration-platform", label: "Integration Platform", icon: Plug }
];

const statusIcons: Record<string, LucideIcon> = {
  connected: CheckCircle,
  CONNECTED: CheckCircle,
  disconnected: Globe,
  DISCONNECTED: Globe,
  CREATED: Globe,
  TESTED: Globe,
  error: AlertCircle,
  CONNECTION_FAILED: AlertCircle,
  configuring: Settings,
  CONNECTING: Settings
};

const protocolVariant: Record<string, string> = {
  "MCP": "info",
  "REST": "success",
  "A2A": "secondary",
  "Direct API": "warning",
  "Identity": "info"
};

// Map backend status to UI status
const mapBackendStatus = (backendStatus: string): Integration["status"] => {
  const statusMap: Record<string, Integration["status"]> = {
    "CONNECTED": "connected",
    "DISCONNECTED": "disconnected",
    "CREATED": "configuring",  // Just created, needs configuration
    "CONFIGURED": "configuring", // Configured, ready to test
    "TESTED": "configuring",     // Tested successfully, ready to connect
    "CONNECTING": "configuring",
    "CONNECTION_FAILED": "error"
  };
  return statusMap[backendStatus] || "configuring";
};

// Helper: map a backend integration to the UI Integration type using CONNECTOR_REGISTRY
const mapBackendToUIIntegration = (backend: BackendIntegration, index: number): Integration => {
  const connectorDef = getConnectorDefinition(backend.integrationType as IntegrationType);
  const isConnected = backend.status === "CONNECTED";

  return {
    id: String(index + 1),
    integrationId: backend.integrationId,
    name: connectorDef?.name ?? backend.name ?? backend.integrationType,
    description: connectorDef?.description ?? `${backend.integrationType} integration`,
    category: connectorDef?.category ?? "other",
    provider: connectorDef?.provider ?? "Unknown",
    status: mapBackendStatus(backend.status),
    backendStatus: backend.status,
    icon: getIconName(connectorDef?.icon),
    isPopular: connectorDef?.isPopular ?? false,
    lastSync: isConnected ? new Date(backend.updatedAt).toLocaleString() : "Never",
    features: [],
    pricing: "free",
    setupComplexity: "medium",
    integrationType: backend.integrationType,
    orgId: backend.orgId,
    config: backend.config,
    createdAt: backend.createdAt,
    updatedAt: backend.updatedAt,
    errorMessage: backend.errorMessage,
  };
};

export function Integrations() {
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedCategory, setSelectedCategory] = useState("all");
  const [searchTerm, setSearchTerm] = useState("");
  const [viewMode, setViewMode] = useState<"connected" | "available" | "graph">("graph");
  const [configDialogOpen, setConfigDialogOpen] = useState(false);
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [selectedIntegration, setSelectedIntegration] = useState<Integration | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  
  // New state for connector type selection
  const [selectedConnectorType, setSelectedConnectorType] = useState<ConnectorType | null>(null);
  const [showConnectorSelector, setShowConnectorSelector] = useState(true);

  useEffect(() => {
    loadIntegrations();
  }, []);

  const loadIntegrations = async () => {
    try {
      setLoading(true);
      // Fetch all integrations from the backend (any status)
      const backendIntegrations = await integrationServiceBackend.listIntegrations('default');
      
      // Map ALL backend integrations to UI representations
      const uiIntegrations = backendIntegrations.map((backend, index) =>
        mapBackendToUIIntegration(backend, index)
      );
      
      setIntegrations(uiIntegrations);
    } catch (error) {
      console.error('Error loading integrations:', error);
      // On failure, show empty state instead of mocks
      setIntegrations([]);
    } finally {
      setLoading(false);
    }
  };

  const handleConfigure = async (formData: ConnectorFormData) => {
    if (!selectedIntegration?.integrationId) return;
    setActionLoading('configure');
    setMessage(null);
    
    // Check if integration was previously connected
    const wasConnected = selectedIntegration.backendStatus === 'CONNECTED';
    
    try {
      // Build config object based on connector type
      const config: Record<string, any> = {
        ...formData.config
      };
      
      // Add default fields for specific connectors if needed
      const integrationType = selectedIntegration.integrationType as IntegrationType;
      if (integrationType === 'CONFLUENCE' || integrationType === 'JIRA') {
        config.spaceKeys = config.spaceKeys || [];
        config.enabledFeatures = config.enabledFeatures || [];
      }
      
      const updatePayload: any = {
        integrationId: selectedIntegration.integrationId,
        config
      };
      
      // Only update credentials if any were provided (non-empty credentials object)
      if (Object.keys(formData.credentials).length > 0) {
        updatePayload.credentials = formData.credentials;
      }
      
      await integrationServiceBackend.updateIntegration(updatePayload);
      
      // Show context-aware success message
      const successMessage = wasConnected 
        ? 'Configuration updated successfully. Please test the connection to verify the changes, then reconnect.'
        : 'Configuration updated successfully. You can now test the connection.';
      
      setMessage({ type: 'success', text: successMessage });
      setConfigDialogOpen(false);
      await loadIntegrations();
    } catch (error: any) {
      setMessage({ type: 'error', text: error.message || 'Configuration failed' });
    } finally {
      setActionLoading(null);
    }
  };

  const handleAddIntegration = async (formData: ConnectorFormData) => {
    console.log('=== handleAddIntegration START ===');
    console.log('selectedConnectorType:', selectedConnectorType);
    console.log('formData:', formData);
    
    if (!selectedConnectorType) {
      console.error('No connector type selected!');
      return;
    }
    
    setActionLoading('add');
    setMessage(null);
    try {
      // Build config object based on connector type
      const config: Record<string, any> = {
        ...formData.config
      };
      
      console.log('Config before processing:', config);
      
      // Add default fields for specific connectors if needed
      if (selectedConnectorType.id === 'CONFLUENCE' || selectedConnectorType.id === 'JIRA') {
        config.spaceKeys = config.spaceKeys || [];
        config.enabledFeatures = config.enabledFeatures || [];
      }
      
      console.log('Config after processing:', config);
      
      const integrationInput = {
        name: formData.name,
        integrationType: selectedConnectorType.id,
        orgId: "default",
        config,
        credentials: formData.credentials
      };
      
      console.log('Integration input to be sent:', integrationInput);
      console.log('Calling createIntegration...');
      
      const result = await integrationServiceBackend.createIntegration(integrationInput);
      
      console.log('createIntegration returned successfully:', result);
      
      setMessage({ type: 'success', text: `${formData.name} created successfully! Your credentials are securely saved. Click "Test Connection" to verify, then "Connect" to activate.` });
      setAddDialogOpen(false);
      setSelectedConnectorType(null);
      setShowConnectorSelector(true);
      
      console.log('Loading integrations...');
      await loadIntegrations();
      console.log('=== handleAddIntegration SUCCESS ===');
    } catch (error: any) {
      console.error('=== handleAddIntegration ERROR ===');
      console.error('Error object:', error);
      console.error('Error message:', error.message);
      console.error('Error stack:', error.stack);
      console.error('Error details:', JSON.stringify(error, null, 2));
      
      const errorMessage = error.message || 'Failed to create integration';
      console.error('Setting error message:', errorMessage);
      setMessage({ type: 'error', text: errorMessage });
    } finally {
      console.log('=== handleAddIntegration FINALLY ===');
      setActionLoading(null);
    }
  };

  const handleTest = async (integration: Integration) => {
    if (!integration.integrationId) return;
    
    console.log('=== handleTest START ===');
    console.log('Testing integration:', integration.integrationId, integration.name);
    
    setActionLoading(`test-${integration.id}`);
    setMessage(null);
    try {
      console.log('Calling testIntegration...');
      const result = await integrationServiceBackend.testIntegration(integration.integrationId);
      
      console.log('Test result:', result);
      
      if (result.success) {
        setMessage({ type: 'success', text: 'Connection test successful! You can now connect.' });
        await loadIntegrations();
      } else {
        console.error('Test failed:', result);
        setMessage({ type: 'error', text: `${result.message}${result.details ? ` - Details: ${JSON.stringify(result.details)}` : ''}` });
      }
    } catch (error: any) {
      console.error('Test error (exception):', error);
      console.error('Error details:', JSON.stringify(error, null, 2));
      setMessage({ type: 'error', text: error.message || 'Connection test failed' });
    } finally {
      console.log('=== handleTest END ===');
      setActionLoading(null);
    }
  };

  const handleConnect = async (integration: Integration) => {
    if (!integration.integrationId) {
      // If no integrationId, need to create first
      setSelectedIntegration(integration);
      setAddDialogOpen(true);
      return;
    }
    
    console.log('Connect clicked, integrationId:', integration.integrationId);
    setActionLoading(`connect-${integration.id}`);
    setMessage(null);
    try {
      console.log('Calling connectIntegration...');
      await integrationServiceBackend.connectIntegration(integration.integrationId);
      console.log('connectIntegration returned');
      setMessage({ type: 'success', text: 'Connecting...' });
      await loadIntegrations();
      
      // Poll for status updates
      const pollInterval = setInterval(async () => {
        const backendIntegrations = await integrationServiceBackend.listIntegrations();
        const updated = backendIntegrations.find(i => i.integrationId === integration.integrationId);
        if (updated) {
          await loadIntegrations();
          if (updated.status === 'CONNECTED') {
            setMessage({ type: 'success', text: 'Connected successfully!' });
            clearInterval(pollInterval);
            setActionLoading(null);
          } else if (updated.status === 'CONNECTION_FAILED') {
            setMessage({ type: 'error', text: updated.errorMessage || 'Connection failed' });
            clearInterval(pollInterval);
            setActionLoading(null);
          }
        }
      }, 2000);
      
      setTimeout(() => {
        clearInterval(pollInterval);
        setActionLoading(null);
      }, 30000);
    } catch (error: any) {
      console.error('Connect error:', error);
      setMessage({ type: 'error', text: error.message || 'Connection failed' });
      setActionLoading(null);
    }
  };

  const handleDisconnect = async (integration: Integration) => {
    if (!integration.integrationId) return;
    setActionLoading(`disconnect-${integration.id}`);
    setMessage(null);
    try {
      await integrationServiceBackend.disconnectIntegration(integration.integrationId);
      setMessage({ type: 'success', text: 'Integration disconnected. You can reconnect anytime.' });
      await loadIntegrations();
    } catch (error: any) {
      setMessage({ type: 'error', text: error.message || 'Disconnect failed' });
    } finally {
      setActionLoading(null);
    }
  };

  const handleDelete = async (integration: Integration) => {
    if (!integration.integrationId) return;
    
    // Confirm deletion
    if (!confirm(`Are you sure you want to delete "${integration.name}"? This will permanently remove the integration and all its credentials.`)) {
      return;
    }
    
    setActionLoading(`delete-${integration.id}`);
    setMessage(null);
    try {
      await integrationServiceBackend.deleteIntegration(integration.integrationId);
      setMessage({ type: 'success', text: `${integration.name} deleted successfully.` });
      await loadIntegrations();
    } catch (error: any) {
      setMessage({ type: 'error', text: error.message || 'Delete failed' });
    } finally {
      setActionLoading(null);
    }
  };

  const handleConfigureClick = (integration: Integration) => {
    setSelectedIntegration(integration);
    setConfigDialogOpen(true);
  };

  // Update category counts dynamically
  const getCategoryCount = (categoryId: string) => {
    if (categoryId === "all") return integrations.length;
    return integrations.filter(i => i.category === categoryId).length;
  };

  const filteredIntegrations = integrations.filter(integration => {
    const matchesCategory = selectedCategory === "all" || integration.category === selectedCategory;
    const matchesSearch = integration.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
                         integration.description.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesView = viewMode === "connected" ? 
      integration.status === "connected" || integration.status === "CONNECTED" :
      viewMode === "available" ? true : true;
    
    return matchesCategory && matchesSearch && matchesView;
  });

  const connectedIntegrations = integrations.filter(i => 
    i.status === "connected" || i.status === "CONNECTED"
  );

  if (loading) {
    return (
      <PageContainer className="flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full size-12 border-b-2 border-primary mx-auto mb-4"></div>
          <p className="text-muted-foreground">Loading integrations...</p>
        </div>
      </PageContainer>
    );
  }

  return (
    <PageContainer className="flex flex-col w-full max-w-full box-border min-w-0">
      
      <div className="flex items-center justify-between shrink-0 mb-3">
        <div>
          <h1 className="text-2xl font-semibold mb-0">Integrations</h1>
          <p className="text-muted-foreground text-xs">
            Manage your connected services and data sources
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button 
            variant="outline" 
            className="gap-1 text-xs py-1 px-2 h-7"
            onClick={() => {
              setSelectedConnectorType(null);
              setShowConnectorSelector(true);
              setAddDialogOpen(true);
            }}
          >
            <Plug className="size-3" />
            Add Connectors
          </Button>
        </div>
      </div>

      {message && (
        <div className={`mb-3 p-3 rounded-md text-sm ${message.type === 'success' ? 'bg-chart-2/10 text-chart-2' : 'bg-destructive/10 text-destructive'}`}>
          {message.text}
        </div>
      )}

      <Tabs value={viewMode} onValueChange={(value: string) => setViewMode(value as "connected" | "available" | "graph")} className="shrink-0">
        <TabsList className="shrink-0 mb-2">
          <TabsTrigger value="graph" className="text-xs px-3 py-1">
            <Share2 className="size-3 mr-1" />
            Integration Graph
          </TabsTrigger>
          <TabsTrigger value="connected" className="text-xs px-3 py-1">
            Connected ({connectedIntegrations.length})
          </TabsTrigger>
          <TabsTrigger value="available" className="text-xs px-3 py-1">Available</TabsTrigger>
        </TabsList>

        <div className="min-w-0">
          {/* Graph View */}
          <TabsContent value="graph" className="h-auto m-0 p-0">
            <div className="w-full rounded-lg bg-card border border-dashed border-primary/20 p-8 box-border"
              /* Inline style required: CSS linear-gradient background cannot be expressed as a single Tailwind utility */
              style={{
                backgroundImage: 'linear-gradient(to bottom, #0f1419, #1a1f2e)',
              }}>
              <div className="flex flex-col items-center justify-center gap-8">
                {/* Factory Core */}
                <div className="relative">
                  <div className="absolute inset-0 rounded-2xl animate-ping bg-chart-4 opacity-30"></div>
                  <div className="relative rounded-2xl px-12 py-8 shadow-[0_0_40px_rgba(249,115,22,0.5)]"
                    /* Inline style required: CSS linear-gradient cannot be expressed as a single Tailwind utility */
                    style={{
                    background: 'linear-gradient(135deg, #f97316 0%, #ea580c 100%)',
                  }}>
                    <div className="flex flex-col items-center gap-3">
                      <Plug className="size-14 text-foreground" />
                      <div className="text-center">
                        <h3 className="font-bold text-lg text-foreground">Integration Core</h3>
                        <p className="text-sm text-foreground/90">Multi-Agent System</p>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Connected Integrations */}
                {connectedIntegrations.length > 0 && (
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4 w-full max-w-4xl">
                    {connectedIntegrations.map((integration) => {
                      const Icon = getIconComponent(integration.icon);
                      return (
                        <div
                          key={integration.id}
                          className="hover:shadow-lg transition-all cursor-pointer bg-card border-2 border-chart-2 rounded-lg p-4"
                        >
                          <div className="flex items-center gap-3">
                            <Icon className="size-6 text-chart-2" />
                            <div className="flex-1">
                              <p className="font-medium text-foreground text-sm">{integration.name}</p>
                              <p className="text-xs text-muted-foreground">Connected</p>
                            </div>
                            <CheckCircle className="size-5 text-chart-2" />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                {connectedIntegrations.length === 0 && (
                  <div className="text-center text-muted-foreground">
                    <p className="text-sm">No integrations connected yet</p>
                  </div>
                )}
              </div>
            </div>
          </TabsContent>

          {/* Connected/Available Views */}
          <TabsContent value={viewMode} className="flex flex-col gap-6">
            {/* Search and Filter */}
            <div className="flex items-center gap-4 mt-[15px]">
              <div className="flex-1 max-w-md">
                <SearchInput
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  placeholder="Search integrations..."
                />
              </div>
            </div>

            {/* Categories */}
            <div className="flex flex-wrap gap-2">
              {categories.map((category) => {
                const Icon = category.icon;
                const isActive = selectedCategory === category.id;

                return (
                  <button
                    key={category.id}
                    className={cn(
                      "flex items-center gap-2 px-3 py-1.5 rounded-full text-sm font-medium transition-all whitespace-nowrap",
                      isActive
                        ? "bg-primary text-primary-foreground border border-primary"
                        : "bg-transparent text-muted-foreground border border-border"
                    )}
                    onClick={() => setSelectedCategory(category.id)}
                  >
                    <Icon className="size-4 shrink-0" />
                    <span className="whitespace-nowrap">{category.label}</span>
                    <span
                      className={cn(
                        "text-sm shrink-0",
                        isActive ? "text-primary-foreground" : "text-muted-foreground"
                      )}
                    >
                      {getCategoryCount(category.id)}
                    </span>
                  </button>
                );
              })}
            </div>

            {/* Integrations Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {filteredIntegrations.map((integration) => {
                const Icon = getIconComponent(integration.icon);
                // Status is already normalized in loadIntegrations, don't map it again
                const normalizedStatus = integration.status as "connected" | "disconnected" | "error" | "configuring";
                const StatusIcon = statusIcons[normalizedStatus] || statusIcons[integration.backendStatus || 'disconnected'];
                
                // Get auth method from connector definition if integration type is available
                let authMethod: string | undefined;
                if (integration.integrationType) {
                  const connectorDef = getConnectorDefinition(integration.integrationType as IntegrationType);
                  authMethod = connectorDef?.authMethod;
                }
                
                // Create normalized integration for IntegrationCard
                const normalizedIntegration = {
                  ...integration,
                  status: normalizedStatus
                };
                
                return (
                  <IntegrationCard
                    key={integration.id}
                    integration={normalizedIntegration as any}
                    icon={Icon}
                    statusIcon={StatusIcon}
                    backendStatus={integration.backendStatus}
                    authMethod={authMethod}
                    onConfigure={(integration) => handleConfigureClick(integration as Integration)}
                    onTest={(integration) => handleTest(integration as Integration)}
                    onConnect={(integration) => handleConnect(integration as Integration)}
                    onDisconnect={(integration) => handleDisconnect(integration as Integration)}
                    onDelete={(integration) => handleDelete(integration as Integration)}
                  />
                );
              })}
            </div>

            {filteredIntegrations.length === 0 && (
              <div className="text-center py-12">
                <Plug className="size-12 text-muted-foreground mx-auto mb-4" />
                <h3 className="text-lg font-medium mb-2 text-muted-foreground">No integrations found</h3>
                <p className="text-muted-foreground">
                  Try adjusting your search or category filters
                </p>
              </div>
            )}
          </TabsContent>
        </div>
      </Tabs>

      {/* Add Integration Dialog with Connector Type Selection */}
      <Dialog open={addDialogOpen} onOpenChange={(open: boolean) => {
        setAddDialogOpen(open);
        if (!open) {
          setSelectedConnectorType(null);
          setShowConnectorSelector(true);
        }
      }}>
        <DialogContent 
          className="max-h-[85vh] overflow-y-auto bg-card border border-border sm:max-w-[80rem] w-[90vw]"
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-foreground">
              {selectedConnectorType ? (
                <>
                  {(() => {
                    const Icon = selectedConnectorType.icon;
                    return <Icon className="size-5" />;
                  })()}
                  Add {selectedConnectorType.name} Integration
                </>
              ) : (
                <>
                  <Plug className="size-5" />
                  Add Integration
                </>
              )}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {selectedConnectorType
                ? `Configure your ${selectedConnectorType.name} integration`
                : 'Select a connector type to get started'}
            </DialogDescription>
          </DialogHeader>

          <div className="py-4">
            {showConnectorSelector && !selectedConnectorType ? (
              <ConnectorTypeSelector
                onSelect={(connectorType) => {
                  setSelectedConnectorType(connectorType);
                  setShowConnectorSelector(false);
                }}
                selectedType={selectedConnectorType || undefined}
              />
            ) : selectedConnectorType ? (
              <DynamicConnectorForm
                connectorType={selectedConnectorType}
                onSubmit={handleAddIntegration}
                mode="create"
                onCancel={() => {
                  setSelectedConnectorType(null);
                  setShowConnectorSelector(true);
                }}
              />
            ) : null}
          </div>
        </DialogContent>
      </Dialog>

      {/* Configure Integration Dialog */}
      <Dialog open={configDialogOpen} onOpenChange={setConfigDialogOpen}>
        <DialogContent 
          className="max-h-[85vh] overflow-y-auto bg-card border border-border sm:max-w-3xl w-[90vw]"
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-foreground">
              {selectedIntegration && (() => {
                const Icon = getIconComponent(selectedIntegration.icon);
                return <Icon className="size-5" />;
              })()}
              Configure {selectedIntegration?.name}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              Update your {selectedIntegration?.name} integration settings. Credentials are masked for security - leave them as-is to keep existing values, or enter new ones to update.
            </DialogDescription>
          </DialogHeader>

          <div className="py-4">
            {selectedIntegration?.integrationType ? (
              (() => {
                const integrationType = selectedIntegration.integrationType as IntegrationType;
                const connectorDef = getConnectorDefinition(integrationType);
                
                if (!connectorDef) {
                  return (
                    <div className="text-sm text-muted-foreground">
                      Configuration interface for {selectedIntegration.name} is not available.
                    </div>
                  );
                }
                
                // Create connector type object for the form
                const connectorType: ConnectorType = {
                  id: connectorDef.type,
                  name: connectorDef.name,
                  description: connectorDef.description,
                  icon: connectorDef.icon,
                  authMethod: connectorDef.authMethod,
                  provider: connectorDef.provider,
                  category: connectorDef.category,
                  isPopular: connectorDef.isPopular
                };
                
                // Prepare initial values
                // For edit mode, we need to populate credentials from config
                // because the backend stores email in config, but the form expects it in credentials
                const initialCredentials: Record<string, string> = {};
                
                // Parse config if it's a string
                const parsedConfig = typeof selectedIntegration.config === 'string' 
                  ? JSON.parse(selectedIntegration.config) 
                  : selectedIntegration.config;
                
                if (connectorDef.formConfig.authFields && parsedConfig) {
                  connectorDef.formConfig.authFields.forEach((field) => {
                    const configValue = parsedConfig[field.name];
                    if (configValue !== undefined && configValue !== null) {
                      initialCredentials[field.name] = String(configValue);
                    }
                  });
                }
                
                const initialValues = {
                  name: selectedIntegration.name,
                  credentials: initialCredentials,
                  config: parsedConfig || {}
                };
                
                return (
                  <DynamicConnectorForm
                    connectorType={connectorType}
                    onSubmit={handleConfigure}
                    initialValues={initialValues}
                    mode="edit"
                    onCancel={() => setConfigDialogOpen(false)}
                  />
                );
              })()
            ) : (
              <div className="flex flex-col gap-4">
                <p className="text-sm text-muted-foreground">
                  Configuration interface for {selectedIntegration?.name} will be displayed here.
                </p>
                {selectedIntegration?.protocol && (
                  <div className="p-4 bg-muted rounded-lg">
                    <p className="text-sm font-medium mb-2">Protocol Information</p>
                    <Badge variant={(protocolVariant[selectedIntegration.protocol] || 'secondary') as any}>
                      {selectedIntegration.protocol}
                    </Badge>
                  </div>
                )}
                <div className="flex gap-2">
                  <Button className="flex-1" disabled>Mock Integration</Button>
                  <Button variant="outline" onClick={() => setConfigDialogOpen(false)}>Cancel</Button>
                </div>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </PageContainer>
  );
}

export default Integrations;
