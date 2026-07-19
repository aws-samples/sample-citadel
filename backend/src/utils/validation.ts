import { ProjectStatus, AgentStatusEnum, MessageType } from '../types';

export class ValidationError extends Error {
  constructor(message: string, public field?: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export function validateProjectInput(rawInput: unknown): void {
  const input = rawInput as {
    name?: string;
    description?: string;
    requirements?: string;
  };
  if (!input.name || typeof input.name !== 'string') {
    throw new ValidationError('Project name is required and must be a string', 'name');
  }

  if (input.name.length < 1 || input.name.length > 100) {
    throw new ValidationError('Project name must be between 1 and 100 characters', 'name');
  }

  if (input.description && typeof input.description !== 'string') {
    throw new ValidationError('Description must be a string', 'description');
  }

  if (input.description && input.description.length > 1000) {
    throw new ValidationError('Description must be less than 1000 characters', 'description');
  }

  if (input.requirements && typeof input.requirements !== 'string') {
    throw new ValidationError('Requirements must be a string', 'requirements');
  }

  if (input.requirements && input.requirements.length > 5000) {
    throw new ValidationError('Requirements must be less than 5000 characters', 'requirements');
  }
}

export function validateProjectStatus(status: string): boolean {
  return Object.values(ProjectStatus).includes(status as ProjectStatus);
}

export function validateAgentStatus(status: string): boolean {
  return Object.values(AgentStatusEnum).includes(status as AgentStatusEnum);
}

export function validateMessageType(messageType: string): boolean {
  return Object.values(MessageType).includes(messageType as MessageType);
}

export function validateUUID(uuid: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

export function sanitizeString(input: string, maxLength: number = 1000): string {
  if (typeof input !== 'string') {
    return '';
  }

  // Neutralise HTML/script markup by escaping the characters that can open or
  // close a tag, rather than stripping multi-character tokens.
  //
  // CodeQL js/incomplete-multi-character-sanitization remediation: any
  // strip-based approach — even one looped to a fixed point — can be defeated
  // by interleaved input. For example "<scr<script></script>ipt" reassembles
  // into a bare "<script" once the inner block is removed; because that residue
  // has no closing ">", no tag regex matches it and the fixed point still
  // contains live markup. Escaping is immune to this entire bypass class: each
  // character is rewritten independently, so there is no removal step that can
  // splice neighbouring characters into a new tag. The result contains no
  // literal "<" or ">" at all.
  //
  // Order matters — "&" must be escaped first so the entities introduced for
  // "<" and ">" are not themselves double-escaped.
  const escaped = input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  return escaped.trim().substring(0, maxLength);
}

export function validatePaginationInput(rawInput: unknown): void {
  const input = rawInput as { limit?: number; nextToken?: string };
  if (input.limit && (typeof input.limit !== 'number' || input.limit < 1 || input.limit > 100)) {
    throw new ValidationError('Limit must be a number between 1 and 100', 'limit');
  }

  if (input.nextToken && typeof input.nextToken !== 'string') {
    throw new ValidationError('NextToken must be a string', 'nextToken');
  }
}

export function validateS3Object(rawS3Object: unknown): void {
  const s3Object = rawS3Object as { bucket?: string; key?: string; region?: string };
  if (!s3Object.bucket || typeof s3Object.bucket !== 'string') {
    throw new ValidationError('S3 bucket is required and must be a string', 'bucket');
  }

  if (!s3Object.key || typeof s3Object.key !== 'string') {
    throw new ValidationError('S3 key is required and must be a string', 'key');
  }

  if (!s3Object.region || typeof s3Object.region !== 'string') {
    throw new ValidationError('S3 region is required and must be a string', 'region');
  }

  // Validate S3 key format
  const keyRegex = /^[a-zA-Z0-9!_.*'()-/]+$/;
  if (!keyRegex.test(s3Object.key)) {
    throw new ValidationError('Invalid S3 key format', 'key');
  }
}

/**
 * Validates AWS ARN format for Lambda functions and IAM roles
 * @param arn - The ARN string to validate
 * @param arnType - The type of ARN ('lambda' or 'iam-role')
 * @throws ValidationError if ARN format is invalid
 */
export function validateARN(arn: string, arnType: 'lambda' | 'iam-role'): void {
  if (!arn || typeof arn !== 'string') {
    throw new ValidationError(`${arnType === 'lambda' ? 'Lambda' : 'IAM Role'} ARN is required and must be a string`, 'arn');
  }

  // General ARN format: arn:partition:service:region:account-id:resource
  const arnRegex = /^arn:aws:[a-z0-9-]+:[a-z0-9-]*:\d{12}:.+$/;
  
  if (!arnRegex.test(arn)) {
    if (arnType === 'lambda') {
      throw new ValidationError(
        'Invalid Lambda ARN format. Expected: arn:aws:lambda:region:account:function:function-name',
        'lambdaArn'
      );
    } else {
      throw new ValidationError(
        'Invalid IAM Role ARN format. Expected: arn:aws:iam::account:role/role-name',
        'executionRoleArn'
      );
    }
  }

  // Specific validation for Lambda ARNs
  if (arnType === 'lambda') {
    const lambdaArnRegex = /^arn:aws:lambda:[a-z0-9-]+:\d{12}:function:[a-zA-Z0-9-_]+$/;
    if (!lambdaArnRegex.test(arn)) {
      throw new ValidationError(
        'Invalid Lambda ARN format. Expected: arn:aws:lambda:region:account:function:function-name',
        'lambdaArn'
      );
    }
  }

  // Specific validation for IAM Role ARNs
  if (arnType === 'iam-role') {
    const iamRoleArnRegex = /^arn:aws:iam::\d{12}:role\/[a-zA-Z0-9+=,.@_-]+$/;
    if (!iamRoleArnRegex.test(arn)) {
      throw new ValidationError(
        'Invalid IAM Role ARN format. Expected: arn:aws:iam::account:role/role-name',
        'executionRoleArn'
      );
    }
  }
}

/**
 * Validates JSON format and structure for MCP tool schema
 * @param jsonString - The JSON string to validate
 * @throws ValidationError if JSON is invalid or missing required fields
 */
export function validateToolSchemaJSON(jsonString: string): void {
  if (!jsonString || typeof jsonString !== 'string') {
    throw new ValidationError('Tool schema is required and must be a string', 'toolSchema');
  }

  // Validate JSON syntax
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonString);
  } catch (error) {
    throw new ValidationError('Tool schema must be valid JSON', 'toolSchema');
  }
  const schema = parsed as {
    name?: string;
    description?: string;
    inputSchema?: { type?: string };
  };

  // Ensure schema is an object (not null, array, or primitive)
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    throw new ValidationError('Tool schema must be valid JSON', 'toolSchema');
  }

  // Validate required MCP fields
  if (!schema.name || typeof schema.name !== 'string') {
    throw new ValidationError('Tool schema must include "name" field', 'toolSchema');
  }

  if (!schema.description || typeof schema.description !== 'string') {
    throw new ValidationError('Tool schema must include "description" field', 'toolSchema');
  }

  if (!schema.inputSchema || typeof schema.inputSchema !== 'object') {
    throw new ValidationError('Tool schema must include "inputSchema" field', 'toolSchema');
  }

  // Validate inputSchema is valid JSON Schema
  if (schema.inputSchema.type !== 'object') {
    throw new ValidationError('Tool schema inputSchema must be of type "object"', 'toolSchema');
  }
}

/**
 * Validates AWS region code format
 * @param region - The AWS region code to validate
 * @throws ValidationError if region is invalid
 */
export function validateAWSRegion(region: string): void {
  if (!region || typeof region !== 'string') {
    throw new ValidationError('AWS region is required and must be a string', 'region');
  }

  // List of valid AWS regions (as of 2024)
  const validRegions = [
    'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2',
    'af-south-1',
    'ap-east-1', 'ap-south-1', 'ap-south-2', 'ap-northeast-1', 'ap-northeast-2', 'ap-northeast-3',
    'ap-southeast-1', 'ap-southeast-2', 'ap-southeast-3', 'ap-southeast-4',
    'ca-central-1',
    'eu-central-1', 'eu-central-2', 'eu-west-1', 'eu-west-2', 'eu-west-3',
    'eu-south-1', 'eu-south-2', 'eu-north-1',
    'il-central-1',
    'me-south-1', 'me-central-1',
    'sa-east-1',
    'us-gov-east-1', 'us-gov-west-1'
  ];

  if (!validRegions.includes(region)) {
    throw new ValidationError(
      'Invalid AWS region code. Must be a valid region like us-east-1, eu-west-1',
      'region'
    );
  }
}

/**
 * Validates HTTPS URL format for MCP servers
 * @param url - The URL to validate
 * @throws ValidationError if URL is not HTTPS or invalid format
 */
export function validateHTTPSUrl(url: string): void {
  if (!url || typeof url !== 'string') {
    throw new ValidationError('MCP Server URL is required and must be a string', 'serverUrl');
  }

  // Validate URL format
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch (error) {
    throw new ValidationError('MCP Server URL must be a valid HTTPS URL', 'serverUrl');
  }

  // Ensure HTTPS protocol
  if (parsedUrl.protocol !== 'https:') {
    throw new ValidationError('MCP Server URL must be a valid HTTPS URL', 'serverUrl');
  }
}