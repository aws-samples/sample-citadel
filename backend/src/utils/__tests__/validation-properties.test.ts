/**
 * Property-Based Tests for AgentCore Input Validation
 * 
 * These tests verify universal properties that should hold true for all validation operations.
 * 
 * Feature: agentcore-integration-types
 */

import * as fc from 'fast-check';
import {
  validateARN,
  validateToolSchemaJSON,
  validateAWSRegion,
  validateHTTPSUrl,
  ValidationError
} from '../validation';

describe('AgentCore Validation - Property-Based Tests', () => {
  /**
   * Property 5: ARN format validation
   * 
   * For any ARN input field (Lambda ARN, Execution Role ARN), if the input does not match 
   * the AWS ARN format pattern (arn:aws:service:region:account:resource), the validation 
   * should reject it with a descriptive error
   * 
   * **Validates: Requirements 1.8, 1.9, 2.10, 4.6**
   */
  describe('Property 5: ARN format validation', () => {
    test('should accept valid Lambda ARNs', () => {
      fc.assert(
        fc.property(
          fc.constantFrom('us-east-1', 'us-west-2', 'eu-west-1', 'ap-southeast-1'),
          fc.integer({ min: 100000000000, max: 999999999999 }),
          fc.string({ minLength: 1, maxLength: 64 }).filter(s => /^[a-zA-Z0-9-_]+$/.test(s)),
          (region, accountId, functionName) => {
            const arn = `arn:aws:lambda:${region}:${accountId}:function:${functionName}`;
            
            // Property: Valid Lambda ARN should not throw
            expect(() => validateARN(arn, 'lambda')).not.toThrow();
            
            return true;
          }
        ),
        { numRuns: 100 }
      );
    });
    
    test('should accept valid IAM Role ARNs', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 100000000000, max: 999999999999 }),
          fc.string({ minLength: 1, maxLength: 64 }).filter(s => /^[a-zA-Z0-9+=,.@_-]+$/.test(s)),
          (accountId, roleName) => {
            const arn = `arn:aws:iam::${accountId}:role/${roleName}`;
            
            // Property: Valid IAM Role ARN should not throw
            expect(() => validateARN(arn, 'iam-role')).not.toThrow();
            
            return true;
          }
        ),
        { numRuns: 100 }
      );
    });
    
    test('should reject ARNs with invalid format', () => {
      fc.assert(
        fc.property(
          fc.oneof(
            fc.constant('not-an-arn'),
            fc.constant('arn:aws'),
            fc.constant('arn:aws:lambda'),
            fc.constant('arn:aws:lambda:us-east-1'),
            fc.constant('arn:aws:lambda:us-east-1:123'),
            fc.string({ minLength: 1, maxLength: 20 }).filter(s => !s.startsWith('arn:aws:')),
            fc.constant(''),
            fc.constant('arn:gcp:lambda:us-east-1:123456789012:function:test')
          ),
          fc.constantFrom('lambda', 'iam-role'),
          (invalidArn, arnType) => {
            // Property: Invalid ARN format should throw ValidationError
            expect(() => validateARN(invalidArn, arnType)).toThrow(ValidationError);
            
            return true;
          }
        ),
        { numRuns: 100 }
      );
    });
    
    test('should reject Lambda ARNs with wrong service', () => {
      fc.assert(
        fc.property(
          fc.constantFrom('s3', 'dynamodb', 'iam', 'ec2'),
          fc.constantFrom('us-east-1', 'us-west-2', 'eu-west-1'),
          fc.integer({ min: 100000000000, max: 999999999999 }),
          (service, region, accountId) => {
            const arn = `arn:aws:${service}:${region}:${accountId}:function:test`;
            
            // Property: Lambda ARN with wrong service should throw
            expect(() => validateARN(arn, 'lambda')).toThrow(ValidationError);
            expect(() => validateARN(arn, 'lambda')).toThrow(/Invalid Lambda ARN format/);
            
            return true;
          }
        ),
        { numRuns: 100 }
      );
    });
    
    test('should reject IAM Role ARNs with region specified', () => {
      fc.assert(
        fc.property(
          fc.constantFrom('us-east-1', 'us-west-2', 'eu-west-1'),
          fc.integer({ min: 100000000000, max: 999999999999 }),
          fc.string({ minLength: 1, maxLength: 64 }).filter(s => /^[a-zA-Z0-9+=,.@_-]+$/.test(s)),
          (region, accountId, roleName) => {
            const arn = `arn:aws:iam:${region}:${accountId}:role/${roleName}`;
            
            // Property: IAM Role ARN with region should throw (IAM is global)
            expect(() => validateARN(arn, 'iam-role')).toThrow(ValidationError);
            expect(() => validateARN(arn, 'iam-role')).toThrow(/Invalid IAM Role ARN format/);
            
            return true;
          }
        ),
        { numRuns: 100 }
      );
    });
    
    test('should reject ARNs with invalid account ID', () => {
      fc.assert(
        fc.property(
          fc.oneof(
            fc.constant('123'),
            fc.constant('abc'),
            fc.constant('12345678901'),  // 11 digits
            fc.constant('1234567890123'), // 13 digits
            fc.string({ minLength: 1, maxLength: 10 }).filter(s => !/^\d{12}$/.test(s))
          ),
          fc.constantFrom('lambda', 'iam-role'),
          (invalidAccountId, arnType) => {
            let arn: string;
            if (arnType === 'lambda') {
              arn = `arn:aws:lambda:us-east-1:${invalidAccountId}:function:test`;
            } else {
              arn = `arn:aws:iam::${invalidAccountId}:role/test`;
            }
            
            // Property: ARN with invalid account ID should throw
            expect(() => validateARN(arn, arnType)).toThrow(ValidationError);
            
            return true;
          }
        ),
        { numRuns: 100 }
      );
    });
    
    test('should provide descriptive error messages', () => {
      fc.assert(
        fc.property(
          fc.constantFrom('lambda', 'iam-role'),
          (arnType) => {
            const invalidArn = 'invalid-arn';
            
            try {
              validateARN(invalidArn, arnType);
              return false; // Should have thrown
            } catch (error) {
              // Property: Error message should be descriptive and mention expected format
              expect(error).toBeInstanceOf(ValidationError);
              expect((error as ValidationError).message).toContain('Invalid');
              expect((error as ValidationError).message).toContain('ARN format');
              expect((error as ValidationError).message).toContain('Expected:');
              
              return true;
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });
  
  /**
   * Property 6: JSON validation for tool schema
   * 
   * For any tool schema input, if the input is not valid JSON, the validation should 
   * reject it with an error message
   * 
   * **Validates: Requirements 1.10**
   */
  describe('Property 6: JSON validation for tool schema', () => {
    test('should accept valid tool schema JSON', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 50 }),
          fc.string({ minLength: 1, maxLength: 200 }),
          fc.record({
            type: fc.constant('object'),
            properties: fc.dictionary(
              fc.string({ minLength: 1, maxLength: 20 }),
              fc.record({
                type: fc.constantFrom('string', 'number', 'boolean')
              })
            )
          }),
          (name, description, inputSchema) => {
            const schema = {
              name,
              description,
              inputSchema
            };
            const jsonString = JSON.stringify(schema);
            
            // Property: Valid tool schema JSON should not throw
            expect(() => validateToolSchemaJSON(jsonString)).not.toThrow();
            
            return true;
          }
        ),
        { numRuns: 100 }
      );
    });
    
    test('should reject invalid JSON syntax', () => {
      fc.assert(
        fc.property(
          fc.oneof(
            fc.constant('{invalid json}'),
            fc.constant('{"name": "test"'),
            fc.constant('{"name": "test",}'),
            fc.constant('{name: "test"}'),
            fc.constant('undefined'),
            fc.constant('null'),
            fc.string({ minLength: 1, maxLength: 50 }).filter(s => {
              try {
                JSON.parse(s);
                return false;
              } catch {
                return true;
              }
            })
          ),
          (invalidJson) => {
            // Property: Invalid JSON should throw ValidationError
            expect(() => validateToolSchemaJSON(invalidJson)).toThrow(ValidationError);
            expect(() => validateToolSchemaJSON(invalidJson)).toThrow(/must be valid JSON/);
            
            return true;
          }
        ),
        { numRuns: 100 }
      );
    });
    
    test('should reject JSON missing required fields', () => {
      fc.assert(
        fc.property(
          fc.constantFrom(
            { description: 'test', inputSchema: { type: 'object' } }, // missing name
            { name: 'test', inputSchema: { type: 'object' } },         // missing description
            { name: 'test', description: 'test' }                      // missing inputSchema
          ),
          (incompleteSchema) => {
            const jsonString = JSON.stringify(incompleteSchema);
            
            // Property: JSON missing required fields should throw
            expect(() => validateToolSchemaJSON(jsonString)).toThrow(ValidationError);
            expect(() => validateToolSchemaJSON(jsonString)).toThrow(/must include/);
            
            return true;
          }
        ),
        { numRuns: 100 }
      );
    });
    
    test('should reject JSON with invalid inputSchema type', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 50 }),
          fc.string({ minLength: 1, maxLength: 200 }),
          fc.constantFrom('string', 'number', 'boolean', 'array'),
          (name, description, type) => {
            const schema = {
              name,
              description,
              inputSchema: { type }
            };
            const jsonString = JSON.stringify(schema);
            
            // Property: inputSchema with type not "object" should throw
            expect(() => validateToolSchemaJSON(jsonString)).toThrow(ValidationError);
            expect(() => validateToolSchemaJSON(jsonString)).toThrow(/must be of type "object"/);
            
            return true;
          }
        ),
        { numRuns: 100 }
      );
    });
    
    test('should reject non-string inputs', () => {
      fc.assert(
        fc.property(
          fc.oneof(
            fc.constant(null),
            fc.constant(undefined),
            fc.integer(),
            fc.boolean(),
            fc.object()
          ),
          (nonString) => {
            // Property: Non-string input should throw
            expect(() => validateToolSchemaJSON(nonString as never)).toThrow(ValidationError);
            
            return true;
          }
        ),
        { numRuns: 100 }
      );
    });
  });
  
  /**
   * Property 7: AWS region validation
   * 
   * For any region input, if the input is not a valid AWS region code (e.g., us-east-1, eu-west-1), 
   * the validation should reject it
   * 
   * **Validates: Requirements 2.9**
   */
  describe('Property 7: AWS region validation', () => {
    test('should accept valid AWS regions', () => {
      fc.assert(
        fc.property(
          fc.constantFrom(
            'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2',
            'eu-west-1', 'eu-west-2', 'eu-west-3', 'eu-central-1',
            'ap-southeast-1', 'ap-southeast-2', 'ap-northeast-1',
            'ca-central-1', 'sa-east-1'
          ),
          (region) => {
            // Property: Valid AWS region should not throw
            expect(() => validateAWSRegion(region)).not.toThrow();
            
            return true;
          }
        ),
        { numRuns: 100 }
      );
    });
    
    test('should reject invalid region codes', () => {
      fc.assert(
        fc.property(
          fc.oneof(
            fc.constant('invalid-region'),
            fc.constant('us-east-3'),
            fc.constant('eu-north-2'),
            fc.constant('us_east_1'),
            fc.constant('US-EAST-1'),
            fc.string({ minLength: 1, maxLength: 20 }).filter(s => 
              !['us-east-1', 'us-east-2', 'us-west-1', 'us-west-2',
                'eu-west-1', 'eu-west-2', 'eu-west-3', 'eu-central-1',
                'ap-southeast-1', 'ap-southeast-2', 'ap-northeast-1',
                'ca-central-1', 'sa-east-1'].includes(s)
            )
          ),
          (invalidRegion) => {
            // Property: Invalid region should throw ValidationError
            expect(() => validateAWSRegion(invalidRegion)).toThrow(ValidationError);
            
            return true;
          }
        ),
        { numRuns: 100 }
      );
    });
    
    test('should reject non-string inputs', () => {
      fc.assert(
        fc.property(
          fc.oneof(
            fc.constant(null),
            fc.constant(undefined),
            fc.integer(),
            fc.boolean()
          ),
          (nonString) => {
            // Property: Non-string input should throw
            expect(() => validateAWSRegion(nonString as never)).toThrow(ValidationError);
            
            return true;
          }
        ),
        { numRuns: 100 }
      );
    });
    
    test('should provide descriptive error messages', () => {
      const invalidRegion = 'invalid-region';
      
      try {
        validateAWSRegion(invalidRegion);
        fail('Should have thrown');
      } catch (error) {
        // Property: Error message should be descriptive
        expect(error).toBeInstanceOf(ValidationError);
        expect((error as ValidationError).message).toContain('Invalid AWS region');
        expect((error as ValidationError).message).toContain('us-east-1');
      }
    });
  });
  
  /**
   * Property 8: HTTPS URL validation for MCP servers
   * 
   * For any MCP server URL input, if the URL does not use HTTPS protocol or is not a valid 
   * URL format, the validation should reject it
   * 
   * **Validates: Requirements 3.10**
   */
  describe('Property 8: HTTPS URL validation for MCP servers', () => {
    test('should accept valid HTTPS URLs', () => {
      fc.assert(
        fc.property(
          fc.webUrl({ validSchemes: ['https'] }),
          (url) => {
            // Property: Valid HTTPS URL should not throw
            expect(() => validateHTTPSUrl(url)).not.toThrow();
            
            return true;
          }
        ),
        { numRuns: 100 }
      );
    });
    
    test('should reject HTTP URLs', () => {
      fc.assert(
        fc.property(
          fc.webUrl({ validSchemes: ['http'] }),
          (url) => {
            // Property: HTTP URL should throw ValidationError
            expect(() => validateHTTPSUrl(url)).toThrow(ValidationError);
            expect(() => validateHTTPSUrl(url)).toThrow(/must be a valid HTTPS URL/);
            
            return true;
          }
        ),
        { numRuns: 100 }
      );
    });
    
    test('should reject invalid URL formats', () => {
      fc.assert(
        fc.property(
          fc.oneof(
            fc.constant('not-a-url'),
            fc.constant('ftp://example.com'),
            fc.constant('//example.com'),
            fc.constant('example.com'),
            fc.string({ minLength: 1, maxLength: 50 }).filter(s => {
              try {
                new URL(s);
                return false;
              } catch {
                return true;
              }
            })
          ),
          (invalidUrl) => {
            // Property: Invalid URL format should throw ValidationError
            expect(() => validateHTTPSUrl(invalidUrl)).toThrow(ValidationError);
            
            return true;
          }
        ),
        { numRuns: 100 }
      );
    });
    
    test('should reject non-string inputs', () => {
      fc.assert(
        fc.property(
          fc.oneof(
            fc.constant(null),
            fc.constant(undefined),
            fc.integer(),
            fc.boolean()
          ),
          (nonString) => {
            // Property: Non-string input should throw
            expect(() => validateHTTPSUrl(nonString as never)).toThrow(ValidationError);
            
            return true;
          }
        ),
        { numRuns: 100 }
      );
    });
    
    test('should provide descriptive error messages', () => {
      const invalidUrl = 'http://example.com';
      
      try {
        validateHTTPSUrl(invalidUrl);
        fail('Should have thrown');
      } catch (error) {
        // Property: Error message should be descriptive
        expect(error).toBeInstanceOf(ValidationError);
        expect((error as ValidationError).message).toContain('HTTPS');
      }
    });
  });
});
