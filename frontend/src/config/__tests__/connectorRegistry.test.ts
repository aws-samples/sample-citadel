/**
 * Unit tests for connector registry
 */

import {
  CONNECTOR_REGISTRY,
  getConnectorDefinition,
  getAllConnectorTypes,
  getConnectorsByCategory,
  type IntegrationType,
} from '../connectorRegistry';

describe('Connector Registry', () => {
  describe('CONNECTOR_REGISTRY', () => {
    it('should contain all 10 connector types', () => {
      const connectorTypes: IntegrationType[] = [
        'CONFLUENCE',
        'SERVICENOW',
        'JIRA',
        'SLACK',
        'MICROSOFT',
        'ZENDESK',
        'PAGERDUTY',
        'AWS_LAMBDA',
        'AWS_SMITHY',
        'MCP_SERVER',
      ];

      connectorTypes.forEach((type) => {
        expect(CONNECTOR_REGISTRY[type]).toBeDefined();
      });
    });

    it('should have required metadata for each connector', () => {
      Object.values(CONNECTOR_REGISTRY).forEach((connector) => {
        expect(connector.type).toBeDefined();
        expect(connector.name).toBeDefined();
        expect(connector.description).toBeDefined();
        expect(connector.icon).toBeDefined();
        expect(connector.authMethod).toBeDefined();
        expect(connector.provider).toBeDefined();
        expect(connector.category).toBeDefined();
        expect(connector.formConfig).toBeDefined();
      });
    });

    it('should have form config with auth fields for each connector', () => {
      Object.values(CONNECTOR_REGISTRY).forEach((connector) => {
        expect(connector.formConfig.connectorType).toBe(connector.type);
        expect(Array.isArray(connector.formConfig.authFields)).toBe(true);
        expect(connector.formConfig.authFields.length).toBeGreaterThan(0);
      });
    });

    it('should have help text for all fields', () => {
      Object.values(CONNECTOR_REGISTRY).forEach((connector) => {
        const allFields = [
          ...connector.formConfig.authFields,
          ...connector.formConfig.configFields,
        ];

        allFields.forEach((field) => {
          expect(field.helpText).toBeDefined();
          expect(field.helpText).not.toBe('');
        });
      });
    });

    it('should mark sensitive fields correctly', () => {
      const confluence = CONNECTOR_REGISTRY.CONFLUENCE;
      const apiTokenField = confluence.formConfig.authFields.find(
        (f) => f.name === 'apiToken'
      );
      const emailField = confluence.formConfig.authFields.find(
        (f) => f.name === 'email'
      );

      expect(apiTokenField?.sensitive).toBe(true);
      expect(emailField?.sensitive).toBe(false);
    });
  });

  describe('getConnectorDefinition', () => {
    it('should return connector definition for valid type', () => {
      const confluence = getConnectorDefinition('CONFLUENCE');
      expect(confluence).toBeDefined();
      expect(confluence?.type).toBe('CONFLUENCE');
      expect(confluence?.name).toBe('Confluence');
    });

    it('should return connector definition for ServiceNow', () => {
      const servicenow = getConnectorDefinition('SERVICENOW');
      expect(servicenow).toBeDefined();
      expect(servicenow?.type).toBe('SERVICENOW');
      expect(servicenow?.authMethod).toBe('BASIC_AUTH');
    });

    it('should return connector definition for Jira', () => {
      const jira = getConnectorDefinition('JIRA');
      expect(jira).toBeDefined();
      expect(jira?.type).toBe('JIRA');
      expect(jira?.authMethod).toBe('API_KEY');
    });

    it('should return connector definition for Slack', () => {
      const slack = getConnectorDefinition('SLACK');
      expect(slack).toBeDefined();
      expect(slack?.type).toBe('SLACK');
      expect(slack?.authMethod).toBe('OAUTH2');
    });

    it('should return connector definition for Microsoft', () => {
      const microsoft = getConnectorDefinition('MICROSOFT');
      expect(microsoft).toBeDefined();
      expect(microsoft?.type).toBe('MICROSOFT');
      expect(microsoft?.authMethod).toBe('OAUTH2');
    });

    it('should return connector definition for Zendesk', () => {
      const zendesk = getConnectorDefinition('ZENDESK');
      expect(zendesk).toBeDefined();
      expect(zendesk?.type).toBe('ZENDESK');
      expect(zendesk?.authMethod).toBe('API_KEY');
    });

    it('should return connector definition for PagerDuty', () => {
      const pagerduty = getConnectorDefinition('PAGERDUTY');
      expect(pagerduty).toBeDefined();
      expect(pagerduty?.type).toBe('PAGERDUTY');
      expect(pagerduty?.authMethod).toBe('BEARER_TOKEN');
    });

    it('should return undefined for invalid type', () => {
      const invalid = getConnectorDefinition('INVALID' as IntegrationType);
      expect(invalid).toBeUndefined();
    });
  });

  describe('getAllConnectorTypes', () => {
    it('should return all 10 connector types', () => {
      const connectors = getAllConnectorTypes();
      expect(connectors).toHaveLength(10);
    });

    it('should return connectors with required properties', () => {
      const connectors = getAllConnectorTypes();
      connectors.forEach((connector) => {
        expect(connector.id).toBeDefined();
        expect(connector.name).toBeDefined();
        expect(connector.description).toBeDefined();
        expect(connector.icon).toBeDefined();
        expect(connector.authMethod).toBeDefined();
        expect(connector.provider).toBeDefined();
        expect(connector.category).toBeDefined();
      });
    });

    it('should order popular connectors first', () => {
      const connectors = getAllConnectorTypes();
      const popularConnectors = connectors.filter((c) => c.isPopular);
      const nonPopularConnectors = connectors.filter((c) => !c.isPopular);

      // All popular connectors should come before non-popular ones
      const firstNonPopularIndex = connectors.findIndex((c) => !c.isPopular);
      if (firstNonPopularIndex > 0) {
        const allBeforeArePopular = connectors
          .slice(0, firstNonPopularIndex)
          .every((c) => c.isPopular);
        expect(allBeforeArePopular).toBe(true);
      }
    });

    it('should order non-popular connectors alphabetically', () => {
      const connectors = getAllConnectorTypes();
      const nonPopularConnectors = connectors.filter((c) => !c.isPopular);

      for (let i = 1; i < nonPopularConnectors.length; i++) {
        const prev = nonPopularConnectors[i - 1].name;
        const curr = nonPopularConnectors[i].name;
        expect(prev.localeCompare(curr)).toBeLessThanOrEqual(0);
      }
    });

    it('should order popular connectors alphabetically among themselves', () => {
      const connectors = getAllConnectorTypes();
      const popularConnectors = connectors.filter((c) => c.isPopular);

      for (let i = 1; i < popularConnectors.length; i++) {
        const prev = popularConnectors[i - 1].name;
        const curr = popularConnectors[i].name;
        expect(prev.localeCompare(curr)).toBeLessThanOrEqual(0);
      }
    });
  });

  describe('getConnectorsByCategory', () => {
    it('should return connectors in productivity category', () => {
      const productivity = getConnectorsByCategory('productivity');
      expect(productivity.length).toBeGreaterThan(0);
      productivity.forEach((connector) => {
        expect(connector.category).toBe('productivity');
      });
    });

    it('should return connectors in automation category', () => {
      const automation = getConnectorsByCategory('automation');
      expect(automation.length).toBeGreaterThan(0);
      automation.forEach((connector) => {
        expect(connector.category).toBe('automation');
      });
    });

    it('should return connectors in communication category', () => {
      const communication = getConnectorsByCategory('communication');
      expect(communication.length).toBeGreaterThan(0);
      communication.forEach((connector) => {
        expect(connector.category).toBe('communication');
      });
    });

    it('should return connectors in crm category', () => {
      const crm = getConnectorsByCategory('crm');
      expect(crm.length).toBeGreaterThan(0);
      crm.forEach((connector) => {
        expect(connector.category).toBe('crm');
      });
    });

    it('should return empty array for non-existent category', () => {
      const nonExistent = getConnectorsByCategory('non-existent');
      expect(nonExistent).toHaveLength(0);
    });

    it('should maintain ordering within category', () => {
      const productivity = getConnectorsByCategory('productivity');
      const popularInCategory = productivity.filter((c) => c.isPopular);
      const nonPopularInCategory = productivity.filter((c) => !c.isPopular);

      // Check popular connectors come first
      if (popularInCategory.length > 0 && nonPopularInCategory.length > 0) {
        const firstNonPopularIndex = productivity.findIndex((c) => !c.isPopular);
        const allBeforeArePopular = productivity
          .slice(0, firstNonPopularIndex)
          .every((c) => c.isPopular);
        expect(allBeforeArePopular).toBe(true);
      }
    });
  });

  describe('Connector-specific configurations', () => {
    it('should configure Confluence with API_KEY auth', () => {
      const confluence = CONNECTOR_REGISTRY.CONFLUENCE;
      expect(confluence.authMethod).toBe('API_KEY');
      expect(confluence.formConfig.authFields).toHaveLength(2);
      expect(confluence.formConfig.authFields.map((f) => f.name)).toContain('email');
      expect(confluence.formConfig.authFields.map((f) => f.name)).toContain('apiToken');
      expect(confluence.formConfig.configFields).toHaveLength(1);
      expect(confluence.formConfig.configFields[0].name).toBe('baseUrl');
    });

    it('should configure ServiceNow with BASIC_AUTH', () => {
      const servicenow = CONNECTOR_REGISTRY.SERVICENOW;
      expect(servicenow.authMethod).toBe('BASIC_AUTH');
      expect(servicenow.formConfig.authFields).toHaveLength(2);
      expect(servicenow.formConfig.authFields.map((f) => f.name)).toContain('username');
      expect(servicenow.formConfig.authFields.map((f) => f.name)).toContain('password');
      expect(servicenow.formConfig.configFields).toHaveLength(1);
      expect(servicenow.formConfig.configFields[0].name).toBe('instanceUrl');
    });

    it('should configure Slack with OAUTH2', () => {
      const slack = CONNECTOR_REGISTRY.SLACK;
      expect(slack.authMethod).toBe('OAUTH2');
      expect(slack.formConfig.authFields).toHaveLength(2);
      expect(slack.formConfig.authFields.map((f) => f.name)).toContain('clientId');
      expect(slack.formConfig.authFields.map((f) => f.name)).toContain('clientSecret');
      expect(slack.formConfig.configFields).toHaveLength(1);
      expect(slack.formConfig.configFields[0].name).toBe('workspaceId');
    });

    it('should configure PagerDuty with BEARER_TOKEN', () => {
      const pagerduty = CONNECTOR_REGISTRY.PAGERDUTY;
      expect(pagerduty.authMethod).toBe('BEARER_TOKEN');
      expect(pagerduty.formConfig.authFields).toHaveLength(1);
      expect(pagerduty.formConfig.authFields[0].name).toBe('apiToken');
      expect(pagerduty.formConfig.configFields).toHaveLength(0);
    });
  });

  describe('AgentCore Connector configurations', () => {
    it('should configure AWS_LAMBDA with IAM_ROLE auth', () => {
      const lambda = CONNECTOR_REGISTRY.AWS_LAMBDA;
      expect(lambda).toBeDefined();
      expect(lambda.type).toBe('AWS_LAMBDA');
      expect(lambda.authMethod).toBe('IAM_ROLE');
      expect(lambda.provider).toBe('Amazon Web Services');
      expect(lambda.category).toBe('aws-services');
      expect(lambda.isPopular).toBe(true);
      expect(lambda.formConfig.authFields).toHaveLength(1);
      expect(lambda.formConfig.authFields[0].name).toBe('executionRoleArn');
      expect(lambda.formConfig.configFields).toHaveLength(3);
      expect(lambda.formConfig.configFields.map((f) => f.name)).toContain('lambdaArn');
      expect(lambda.formConfig.configFields.map((f) => f.name)).toContain('toolSchema');
      expect(lambda.formConfig.configFields.map((f) => f.name)).toContain('region');
    });

    it('should configure AWS_LAMBDA with textarea for toolSchema', () => {
      const lambda = CONNECTOR_REGISTRY.AWS_LAMBDA;
      const toolSchemaField = lambda.formConfig.configFields.find(
        (f) => f.name === 'toolSchema'
      );
      expect(toolSchemaField).toBeDefined();
      expect(toolSchemaField?.type).toBe('textarea');
      expect(toolSchemaField?.required).toBe(true);
    });

    it('should configure AWS_SMITHY with IAM_ROLE auth', () => {
      const smithy = CONNECTOR_REGISTRY.AWS_SMITHY;
      expect(smithy).toBeDefined();
      expect(smithy.type).toBe('AWS_SMITHY');
      expect(smithy.authMethod).toBe('IAM_ROLE');
      expect(smithy.provider).toBe('Amazon Web Services');
      expect(smithy.category).toBe('aws-services');
      expect(smithy.isPopular).toBe(true);
      expect(smithy.formConfig.authFields).toHaveLength(1);
      expect(smithy.formConfig.authFields[0].name).toBe('executionRoleArn');
      expect(smithy.formConfig.configFields).toHaveLength(2);
      expect(smithy.formConfig.configFields.map((f) => f.name)).toContain('serviceType');
      expect(smithy.formConfig.configFields.map((f) => f.name)).toContain('region');
    });

    it('should configure AWS_SMITHY with select dropdown for serviceType', () => {
      const smithy = CONNECTOR_REGISTRY.AWS_SMITHY;
      const serviceTypeField = smithy.formConfig.configFields.find(
        (f) => f.name === 'serviceType'
      );
      expect(serviceTypeField).toBeDefined();
      expect(serviceTypeField?.type).toBe('select');
      expect(serviceTypeField?.options).toBeDefined();
      expect(serviceTypeField?.options).toHaveLength(5);
      expect(serviceTypeField?.options?.map((o) => o.value)).toContain('dynamodb');
      expect(serviceTypeField?.options?.map((o) => o.value)).toContain('s3');
      expect(serviceTypeField?.options?.map((o) => o.value)).toContain('lambda');
      expect(serviceTypeField?.options?.map((o) => o.value)).toContain('sqs');
      expect(serviceTypeField?.options?.map((o) => o.value)).toContain('sns');
    });

    it('should configure MCP_SERVER with CONFIGURABLE auth', () => {
      const mcpServer = CONNECTOR_REGISTRY.MCP_SERVER;
      expect(mcpServer).toBeDefined();
      expect(mcpServer.type).toBe('MCP_SERVER');
      expect(mcpServer.authMethod).toBe('CONFIGURABLE');
      expect(mcpServer.provider).toBe('External');
      expect(mcpServer.category).toBe('integration-platform');
      expect(mcpServer.isPopular).toBe(false);
      expect(mcpServer.formConfig.authFields.length).toBeGreaterThan(0);
      expect(mcpServer.formConfig.configFields).toHaveLength(1);
      expect(mcpServer.formConfig.configFields[0].name).toBe('serverUrl');
    });

    it('should configure MCP_SERVER with conditional fields', () => {
      const mcpServer = CONNECTOR_REGISTRY.MCP_SERVER;
      const apiKeyField = mcpServer.formConfig.authFields.find(
        (f) => f.name === 'apiKey'
      );
      const clientIdField = mcpServer.formConfig.authFields.find(
        (f) => f.name === 'clientId'
      );
      const clientSecretField = mcpServer.formConfig.authFields.find(
        (f) => f.name === 'clientSecret'
      );

      expect(apiKeyField?.conditionalOn).toEqual({ field: 'authMethod', value: 'API_KEY' });
      expect(clientIdField?.conditionalOn).toEqual({ field: 'authMethod', value: 'OAUTH2' });
      expect(clientSecretField?.conditionalOn).toEqual({ field: 'authMethod', value: 'OAUTH2' });
    });

    it('should configure MCP_SERVER with authMethod select dropdown', () => {
      const mcpServer = CONNECTOR_REGISTRY.MCP_SERVER;
      const authMethodField = mcpServer.formConfig.authFields.find(
        (f) => f.name === 'authMethod'
      );
      expect(authMethodField).toBeDefined();
      expect(authMethodField?.type).toBe('select');
      expect(authMethodField?.options).toBeDefined();
      expect(authMethodField?.options).toHaveLength(3);
      expect(authMethodField?.options?.map((o) => o.value)).toContain('API_KEY');
      expect(authMethodField?.options?.map((o) => o.value)).toContain('OAUTH2');
      expect(authMethodField?.options?.map((o) => o.value)).toContain('CUSTOM');
    });

    it('should return AWS_LAMBDA connector definition', () => {
      const lambda = getConnectorDefinition('AWS_LAMBDA');
      expect(lambda).toBeDefined();
      expect(lambda?.type).toBe('AWS_LAMBDA');
      expect(lambda?.name).toBe('AWS Lambda');
    });

    it('should return AWS_SMITHY connector definition', () => {
      const smithy = getConnectorDefinition('AWS_SMITHY');
      expect(smithy).toBeDefined();
      expect(smithy?.type).toBe('AWS_SMITHY');
      expect(smithy?.name).toBe('AWS Services (Smithy)');
    });

    it('should return MCP_SERVER connector definition', () => {
      const mcpServer = getConnectorDefinition('MCP_SERVER');
      expect(mcpServer).toBeDefined();
      expect(mcpServer?.type).toBe('MCP_SERVER');
      expect(mcpServer?.name).toBe('MCP Server');
    });

    it('should return connectors in aws-services category', () => {
      const awsServices = getConnectorsByCategory('aws-services');
      expect(awsServices.length).toBe(2);
      expect(awsServices.map((c) => c.id)).toContain('AWS_LAMBDA');
      expect(awsServices.map((c) => c.id)).toContain('AWS_SMITHY');
    });

    it('should return connectors in integration-platform category', () => {
      const integrationPlatform = getConnectorsByCategory('integration-platform');
      expect(integrationPlatform.length).toBe(1);
      expect(integrationPlatform[0].id).toBe('MCP_SERVER');
    });
  });
});
