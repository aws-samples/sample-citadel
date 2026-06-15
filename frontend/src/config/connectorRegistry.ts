/**
 * Frontend Connector Registry
 * 
 * This module defines the connector registry for the multi-connector support feature.
 * It provides type definitions, connector configurations, and helper functions for
 * managing different integration types.
 */

import {
  BookOpen,
  Settings,
  GitBranch,
  MessageSquare,
  Cloud,
  Users,
  AlertCircle,
  Zap,
  Database,
  Plug,
  type LucideIcon,
} from 'lucide-react';

/**
 * Authentication methods supported by connectors
 */
export type AuthenticationMethod = 'API_KEY' | 'OAUTH2' | 'BASIC_AUTH' | 'BEARER_TOKEN' | 'IAM_ROLE' | 'CONFIGURABLE';

/**
 * Integration types matching the GraphQL schema
 */
export type IntegrationType =
  | 'CONFLUENCE'
  | 'SERVICENOW'
  | 'JIRA'
  | 'SLACK'
  | 'MICROSOFT'
  | 'ZENDESK'
  | 'PAGERDUTY'
  | 'AWS_LAMBDA'
  | 'AWS_SMITHY'
  | 'MCP_SERVER';

/**
 * Form field types
 */
export type FormFieldType = 'text' | 'password' | 'email' | 'url' | 'select' | 'textarea';

/**
 * Conditional field configuration
 */
export interface ConditionalField {
  field: string;
  value: string;
}

/**
 * Select option configuration
 */
export interface SelectOption {
  value: string;
  label: string;
}

/**
 * Form field configuration
 */
export interface ConnectorFormField {
  name: string;
  label: string;
  type: FormFieldType;
  placeholder: string;
  required: boolean;
  helpText?: string;
  sensitive: boolean;
  options?: SelectOption[];
  conditionalOn?: ConditionalField;
  /** Optional default value applied in create mode. */
  defaultValue?: string;
  /** When true, field is rendered inside the "Advanced" collapsible section. */
  advanced?: boolean;
  /**
   * Optional predicate evaluated against the current credentials (and config) values
   * to decide visibility. Use this for multi-condition or negative checks
   * (e.g., "field is empty"). When both `conditionalOn` and `visibleWhen` are set,
   * both must pass for the field to be visible.
   */
  visibleWhen?: (values: Record<string, string>) => boolean;
}

/**
 * Form configuration for a connector
 */
export interface ConnectorFormConfig {
  connectorType: string;
  authFields: ConnectorFormField[];
  configFields: ConnectorFormField[];
}

/**
 * Connector type information
 */
export interface ConnectorType {
  id: IntegrationType;
  name: string;
  description: string;
  icon: LucideIcon;
  authMethod: AuthenticationMethod;
  provider: string;
  category: string;
  isPopular?: boolean;
}

/**
 * Complete connector definition including form configuration
 */
export interface ConnectorDefinition {
  type: IntegrationType;
  name: string;
  description: string;
  icon: LucideIcon;
  authMethod: AuthenticationMethod;
  provider: string;
  category: string;
  isPopular?: boolean;
  formConfig: ConnectorFormConfig;
}

/**
 * Connector Registry
 * 
 * Defines all available connectors with their metadata and form configurations.
 * Each connector includes:
 * - Basic metadata (name, description, icon, provider)
 * - Authentication method
 * - Form field configurations for auth and config
 */
export const CONNECTOR_REGISTRY: Record<IntegrationType, ConnectorDefinition> = {
  CONFLUENCE: {
    type: 'CONFLUENCE',
    name: 'Confluence',
    description: 'Connect to Atlassian Confluence for documentation and knowledge base management',
    icon: BookOpen,
    authMethod: 'API_KEY',
    provider: 'Atlassian',
    category: 'productivity',
    isPopular: true,
    formConfig: {
      connectorType: 'CONFLUENCE',
      authFields: [
        {
          name: 'email',
          label: 'Email',
          type: 'text',
          placeholder: 'user@company.com',
          required: true,
          helpText: 'Your Atlassian account email',
          sensitive: false,
        },
        {
          name: 'apiToken',
          label: 'API Token',
          type: 'password',
          placeholder: 'Your Confluence API token',
          required: true,
          helpText: 'Generate from Atlassian account settings',
          sensitive: true,
        },
      ],
      configFields: [
        {
          name: 'baseUrl',
          label: 'Base URL',
          type: 'url',
          placeholder: 'https://your-domain.atlassian.net',
          required: true,
          helpText: 'Your Confluence instance URL',
          sensitive: false,
        },
      ],
    },
  },
  SERVICENOW: {
    type: 'SERVICENOW',
    name: 'ServiceNow',
    description: 'Connect to ServiceNow for IT service management and workflow automation',
    icon: Settings,
    authMethod: 'BASIC_AUTH',
    provider: 'ServiceNow',
    category: 'automation',
    isPopular: true,
    formConfig: {
      connectorType: 'SERVICENOW',
      authFields: [
        {
          name: 'username',
          label: 'Username',
          type: 'text',
          placeholder: 'admin',
          required: true,
          helpText: 'ServiceNow username',
          sensitive: false,
        },
        {
          name: 'password',
          label: 'Password',
          type: 'password',
          placeholder: 'Your ServiceNow password',
          required: true,
          helpText: 'ServiceNow password',
          sensitive: true,
        },
      ],
      configFields: [
        {
          name: 'instanceUrl',
          label: 'Instance URL',
          type: 'url',
          placeholder: 'https://your-instance.service-now.com',
          required: true,
          helpText: 'Your ServiceNow instance URL',
          sensitive: false,
        },
      ],
    },
  },
  JIRA: {
    type: 'JIRA',
    name: 'Jira',
    description: 'Connect to Atlassian Jira for issue tracking and project management',
    icon: GitBranch,
    authMethod: 'API_KEY',
    provider: 'Atlassian',
    category: 'productivity',
    isPopular: true,
    formConfig: {
      connectorType: 'JIRA',
      authFields: [
        {
          name: 'email',
          label: 'Email',
          type: 'text',
          placeholder: 'user@company.com',
          required: true,
          helpText: 'Your Atlassian account email',
          sensitive: false,
        },
        {
          name: 'apiToken',
          label: 'API Token',
          type: 'password',
          placeholder: 'Your Jira API token',
          required: true,
          helpText: 'Generate from Atlassian account settings',
          sensitive: true,
        },
      ],
      configFields: [
        {
          name: 'baseUrl',
          label: 'Base URL',
          type: 'url',
          placeholder: 'https://your-domain.atlassian.net',
          required: true,
          helpText: 'Your Jira instance URL',
          sensitive: false,
        },
      ],
    },
  },
  SLACK: {
    type: 'SLACK',
    name: 'Slack',
    description: 'Connect to Slack for team communication and notifications',
    icon: MessageSquare,
    authMethod: 'OAUTH2',
    provider: 'Slack Technologies',
    category: 'communication',
    formConfig: {
      connectorType: 'SLACK',
      authFields: [
        {
          name: 'clientId',
          label: 'Client ID',
          type: 'text',
          placeholder: 'Your Slack app client ID',
          required: true,
          helpText: 'From Slack app Basic Information',
          sensitive: false,
        },
        {
          name: 'clientSecret',
          label: 'Client Secret',
          type: 'password',
          placeholder: 'Your Slack app client secret',
          required: true,
          helpText: 'From Slack app Basic Information',
          sensitive: true,
        },
      ],
      configFields: [
        {
          name: 'workspaceId',
          label: 'Workspace ID',
          type: 'text',
          placeholder: 'T01234ABCDE',
          required: true,
          helpText: 'Your Slack workspace ID',
          sensitive: false,
        },
      ],
    },
  },
  MICROSOFT: {
    type: 'MICROSOFT',
    name: 'Microsoft',
    description: 'Connect to Microsoft SharePoint and Teams via Graph API',
    icon: Cloud,
    authMethod: 'OAUTH2',
    provider: 'Microsoft',
    category: 'productivity',
    formConfig: {
      connectorType: 'MICROSOFT',
      authFields: [
        {
          name: 'clientId',
          label: 'Client ID',
          type: 'text',
          placeholder: 'Your Azure app client ID',
          required: true,
          helpText: 'From Azure app registration',
          sensitive: false,
        },
        {
          name: 'clientSecret',
          label: 'Client Secret',
          type: 'password',
          placeholder: 'Your Azure app client secret',
          required: true,
          helpText: 'From Azure app registration',
          sensitive: true,
        },
      ],
      configFields: [
        {
          name: 'tenantId',
          label: 'Tenant ID',
          type: 'text',
          placeholder: 'Your Azure tenant ID',
          required: true,
          helpText: 'From Azure Active Directory',
          sensitive: false,
        },
      ],
    },
  },
  ZENDESK: {
    type: 'ZENDESK',
    name: 'Zendesk',
    description: 'Connect to Zendesk for customer support and ticketing',
    icon: Users,
    authMethod: 'API_KEY',
    provider: 'Zendesk',
    category: 'crm',
    formConfig: {
      connectorType: 'ZENDESK',
      authFields: [
        {
          name: 'email',
          label: 'Email',
          type: 'text',
          placeholder: 'user@company.com',
          required: true,
          helpText: 'Your Zendesk account email',
          sensitive: false,
        },
        {
          name: 'apiToken',
          label: 'API Token',
          type: 'password',
          placeholder: 'Your Zendesk API token',
          required: true,
          helpText: 'Generate from Admin > Channels > API',
          sensitive: true,
        },
      ],
      configFields: [
        {
          name: 'subdomain',
          label: 'Subdomain',
          type: 'text',
          placeholder: 'your-company',
          required: true,
          helpText: 'Your Zendesk subdomain (from your-company.zendesk.com)',
          sensitive: false,
        },
      ],
    },
  },
  PAGERDUTY: {
    type: 'PAGERDUTY',
    name: 'PagerDuty',
    description: 'Connect to PagerDuty for incident management and on-call scheduling',
    icon: AlertCircle,
    authMethod: 'BEARER_TOKEN',
    provider: 'PagerDuty',
    category: 'automation',
    formConfig: {
      connectorType: 'PAGERDUTY',
      authFields: [
        {
          name: 'apiToken',
          label: 'API Token',
          type: 'password',
          placeholder: 'Your PagerDuty API token',
          required: true,
          helpText: 'Generate from Integrations > API Access Keys',
          sensitive: true,
        },
      ],
      configFields: [],
    },
  },
  AWS_LAMBDA: {
    type: 'AWS_LAMBDA',
    name: 'AWS Lambda',
    description: 'Execute custom business logic via Lambda functions as MCP tools',
    icon: Zap,
    authMethod: 'IAM_ROLE',
    provider: 'Amazon Web Services',
    category: 'aws-services',
    isPopular: true,
    formConfig: {
      connectorType: 'AWS_LAMBDA',
      authFields: [
        {
          name: 'executionRoleArn',
          label: 'Execution Role ARN',
          type: 'text',
          placeholder: 'arn:aws:iam::123456789012:role/LambdaExecutionRole',
          required: true,
          helpText: 'IAM role that Lambda function will assume. Must have permissions to invoke the function.',
          sensitive: true,
        },
      ],
      configFields: [
        {
          name: 'lambdaArn',
          label: 'Lambda Function ARN',
          type: 'text',
          placeholder: 'arn:aws:lambda:us-east-1:123456789012:function:MyFunction',
          required: true,
          helpText: 'ARN of the Lambda function to invoke',
          sensitive: false,
        },
        {
          name: 'toolSchema',
          label: 'Tool Schema (JSON)',
          type: 'textarea',
          placeholder: '{"name": "my_tool", "description": "...", "inputSchema": {...}}',
          required: true,
          helpText: 'MCP tool schema defining the function interface. Must include name, description, and inputSchema.',
          sensitive: false,
        },
        {
          name: 'region',
          label: 'AWS Region',
          type: 'text',
          placeholder: 'us-east-1',
          required: true,
          helpText: 'AWS region where the Lambda function is deployed',
          sensitive: false,
        },
      ],
    },
  },
  AWS_SMITHY: {
    type: 'AWS_SMITHY',
    name: 'AWS Services (Smithy)',
    description: 'Direct integration with AWS services like DynamoDB, S3, Lambda, SQS, and SNS',
    icon: Database,
    authMethod: 'IAM_ROLE',
    provider: 'Amazon Web Services',
    category: 'aws-services',
    isPopular: true,
    formConfig: {
      connectorType: 'AWS_SMITHY',
      authFields: [
        {
          name: 'executionRoleArn',
          label: 'Execution Role ARN',
          type: 'text',
          placeholder: 'arn:aws:iam::123456789012:role/ServiceExecutionRole',
          required: true,
          helpText: 'IAM role with permissions to access the AWS service',
          sensitive: true,
        },
      ],
      configFields: [
        {
          name: 'serviceType',
          label: 'AWS Service',
          type: 'select',
          options: [
            { value: 'dynamodb', label: 'DynamoDB' },
            { value: 's3', label: 'S3' },
            { value: 'lambda', label: 'Lambda' },
            { value: 'sqs', label: 'SQS' },
            { value: 'sns', label: 'SNS' },
          ],
          placeholder: 'Select AWS service',
          required: true,
          helpText: 'AWS service to integrate with',
          sensitive: false,
        },
        {
          name: 'region',
          label: 'AWS Region',
          type: 'text',
          placeholder: 'us-east-1',
          required: true,
          helpText: 'AWS region for the service',
          sensitive: false,
        },
      ],
    },
  },
  MCP_SERVER: {
    type: 'MCP_SERVER',
    name: 'MCP Server',
    description: 'Connect to external MCP-compatible servers for specialized tools and third-party services',
    icon: Plug,
    authMethod: 'CONFIGURABLE',
    provider: 'External',
    category: 'integration-platform',
    isPopular: false,
    formConfig: {
      connectorType: 'MCP_SERVER',
      authFields: [
        {
          name: 'authMethod',
          label: 'Authentication Method',
          type: 'select',
          options: [
            { value: 'API_KEY', label: 'API Key' },
            { value: 'OAUTH2', label: 'OAuth 2.0' },
            { value: 'CUSTOM', label: 'Custom' },
          ],
          placeholder: 'Select authentication method',
          required: true,
          helpText: 'How to authenticate with the MCP server',
          sensitive: false,
        },
        {
          name: 'apiKey',
          label: 'API Key',
          type: 'password',
          placeholder: 'Your MCP server API key',
          required: false,
          helpText: 'Required if using API Key authentication',
          sensitive: true,
          conditionalOn: { field: 'authMethod', value: 'API_KEY' },
        },
        {
          name: 'clientId',
          label: 'Client ID',
          type: 'text',
          placeholder: 'OAuth client ID',
          required: false,
          helpText: 'Required if using OAuth 2.0',
          sensitive: false,
          conditionalOn: { field: 'authMethod', value: 'OAUTH2' },
        },
        {
          name: 'clientSecret',
          label: 'Client Secret',
          type: 'password',
          placeholder: 'OAuth client secret',
          required: false,
          helpText: 'Required if using OAuth 2.0',
          sensitive: true,
          conditionalOn: { field: 'authMethod', value: 'OAUTH2' },
        },
        {
          name: 'grantType',
          label: 'Grant Type',
          type: 'select',
          options: [
            { value: 'CLIENT_CREDENTIALS', label: 'Client Credentials' },
            { value: 'AUTHORIZATION_CODE', label: 'Authorization Code (3LO)' },
            { value: 'TOKEN_EXCHANGE', label: 'Token Exchange' },
          ],
          placeholder: 'Select grant type',
          required: true,
          helpText: 'OAuth 2.0 grant type. Use Authorization Code for user-delegated access, Client Credentials for service-to-service.',
          sensitive: false,
          defaultValue: 'CLIENT_CREDENTIALS',
          conditionalOn: { field: 'authMethod', value: 'OAUTH2' },
        },
        {
          name: 'discoveryUrl',
          label: 'Discovery URL',
          type: 'url',
          placeholder: 'https://idp.example.com/.well-known/oauth-authorization-server',
          required: false,
          helpText: "Optional. Provide your IdP's .well-known/oauth-authorization-server URL to auto-discover endpoints.",
          sensitive: false,
          conditionalOn: { field: 'authMethod', value: 'OAUTH2' },
        },
        {
          name: 'authorizationUrl',
          label: 'Authorization URL',
          type: 'url',
          placeholder: 'https://idp.example.com/oauth2/authorize',
          required: true,
          helpText: 'OAuth authorization endpoint (3LO redirect target). Required when no discovery URL is provided.',
          sensitive: false,
          visibleWhen: (values) =>
            values.authMethod === 'OAUTH2' &&
            values.grantType === 'AUTHORIZATION_CODE' &&
            !(values.discoveryUrl ?? '').trim(),
        },
        {
          name: 'tokenUrl',
          label: 'Token URL',
          type: 'url',
          placeholder: 'https://idp.example.com/oauth2/token',
          required: true,
          helpText: 'OAuth token endpoint. Required when no discovery URL is provided.',
          sensitive: false,
          visibleWhen: (values) =>
            values.authMethod === 'OAUTH2' &&
            !(values.discoveryUrl ?? '').trim(),
        },
        {
          name: 'scopes',
          label: 'Scopes',
          type: 'text',
          placeholder: 'read write profile',
          required: true,
          helpText: 'Comma- or space-separated list of OAuth scopes (at least one required).',
          sensitive: false,
          conditionalOn: { field: 'authMethod', value: 'OAUTH2' },
        },
        {
          name: 'clientAuthenticationMethod',
          label: 'Client Authentication Method',
          type: 'select',
          options: [
            { value: 'CLIENT_SECRET_BASIC', label: 'Client Secret Basic (default)' },
            { value: 'CLIENT_SECRET_POST', label: 'Client Secret Post' },
          ],
          placeholder: 'Select method',
          required: false,
          helpText: 'How the client authenticates to the OAuth token endpoint.',
          sensitive: false,
          defaultValue: 'CLIENT_SECRET_BASIC',
          advanced: true,
          conditionalOn: { field: 'authMethod', value: 'OAUTH2' },
        },
      ],
      configFields: [
        {
          name: 'serverUrl',
          label: 'MCP Server URL',
          type: 'url',
          placeholder: 'https://mcp.example.com',
          required: true,
          helpText: 'HTTPS URL of the MCP server endpoint',
          sensitive: false,
        },
      ],
    },
  },
};

/**
 * Get connector definition by type
 * 
 * @param type - The connector type
 * @returns The connector definition or undefined if not found
 */
export function getConnectorDefinition(
  type: IntegrationType
): ConnectorDefinition | undefined {
  return CONNECTOR_REGISTRY[type];
}

/**
 * Get all connector types
 * 
 * Returns connectors ordered by popularity (popular first) then alphabetically
 * 
 * @returns Array of connector types
 */
export function getAllConnectorTypes(): ConnectorType[] {
  const connectors = Object.values(CONNECTOR_REGISTRY).map((def) => ({
    id: def.type,
    name: def.name,
    description: def.description,
    icon: def.icon,
    authMethod: def.authMethod,
    provider: def.provider,
    category: def.category,
    isPopular: def.isPopular,
  }));

  // Sort: popular first, then alphabetically by name
  return connectors.sort((a, b) => {
    if (a.isPopular && !b.isPopular) return -1;
    if (!a.isPopular && b.isPopular) return 1;
    return a.name.localeCompare(b.name);
  });
}

/**
 * Get connectors by category
 * 
 * @param category - The category to filter by
 * @returns Array of connector types in the specified category
 */
export function getConnectorsByCategory(category: string): ConnectorType[] {
  const allConnectors = getAllConnectorTypes();
  return allConnectors.filter((connector) => connector.category === category);
}
