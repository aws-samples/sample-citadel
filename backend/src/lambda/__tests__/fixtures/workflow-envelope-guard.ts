/**
 * Envelope guard: field-for-field mirror of the frontend workflow type
 * guards, shared by the backend contract tests (seed blueprints and the
 * intake Python-client round-trip).
 *
 * KEEP IN SYNC: the guards below mirror isWorkflowDefinition (and its
 * isWorkflowNodeDefinition / isWorkflowEdgeDefinition sub-guards) in
 * frontend/src/types/workflow.ts field-for-field. The frontend guard carries
 * the reciprocal cross-reference comment — if either side changes shape,
 * update both in the same review.
 *
 * Lives under __tests__/fixtures/ so jest imports it without treating it as
 * a test suite (fixtures/ is in testPathIgnorePatterns).
 */

// Mirrors isWorkflowNodeDefinition in frontend/src/types/workflow.ts.
export function isWorkflowNodeDefinition(node: unknown): boolean {
  if (node === null || typeof node !== 'object') {
    return false;
  }
  const candidate = node as {
    id?: unknown;
    agentId?: unknown;
    name?: unknown;
    position?: unknown;
    configuration?: unknown;
  };
  if (candidate.position === null || typeof candidate.position !== 'object') {
    return false;
  }
  const position = candidate.position as { x?: unknown; y?: unknown };
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.agentId === 'string' &&
    (candidate.name === undefined || typeof candidate.name === 'string') &&
    typeof position.x === 'number' &&
    typeof position.y === 'number' &&
    candidate.configuration !== null &&
    typeof candidate.configuration === 'object'
  );
}

// Mirrors isWorkflowEdgeDefinition in frontend/src/types/workflow.ts.
export function isWorkflowEdgeDefinition(edge: unknown): boolean {
  if (edge === null || typeof edge !== 'object') {
    return false;
  }
  const candidate = edge as {
    id?: unknown;
    source?: unknown;
    target?: unknown;
    sourceHandle?: unknown;
    targetHandle?: unknown;
  };
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.source === 'string' &&
    typeof candidate.target === 'string' &&
    typeof candidate.sourceHandle === 'string' &&
    typeof candidate.targetHandle === 'string'
  );
}

// Mirrors isWorkflowDefinition in frontend/src/types/workflow.ts.
export function isWorkflowDefinitionEnvelope(workflow: unknown): boolean {
  if (workflow === null || typeof workflow !== 'object') {
    return false;
  }
  const candidate = workflow as {
    version?: unknown;
    id?: unknown;
    name?: unknown;
    createdAt?: unknown;
    updatedAt?: unknown;
    nodes?: unknown;
    edges?: unknown;
  };
  if (
    typeof candidate.version !== 'string' ||
    typeof candidate.id !== 'string' ||
    typeof candidate.name !== 'string' ||
    typeof candidate.createdAt !== 'string' ||
    typeof candidate.updatedAt !== 'string' ||
    !Array.isArray(candidate.nodes) ||
    !Array.isArray(candidate.edges)
  ) {
    return false;
  }
  return (
    candidate.nodes.every(isWorkflowNodeDefinition) &&
    candidate.edges.every(isWorkflowEdgeDefinition)
  );
}
