/**
 * GraphQL client/schema contract guard.
 *
 * Parses the backend SDL and each frontend client operation document, then
 * diffs them so drift (wrong argument name/type/nullability, wrong return type,
 * or a selected field that does not exist on the return type) fails the build.
 *
 * Scope: the workflow/execution operations wired into the canvas —
 * startExecution, cancelExecution, publishWorkflow, createWorkflow,
 * updateWorkflow, and the onWorkflowProgress subscription.
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

import { START_EXECUTION, CANCEL_EXECUTION } from '../executionApiService';
import { CREATE_WORKFLOW, UPDATE_WORKFLOW, PUBLISH_WORKFLOW } from '../workflowApiService';
import { ON_WORKFLOW_PROGRESS } from '../../hooks/useExecutionSubscription';

const SDL_PATH = path.resolve(__dirname, '../../../../backend/src/schema/schema.graphql');
const sdl: DocumentNode = parse(fs.readFileSync(SDL_PATH, 'utf8'));

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

interface ClientOperation {
  operation: 'query' | 'mutation' | 'subscription';
  rootField: string;
  variableTypes: Record<string, string>; // variable name -> printed type (e.g. "ID!")
  argVariables: Record<string, string>; // argument name -> referenced variable name
  selection: string[]; // top-level selected field names on the return type
}

function parseClientOperation(doc: string): ClientOperation {
  const opDef = parse(doc).definitions.find(
    (d): d is OperationDefinitionNode => d.kind === 'OperationDefinition'
  );
  if (!opDef) throw new Error('client document has no operation definition');

  const variableTypes: Record<string, string> = {};
  for (const v of opDef.variableDefinitions ?? []) {
    variableTypes[v.variable.name.value] = print(v.type);
  }

  const rootField = opDef.selectionSet.selections.find(
    (s): s is FieldNode => s.kind === 'Field'
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

  return { operation: opDef.operation, rootField: rootField.name.value, variableTypes, argVariables, selection };
}

type RootType = 'Mutation' | 'Subscription';

interface OpCase {
  label: string;
  doc: string;
  root: RootType;
  field: string;
  returnType: string;
}

const OPERATIONS: OpCase[] = [
  { label: 'startExecution', doc: START_EXECUTION, root: 'Mutation', field: 'startExecution', returnType: 'Execution' },
  { label: 'cancelExecution', doc: CANCEL_EXECUTION, root: 'Mutation', field: 'cancelExecution', returnType: 'Execution' },
  { label: 'publishWorkflow', doc: PUBLISH_WORKFLOW, root: 'Mutation', field: 'publishWorkflow', returnType: 'Workflow' },
  { label: 'createWorkflow', doc: CREATE_WORKFLOW, root: 'Mutation', field: 'createWorkflow', returnType: 'Workflow' },
  { label: 'updateWorkflow', doc: UPDATE_WORKFLOW, root: 'Mutation', field: 'updateWorkflow', returnType: 'Workflow' },
  { label: 'onWorkflowProgress', doc: ON_WORKFLOW_PROGRESS, root: 'Subscription', field: 'onWorkflowProgress', returnType: 'WorkflowProgressEvent' },
];

describe('GraphQL client documents match backend schema.graphql', () => {
  it.each(OPERATIONS)('$label: root field, operation type and return type match the SDL', (op) => {
    const client = parseClientOperation(op.doc);
    const field = sdlField(op.root, op.field);

    expect(client.rootField).toBe(op.field);
    expect(client.operation).toBe(op.root === 'Subscription' ? 'subscription' : 'mutation');
    expect(baseTypeName(print(field.type))).toBe(op.returnType);
  });

  it.each(OPERATIONS)('$label: arguments (names, types, nullability) match the SDL', (op) => {
    const client = parseClientOperation(op.doc);
    const field = sdlField(op.root, op.field);

    const sdlArgs: Record<string, string> = {};
    for (const a of field.arguments ?? []) sdlArgs[a.name.value] = print(a.type);

    // Every argument the client passes exists in the SDL with an identical type (incl. nullability).
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
    const client = parseClientOperation(op.doc);
    const returnFields = sdlTypeFieldNames(op.returnType);
    for (const selected of client.selection) {
      expect(returnFields.has(selected)).toBe(true);
    }
  });

  it('onWorkflowProgress selects exactly the WorkflowProgressEvent fields', () => {
    const client = parseClientOperation(ON_WORKFLOW_PROGRESS);
    expect(new Set(client.selection)).toEqual(sdlTypeFieldNames('WorkflowProgressEvent'));
  });
});
