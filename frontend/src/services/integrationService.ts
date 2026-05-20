import serverService from './server';

export interface Integration {
  id: string;
  name: string;
  description: string;
  category: string;
  provider: string;
  status: "connected" | "disconnected" | "error" | "configuring";
  icon: string; // Store icon name as string instead of component
  isPopular: boolean;
  lastSync: string;
  features: string[];
  pricing: "free" | "paid" | "freemium";
  setupComplexity: "easy" | "medium" | "advanced";
  protocol?: string;
}

// Mock data - will be replaced with AppSync queries later
const mockIntegrations: Integration[] = [
  {
    id: "1",
    name: "Confluence",
    description: "Connect to Atlassian Confluence for documentation and knowledge base management",
    category: "productivity",
    provider: "Atlassian",
    status: "disconnected",
    icon: "BookOpen",
    isPopular: true,
    lastSync: "Never",
    features: ["Documentation", "Knowledge base", "Team collaboration", "Page management", "Space organization"],
    pricing: "freemium",
    setupComplexity: "medium",
    protocol: "REST"
  },
  {
    id: "2",
    name: "Slack",
    description: "Send notifications and updates to Slack channels when workflows complete",
    category: "communication",
    provider: "Slack Technologies",
    status: "connected",
    icon: "MessageSquare",
    isPopular: true,
    lastSync: "2 minutes ago",
    features: ["Real-time notifications", "Channel routing", "Custom messages", "Thread replies"],
    pricing: "free",
    setupComplexity: "easy",
    protocol: "REST"
  },
  {
    id: "4",
    name: "Google Workspace",
    description: "Access Gmail, Drive, Sheets, and other Google services for data processing",
    category: "productivity", 
    provider: "Google",
    status: "connected",
    icon: "Mail",
    isPopular: true,
    lastSync: "5 minutes ago",
    features: ["Gmail API", "Drive storage", "Sheets integration", "Calendar sync"],
    pricing: "freemium",
    setupComplexity: "medium",
    protocol: "REST"
  },
  {
    id: "4",
    name: "Salesforce",
    description: "Sync customer data and automate CRM workflows with AI insights",
    category: "crm",
    provider: "Salesforce",
    status: "disconnected",
    icon: "Users",
    isPopular: true,
    lastSync: "Never",
    features: ["Lead management", "Contact sync", "Opportunity tracking", "Custom fields"],
    pricing: "paid",
    setupComplexity: "advanced",
    protocol: "REST"
  },
  {
    id: "5",
    name: "Stripe",
    description: "Process payments and handle billing automation for AI services",
    category: "payments",
    provider: "Stripe",
    status: "configuring",
    icon: "CreditCard",
    isPopular: false,
    lastSync: "Configuring",
    features: ["Payment processing", "Subscription billing", "Invoice generation", "Webhook events"],
    pricing: "paid",
    setupComplexity: "medium",
    protocol: "REST"
  },
  {
    id: "6",
    name: "AWS S3",
    description: "Store and retrieve files, documents, and processed data in cloud storage",
    category: "storage",
    provider: "Amazon Web Services",
    status: "connected",
    icon: "Cloud",
    isPopular: true,
    lastSync: "1 hour ago",
    features: ["File storage", "Data backup", "CDN integration", "Encryption"],
    pricing: "paid",
    setupComplexity: "medium",
    protocol: "REST"
  },
  {
    id: "7",
    name: "Zapier",
    description: "Connect to 5000+ apps and services through Zapier's automation platform",
    category: "automation",
    provider: "Zapier",
    status: "error",
    icon: "Settings",
    isPopular: true,
    lastSync: "Error",
    features: ["Multi-app workflows", "Trigger events", "Data transformation", "Conditional logic"],
    pricing: "freemium",
    setupComplexity: "easy",
    protocol: "REST"
  },
  {
    id: "8",
    name: "PostgreSQL",
    description: "Connect to PostgreSQL databases for data analysis and storage",
    category: "database",
    provider: "PostgreSQL Global Development Group",
    status: "disconnected",
    icon: "Database",
    isPopular: false,
    lastSync: "Never",
    features: ["SQL queries", "Data export", "Real-time sync", "Custom schemas"],
    pricing: "free",
    setupComplexity: "advanced",
    protocol: "Direct API"
  },
  {
    id: "9",
    name: "Tableau",
    description: "Create interactive dashboards and visualizations from AI analysis results",
    category: "analytics",
    provider: "Tableau",
    status: "disconnected",
    icon: "BarChart3",
    isPopular: false,
    lastSync: "Never",
    features: ["Data visualization", "Interactive dashboards", "Report generation", "Data blending"],
    pricing: "paid",
    setupComplexity: "medium",
    protocol: "REST"
  },
  {
    id: "10",
    name: "Canva MCP Server",
    description: "MCP protocol integration for Canva - access design tools, templates, and creative automation capabilities",
    category: "productivity",
    provider: "Canva (MCP Protocol)",
    status: "connected",
    icon: "FileText",
    isPopular: true,
    lastSync: "3 minutes ago",
    features: ["Design templates", "Asset management", "Brand kit access", "Export automation", "Collaboration tools"],
    pricing: "freemium",
    setupComplexity: "medium",
    protocol: "MCP"
  },
  {
    id: "11",
    name: "Anthropic Claude",
    description: "Connect to Claude via MCP protocol for advanced conversational AI capabilities and code analysis",
    category: "ai-services",
    provider: "Anthropic",
    status: "connected",
    icon: "Zap",
    isPopular: true,
    lastSync: "1 minute ago",
    features: ["Conversational AI", "Long context", "Tool use", "Agent capabilities", "Code analysis"],
    pricing: "paid",
    setupComplexity: "medium",
    protocol: "MCP"
  },
  {
    id: "12",
    name: "Atlassian Jira & Confluence",
    description: "MCP integration for Atlassian Jira issue tracking and Confluence documentation platform",
    category: "productivity",
    provider: "Atlassian",
    status: "connected",
    icon: "FileText",
    isPopular: true,
    lastSync: "5 minutes ago",
    features: ["Issue tracking", "Documentation", "Project management", "Team collaboration", "Knowledge base"],
    pricing: "freemium",
    setupComplexity: "medium",
    protocol: "MCP"
  },
  {
    id: "13",
    name: "BitBucket",
    description: "MCP integration for Atlassian BitBucket - Git repository management and code collaboration",
    category: "productivity",
    provider: "Atlassian",
    status: "connected",
    icon: "GitBranch",
    isPopular: true,
    lastSync: "8 minutes ago",
    features: ["Repository access", "Code review", "Branch management", "Pull requests", "Version control"],
    pricing: "freemium",
    setupComplexity: "medium",
    protocol: "MCP"
  },
  {
    id: "14",
    name: "Filesystem",
    description: "MCP integration for local and remote filesystem access - read, write, and manage files",
    category: "storage",
    provider: "MCP Protocol",
    status: "connected",
    icon: "FileText",
    isPopular: false,
    lastSync: "3 minutes ago",
    features: ["File operations", "Directory management", "File search", "Path resolution", "File monitoring"],
    pricing: "free",
    setupComplexity: "easy",
    protocol: "MCP"
  },
  {
    id: "15",
    name: "GitHub",
    description: "API integration for GitHub - repository management, issues, pull requests, and actions",
    category: "productivity",
    provider: "GitHub",
    status: "connected",
    icon: "GitBranch",
    isPopular: true,
    lastSync: "4 minutes ago",
    features: ["Repository management", "Issue tracking", "Pull requests", "Actions", "Webhooks", "Code search"],
    pricing: "freemium",
    setupComplexity: "medium",
    protocol: "REST"
  },
  {
    id: "16",
    name: "Atlassian Rovo Agent",
    description: "A2A protocol integration for Atlassian Rovo - AI-powered agent for knowledge discovery and team collaboration",
    category: "ai-services",
    provider: "Atlassian",
    status: "connected",
    icon: "Brain",
    isPopular: true,
    lastSync: "2 minutes ago",
    features: ["Knowledge discovery", "Team collaboration", "Agent-to-Agent communication", "Context sharing", "Smart search"],
    pricing: "freemium",
    setupComplexity: "medium",
    protocol: "A2A"
  },
  {
    id: "17",
    name: "OAuth 2.0",
    description: "Industry-standard protocol for authorization - secure delegated access to user resources",
    category: "security",
    provider: "OAuth Foundation",
    status: "connected",
    icon: "Key",
    isPopular: true,
    lastSync: "1 minute ago",
    features: ["Token-based authentication", "Delegated access", "Scope management", "Refresh tokens", "Client credentials"],
    pricing: "free",
    setupComplexity: "medium",
    protocol: "Identity"
  },
  {
    id: "18",
    name: "OpenID Connect (OIDC)",
    description: "Authentication layer on top of OAuth 2.0 - verify user identity and obtain profile information",
    category: "security",
    provider: "OpenID Foundation",
    status: "connected",
    icon: "UserCheck",
    isPopular: true,
    lastSync: "3 minutes ago",
    features: ["Identity verification", "SSO support", "User profile claims", "ID tokens", "Session management"],
    pricing: "free",
    setupComplexity: "medium",
    protocol: "Identity"
  },
  {
    id: "19",
    name: "LDAP",
    description: "Lightweight Directory Access Protocol - access and manage directory information services",
    category: "security",
    provider: "IETF",
    status: "connected",
    icon: "Users",
    isPopular: false,
    lastSync: "10 minutes ago",
    features: ["Directory services", "User authentication", "Group management", "Organizational hierarchy", "Attribute queries"],
    pricing: "free",
    setupComplexity: "advanced",
    protocol: "Identity"
  },
  {
    id: "20",
    name: "SAML",
    description: "Security Assertion Markup Language - XML-based standard for exchanging authentication and authorization data",
    category: "security",
    provider: "OASIS",
    status: "connected",
    icon: "Lock",
    isPopular: false,
    lastSync: "5 minutes ago",
    features: ["Single Sign-On (SSO)", "Identity federation", "Cross-domain authentication", "Assertion-based", "Service provider integration"],
    pricing: "free",
    setupComplexity: "advanced",
    protocol: "Identity"
  }
];

// GraphQL queries (to be implemented later)
const listIntegrationsQuery = `
  query ListIntegrations {
    listIntegrations {
      id
      name
      description
      category
      provider
      status
      icon
      isPopular
      lastSync
      features
      pricing
      setupComplexity
      protocol
    }
  }
`;

const getIntegrationQuery = `
  query GetIntegration($id: String!) {
    getIntegration(id: $id) {
      id
      name
      description
      category
      provider
      status
      icon
      isPopular
      lastSync
      features
      pricing
      setupComplexity
      protocol
    }
  }
`;

const updateIntegrationStatusMutation = `
  mutation UpdateIntegrationStatus($id: String!, $status: String!) {
    updateIntegrationStatus(id: $id, status: $status) {
      id
      status
      lastSync
    }
  }
`;

export const integrationService = {
  async listIntegrations(): Promise<Integration[]> {
    try {
      // TODO: Replace with actual AppSync query
      // const response = await serverService.query<{ listIntegrations: Integration[] }>(
      //   listIntegrationsQuery
      // );
      // return response.listIntegrations || [];
      
      // For now, return mock data
      return Promise.resolve(mockIntegrations);
    } catch (error) {
      console.error('Error listing integrations:', error);
      throw error;
    }
  },

  async getIntegration(id: string): Promise<Integration | null> {
    try {
      // TODO: Replace with actual AppSync query
      // const response = await serverService.query<{ getIntegration: Integration | null }>(
      //   getIntegrationQuery,
      //   { id }
      // );
      // return response.getIntegration;
      
      // For now, return mock data
      const integration = mockIntegrations.find(i => i.id === id);
      return Promise.resolve(integration || null);
    } catch (error) {
      console.error('Error getting integration:', error);
      throw error;
    }
  },

  async updateIntegrationStatus(
    id: string, 
    status: "connected" | "disconnected" | "error" | "configuring"
  ): Promise<Integration> {
    try {
      // TODO: Replace with actual AppSync mutation
      // const response = await serverService.mutate<{ updateIntegrationStatus: Integration }>(
      //   updateIntegrationStatusMutation,
      //   { id, status }
      // );
      // return response.updateIntegrationStatus;
      
      // For now, update mock data
      const integration = mockIntegrations.find(i => i.id === id);
      if (!integration) {
        throw new Error(`Integration with id ${id} not found`);
      }
      
      integration.status = status;
      integration.lastSync = status === "connected" ? "Just now" : integration.lastSync;
      
      return Promise.resolve(integration);
    } catch (error) {
      console.error('Error updating integration status:', error);
      throw error;
    }
  },

  async getIntegrationsByCategory(category: string): Promise<Integration[]> {
    try {
      const integrations = await this.listIntegrations();
      return integrations.filter(i => i.category === category);
    } catch (error) {
      console.error('Error getting integrations by category:', error);
      throw error;
    }
  },

  async getIntegrationsByProtocol(protocol: string): Promise<Integration[]> {
    try {
      const integrations = await this.listIntegrations();
      return integrations.filter(i => i.protocol === protocol);
    } catch (error) {
      console.error('Error getting integrations by protocol:', error);
      throw error;
    }
  },

  async getConnectedIntegrations(): Promise<Integration[]> {
    try {
      const integrations = await this.listIntegrations();
      return integrations.filter(i => i.status === "connected");
    } catch (error) {
      console.error('Error getting connected integrations:', error);
      throw error;
    }
  },
};
