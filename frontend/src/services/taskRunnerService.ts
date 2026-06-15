import serverService from './server';

const SUBMIT_TASK = `
  mutation SubmitTask($input: SubmitTaskInput!) {
    submitTask(input: $input) {
      success
      orchestrationId
      message
    }
  }
`;

export interface TaskCallback {
  type: string;
  eventBusName?: string;
  source?: string;
  detailType?: string;
  queueUrl?: string;
  endpoint?: string;
  serverId?: string;
  metadata?: any;
}

export interface SubmitTaskInput {
  taskDetails: string;
  callback?: TaskCallback;
}

export interface TaskSubmissionResponse {
  success: boolean;
  orchestrationId: string;
  message?: string;
}

export const taskRunnerService = {
  async submitTask(input: SubmitTaskInput): Promise<TaskSubmissionResponse> {
    try {
      const response = await serverService.mutate<{ submitTask: TaskSubmissionResponse }>(
        SUBMIT_TASK,
        { input }
      );

      return response.submitTask;
    } catch (error) {
      console.error('Error submitting task:', error);
      throw error;
    }
  },
};
