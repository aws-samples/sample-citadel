/**
 * Property-Based Tests for Credential Manager
 * 
 * These tests verify universal properties for credential storage, retrieval,
 * and configuration management across all connector types.
 */

import * as fc from 'fast-check';
import {
  storeCredentials,
  retrieveCredentials
} from '../credential-manager';
import { getConnectorSpec, getAllConnectorTypes } from '../connector-registry';
import { 
  SecretsManagerClient, 
  CreateSecretCommand,
  GetSecretValueCommand, 
} from '@aws-sdk/client-secrets-manager';
import {
  SSMClient,
  PutParameterCommand,
} from '@aws-sdk/client-ssm';
import { mockClient } from 'aws-sdk-client-mock';

// Mock AWS SDK clients
const secretsManagerMock = mockClient(SecretsManagerClient);
const ssmMock = mockClient(SSMClient);

describe('Credential Manager - Property-Based Tests', () => {
  beforeEach(() => {
    secretsManagerMock.reset();
    ssmMock.reset();
  });

  /**
   * Property 6: Credential storage in Secrets Manager
   * 
   * For any integration created, all sensitive credentials (API tokens, passwords,
   * OAuth secrets, bearer tokens) should be stored in Secrets Manager with encryption at rest.
   * 
   * Validates: Requirements 4.1, 8.1, 8.2, 8.3, 8.4
   */
  describe('Property 6: Credential storage in Secrets Manager', () => {
    const graphqlConnectorTypes = getAllConnectorTypes().filter(type => 
      ['CONFLUENCE', 'SERVICENOW', 'JIRA', 'SLACK', 'MICROSOFT', 'ZENDESK', 'PAGERDUTY'].includes(type)
    );

    test('should store all sensitive credentials in Secrets Manager', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom(...graphqlConnectorTypes),
          fc.uuid(),
          fc.string({ minLength: 1, maxLength: 50 }).filter(s => s.trim().length > 0),
          async (connectorType, integrationId, orgId) => {
            const spec = getConnectorSpec(connectorType);
            if (!spec) return true;

            // Reset mocks for each test
            secretsManagerMock.reset();
            ssmMock.reset();

            // Build valid credentials based on connector spec
            const credentials: Record<string, any> = {};
            for (const field of spec.authentication.fields) {
              credentials[field] = `test-${field}-${Math.random()}`;
            }

            // Build valid config
            const config: Record<string, any> = {};
            for (const field of spec.configuration.required) {
              config[field] = `test-${field}-${Math.random()}`;
            }

            // Mock Secrets Manager response
            const mockSecretArn = `arn:aws:secretsmanager:us-east-1:123456789012:secret:test-${integrationId}`;
            secretsManagerMock.on(CreateSecretCommand).resolves({
              ARN: mockSecretArn,
              Name: `/citadel/integrations/${orgId}/${connectorType.toLowerCase()}-${integrationId}`
            });

            // Mock SSM responses
            ssmMock.on(PutParameterCommand).resolves({});

            // Property: storeCredentials should succeed and return ARN
            const result = await storeCredentials(
              connectorType,
              integrationId,
              orgId,
              credentials,
              config
            );

            expect(result.secretArn).toBeDefined();
            expect(result.secretArn).toContain('arn:aws:secretsmanager');
            expect(result.ssmParameterPrefix).toBeDefined();
            expect(result.ssmParameterPrefix).toContain(orgId);
            expect(result.ssmParameterPrefix).toContain(connectorType.toLowerCase());

            // Verify CreateSecretCommand was called
            const createSecretCalls = secretsManagerMock.commandCalls(CreateSecretCommand);
            expect(createSecretCalls.length).toBeGreaterThan(0);

            // Verify secret contains all required authentication fields
            const secretCall = createSecretCalls[0];
            const secretString = secretCall.args[0].input.SecretString;
            const secretData = JSON.parse(secretString);

            for (const field of spec.authentication.fields) {
              expect(secretData).toHaveProperty(field);
              // Only check exact value if field is not also in config (to avoid random value mismatch)
              if (!spec.configuration.required.includes(field)) {
                expect(secretData[field]).toBe(credentials[field]);
              }
            }

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    test('should reject storage when required authentication fields are missing', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom(...graphqlConnectorTypes),
          fc.uuid(),
          fc.string({ minLength: 1, maxLength: 50 }),
          async (connectorType, integrationId, orgId) => {
            const spec = getConnectorSpec(connectorType);
            if (!spec || spec.authentication.fields.length === 0) return true;

            // Build incomplete credentials (missing last required field)
            const credentials: Record<string, any> = {};
            for (let i = 0; i < spec.authentication.fields.length - 1; i++) {
              const field = spec.authentication.fields[i];
              credentials[field] = `test-${field}-${Math.random()}`;
            }

            const config: Record<string, any> = {};

            // Property: storeCredentials should throw error for missing required fields
            await expect(
              storeCredentials(connectorType, integrationId, orgId, credentials, config)
            ).rejects.toThrow(/Missing required authentication field/);

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    test('should store credentials with encryption at rest', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom(...graphqlConnectorTypes),
          fc.uuid(),
          fc.string({ minLength: 1, maxLength: 50 }).filter(s => s.trim().length > 0),
          async (connectorType, integrationId, orgId) => {
            const spec = getConnectorSpec(connectorType);
            if (!spec) return true;

            // Reset mocks for each test
            secretsManagerMock.reset();
            ssmMock.reset();

            const credentials: Record<string, any> = {};
            for (const field of spec.authentication.fields) {
              credentials[field] = `test-${field}-${Math.random()}`;
            }

            const config: Record<string, any> = {};
            for (const field of spec.configuration.required) {
              config[field] = `test-${field}-${Math.random()}`;
            }

            const mockSecretArn = `arn:aws:secretsmanager:us-east-1:123456789012:secret:test-${integrationId}`;
            secretsManagerMock.on(CreateSecretCommand).resolves({
              ARN: mockSecretArn,
              Name: `/citadel/integrations/${orgId}/${connectorType.toLowerCase()}-${integrationId}`
            });

            ssmMock.on(PutParameterCommand).resolves({});

            await storeCredentials(connectorType, integrationId, orgId, credentials, config);

            // Property: Secrets Manager is used (which provides encryption at rest by default)
            const createSecretCalls = secretsManagerMock.commandCalls(CreateSecretCommand);
            expect(createSecretCalls.length).toBeGreaterThan(0);

            // Verify secret name follows expected pattern
            const secretCall = createSecretCalls[0];
            expect(secretCall.args[0].input.Name).toContain('/citadel/integrations/');
            expect(secretCall.args[0].input.Name).toContain(orgId);
            expect(secretCall.args[0].input.Name).toContain(connectorType.toLowerCase());

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    test('should store different credential types correctly', async () => {
      // Test API_KEY authentication (Confluence, Jira, Zendesk)
      const apiKeyTypes = graphqlConnectorTypes.filter(type => {
        const spec = getConnectorSpec(type);
        return spec?.authentication.method === 'API_KEY';
      });

      for (const connectorType of apiKeyTypes) {
        secretsManagerMock.reset();
        ssmMock.reset();

        const spec = getConnectorSpec(connectorType)!;
        const credentials: Record<string, any> = {};
        for (const field of spec.authentication.fields) {
          credentials[field] = `test-${field}`;
        }

        const config: Record<string, any> = {};
        for (const field of spec.configuration.required) {
          config[field] = `test-${field}`;
        }

        secretsManagerMock.on(CreateSecretCommand).resolves({
          ARN: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:test',
          Name: 'test-secret'
        });
        ssmMock.on(PutParameterCommand).resolves({});

        const result = await storeCredentials(connectorType, 'test-id', 'test-org', credentials, config);
        expect(result.secretArn).toBeDefined();
      }

      // Test BASIC_AUTH authentication (ServiceNow)
      const basicAuthTypes = graphqlConnectorTypes.filter(type => {
        const spec = getConnectorSpec(type);
        return spec?.authentication.method === 'BASIC_AUTH';
      });

      for (const connectorType of basicAuthTypes) {
        secretsManagerMock.reset();
        ssmMock.reset();

        const spec = getConnectorSpec(connectorType)!;
        const credentials: Record<string, any> = {};
        for (const field of spec.authentication.fields) {
          credentials[field] = `test-${field}`;
        }

        const config: Record<string, any> = {};
        for (const field of spec.configuration.required) {
          config[field] = `test-${field}`;
        }

        secretsManagerMock.on(CreateSecretCommand).resolves({
          ARN: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:test',
          Name: 'test-secret'
        });
        ssmMock.on(PutParameterCommand).resolves({});

        const result = await storeCredentials(connectorType, 'test-id', 'test-org', credentials, config);
        expect(result.secretArn).toBeDefined();
      }

      // Test OAUTH2 authentication (Slack, Microsoft)
      const oauth2Types = graphqlConnectorTypes.filter(type => {
        const spec = getConnectorSpec(type);
        return spec?.authentication.method === 'OAUTH2';
      });

      for (const connectorType of oauth2Types) {
        secretsManagerMock.reset();
        ssmMock.reset();

        const spec = getConnectorSpec(connectorType)!;
        const credentials: Record<string, any> = {};
        for (const field of spec.authentication.fields) {
          credentials[field] = `test-${field}`;
        }

        const config: Record<string, any> = {};
        for (const field of spec.configuration.required) {
          config[field] = `test-${field}`;
        }

        secretsManagerMock.on(CreateSecretCommand).resolves({
          ARN: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:test',
          Name: 'test-secret'
        });
        ssmMock.on(PutParameterCommand).resolves({});

        const result = await storeCredentials(connectorType, 'test-id', 'test-org', credentials, config);
        expect(result.secretArn).toBeDefined();
      }

      // Test BEARER_TOKEN authentication (PagerDuty)
      const bearerTokenTypes = graphqlConnectorTypes.filter(type => {
        const spec = getConnectorSpec(type);
        return spec?.authentication.method === 'BEARER_TOKEN';
      });

      for (const connectorType of bearerTokenTypes) {
        secretsManagerMock.reset();
        ssmMock.reset();

        const spec = getConnectorSpec(connectorType)!;
        const credentials: Record<string, any> = {};
        for (const field of spec.authentication.fields) {
          credentials[field] = `test-${field}`;
        }

        const config: Record<string, any> = {};

        secretsManagerMock.on(CreateSecretCommand).resolves({
          ARN: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:test',
          Name: 'test-secret'
        });
        ssmMock.on(PutParameterCommand).resolves({});

        const result = await storeCredentials(connectorType, 'test-id', 'test-org', credentials, config);
        expect(result.secretArn).toBeDefined();
      }
    });

    test('should reject unknown connector types', async () => {
      const allRegisteredTypes = getAllConnectorTypes();
      await fc.assert(
        fc.asyncProperty(
          fc.string().filter(s => 
            s.length > 0 && 
            !allRegisteredTypes.includes(s) &&
            !['valueOf', 'toString', 'constructor', '__proto__', 'hasOwnProperty', '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__', 'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString'].includes(s)
          ),
          fc.uuid(),
          fc.string({ minLength: 1, maxLength: 50 }),
          async (unknownType, integrationId, orgId) => {
            // Property: Unknown connector types should be rejected
            await expect(
              storeCredentials(unknownType, integrationId, orgId, {}, {})
            ).rejects.toThrow(/Unknown connector type/);

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  /**
   * Property 7: Configuration storage in SSM
   * 
   * For any integration created, all non-sensitive configuration fields
   * should be stored in SSM Parameter Store.
   * 
   * Validates: Requirements 4.2, 3.6, 8.8
   */
  describe('Property 7: Configuration storage in SSM', () => {
    const graphqlConnectorTypes = getAllConnectorTypes().filter(type => 
      ['CONFLUENCE', 'SERVICENOW', 'JIRA', 'SLACK', 'MICROSOFT', 'ZENDESK', 'PAGERDUTY'].includes(type)
    );

    test('should store non-sensitive configuration in SSM Parameter Store', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom(...graphqlConnectorTypes),
          fc.uuid(),
          fc.string({ minLength: 1, maxLength: 50 }).filter(s => s.trim().length > 0),
          async (connectorType, integrationId, orgId) => {
            const spec = getConnectorSpec(connectorType);
            if (!spec) return true;

            // Reset mocks for each test
            secretsManagerMock.reset();
            ssmMock.reset();

            const credentials: Record<string, any> = {};
            for (const field of spec.authentication.fields) {
              credentials[field] = `test-${field}`;
            }

            const config: Record<string, any> = {};
            for (const field of spec.configuration.required) {
              config[field] = `test-config-${field}`;
            }

            secretsManagerMock.on(CreateSecretCommand).resolves({
              ARN: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:test',
              Name: 'test-secret'
            });
            ssmMock.on(PutParameterCommand).resolves({});

            await storeCredentials(connectorType, integrationId, orgId, credentials, config);

            // Property: SSM PutParameterCommand should be called for each SSM parameter
            const putParameterCalls = ssmMock.commandCalls(PutParameterCommand);

            // Verify SSM parameters were created for connector-specific parameters
            if (spec.configuration.ssmParameters.length > 0 && spec.configuration.required.length > 0) {
              expect(putParameterCalls.length).toBeGreaterThan(0);

              // Verify parameter names follow expected pattern
              for (const call of putParameterCalls) {
                const paramName = call.args[0].input.Name;
                expect(paramName).toContain('/citadel/integrations/');
                expect(paramName).toContain(orgId);
                expect(paramName).toContain(connectorType.toLowerCase());
              }
            }

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    test('should use connector-specific SSM parameter paths', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom(...graphqlConnectorTypes),
          fc.uuid(),
          fc.string({ minLength: 1, maxLength: 50 }).filter(s => s.trim().length > 0),
          async (connectorType, integrationId, orgId) => {
            const spec = getConnectorSpec(connectorType);
            if (!spec || spec.configuration.ssmParameters.length === 0) return true;

            // Reset mocks for each test
            secretsManagerMock.reset();
            ssmMock.reset();

            const credentials: Record<string, any> = {};
            for (const field of spec.authentication.fields) {
              credentials[field] = `test-${field}`;
            }

            const config: Record<string, any> = {};
            for (const field of spec.configuration.required) {
              config[field] = `test-${field}`;
            }

            secretsManagerMock.on(CreateSecretCommand).resolves({
              ARN: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:test',
              Name: 'test-secret'
            });
            ssmMock.on(PutParameterCommand).resolves({});

            const result = await storeCredentials(connectorType, integrationId, orgId, credentials, config);

            // Property: SSM parameter prefix should be connector-specific
            expect(result.ssmParameterPrefix).toContain(connectorType.toLowerCase());
            expect(result.ssmParameterPrefix).toContain(integrationId);
            expect(result.ssmParameterPrefix).toContain(orgId);

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    test('should not store sensitive data in SSM', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom(...graphqlConnectorTypes),
          fc.uuid(),
          fc.string({ minLength: 1, maxLength: 50 }).filter(s => s.trim().length > 0),
          async (connectorType, integrationId, orgId) => {
            const spec = getConnectorSpec(connectorType);
            if (!spec) return true;

            // Reset mocks for each test
            secretsManagerMock.reset();
            ssmMock.reset();

            const credentials: Record<string, any> = {};
            for (const field of spec.authentication.fields) {
              credentials[field] = `sensitive-${field}`;
            }

            const config: Record<string, any> = {};
            for (const field of spec.configuration.required) {
              config[field] = `config-${field}`;
            }

            secretsManagerMock.on(CreateSecretCommand).resolves({
              ARN: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:test',
              Name: 'test-secret'
            });
            ssmMock.on(PutParameterCommand).resolves({});

            await storeCredentials(connectorType, integrationId, orgId, credentials, config);

            // Property: SSM parameters should not contain sensitive credential fields
            const putParameterCalls = ssmMock.commandCalls(PutParameterCommand);

            for (const call of putParameterCalls) {
              const paramValue = call.args[0].input.Value;
              
              // Verify sensitive fields are not in SSM parameter values
              for (const field of spec.authentication.fields) {
                const sensitiveValue = credentials[field];
                expect(paramValue).not.toContain(sensitiveValue);
              }
            }

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  /**
   * Property 9: Credential structure parsing
   * 
   * For any connector type, when credentials are retrieved from Secrets Manager,
   * they should be parsed according to that connector type's defined secret structure.
   * 
   * Validates: Requirements 4.4
   */
  describe('Property 9: Credential structure parsing', () => {
    const graphqlConnectorTypes = getAllConnectorTypes().filter(type => 
      ['CONFLUENCE', 'SERVICENOW', 'JIRA', 'SLACK', 'MICROSOFT', 'ZENDESK', 'PAGERDUTY'].includes(type)
    );

    test('should parse credentials according to connector type secret structure', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom(...graphqlConnectorTypes),
          async (connectorType) => {
            const spec = getConnectorSpec(connectorType);
            if (!spec) return true;

            // Reset mocks for each test
            secretsManagerMock.reset();

            // Build valid credentials based on connector spec
            const storedCredentials: Record<string, any> = {};
            for (const field of spec.authentication.fields) {
              storedCredentials[field] = `test-${field}-value`;
            }

            // Add any config fields that should be in secret
            for (const configField of spec.configuration.required) {
              if (spec.authentication.secretStructure[configField]) {
                storedCredentials[configField] = `test-${configField}-value`;
              }
            }

            const mockSecretArn = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:test';
            secretsManagerMock.on(GetSecretValueCommand).resolves({
              SecretString: JSON.stringify(storedCredentials)
            });

            // Property: retrieveCredentials should parse and return credentials in expected format
            const retrievedCredentials = await retrieveCredentials(mockSecretArn, connectorType);

            // Verify all authentication fields are present
            for (const field of spec.authentication.fields) {
              expect(retrievedCredentials).toHaveProperty(field);
              expect(retrievedCredentials[field]).toBe(storedCredentials[field]);
            }

            // Verify config fields that were in secret are also returned
            for (const configField of spec.configuration.required) {
              if (storedCredentials[configField]) {
                expect(retrievedCredentials).toHaveProperty(configField);
                expect(retrievedCredentials[configField]).toBe(storedCredentials[configField]);
              }
            }

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    test('should throw error when expected fields are missing from secret', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom(...graphqlConnectorTypes),
          async (connectorType) => {
            const spec = getConnectorSpec(connectorType);
            if (!spec || spec.authentication.fields.length === 0) return true;

            // Reset mocks for each test
            secretsManagerMock.reset();

            // Build incomplete credentials (missing last required field)
            const incompleteCredentials: Record<string, any> = {};
            for (let i = 0; i < spec.authentication.fields.length - 1; i++) {
              const field = spec.authentication.fields[i];
              incompleteCredentials[field] = `test-${field}-value`;
            }

            const mockSecretArn = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:test';
            secretsManagerMock.on(GetSecretValueCommand).resolves({
              SecretString: JSON.stringify(incompleteCredentials)
            });

            // Property: retrieveCredentials should throw error for missing expected fields
            await expect(
              retrieveCredentials(mockSecretArn, connectorType)
            ).rejects.toThrow(/Missing expected field/);

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    test('should handle different credential structures for different auth methods', async () => {
      // Test API_KEY credentials
      const apiKeyTypes = graphqlConnectorTypes.filter(type => {
        const spec = getConnectorSpec(type);
        return spec?.authentication.method === 'API_KEY';
      });

      for (const connectorType of apiKeyTypes) {
        secretsManagerMock.reset();
        const spec = getConnectorSpec(connectorType)!;
        
        const credentials: Record<string, any> = {};
        for (const field of spec.authentication.fields) {
          credentials[field] = `test-${field}`;
        }

        secretsManagerMock.on(GetSecretValueCommand).resolves({
          SecretString: JSON.stringify(credentials)
        });

        const retrieved = await retrieveCredentials('arn:test', connectorType);
        expect(retrieved).toHaveProperty('email');
        expect(retrieved).toHaveProperty('apiToken');
      }

      // Test BASIC_AUTH credentials
      const basicAuthTypes = graphqlConnectorTypes.filter(type => {
        const spec = getConnectorSpec(type);
        return spec?.authentication.method === 'BASIC_AUTH';
      });

      for (const connectorType of basicAuthTypes) {
        secretsManagerMock.reset();
        const spec = getConnectorSpec(connectorType)!;
        
        const credentials: Record<string, any> = {};
        for (const field of spec.authentication.fields) {
          credentials[field] = `test-${field}`;
        }

        secretsManagerMock.on(GetSecretValueCommand).resolves({
          SecretString: JSON.stringify(credentials)
        });

        const retrieved = await retrieveCredentials('arn:test', connectorType);
        expect(retrieved).toHaveProperty('username');
        expect(retrieved).toHaveProperty('password');
      }

      // Test OAUTH2 credentials
      const oauth2Types = graphqlConnectorTypes.filter(type => {
        const spec = getConnectorSpec(type);
        return spec?.authentication.method === 'OAUTH2';
      });

      for (const connectorType of oauth2Types) {
        secretsManagerMock.reset();
        const spec = getConnectorSpec(connectorType)!;
        
        const credentials: Record<string, any> = {};
        for (const field of spec.authentication.fields) {
          credentials[field] = `test-${field}`;
        }

        secretsManagerMock.on(GetSecretValueCommand).resolves({
          SecretString: JSON.stringify(credentials)
        });

        const retrieved = await retrieveCredentials('arn:test', connectorType);
        expect(retrieved).toHaveProperty('clientId');
        expect(retrieved).toHaveProperty('clientSecret');
      }

      // Test BEARER_TOKEN credentials
      const bearerTokenTypes = graphqlConnectorTypes.filter(type => {
        const spec = getConnectorSpec(type);
        return spec?.authentication.method === 'BEARER_TOKEN';
      });

      for (const connectorType of bearerTokenTypes) {
        secretsManagerMock.reset();
        const spec = getConnectorSpec(connectorType)!;
        
        const credentials: Record<string, any> = {};
        for (const field of spec.authentication.fields) {
          credentials[field] = `test-${field}`;
        }

        secretsManagerMock.on(GetSecretValueCommand).resolves({
          SecretString: JSON.stringify(credentials)
        });

        const retrieved = await retrieveCredentials('arn:test', connectorType);
        expect(retrieved).toHaveProperty('apiToken');
      }
    });

    test('should handle backward compatibility for unknown connector types', async () => {
      // Reset mocks
      secretsManagerMock.reset();

      const legacyCredentials = {
        email: 'test@example.com',
        apiToken: 'legacy-token',
        baseUrl: 'https://legacy.atlassian.net'
      };

      secretsManagerMock.on(GetSecretValueCommand).resolves({
        SecretString: JSON.stringify(legacyCredentials)
      });

      // Property: Unknown connector types should return raw data for backward compatibility
      const retrieved = await retrieveCredentials('arn:test', 'UNKNOWN_TYPE');
      expect(retrieved).toEqual(legacyCredentials);
    });

    test('should migrate old Confluence credentials with legacy field names', async () => {
      // Reset mocks
      secretsManagerMock.reset();

      // Old format: using 'token' instead of 'apiToken', 'url' instead of 'baseUrl'
      const oldFormatCredentials = {
        email: 'test@example.com',
        token: 'old-api-token',
        url: 'https://old.atlassian.net'
      };

      secretsManagerMock.on(GetSecretValueCommand).resolves({
        SecretString: JSON.stringify(oldFormatCredentials)
      });

      // Should migrate and return in new format
      const retrieved = await retrieveCredentials('arn:test', 'CONFLUENCE');
      
      expect(retrieved).toHaveProperty('email', 'test@example.com');
      expect(retrieved).toHaveProperty('apiToken', 'old-api-token');
      expect(retrieved).toHaveProperty('baseUrl', 'https://old.atlassian.net');
    });

    test('should migrate old ServiceNow credentials with legacy field names', async () => {
      // Reset mocks
      secretsManagerMock.reset();

      // Old format: using 'user' instead of 'username', 'pass' instead of 'password'
      const oldFormatCredentials = {
        user: 'admin',
        pass: 'old-password',
        instance: 'https://old-instance.service-now.com'
      };

      secretsManagerMock.on(GetSecretValueCommand).resolves({
        SecretString: JSON.stringify(oldFormatCredentials)
      });

      // Should migrate and return in new format
      const retrieved = await retrieveCredentials('arn:test', 'SERVICENOW');
      
      expect(retrieved).toHaveProperty('username', 'admin');
      expect(retrieved).toHaveProperty('password', 'old-password');
      expect(retrieved).toHaveProperty('instanceUrl', 'https://old-instance.service-now.com');
    });

    test('should handle credentials that are already in new format', async () => {
      // Reset mocks
      secretsManagerMock.reset();

      // New format credentials
      const newFormatCredentials = {
        email: 'test@example.com',
        apiToken: 'new-api-token',
        baseUrl: 'https://new.atlassian.net'
      };

      secretsManagerMock.on(GetSecretValueCommand).resolves({
        SecretString: JSON.stringify(newFormatCredentials)
      });

      // Should return as-is without migration
      const retrieved = await retrieveCredentials('arn:test', 'CONFLUENCE');
      
      expect(retrieved).toEqual(newFormatCredentials);
    });

    test('should migrate old Slack credentials with legacy workspace field', async () => {
      // Reset mocks
      secretsManagerMock.reset();

      // Old format: using 'workspace' instead of 'workspaceId'
      const oldFormatCredentials = {
        clientId: 'old-client-id',
        clientSecret: 'old-client-secret',
        workspace: 'T01234ABCDE'
      };

      secretsManagerMock.on(GetSecretValueCommand).resolves({
        SecretString: JSON.stringify(oldFormatCredentials)
      });

      // Should migrate and return in new format
      const retrieved = await retrieveCredentials('arn:test', 'SLACK');
      
      expect(retrieved).toHaveProperty('clientId', 'old-client-id');
      expect(retrieved).toHaveProperty('clientSecret', 'old-client-secret');
      expect(retrieved).toHaveProperty('workspaceId', 'T01234ABCDE');
    });

    test('should migrate old Zendesk credentials with legacy domain field', async () => {
      // Reset mocks
      secretsManagerMock.reset();

      // Old format: using 'domain' instead of 'subdomain'
      const oldFormatCredentials = {
        email: 'test@example.com',
        token: 'old-zendesk-token',
        domain: 'mycompany'
      };

      secretsManagerMock.on(GetSecretValueCommand).resolves({
        SecretString: JSON.stringify(oldFormatCredentials)
      });

      // Should migrate and return in new format
      const retrieved = await retrieveCredentials('arn:test', 'ZENDESK');
      
      expect(retrieved).toHaveProperty('email', 'test@example.com');
      expect(retrieved).toHaveProperty('apiToken', 'old-zendesk-token');
      expect(retrieved).toHaveProperty('subdomain', 'mycompany');
    });

    test('should preserve both old and new field names during migration', async () => {
      // Reset mocks
      secretsManagerMock.reset();

      // Mixed format: has both old and new field names
      const mixedFormatCredentials = {
        email: 'test@example.com',
        token: 'old-token',
        apiToken: 'new-token',
        baseUrl: 'https://new.atlassian.net'
      };

      secretsManagerMock.on(GetSecretValueCommand).resolves({
        SecretString: JSON.stringify(mixedFormatCredentials)
      });

      // Should prioritize new field names
      const retrieved = await retrieveCredentials('arn:test', 'CONFLUENCE');
      
      expect(retrieved).toHaveProperty('apiToken', 'new-token'); // New field takes precedence
      expect(retrieved).toHaveProperty('baseUrl', 'https://new.atlassian.net');
    });

    test('should throw error if required fields are missing even after migration', async () => {
      // Reset mocks
      secretsManagerMock.reset();

      // Incomplete credentials that cannot be migrated
      const incompleteCredentials = {
        email: 'test@example.com'
        // Missing apiToken/token and baseUrl/url
      };

      secretsManagerMock.on(GetSecretValueCommand).resolves({
        SecretString: JSON.stringify(incompleteCredentials)
      });

      // Should throw error
      await expect(retrieveCredentials('arn:test', 'CONFLUENCE'))
        .rejects.toThrow('Missing expected field');
    });
  });
});

  /**
   * Property 3: IAM credential storage in Secrets Manager
   * 
   * For any AgentCore integration using IAM authentication (Lambda, Smithy),
   * the execution role ARN should be stored in Secrets Manager with encryption at rest.
   * 
   * Validates: Requirements 1.6, 2.6, 3.8, 4.1, 4.2
   */
  describe('Property 3: IAM credential storage in Secrets Manager', () => {
    const iamConnectorTypes = ['AWS_LAMBDA', 'AWS_SMITHY'];

    test('should store IAM execution role ARN in Secrets Manager for Lambda and Smithy', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom(...iamConnectorTypes),
          fc.uuid(),
          fc.string({ minLength: 1, maxLength: 50 }).filter(s => s.trim().length > 0),
          fc.integer({ min: 100000000000, max: 999999999999 }),
          fc.string({ minLength: 5, maxLength: 30 }).filter(s => /^[a-zA-Z0-9_-]+$/.test(s)),
          async (connectorType, integrationId, orgId, accountId, roleName) => {
            const spec = getConnectorSpec(connectorType);
            if (!spec) return true;

            // Reset mocks for each test
            secretsManagerMock.reset();
            ssmMock.reset();

            // Build IAM credentials
            const credentials = {
              executionRoleArn: `arn:aws:iam::${accountId}:role/${roleName}`
            };

            // Build valid config based on connector type
            const config: Record<string, any> = {};
            if (connectorType === 'AWS_LAMBDA') {
              config.lambdaArn = `arn:aws:lambda:us-east-1:${accountId}:function:TestFunction`;
              config.toolSchema = JSON.stringify({
                name: 'test_tool',
                description: 'Test tool',
                inputSchema: { type: 'object', properties: {} }
              });
              config.region = 'us-east-1';
            } else if (connectorType === 'AWS_SMITHY') {
              config.serviceType = 'dynamodb';
              config.region = 'us-east-1';
            }

            const mockSecretArn = `arn:aws:secretsmanager:us-east-1:${accountId}:secret:test-${integrationId}`;
            secretsManagerMock.on(CreateSecretCommand).resolves({
              ARN: mockSecretArn,
              Name: `/citadel/integrations/${orgId}/${connectorType.toLowerCase()}-${integrationId}`
            });

            ssmMock.on(PutParameterCommand).resolves({});

            // Property: storeCredentials should succeed and store execution role ARN
            const result = await storeCredentials(
              connectorType,
              integrationId,
              orgId,
              credentials,
              config
            );

            expect(result.secretArn).toBeDefined();
            expect(result.secretArn).toContain('arn:aws:secretsmanager');

            // Verify CreateSecretCommand was called
            const createSecretCalls = secretsManagerMock.commandCalls(CreateSecretCommand);
            expect(createSecretCalls.length).toBeGreaterThan(0);

            // Verify secret contains executionRoleArn
            const secretCall = createSecretCalls[0];
            const secretString = secretCall.args[0].input.SecretString;
            const secretData = JSON.parse(secretString);

            expect(secretData).toHaveProperty('executionRoleArn');
            expect(secretData.executionRoleArn).toBe(credentials.executionRoleArn);
            expect(secretData.executionRoleArn).toMatch(/^arn:aws:iam::\d+:role\/.+$/);

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    test('should store MCP Server credentials with configurable authentication', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom('API_KEY', 'OAUTH2'),
          fc.uuid(),
          fc.string({ minLength: 1, maxLength: 50 }).filter(s => s.trim().length > 0),
          async (authMethod, integrationId, orgId) => {
            const connectorType = 'MCP_SERVER';
            const spec = getConnectorSpec(connectorType);
            if (!spec) return true;

            // Reset mocks for each test
            secretsManagerMock.reset();
            ssmMock.reset();

            // Build credentials based on auth method
            const credentials: Record<string, any> = {
              authMethod
            };

            if (authMethod === 'API_KEY') {
              credentials.apiKey = `test-api-key-${Math.random()}`;
            } else if (authMethod === 'OAUTH2') {
              credentials.clientId = `test-client-id-${Math.random()}`;
              credentials.clientSecret = `test-client-secret-${Math.random()}`;
            }

            const config = {
              serverUrl: 'https://mcp.example.com'
            };

            const mockSecretArn = `arn:aws:secretsmanager:us-east-1:123456789012:secret:test-${integrationId}`;
            secretsManagerMock.on(CreateSecretCommand).resolves({
              ARN: mockSecretArn,
              Name: `/citadel/integrations/${orgId}/${connectorType.toLowerCase()}-${integrationId}`
            });

            ssmMock.on(PutParameterCommand).resolves({});

            // Property: storeCredentials should succeed with configurable auth
            const result = await storeCredentials(
              connectorType,
              integrationId,
              orgId,
              credentials,
              config
            );

            expect(result.secretArn).toBeDefined();

            // Verify secret contains authMethod and appropriate credentials
            const createSecretCalls = secretsManagerMock.commandCalls(CreateSecretCommand);
            expect(createSecretCalls.length).toBeGreaterThan(0);

            const secretCall = createSecretCalls[0];
            const secretString = secretCall.args[0].input.SecretString;
            const secretData = JSON.parse(secretString);

            expect(secretData).toHaveProperty('authMethod', authMethod);

            if (authMethod === 'API_KEY') {
              expect(secretData).toHaveProperty('apiKey');
            } else if (authMethod === 'OAUTH2') {
              expect(secretData).toHaveProperty('clientId');
              expect(secretData).toHaveProperty('clientSecret');
            }

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    test('should reject IAM credential storage when executionRoleArn is missing', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom('AWS_LAMBDA', 'AWS_SMITHY'),
          fc.uuid(),
          fc.string({ minLength: 1, maxLength: 50 }),
          async (connectorType, integrationId, orgId) => {
            // Missing executionRoleArn
            const credentials = {};
            const config = {};

            // Property: storeCredentials should throw error for missing executionRoleArn
            await expect(
              storeCredentials(connectorType, integrationId, orgId, credentials, config)
            ).rejects.toThrow(/Missing required authentication field/);

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    test('should store IAM credentials with encryption at rest', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom('AWS_LAMBDA', 'AWS_SMITHY'),
          fc.uuid(),
          fc.string({ minLength: 1, maxLength: 50 }).filter(s => s.trim().length > 0),
          async (connectorType, integrationId, orgId) => {
            const spec = getConnectorSpec(connectorType);
            if (!spec) return true;

            // Reset mocks for each test
            secretsManagerMock.reset();
            ssmMock.reset();

            const credentials = {
              executionRoleArn: `arn:aws:iam::123456789012:role/TestRole-${integrationId}`
            };

            const config: Record<string, any> = {};
            if (connectorType === 'AWS_LAMBDA') {
              config.lambdaArn = 'arn:aws:lambda:us-east-1:123456789012:function:TestFunction';
              config.toolSchema = JSON.stringify({ name: 'test', description: 'test', inputSchema: { type: 'object' } });
              config.region = 'us-east-1';
            } else {
              config.serviceType = 'dynamodb';
              config.region = 'us-east-1';
            }

            const mockSecretArn = `arn:aws:secretsmanager:us-east-1:123456789012:secret:test-${integrationId}`;
            secretsManagerMock.on(CreateSecretCommand).resolves({
              ARN: mockSecretArn,
              Name: `/citadel/integrations/${orgId}/${connectorType.toLowerCase()}-${integrationId}`
            });

            ssmMock.on(PutParameterCommand).resolves({});

            await storeCredentials(connectorType, integrationId, orgId, credentials, config);

            // Property: Secrets Manager is used (which provides encryption at rest by default)
            const createSecretCalls = secretsManagerMock.commandCalls(CreateSecretCommand);
            expect(createSecretCalls.length).toBeGreaterThan(0);

            // Verify secret name follows expected pattern
            const secretCall = createSecretCalls[0];
            expect(secretCall.args[0].input.Name).toContain('/citadel/integrations/');
            expect(secretCall.args[0].input.Name).toContain(orgId);
            expect(secretCall.args[0].input.Name).toContain(connectorType.toLowerCase());

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  /**
   * Property 9: IAM credential structure parsing
   * 
   * For any AgentCore integration with IAM authentication, when credentials are
   * retrieved from Secrets Manager, they should be parsed correctly to extract
   * the execution role ARN.
   * 
   * Validates: Requirements 4.3, 4.4
   */
  describe('Property 9: IAM credential structure parsing', () => {
    const iamConnectorTypes = ['AWS_LAMBDA', 'AWS_SMITHY'];

    test('should parse IAM credentials and extract execution role ARN', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom(...iamConnectorTypes),
          fc.integer({ min: 100000000000, max: 999999999999 }),
          fc.string({ minLength: 5, maxLength: 30 }).filter(s => /^[a-zA-Z0-9_-]+$/.test(s)),
          async (connectorType, accountId, roleName) => {
            const spec = getConnectorSpec(connectorType);
            if (!spec) return true;

            // Reset mocks for each test
            secretsManagerMock.reset();

            // Build stored IAM credentials
            const storedCredentials = {
              executionRoleArn: `arn:aws:iam::${accountId}:role/${roleName}`
            };

            const mockSecretArn = `arn:aws:secretsmanager:us-east-1:${accountId}:secret:test`;
            secretsManagerMock.on(GetSecretValueCommand).resolves({
              SecretString: JSON.stringify(storedCredentials)
            });

            // Property: retrieveCredentials should parse and return execution role ARN
            const retrievedCredentials = await retrieveCredentials(mockSecretArn, connectorType);

            expect(retrievedCredentials).toHaveProperty('executionRoleArn');
            expect(retrievedCredentials.executionRoleArn).toBe(storedCredentials.executionRoleArn);
            expect(retrievedCredentials.executionRoleArn).toMatch(/^arn:aws:iam::\d+:role\/.+$/);

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    test('should parse MCP Server credentials with configurable authentication', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom('API_KEY', 'OAUTH2'),
          async (authMethod) => {
            const connectorType = 'MCP_SERVER';
            const spec = getConnectorSpec(connectorType);
            if (!spec) return true;

            // Reset mocks for each test
            secretsManagerMock.reset();

            // Build stored credentials based on auth method
            const storedCredentials: Record<string, any> = {
              authMethod
            };

            if (authMethod === 'API_KEY') {
              storedCredentials.apiKey = `test-api-key-${Math.random()}`;
            } else if (authMethod === 'OAUTH2') {
              storedCredentials.clientId = `test-client-id-${Math.random()}`;
              storedCredentials.clientSecret = `test-client-secret-${Math.random()}`;
            }

            const mockSecretArn = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:test';
            secretsManagerMock.on(GetSecretValueCommand).resolves({
              SecretString: JSON.stringify(storedCredentials)
            });

            // Property: retrieveCredentials should parse configurable auth correctly
            const retrievedCredentials = await retrieveCredentials(mockSecretArn, connectorType);

            expect(retrievedCredentials).toHaveProperty('authMethod', authMethod);

            if (authMethod === 'API_KEY') {
              expect(retrievedCredentials).toHaveProperty('apiKey');
              expect(retrievedCredentials.apiKey).toBe(storedCredentials.apiKey);
            } else if (authMethod === 'OAUTH2') {
              expect(retrievedCredentials).toHaveProperty('clientId');
              expect(retrievedCredentials).toHaveProperty('clientSecret');
              expect(retrievedCredentials.clientId).toBe(storedCredentials.clientId);
              expect(retrievedCredentials.clientSecret).toBe(storedCredentials.clientSecret);
            }

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    test('should throw error when executionRoleArn is missing from IAM credentials', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom('AWS_LAMBDA', 'AWS_SMITHY'),
          async (connectorType) => {
            const spec = getConnectorSpec(connectorType);
            if (!spec) return true;

            // Reset mocks for each test
            secretsManagerMock.reset();

            // Missing executionRoleArn
            const incompleteCredentials = {};

            const mockSecretArn = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:test';
            secretsManagerMock.on(GetSecretValueCommand).resolves({
              SecretString: JSON.stringify(incompleteCredentials)
            });

            // Property: retrieveCredentials should throw error for missing executionRoleArn
            await expect(
              retrieveCredentials(mockSecretArn, connectorType)
            ).rejects.toThrow(/Missing expected field/);

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  /**
   * Property 2: Configuration storage in SSM
   * 
   * For any AgentCore integration created, all non-sensitive configuration fields
   * (Lambda ARN, tool schema, service type, region, server URL) should be stored
   * in SSM Parameter Store.
   * 
   * Validates: Requirements 1.5, 2.5, 3.7
   */
  describe('Property 2: Configuration storage in SSM for AgentCore types', () => {
    const agentCoreConnectorTypes = ['AWS_LAMBDA', 'AWS_SMITHY', 'MCP_SERVER'];

    test('should store AgentCore configuration in SSM Parameter Store', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom(...agentCoreConnectorTypes),
          fc.uuid(),
          fc.string({ minLength: 1, maxLength: 50 }).filter(s => s.trim().length > 0),
          async (connectorType, integrationId, orgId) => {
            const spec = getConnectorSpec(connectorType);
            if (!spec) return true;

            // Reset mocks for each test
            secretsManagerMock.reset();
            ssmMock.reset();

            // Build credentials
            const credentials: Record<string, any> = {};
            if (connectorType === 'AWS_LAMBDA' || connectorType === 'AWS_SMITHY') {
              credentials.executionRoleArn = `arn:aws:iam::123456789012:role/TestRole-${integrationId}`;
            } else {
              credentials.authMethod = 'API_KEY';
              credentials.apiKey = `test-api-key-${integrationId}`;
            }

            // Build config based on connector type
            const config: Record<string, any> = {};
            if (connectorType === 'AWS_LAMBDA') {
              config.lambdaArn = `arn:aws:lambda:us-east-1:123456789012:function:Function-${integrationId}`;
              config.toolSchema = JSON.stringify({
                name: 'test_tool',
                description: 'Test tool',
                inputSchema: { type: 'object', properties: {} }
              });
              config.region = 'us-east-1';
            } else if (connectorType === 'AWS_SMITHY') {
              config.serviceType = 'dynamodb';
              config.region = 'us-east-1';
            } else if (connectorType === 'MCP_SERVER') {
              config.serverUrl = 'https://mcp.example.com';
            }

            secretsManagerMock.on(CreateSecretCommand).resolves({
              ARN: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:test',
              Name: 'test-secret'
            });
            ssmMock.on(PutParameterCommand).resolves({});

            await storeCredentials(connectorType, integrationId, orgId, credentials, config);

            // Property: SSM PutParameterCommand should be called for each SSM parameter
            const putParameterCalls = ssmMock.commandCalls(PutParameterCommand);

            // Verify SSM parameters were created
            expect(putParameterCalls.length).toBeGreaterThan(0);

            // Verify parameter names follow expected pattern
            for (const call of putParameterCalls) {
              const paramName = call.args[0].input.Name;
              expect(paramName).toContain('/citadel/integrations/');
              expect(paramName).toContain(orgId);
              expect(paramName).toContain(connectorType.toLowerCase());
            }

            // Verify correct parameters are stored based on connector type
            const paramNames = putParameterCalls.map(call => {
              const fullName = call.args[0].input.Name as string;
              return fullName.split('/').pop();
            });

            if (connectorType === 'AWS_LAMBDA') {
              expect(paramNames).toContain('lambda-arn');
              expect(paramNames).toContain('tool-schema');
              expect(paramNames).toContain('region');
            } else if (connectorType === 'AWS_SMITHY') {
              expect(paramNames).toContain('service-type');
              expect(paramNames).toContain('region');
            } else if (connectorType === 'MCP_SERVER') {
              expect(paramNames).toContain('server-url');
            }

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    test('should not store sensitive credentials in SSM for AgentCore types', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom(...agentCoreConnectorTypes),
          fc.uuid(),
          fc.string({ minLength: 1, maxLength: 50 }).filter(s => s.trim().length > 0),
          async (connectorType, integrationId, orgId) => {
            const spec = getConnectorSpec(connectorType);
            if (!spec) return true;

            // Reset mocks for each test
            secretsManagerMock.reset();
            ssmMock.reset();

            // Build credentials with sensitive data
            const credentials: Record<string, any> = {};
            if (connectorType === 'AWS_LAMBDA' || connectorType === 'AWS_SMITHY') {
              credentials.executionRoleArn = `arn:aws:iam::123456789012:role/SensitiveRole-${integrationId}`;
            } else {
              credentials.authMethod = 'API_KEY';
              credentials.apiKey = `sensitive-api-key-${integrationId}`;
            }

            // Build config
            const config: Record<string, any> = {};
            if (connectorType === 'AWS_LAMBDA') {
              config.lambdaArn = `arn:aws:lambda:us-east-1:123456789012:function:Function-${integrationId}`;
              config.toolSchema = JSON.stringify({ name: 'test', description: 'test', inputSchema: { type: 'object' } });
              config.region = 'us-east-1';
            } else if (connectorType === 'AWS_SMITHY') {
              config.serviceType = 'dynamodb';
              config.region = 'us-east-1';
            } else {
              config.serverUrl = 'https://mcp.example.com';
            }

            secretsManagerMock.on(CreateSecretCommand).resolves({
              ARN: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:test',
              Name: 'test-secret'
            });
            ssmMock.on(PutParameterCommand).resolves({});

            await storeCredentials(connectorType, integrationId, orgId, credentials, config);

            // Property: SSM parameters should not contain sensitive credential fields
            const putParameterCalls = ssmMock.commandCalls(PutParameterCommand);

            for (const call of putParameterCalls) {
              const paramValue = call.args[0].input.Value;
              
              // Verify sensitive fields are not in SSM parameter values
              if (connectorType === 'AWS_LAMBDA' || connectorType === 'AWS_SMITHY') {
                expect(paramValue).not.toContain(credentials.executionRoleArn);
              } else {
                expect(paramValue).not.toContain(credentials.apiKey);
              }
            }

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    test('should use connector-specific SSM parameter paths for AgentCore types', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom(...agentCoreConnectorTypes),
          fc.uuid(),
          fc.string({ minLength: 1, maxLength: 50 }).filter(s => s.trim().length > 0),
          async (connectorType, integrationId, orgId) => {
            const spec = getConnectorSpec(connectorType);
            if (!spec) return true;

            // Reset mocks for each test
            secretsManagerMock.reset();
            ssmMock.reset();

            const credentials: Record<string, any> = {};
            if (connectorType === 'AWS_LAMBDA' || connectorType === 'AWS_SMITHY') {
              credentials.executionRoleArn = `arn:aws:iam::123456789012:role/TestRole`;
            } else {
              credentials.authMethod = 'API_KEY';
              credentials.apiKey = 'test-key';
            }

            const config: Record<string, any> = {};
            if (connectorType === 'AWS_LAMBDA') {
              config.lambdaArn = 'arn:aws:lambda:us-east-1:123456789012:function:TestFunction';
              config.toolSchema = JSON.stringify({ name: 'test', description: 'test', inputSchema: { type: 'object' } });
              config.region = 'us-east-1';
            } else if (connectorType === 'AWS_SMITHY') {
              config.serviceType = 'dynamodb';
              config.region = 'us-east-1';
            } else {
              config.serverUrl = 'https://mcp.example.com';
            }

            secretsManagerMock.on(CreateSecretCommand).resolves({
              ARN: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:test',
              Name: 'test-secret'
            });
            ssmMock.on(PutParameterCommand).resolves({});

            const result = await storeCredentials(connectorType, integrationId, orgId, credentials, config);

            // Property: SSM parameter prefix should be connector-specific
            expect(result.ssmParameterPrefix).toContain(connectorType.toLowerCase());
            expect(result.ssmParameterPrefix).toContain(integrationId);
            expect(result.ssmParameterPrefix).toContain(orgId);

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });
  });
