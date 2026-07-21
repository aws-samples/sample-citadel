/**
 * Schema contract tests for the intake post-fabrication mutations.
 *
 * AppSync silently drops fields declared in `extend type Mutation` blocks, so
 * these tests pin the 4 intake fields INSIDE the primary Mutation block, each
 * with the IAM-only directive, and pin the auth-mode cascade on every object
 * type an IAM caller receives (a type without @aws_iam is unauthorized for an
 * IAM caller even when the field-level directive allows the call).
 */
import * as fs from 'fs';
import * as path from 'path';

const SCHEMA_PATH = path.resolve(__dirname, '../../schema/schema.graphql');

describe('schema.graphql — intake post-fabrication mutations', () => {
  let schema: string;
  let mutationBlock: string;

  beforeAll(() => {
    schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
    // The primary Mutation block: from `type Mutation {` to the first
    // line-anchored closing brace.
    const match = schema.match(/^type Mutation \{[\s\S]*?^\}/m);
    if (!match) throw new Error('primary `type Mutation {` block not found');
    mutationBlock = match[0];
  });

  test('contains no extend type blocks (AppSync drops extended fields silently)', () => {
    const sdlOnly = schema
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n');
    expect(sdlOnly).not.toMatch(/extend\s+type/);
  });

  const fields: Array<[string, string]> = [
    ['intakeActivateProjectAgents', 'ActivateAgentsResult'],
    ['intakeCreateApp', 'RegistryAgentRecord'],
    ['intakeCreateBlueprint', 'IntakeBlueprintResult'],
    ['intakeImportBlueprintToApp', 'Workflow'],
  ];

  test.each(fields)('%s is declared once, inside the primary Mutation block', (field) => {
    const occurrences = schema.split(`${field}(`).length - 1;
    expect(occurrences).toBe(1);
    expect(mutationBlock).toContain(`${field}(`);
  });

  test.each(fields)('%s is IAM-only and returns %s', (field, returnType) => {
    const decl = new RegExp(
      `${field}\\([^)]*\\):\\s*${returnType}\\s+@aws_iam(?!\\s+@aws_cognito_user_pools)`,
    );
    expect(mutationBlock).toMatch(decl);
  });

  test('intakeActivateProjectAgents takes sessionId: ID!', () => {
    expect(mutationBlock).toMatch(/intakeActivateProjectAgents\(sessionId: ID!\)/);
  });

  test('intakeCreateApp takes sessionId, name, optional description — and no client orgId', () => {
    expect(mutationBlock).toMatch(
      /intakeCreateApp\(sessionId: ID!, name: String!, description: String\)/,
    );
  });

  test('intakeCreateBlueprint takes sessionId, name, definition AWSJSON!', () => {
    expect(mutationBlock).toMatch(
      /intakeCreateBlueprint\(sessionId: ID!, name: String!, definition: AWSJSON!\)/,
    );
  });

  test('intakeImportBlueprintToApp takes sessionId, blueprintId, appId, optional name', () => {
    expect(mutationBlock).toMatch(
      /intakeImportBlueprintToApp\(sessionId: ID!, blueprintId: ID!, appId: ID!, name: String\)/,
    );
  });

  // Auth-mode cascade: every object type reachable from an IAM-authorized
  // field must itself allow IAM — and must keep Cognito so the existing
  // user-pool surface is unbroken.
  const cascadeTypes = [
    'ActivateAgentsResult',
    'Workflow',
    'RegistryAgentRecord',
    'RegistryAgentBinding',
    'RegistryAgentRecordPermission',
    'IntakeBlueprintResult',
  ];

  test.each(cascadeTypes)('type %s carries @aws_iam @aws_cognito_user_pools', (typeName) => {
    const decl = new RegExp(`^type ${typeName}\\s+@aws_iam\\s+@aws_cognito_user_pools\\s*\\{`, 'm');
    expect(schema).toMatch(decl);
  });

  test('ActivateAgentsResult carries the additive nullable matchedBy field', () => {
    const block = schema.match(/^type ActivateAgentsResult[^{]*\{[\s\S]*?^\}/m)?.[0] ?? '';
    expect(block).toMatch(/matchedBy: String\b(?!!)/);
  });

  test('IntakeBlueprintResult carries the structured publish-outcome fields', () => {
    const block = schema.match(/^type IntakeBlueprintResult[^{]*\{[\s\S]*?^\}/m)?.[0] ?? '';
    expect(block).toMatch(/ok: Boolean!/);
    expect(block).toMatch(/blueprintId: ID\b(?!!)/);
    expect(block).toMatch(/status: String!/);
    expect(block).toMatch(/nodeCount: Int\b(?!!)/);
    expect(block).toMatch(/missing: \[String!\]/);
    expect(block).toMatch(/errors: \[String!\]/);
  });
});
