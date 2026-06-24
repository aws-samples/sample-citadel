import { AppSyncResolverHandler } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand, ScanCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { v4 as uuidv4 } from 'uuid';
import { getUserId } from '../utils/appsync';
import { extractOrgFromEvent } from '../utils/auth-event';
import { LifecycleManager, PROJECT_TRANSITIONS } from '../adapters/lifecycle';
import { isGrandfathered, emitGrandfatheredBypass } from '../utils/is-grandfathered';
import { listADRsForProject } from './adr-resolver';
import { listExecutionSpecifications } from './execspec-resolver';
import { getAgentDesignAssessment } from './agent-design-assessment-resolver';

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const eventBridgeClient = new EventBridgeClient({});

const PROJECTS_TABLE = process.env.PROJECTS_TABLE!;
const EVENT_BUS_NAME = process.env.EVENT_BUS_NAME!;

interface Project {
  id: string;
  name: string;
  status: string;
  currentModule: {
    id: string;
    name: string;
    description: string;
    status: string;
    agentId: string;
  };
  progress: {
    overall: number;
    assessment: number;
    design: number;
    planning: number;
    implementation: number;
    currentPhase: string;
    estimatedCompletion?: string;
  };
  createdAt: string;
  updatedAt: string;
  owner: string;
  description?: string;
  requirements?: string;
  // governance archetype classification.
  // archetypeStatus defaults to PENDING when absent; normaliseArchetype
  // handles grandfathering for DDB rows written before this story.
  archetype?: 'MONOLITHIC_DB' | 'ENTERPRISE_APP_SPRAWL' | 'HYBRID_IT_OT';
  archetypeConfidence?: number;
  archetypeStatus?: 'PENDING' | 'CLASSIFIED' | 'PENDING_ESCALATION';
}

/**
 * Normalises archetype attributes on a Project read from DynamoDB.
 *
 * DynamoDB is schemaless, so projects created before archetype
 * classification was introduced do not
 * carry any archetype* attributes. We treat missing archetypeStatus as
 * PENDING so clients see a consistent, non-null value without any
 * backfill migration.
 */
function normaliseArchetype<T extends Partial<Project> | null | undefined>(project: T): T {
  if (!project) return project;
  if (!(project as Project).archetypeStatus) {
    (project as Project).archetypeStatus = 'PENDING';
  }
  return project;
}

export const handler: AppSyncResolverHandler<any, any> = async (event) => {
  console.log('Project resolver event:', JSON.stringify(event, null, 2));

  const { info, arguments: args, identity } = event;
  const fieldName = info.fieldName;
  const userId = getUserId(identity);

  try {
    switch (fieldName) {
      case 'getProject':
        return await getProject(args.id, userId, event);
      case 'listProjects':
        return await listProjects(args.filter, userId, event);
      case 'createProject':
        return await createProject(args.input, userId, event);
      case 'updateProject':
        return await updateProject(args.id, args.input, userId, event);
      case 'uploadDocument':
        return await uploadDocument(args.projectId, args.file, userId, event);
      default:
        throw new Error(`Unknown field: ${fieldName}`);
    }
  } catch (error) {
    console.error('Project resolver error:', error);
    throw error;
  }
};

async function getProject(id: string, userId: string, event: any): Promise<Project | null> {
  const command = new GetCommand({
    TableName: PROJECTS_TABLE,
    Key: { id },
  });

  const result = await docClient.send(command);

  if (!result.Item) {
    return null;
  }

  const project = result.Item as any;

  // Check if user has access to this project
  // Allow access if: user is owner OR user is in same organization
  const userOrganization = await extractOrgFromEvent(event);

  const hasAccess =
    project.owner === userId ||
    (userOrganization && project.organization === userOrganization);

  if (!hasAccess) {
    throw new Error('Access denied');
  }

  return normaliseArchetype(project) as Project;
}

async function listProjects(filter: any, userId: string, event: any): Promise<{ items: Project[]; nextToken?: string }> {
  // Get user's organization
  const userOrganization = await extractOrgFromEvent(event);

  if (!userOrganization) {
    // If user has no organization, fall back to owner-based filtering
    const command = new ScanCommand({
      TableName: PROJECTS_TABLE,
      FilterExpression: '#owner = :userId',
      ExpressionAttributeNames: {
        '#owner': 'owner',
      },
      ExpressionAttributeValues: {
        ':userId': userId,
      },
    });

    const result = await docClient.send(command);
    return {
      items: ((result.Items || []) as Project[]).map((p) => normaliseArchetype(p)!),
      nextToken: result.LastEvaluatedKey? JSON.stringify(result.LastEvaluatedKey): undefined,
    };
  }

  // Query by organization using GSI
  const command = new QueryCommand({
    TableName: PROJECTS_TABLE,
    IndexName: 'OrganizationIndex',
    KeyConditionExpression: 'organization = :org',
    ExpressionAttributeValues: {
      ':org': userOrganization,
    },
    ScanIndexForward: false, // Sort by createdAt descending (newest first)
  });

  const result = await docClient.send(command);

  let items = result.Items as Project[] || [];

  // Apply additional filters
  if (filter) {
    if (filter.status) {
      items = items.filter(item => item.status === filter.status);
    }
    if (filter.createdAfter) {
      items = items.filter(item => item.createdAt >= filter.createdAfter);
    }
    if (filter.createdBefore) {
      items = items.filter(item => item.createdAt <= filter.createdBefore);
    }
  }

  return { items: items.map((p) => normaliseArchetype(p)!) };
}

async function createProject(input: any, userId: string, event: any): Promise<Project> {
  const now = new Date().toISOString();
  const projectId = uuidv4();

  // Get user's organization
  const userOrganization = await extractOrgFromEvent(event);

  const project: Project = {
    id: projectId,
    name: input.name,
    description: input.description || '',
    requirements: input.requirements || '',
    status: 'CREATED',
    currentModule: {
      id: 'assessment',
      name: 'Document Assessment',
      description: 'Initial document review and analysis',
      status: 'PENDING',
      agentId: 'agent1',
    },
    progress: {
      overall: 0,
      assessment: 0,
      design: 0,
      planning: 0,
      implementation: 0,
      currentPhase: 'CREATED',
    },
    createdAt: now,
    updatedAt: now,
    owner: userId,
    organization: userOrganization || undefined,
    // new projects start PENDING; archetype/archetypeConfidence
    // stay absent until an archetype classifier populates them.
    archetypeStatus: 'PENDING',
  } as any;

  const command = new PutCommand({
    TableName: PROJECTS_TABLE,
    Item: project,
  });

  await docClient.send(command);

  // Emit project created event
  await emitEvent('project.created', {
    projectId,
    userId,
    project,
  });

  return project;
}

/**
 * phase-transition guard.
 *
 * Runs governance preconditions on project status changes:
 *   - CREATED → IN_PROGRESS                     requires completed AgentDesignAssessment (C3)
 *   - DESIGN_COMPLETE → PLANNING_COMPLETE       requires ≥1 LOCKED ADR (C7)
 *   - PLANNING_COMPLETE → IMPLEMENTATION_READY  requires ≥1 APPROVED ExecutionSpecification (C10)
 *
 * Grandfathered projects (createdAt < ssm.effective_at) bypass the gate
 * and emit `governance.grandfathered.bypass` for telemetry (QT2B-10).
 *
 * Throws `ValidationError: …` on gate failure. The LifecycleManager
 * transition-map check runs first, so invalid transitions throw BEFORE
 * the governance hook is consulted.
 */
async function projectPhaseGuard(
  currentStatus: string,
  nextStatus: string,
  project: Project,
  userId: string,
): Promise<void> {
  const lifecycle = new LifecycleManager(PROJECT_TRANSITIONS);
  await lifecycle.validateTransitionWithHook(
    currentStatus,
    nextStatus,
    async (_current, next, _context) => {
      // Only the three governance-gated next-statuses trigger a check.
      // Other transitions (ASSESSMENT_COMPLETE, COMPLETED, ERROR, …) pass through.
      if (next === 'IN_PROGRESS') {
        await checkC3Assessment(project);
      } else if (next === 'PLANNING_COMPLETE') {
        await checkC7Adr(project);
      } else if (next === 'IMPLEMENTATION_READY') {
        await checkC10Spec(project);
      }
    },
    { projectId: project.id, actorUserId: userId },
  );
}

async function checkC3Assessment(project: Project): Promise<void> {
  if (await isGrandfathered(project)) {
    await emitBypass(project, 'C3_assessment_required');
    return;
  }
  const assessment = await getAgentDesignAssessment(project.id);
  if (!assessment || !assessment.completedAt) {
    throw new Error(
      'ValidationError: IN_PROGRESS requires a completed AgentDesignAssessment',
    );
  }
}

async function checkC7Adr(project: Project): Promise<void> {
  if (await isGrandfathered(project)) {
    await emitBypass(project, 'C7_adr_required');
    return;
  }
  const adrs = await listADRsForProject(project.id);
  if (!adrs.some((a: any) => a.status === 'LOCKED')) {
    throw new Error(
      'ValidationError: PLANNING_COMPLETE requires at least one LOCKED ADR',
    );
  }
}

async function checkC10Spec(project: Project): Promise<void> {
  if (await isGrandfathered(project)) {
    await emitBypass(project, 'C10_spec_required');
    return;
  }
  const specs = await listExecutionSpecifications(project.id);
  if (!specs.some((s: any) => s.status === 'APPROVED')) {
    throw new Error(
      'ValidationError: IMPLEMENTATION_READY requires at least one APPROVED ExecutionSpecification',
    );
  }
}

async function emitBypass(
  project: Project,
  bypassedGate: 'C3_assessment_required' | 'C7_adr_required' | 'C10_spec_required',
): Promise<void> {
  // Read the live effective_at from SSM (cached 60 min by governance-flag.ts).
  // Fire-and-forget: bypass telemetry must not fail the underlying transition.
  try {
    const { getGovernanceEffectiveAt } = await import('../utils/governance-flag');
    const env = process.env.ENVIRONMENT ?? 'dev';
    const effectiveAt = (await getGovernanceEffectiveAt(env)) ?? '';
    await emitGrandfatheredBypass(
      project.id,
      bypassedGate,
      project.createdAt,
      effectiveAt,
    );
  } catch (err) {
    console.warn('Failed to emit governance.grandfathered.bypass', err);
  }
}

async function updateProject(id: string, input: any, userId: string, event: any): Promise<Project> {
  // First check if project exists and user has access
  const existingProject = await getProject(id, userId, event);
  if (!existingProject) {
    throw new Error('Project not found or access denied');
  }

  const now = new Date().toISOString();
  const updateExpression: string[] = [];
  const expressionAttributeNames: Record<string, string> = {};
  const expressionAttributeValues: Record<string, any> = {};

  if (input.name) {
    updateExpression.push('#name = :name');
    expressionAttributeNames['#name'] = 'name';
    expressionAttributeValues[':name'] = input.name;
  }

  if (input.description!== undefined) {
    updateExpression.push('#description = :description');
    expressionAttributeNames['#description'] = 'description';
    expressionAttributeValues[':description'] = input.description;
  }

  if (input.requirements!== undefined) {
    updateExpression.push('#requirements = :requirements');
    expressionAttributeNames['#requirements'] = 'requirements';
    expressionAttributeValues[':requirements'] = input.requirements;
  }

    // governance phase-transition gates.
    // When status is changing (not same-status write), route through the
    // LifecycleManager hook so C3/C7/C10 governance preconditions are
    // enforced (or bypassed + telemetry-logged for grandfathered projects).
    if (input.status && input.status !== (existingProject as any).status) {
      await projectPhaseGuard(
        (existingProject as any).status,
        input.status,
        existingProject as Project,
        userId,
      );
      updateExpression.push('#status = :status');
      expressionAttributeNames['#status'] = 'status';
      expressionAttributeValues[':status'] = input.status;
    } else if (input.status) {
      // Same-status write — no gate. Preserve existing behaviour.
      updateExpression.push('#status = :status');
      expressionAttributeNames['#status'] = 'status';
      expressionAttributeValues[':status'] = input.status;
    }

  // archetype passthrough. No transition validation — gate logic
  // is deferred to. GraphQL enum parsing guarantees valid values
  // reach the resolver.
  if (input.archetype!== undefined) {
    updateExpression.push('#archetype = :archetype');
    expressionAttributeNames['#archetype'] = 'archetype';
    expressionAttributeValues[':archetype'] = input.archetype;
  }

  if (input.archetypeConfidence!== undefined) {
    updateExpression.push('#archetypeConfidence = :archetypeConfidence');
    expressionAttributeNames['#archetypeConfidence'] = 'archetypeConfidence';
    expressionAttributeValues[':archetypeConfidence'] = input.archetypeConfidence;
  }

  if (input.archetypeStatus!== undefined) {
    updateExpression.push('#archetypeStatus = :archetypeStatus');
    expressionAttributeNames['#archetypeStatus'] = 'archetypeStatus';
    expressionAttributeValues[':archetypeStatus'] = input.archetypeStatus;
  }

  updateExpression.push('#updatedAt = :updatedAt');
  expressionAttributeNames['#updatedAt'] = 'updatedAt';
  expressionAttributeValues[':updatedAt'] = now;

  // D-02: Optimistic locking — increment version with conditional write
  const currentVersion = (existingProject as any).version || 0;
  updateExpression.push('#version = :nextVersion');
  expressionAttributeNames['#version'] = 'version';
  expressionAttributeValues[':nextVersion'] = currentVersion + 1;
  expressionAttributeValues[':currentVersion'] = currentVersion;

  const conditionExpression = currentVersion === 0
    ? '(attribute_not_exists(version) OR version = :currentVersion)'
    : 'version = :currentVersion';

  try {
    const command = new UpdateCommand({
      TableName: PROJECTS_TABLE,
      Key: { id },
      UpdateExpression: `SET ${updateExpression.join(', ')}`,
      ConditionExpression: conditionExpression,
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues,
      ReturnValues: 'ALL_NEW',
    });

    const result = await docClient.send(command);

    // Emit project updated event
    await emitEvent('project.updated', {
      projectId: id,
      userId,
      changes: input,
    });

    return normaliseArchetype(result.Attributes as Project) as Project;
  } catch (error: unknown) {
    if (error instanceof Error && error.name === 'ConditionalCheckFailedException') {
      throw new Error(`Conflict: project ${id} was modified concurrently. Please retry.`);
    }
    throw error;
  }
}

async function uploadDocument(projectId: string, file: any, userId: string, event: any): Promise<any> {
  // Check if user has access to this project
  const project = await getProject(projectId, userId, event);
  if (!project) {
    throw new Error('Project not found or access denied');
  }

  // In a real implementation, you would handle S3 upload here
  // For now, we'll just return a success response
  const documentId = uuidv4();

  // Emit document uploaded event
  await emitEvent('document.uploaded', {
    projectId,
    documentId,
    userId,
    file,
  });

  return {
    success: true,
    documentId,
    url: `https://s3.amazonaws.com/${file.bucket}/${file.key}`,
    message: 'Document uploaded successfully',
  };
}

async function emitEvent(eventType: string, detail: any): Promise<void> {
  const command = new PutEventsCommand({
    Entries: [
      {
        Source: 'citadel.backend',
        DetailType: eventType,
        Detail: JSON.stringify(detail),
        EventBusName: EVENT_BUS_NAME,
      },
    ],
  });

  await eventBridgeClient.send(command);
}