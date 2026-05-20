/**
 * Project Service
 * Handles all project-related GraphQL operations via AppSync
 * Migrated to use event bus architecture for centralized subscription management
 */

import serverService from "./server";
import { eventBus } from './eventBus';
import { subscriptionManager } from './subscriptionManager';
import { EVENT_TYPES, ProjectProgressEvent, AssessmentCompleteEvent, DesignProgressEvent } from './eventTypes';

export interface ProjectProgress {
  overall: number;
  assessment: number;
  design: number;
  planning: number;
  implementation: number;
  currentPhase: string;
  estimatedCompletion?: string;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  status: "CREATED" | "IN_PROGRESS" | "ASSESSMENT_COMPLETE" | "DESIGN_COMPLETE" | "PLANNING_COMPLETE" | "IMPLEMENTATION_READY" | "COMPLETED" | "ERROR";
  createdAt: string;
  updatedAt: string;
  owner?: string;
  progress?: ProjectProgress;
  // Legacy field for backward compatibility
  lastModified?: string;
  userId?: string;
}

export interface CreateProjectInput {
  name: string;
  description?: string;
  userId?: string;
}

export interface UpdateProjectInput {
  id: string;
  name?: string;
  description?: string;
  status?: "CREATED" | "IN_PROGRESS" | "ASSESSMENT_COMPLETE" | "DESIGN_COMPLETE" | "PLANNING_COMPLETE" | "IMPLEMENTATION_READY" | "COMPLETED" | "ERROR";
}

// GraphQL Queries
const LIST_PROJECTS = `
  query ListProjects {
    listProjects {
      items {
        id
        name
        description
        status
        createdAt
        updatedAt
        owner
        progress {
          overall
          assessment
          design
          planning
          implementation
          currentPhase
          estimatedCompletion
        }
      }
    }
  }
`;

const GET_PROJECT = `
  query GetProject($id: ID!) {
    getProject(id: $id) {
      id
      name
      description
      status
      createdAt
      updatedAt
      owner
      progress {
        overall
        assessment
        design
        planning
        implementation
        currentPhase
        estimatedCompletion
      }
    }
  }
`;

// GraphQL Mutations
const CREATE_PROJECT = `
  mutation CreateProject($input: CreateProjectInput!) {
    createProject(input: $input) {
      id
      name
      description
      status
      createdAt
      updatedAt
      owner
      progress {
        overall
        assessment
        design
        planning
        implementation
        currentPhase
        estimatedCompletion
      }
    }
  }
`;

const UPDATE_PROJECT = `
  mutation UpdateProject($id: ID!, $input: UpdateProjectInput!) {
    updateProject(id: $id, input: $input) {
      id
      name
      description
      status
      createdAt
      updatedAt
      owner
      progress {
        overall
        assessment
        design
        planning
        implementation
        currentPhase
        estimatedCompletion
      }
    }
  }
`;

const DELETE_PROJECT = `
  mutation DeleteProject($id: ID!) {
    deleteProject(id: $id) {
      id
    }
  }
`;

/**
 * Project Service Class
 */
class ProjectService {
  /**
   * List all projects for the current user
   */
  async listProjects(): Promise<Project[]> {
    try {
      const response = await serverService.query<{
        listProjects: { items: Project[] };
      }>(LIST_PROJECTS);

      // Map backend fields to frontend interface with backward compatibility
      const projects = response.listProjects.items.map((project) => ({
        ...project,
        userId: project.owner || project.userId,
        lastModified: project.updatedAt, // For backward compatibility
      }));

      return projects;
    } catch (error) {
      console.error("Failed to list projects:", error);
      throw new Error("Failed to load projects. Please try again.");
    }
  }

  /**
   * Get a single project by ID
   */
  async getProject(id: string): Promise<Project> {
    try {
      const response = await serverService.query<{ getProject: Project }>(
        GET_PROJECT,
        { id }
      );

      return {
        ...response.getProject,
        userId: response.getProject.owner || response.getProject.userId,
        lastModified: response.getProject.updatedAt, // For backward compatibility
      };
    } catch (error) {
      console.error("Failed to get project:", error);
      throw new Error("Failed to load project details. Please try again.");
    }
  }

  /**
   * Create a new project
   */
  async createProject(input: CreateProjectInput): Promise<Project> {
    try {
      // Note: owner/userId is set automatically by the backend based on authenticated user
      // Remove userId from input as backend doesn't accept it
      const { userId, ...projectInput } = input;

      const response = await serverService.mutate<{ createProject: Project }>(
        CREATE_PROJECT,
        { input: projectInput }
      );

      return {
        ...response.createProject,
        userId: response.createProject.owner || response.createProject.userId,
        lastModified: response.createProject.updatedAt, // For backward compatibility
      };
    } catch (error) {
      console.error("Failed to create project:", error);
      throw new Error("Failed to create project. Please try again.");
    }
  }

  /**
   * Update an existing project
   */
  async updateProject(input: UpdateProjectInput): Promise<Project> {
    try {
      const { id, ...updateInput } = input;

      const response = await serverService.mutate<{ updateProject: Project }>(
        UPDATE_PROJECT,
        { id, input: updateInput }
      );

      return {
        ...response.updateProject,
        userId: response.updateProject.owner || response.updateProject.userId,
        lastModified: response.updateProject.updatedAt, // For backward compatibility
      };
    } catch (error) {
      console.error("Failed to update project:", error);
      throw new Error("Failed to update project. Please try again.");
    }
  }

  /**
   * Delete a project
   */
  async deleteProject(id: string): Promise<void> {
    try {
      await serverService.mutate<{ deleteProject: { id: string } }>(
        DELETE_PROJECT,
        { id }
      );
    } catch (error) {
      console.error("Failed to delete project:", error);
      throw new Error("Failed to delete project. Please try again.");
    }
  }

  /**
   * Mark a project as completed
   */
  async completeProject(id: string): Promise<Project> {
    return this.updateProject({
      id,
      status: "COMPLETED",
    });
  }

  /**
   * Mark a project as in-progress
   */
  async reopenProject(id: string): Promise<Project> {
    return this.updateProject({
      id,
      status: "IN_PROGRESS",
    });
  }

  /**
   * Get assessment progress for a project
   */
  async getAssessmentProgress(sessionId: string) {
    const query = `
      query GetAssessmentProgress($sessionId: String!) {
        getAssessmentProgress(sessionId: $sessionId) {
          dimension
          completionPercentage
          isComplete
        }
      }
    `;
    const response = await serverService.query<{
      getAssessmentProgress: Array<{
        dimension: string;
        completionPercentage: number;
        isComplete: boolean;
      }>;
    }>(query, { sessionId });
    return response.getAssessmentProgress;
  }

  /**
   * Subscribe to project progress updates
   * Migrated to use event bus architecture
   * Maintains backward compatibility with callbacks that don't accept arguments
   */
  subscribeToProjectProgress(
    projectId: string,
    callback: ((data: ProjectProgressEvent) => void) | (() => void)
  ): () => void {
    // Initialize backend subscription if needed (SubscriptionManager handles deduplication)
    this.initializeProjectProgressSubscription(projectId);

    // Add local subscriber to reference count
    subscriptionManager.addLocalSubscriber(EVENT_TYPES.PROJECT_PROGRESS);

    // Subscribe to local event bus with projectId filtering
    const unsubscribe = eventBus.subscribe<ProjectProgressEvent>(
      EVENT_TYPES.PROJECT_PROGRESS,
      (data) => {
        // Filter events by projectId
        if (data.projectId === projectId) {
          // Support both callback signatures for backward compatibility
          if (callback.length === 0) {
            // Callback expects no arguments (legacy)
            (callback as () => void)();
          } else {
            // Callback expects data argument (new)
            (callback as (data: ProjectProgressEvent) => void)(data);
          }
        }
      }
    );

    // Return cleanup function
    return () => {
      unsubscribe();
      subscriptionManager.removeLocalSubscriber(EVENT_TYPES.PROJECT_PROGRESS);
    };
  }

  /**
   * Subscribe to assessment completion events
   * Migrated to use event bus architecture
   */
  subscribeToAssessmentCompletion(
    projectId: string,
    callback: (data: AssessmentCompleteEvent) => void
  ): () => void {
    // Initialize backend subscription if needed (SubscriptionManager handles deduplication)
    this.initializeAssessmentCompleteSubscription(projectId);

    // Add local subscriber to reference count
    subscriptionManager.addLocalSubscriber(EVENT_TYPES.ASSESSMENT_COMPLETE);

    // Subscribe to local event bus with projectId filtering
    const unsubscribe = eventBus.subscribe<AssessmentCompleteEvent>(
      EVENT_TYPES.ASSESSMENT_COMPLETE,
      (data) => {
        // Filter events by projectId
        if (data.projectId === projectId) {
          callback(data);
        }
      }
    );

    // Return cleanup function
    return () => {
      unsubscribe();
      subscriptionManager.removeLocalSubscriber(EVENT_TYPES.ASSESSMENT_COMPLETE);
    };
  }

  /**
   * Subscribe to design progress events
   * Migrated to use event bus architecture
   */
  subscribeToDesignProgress(
    projectId: string,
    callback: (data: DesignProgressEvent) => void
  ): () => void {
    // Initialize backend subscription if needed (SubscriptionManager handles deduplication)
    this.initializeDesignProgressSubscription(projectId);

    // Add local subscriber to reference count
    subscriptionManager.addLocalSubscriber(EVENT_TYPES.DESIGN_PROGRESS);

    // Subscribe to local event bus with projectId filtering
    const unsubscribe = eventBus.subscribe<DesignProgressEvent>(
      EVENT_TYPES.DESIGN_PROGRESS,
      (data) => {
        // Filter events by projectId
        if (data.projectId === projectId) {
          callback(data);
        }
      }
    );

    // Return cleanup function
    return () => {
      unsubscribe();
      subscriptionManager.removeLocalSubscriber(EVENT_TYPES.DESIGN_PROGRESS);
    };
  }

  /**
   * Initialize backend subscription for project progress
   * Called on each subscription - SubscriptionManager handles deduplication
   * Note: Each projectId creates a separate backend subscription since the
   * GraphQL subscription is filtered by projectId on the backend
   */
  private initializeProjectProgressSubscription(projectId: string): void {
    const subscription = `
      subscription OnProjectProgress($projectId: ID!) {
        onProjectProgress(projectId: $projectId) {
          overall
          assessment
          design
          planning
          implementation
          currentPhase
          estimatedCompletion
        }
      }
    `;

    // SubscriptionManager will check if this subscription already exists
    // and reuse it if it does, so we don't need to track initialization ourselves
    subscriptionManager.initializeSubscription(
      EVENT_TYPES.PROJECT_PROGRESS,
      subscription,
      { projectId },
      (data: any) => {
        // Transform backend data to ProjectProgressEvent format
        if (data?.onProjectProgress) {
          return {
            projectId: projectId, // Use the parameter, not from response
            overall: data.onProjectProgress.overall,
            assessment: data.onProjectProgress.assessment,
            design: data.onProjectProgress.design,
            planning: data.onProjectProgress.planning,
            implementation: data.onProjectProgress.implementation,
            currentPhase: data.onProjectProgress.currentPhase,
            estimatedCompletion: data.onProjectProgress.estimatedCompletion,
          };
        }
        return null;
      }
    );
  }

  /**
   * Initialize backend subscription for assessment completion
   * Called on each subscription - SubscriptionManager handles deduplication
   * Note: Each projectId creates a separate backend subscription since the
   * GraphQL subscription is filtered by projectId on the backend
   */
  private initializeAssessmentCompleteSubscription(projectId: string): void {
    const subscription = `
      subscription OnAssessmentCompleted($projectId: ID!) {
        onAssessmentCompleted(projectId: $projectId) {
          projectId
          allDimensionsComplete
          timestamp
        }
      }
    `;

    subscriptionManager.initializeSubscription(
      EVENT_TYPES.ASSESSMENT_COMPLETE,
      subscription,
      { projectId },
      (data: any) => {
        // Transform backend data to AssessmentCompleteEvent format
        if (data?.onAssessmentCompleted) {
          return {
            projectId: data.onAssessmentCompleted.projectId,
            allDimensionsComplete: data.onAssessmentCompleted.allDimensionsComplete,
            timestamp: data.onAssessmentCompleted.timestamp,
          };
        }
        return null;
      }
    );
  }

  /**
   * Initialize backend subscription for design progress
   * Called on each subscription - SubscriptionManager handles deduplication
   * Note: Each projectId creates a separate backend subscription since the
   * GraphQL subscription is filtered by projectId on the backend
   */
  private initializeDesignProgressSubscription(projectId: string): void {
    const subscription = `
      subscription OnDesignProgress($projectId: ID!) {
        onDesignProgress(projectId: $projectId) {
          projectId
          sectionId
          completionPercentage
        }
      }
    `;

    subscriptionManager.initializeSubscription(
      EVENT_TYPES.DESIGN_PROGRESS,
      subscription,
      { projectId },
      (data: any) => {
        // Transform backend data to DesignProgressEvent format
        if (data?.onDesignProgress) {
          return {
            projectId: data.onDesignProgress.projectId || projectId,
            sectionId: data.onDesignProgress.sectionId,
            completionPercentage: data.onDesignProgress.completionPercentage,
          };
        }
        return null;
      }
    );
  }

  /**
   * Check if design is already complete for a project
   */
  isDesignComplete(project: Project): boolean {
    return project.status === 'DESIGN_COMPLETE' || project.status === 'COMPLETED';
  }

  /**
   * Generate high-level design for a project
   * Returns true if generation was triggered, false if already complete
   */
  async generateDesign(projectId: string): Promise<boolean> {
    const project = await this.getProject(projectId);
    
    if (this.isDesignComplete(project)) {
      return false;
    }

    const mutation = `
      mutation SendMessageToAgent($projectId: ID!, $agentId: String!, $message: String!) {
        sendMessageToAgent(projectId: $projectId, agentId: $agentId, message: $message) {
          id
        }
      }
    `;

    await serverService.mutate(mutation, {
      projectId,
      agentId: 'agent2',
      message: 'Start HLD generation workflow: Initialize the HLD structure, then systematically generate all 30 sections one by one. Begin now.',
    });

    return true;
  }
}

const ON_CREATE_PROJECT = `
  subscription OnCreateProject {
    onCreateProject {
      id name description status createdAt updatedAt owner
      progress { overall assessment design planning implementation currentPhase }
    }
  }
`;

const ON_UPDATE_PROJECT = `
  subscription OnUpdateProject {
    onUpdateProject {
      id name description status createdAt updatedAt owner
      progress { overall assessment design planning implementation currentPhase }
    }
  }
`;

/**
 * Subscribe to project create/update events for real-time list updates.
 * Returns an unsubscribe function.
 */
export function subscribeToProjectUpdates(
  onUpdate: (project: Project) => void,
): () => void {
  const eventType = 'PROJECT_LIST_UPDATE' as any;

  subscriptionManager.initializeSubscription(
    eventType,
    ON_CREATE_PROJECT,
    {},
    (data: any) => data?.onCreateProject || null,
  );

  subscriptionManager.initializeSubscription(
    eventType + '_update' as any,
    ON_UPDATE_PROJECT,
    {},
    (data: any) => data?.onUpdateProject || null,
  );

  subscriptionManager.addLocalSubscriber(eventType);
  subscriptionManager.addLocalSubscriber(eventType + '_update' as any);

  const unsub1 = eventBus.subscribe(eventType, onUpdate);
  const unsub2 = eventBus.subscribe(eventType + '_update' as any, onUpdate);

  return () => {
    unsub1();
    unsub2();
    subscriptionManager.removeLocalSubscriber(eventType);
    subscriptionManager.removeLocalSubscriber(eventType + '_update' as any);
  };
}

// Export singleton instance
export const projectService = new ProjectService();
