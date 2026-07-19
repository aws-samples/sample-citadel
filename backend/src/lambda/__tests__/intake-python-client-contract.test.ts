/**
 * Cross-layer contract: Python intake client ↔ backend schema.graphql.
 *
 * Part A — GraphQL document contract (the backend twin of the frontend
 * graphqlSchemaContract.test.ts pattern): extracts the 4 intake* mutation
 * documents from service/agent_intake_single/tools/postfab.py (module-level
 * `_*_MUTATION = """..."""` constants sent through tools/appsync_client.py),
 * parses them with graphql-js, and diffs them against the SDL so drift on
 * EITHER side fails the build:
 *   - root field renamed/removed (schema or Python),
 *   - argument name/type/nullability changed,
 *   - a selected field missing from the return type,
 *   - the @aws_iam directive dropped (or Cognito added) on the field.
 *
 * Part B — envelope round-trip: a fixture in the exact shape
 * generate_process_blueprint emits (copied from the Python test
 * tests/test_blueprint_gen.py::test_envelope_is_canonical) must pass the
 * backend validateDefinitionStructure gate AND the frontend-guard-mirroring
 * envelope guard shared with the seed-blueprints contract test.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parse, print } from 'graphql';
import type {
  DocumentNode,
  ObjectTypeDefinitionNode,
  FieldDefinitionNode,
  OperationDefinitionNode,
  FieldNode,
} from 'graphql';

import { validateDefinitionStructure } from '../workflow-resolver';
import {
  isWorkflowDefinitionEnvelope,
  isWorkflowEdgeDefinition,
  isWorkflowNodeDefinition,
} from './fixtures/workflow-envelope-guard';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const SDL_PATH = path.join(REPO_ROOT, 'backend/src/schema/schema.graphql');
const POSTFAB_PATH = path.join(
  REPO_ROOT,
  'service/agent_intake_single/tools/postfab.py',
);

const sdl: DocumentNode = parse(fs.readFileSync(SDL_PATH, 'utf8'));
const postfabSource = fs.readFileSync(POSTFAB_PATH, 'utf8');

// ─── SDL helpers (same walk as the frontend contract test) ─────────────────

const sdlObjectTypes = new Map<string, ObjectTypeDefinitionNode>();
for (const def of sdl.definitions) {
  if (def.kind === 'ObjectTypeDefinition') {
    sdlObjectTypes.set(def.name.value, def);
  }
}

function sdlField(typeName: string, fieldName: string): FieldDefinitionNode {
  const field = sdlObjectTypes.get(typeName)?.fields?.find((f) => f.name.value === fieldName);
  if (!field) throw new Error(`SDL field ${typeName}.${fieldName} not found`);
  return field;
}

function sdlTypeFieldNames(typeName: string): Set<string> {
  const type = sdlObjectTypes.get(typeName);
  if (!type) throw new Error(`SDL type ${typeName} not found`);
  return new Set((type.fields ?? []).map((f) => f.name.value));
}

/** Strip list/non-null decorations to leave the underlying type name. */
function baseTypeName(printedType: string): string {
  return printedType.replace(/[![\]]/g, '');
}

// ─── Python document extraction ────────────────────────────────────────────

/**
 * Pulls a module-level `NAME = """..."""` GraphQL document out of postfab.py.
 * Throws (failing the suite) if the constant is renamed, moved, or no longer
 * a triple-quoted literal — that is drift too.
 */
function pythonDocument(constantName: string): string {
  const match = postfabSource.match(
    new RegExp(`^${constantName}\\s*=\\s*"""([\\s\\S]*?)"""`, 'm'),
  );
  if (!match) {
    throw new Error(
      `GraphQL document ${constantName} not found as a triple-quoted constant in ${POSTFAB_PATH}`,
    );
  }
  return match[1];
}

interface ClientOperation {
  operation: 'query' | 'mutation' | 'subscription';
  rootField: string;
  variableTypes: Record<string, string>; // variable name -> printed type (e.g. "ID!")
  argVariables: Record<string, string>; // argument name -> referenced variable name
  selection: string[]; // top-level selected field names on the return type
}

function parseClientOperation(doc: string): ClientOperation {
  const opDef = parse(doc).definitions.find(
    (d): d is OperationDefinitionNode => d.kind === 'OperationDefinition',
  );
  if (!opDef) throw new Error('client document has no operation definition');

  const variableTypes: Record<string, string> = {};
  for (const v of opDef.variableDefinitions ?? []) {
    variableTypes[v.variable.name.value] = print(v.type);
  }

  const rootField = opDef.selectionSet.selections.find(
    (s): s is FieldNode => s.kind === 'Field',
  );
  if (!rootField) throw new Error('client operation has no root field');

  const argVariables: Record<string, string> = {};
  for (const arg of rootField.arguments ?? []) {
    argVariables[arg.name.value] =
      arg.value.kind === 'Variable' ? arg.value.name.value : print(arg.value);
  }

  const selection: string[] = [];
  for (const sel of rootField.selectionSet?.selections ?? []) {
    if (sel.kind === 'Field') selection.push(sel.name.value);
  }

  return {
    operation: opDef.operation,
    rootField: rootField.name.value,
    variableTypes,
    argVariables,
    selection,
  };
}

interface OpCase {
  label: string;
  constant: string;
  field: string;
  returnType: string;
}

const OPERATIONS: OpCase[] = [
  {
    label: 'activate_agents',
    constant: '_ACTIVATE_MUTATION',
    field: 'intakeActivateProjectAgents',
    returnType: 'ActivateAgentsResult',
  },
  {
    label: 'create_agent_app',
    constant: '_CREATE_APP_MUTATION',
    field: 'intakeCreateApp',
    returnType: 'RegistryAgentRecord',
  },
  {
    label: 'generate_process_blueprint',
    constant: '_CREATE_BLUEPRINT_MUTATION',
    field: 'intakeCreateBlueprint',
    returnType: 'IntakeBlueprintResult',
  },
  {
    label: 'import_blueprint_to_app',
    constant: '_IMPORT_MUTATION',
    field: 'intakeImportBlueprintToApp',
    returnType: 'Workflow',
  },
];

describe('Python intake client GraphQL documents match backend schema.graphql', () => {
  it('extracts exactly the 4 known mutation constants from postfab.py', () => {
    // Guards the extraction itself: if a 5th document is added (or one is
    // renamed) this inventory must be updated so the new document is covered.
    const declared = [...postfabSource.matchAll(/^(_[A-Z_]+_MUTATION)\s*=/gm)].map(
      (m) => m[1],
    );
    expect(declared.sort()).toEqual(OPERATIONS.map((o) => o.constant).sort());
  });

  it.each(OPERATIONS)('$label: document parses and is a mutation on $field', (op) => {
    const client = parseClientOperation(pythonDocument(op.constant));
    expect(client.operation).toBe('mutation');
    expect(client.rootField).toBe(op.field);
  });

  it.each(OPERATIONS)('$label: root field exists in Mutation and returns $returnType', (op) => {
    const field = sdlField('Mutation', op.field);
    expect(baseTypeName(print(field.type))).toBe(op.returnType);
  });

  it.each(OPERATIONS)('$label: arguments (names, types, nullability) match the SDL', (op) => {
    const client = parseClientOperation(pythonDocument(op.constant));
    const field = sdlField('Mutation', op.field);

    const sdlArgs: Record<string, string> = {};
    for (const a of field.arguments ?? []) sdlArgs[a.name.value] = print(a.type);

    // Every argument the Python client passes exists in the SDL with an
    // identical type (including nullability), via its variable definition.
    for (const [argName, varName] of Object.entries(client.argVariables)) {
      expect(sdlArgs).toHaveProperty(argName);
      expect(client.variableTypes[varName]).toBe(sdlArgs[argName]);
    }

    // Every required (non-null) SDL argument is supplied by the client.
    for (const [argName, argType] of Object.entries(sdlArgs)) {
      if (argType.endsWith('!')) {
        expect(Object.keys(client.argVariables)).toContain(argName);
      }
    }
  });

  it.each(OPERATIONS)('$label: every selected field exists on the SDL return type', (op) => {
    const client = parseClientOperation(pythonDocument(op.constant));
    const returnFields = sdlTypeFieldNames(op.returnType);
    expect(client.selection.length).toBeGreaterThan(0);
    for (const selected of client.selection) {
      expect(returnFields.has(selected)).toBe(true);
    }
  });

  it.each(OPERATIONS)(
    '$label: SDL field is IAM-only (@aws_iam present, no @aws_cognito_user_pools)',
    (op) => {
      const field = sdlField('Mutation', op.field);
      const directives = (field.directives ?? []).map((d) => d.name.value);
      expect(directives).toContain('aws_iam');
      expect(directives).not.toContain('aws_cognito_user_pools');
    },
  );

  it.each(OPERATIONS)(
    '$label: return type $returnType allows IAM callers (auth-mode cascade)',
    (op) => {
      const type = sdlObjectTypes.get(op.returnType);
      if (!type) throw new Error(`SDL type ${op.returnType} not found`);
      const directives = (type.directives ?? []).map((d) => d.name.value);
      expect(directives).toContain('aws_iam');
    },
  );
});

// ─── Part B: envelope round-trip ────────────────────────────────────────────

/**
 * KEEP IN SYNC: exact shape emitted by _build_envelope in
 * service/agent_intake_single/tools/postfab.py, copied from the Python
 * fixture assertions in
 * service/agent_intake_single/tests/test_blueprint_gen.py
 * (test_envelope_is_canonical / test_positions_follow_layout_rule):
 * two resolved registry recordIds, layered positions (x=100+300*depth,
 * y=200+250*lane), one edge with output/input handles.
 */
const PYTHON_ENVELOPE_FIXTURE = {
  version: '1.0.0',
  id: '9a1b6dfd-6a2b-4a0e-9a51-0e63c1d2f7ab',
  name: 'Acme Claims Process',
  createdAt: '2026-07-19T00:00:00.000000Z',
  updatedAt: '2026-07-19T00:00:00.000000Z',
  nodes: [
    { id: 'rec-a', agentId: 'rec-a', position: { x: 100, y: 200 }, configuration: {} },
    { id: 'rec-b', agentId: 'rec-b', position: { x: 400, y: 200 }, configuration: {} },
  ],
  edges: [
    {
      id: 'e-0',
      source: 'rec-a',
      target: 'rec-b',
      sourceHandle: 'output',
      targetHandle: 'input',
    },
  ],
};

describe('generate_process_blueprint envelope round-trips through the backend and frontend gates', () => {
  it('passes validateDefinitionStructure as the JSON string the Python client sends (json.dumps)', () => {
    const result = validateDefinitionStructure(JSON.stringify(PYTHON_ENVELOPE_FIXTURE));
    expect(result).toEqual({ valid: true, errors: [] });
  });

  it('passes validateDefinitionStructure as a parsed object (AppSync AWSJSON form)', () => {
    const result = validateDefinitionStructure(PYTHON_ENVELOPE_FIXTURE);
    expect(result).toEqual({ valid: true, errors: [] });
  });

  it('passes the frontend-guard-mirroring envelope guard from the seed contract work', () => {
    expect(isWorkflowDefinitionEnvelope(PYTHON_ENVELOPE_FIXTURE)).toBe(true);
  });

  // Negative teeth: the gates must actually reject drifted shapes, so a
  // change on either side cannot slip through a vacuous guard.
  it('rejects an envelope whose edge loses sourceHandle (guard is not vacuous)', () => {
    const { sourceHandle: _dropped, ...edgeWithoutHandle } =
      PYTHON_ENVELOPE_FIXTURE.edges[0];
    expect(isWorkflowEdgeDefinition(edgeWithoutHandle)).toBe(false);
    expect(
      isWorkflowDefinitionEnvelope({
        ...PYTHON_ENVELOPE_FIXTURE,
        edges: [edgeWithoutHandle],
      }),
    ).toBe(false);
  });

  it('rejects a node whose position is not {x: number, y: number}', () => {
    const node = { ...PYTHON_ENVELOPE_FIXTURE.nodes[0], position: { x: '100', y: 200 } };
    expect(isWorkflowNodeDefinition(node)).toBe(false);
  });

  it('validateDefinitionStructure rejects an envelope without a nodes array', () => {
    const { nodes: _dropped, ...withoutNodes } = PYTHON_ENVELOPE_FIXTURE;
    const result = validateDefinitionStructure(JSON.stringify(withoutNodes));
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Workflow definition must contain a nodes array');
  });

  it('validateDefinitionStructure rejects a non-JSON definition string', () => {
    const result = validateDefinitionStructure('not json at all');
    expect(result).toEqual({ valid: false, errors: ['Invalid JSON in workflow definition'] });
  });
});
