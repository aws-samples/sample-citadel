import { useState, useCallback } from 'react';
import { Play, CheckCircle, AlertCircle } from 'lucide-react';
import { Button } from './ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { Textarea } from './ui/textarea';
import { Input } from './ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './ui/select';
import { taskRunnerService } from '../services/taskRunnerService';
import { AgentChatter } from './AgentChatter';
import { useChatterSubscription } from '../hooks/useChatterSubscription';
import serverService from '../services/server';

interface ChatterMessage {
  id: string;
  timestamp: string;
  source: string;
  detailType: string;
  detail: any;
}

// Helper function to extract event bus name from ARN
const extractEventBusName = (arn: string): string => {
  // Format: arn:aws:events:region:account:event-bus/bus-name
  const match = arn.match(/event-bus\/(.+)$/);
  return match ? `event-bus/${match[1]}` : arn;
};

export function TaskRunner() {
  const config = serverService.getConfig();
  const defaultEventBusArn = config?.eventBusUrl || '';
  const defaultDisplayValue = defaultEventBusArn ? extractEventBusName(defaultEventBusArn) : '';
  
  const [taskDetails, setTaskDetails] = useState('');
  const [callbackType, setCallbackType] = useState<'eventbridge' | 'sqs' | 'mcp'>('eventbridge');
  const [callbackUrl, setCallbackUrl] = useState(defaultDisplayValue);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<{ orchestrationId: string; message: string } | null>(null);
  const [isSubscribed, setIsSubscribed] = useState(false);
  const [chatterMessages, setChatterMessages] = useState<ChatterMessage[]>([]);
  const [supervisorResponse, setSupervisorResponse] = useState<string | null>(null);

  const handleChatterMessage = useCallback((message: ChatterMessage) => {
    setChatterMessages((prev) => [...prev, message]);
    
    // Check if this is a supervisor response
    if (message.source === 'supervisor' && message.detailType === 'task.response') {
      try {
        const detail = typeof message.detail === 'string' ? JSON.parse(message.detail) : message.detail;
        setSupervisorResponse(detail.message || 'Task completed');
        // Stop listening to chatter once we receive the final response
        setIsSubscribed(false);
      } catch (e) {
        console.error('Error parsing supervisor response:', e);
      }
    }
  }, []);

  // Subscribe to chatter when a task is active
  useChatterSubscription(handleChatterMessage, isSubscribed);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!taskDetails.trim()) {
      setError('Please enter task details');
      return;
    }

    try {
      setLoading(true);
      setError(null);
      setSuccess(null);

      // Prepare callback configuration based on type
      let finalCallbackUrl = callbackUrl.trim();
      
      // If using default display value (just event-bus/name), reconstruct full ARN
      if (callbackType === 'eventbridge' && finalCallbackUrl === defaultDisplayValue && defaultEventBusArn) {
        finalCallbackUrl = defaultEventBusArn;
      }
      
      // If empty, use default ARN
      if (!finalCallbackUrl && defaultEventBusArn) {
        finalCallbackUrl = defaultEventBusArn;
      }
      
      let callback;
      
      if (finalCallbackUrl) {
        if (callbackType === 'eventbridge') {
          callback = {
            type: 'eventbridge',
            eventBusName: finalCallbackUrl,
            source: 'supervisor',
            detailType: 'task.response'
          };
        } else if (callbackType === 'sqs') {
          callback = {
            type: 'sqs',
            queueUrl: finalCallbackUrl
          };
        } else if (callbackType === 'mcp') {
          callback = {
            type: 'mcp',
            endpoint: finalCallbackUrl
          };
        }
      }

      const response = await taskRunnerService.submitTask({
        taskDetails: taskDetails.trim(),
        ...(callback && { callback }),
      });

      if (response.success) {
        setSuccess({
          orchestrationId: response.orchestrationId,
          message: response.message || 'Task submitted successfully',
        });
        setTaskDetails(''); // Clear the form
        setIsSubscribed(true); // Start listening to chatter
        setChatterMessages([]); // Clear previous messages
        setSupervisorResponse(null); // Clear previous supervisor response
      } else {
        setError(response.message || 'Failed to submit task');
      }
    } catch (err: any) {
      console.error('Failed to submit task:', err);
      setError(err.message || 'Failed to submit task');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-card p-6">
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-foreground mb-1">Task Runner</h2>
        <p className="text-muted-foreground text-sm">
          Submit tasks to the Supervisor agent for orchestration and execution
        </p>
      </div>

      {/* Supervisor Response Section - Full Width Below */}
      {success && (
        <div className="flex gap-6 mb-6">
          <Card className="bg-accent border-border">
            <CardHeader>
              <CardTitle className="text-foreground flex items-center gap-2">
                <CheckCircle className="size-5 text-chart-2" />
                Supervisor Response
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="flex items-start gap-3 p-4 bg-chart-2/10 border border-chart-2/50 rounded-lg">
                <div className="flex-1">
                  <p className="text-chart-2 font-medium">Task Submitted Successfully</p>
                  <p className="text-chart-2 text-sm mt-1">{success.message}</p>
                  <div className="mt-3 p-3 bg-card rounded border border-border">
                    <p className="text-xs text-muted-foreground mb-1">Orchestration ID:</p>
                    <p className="text-sm text-foreground font-mono">{success.orchestrationId}</p>
                  </div>
                </div>
              </div>

              {/* Supervisor Final Response */}
              {supervisorResponse && (
                <div className="flex items-start gap-3 p-4 bg-primary/10 border border-primary/50 rounded-lg">
                  <div className="flex-1">
                    <p className="text-primary font-medium">Supervisor Final Response</p>
                    <p className="text-primary text-sm mt-2 whitespace-pre-wrap">{supervisorResponse}</p>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {/* Two Column Layout */}
      <div className="flex gap-6 mb-6">
        {/* Left Column - Task Submission */}
        <div className="flex flex-col-1 gap-6" style={{ minWidth: '400px', maxWidth: '600px' }}>
          <Card className="bg-accent border-border">
            <CardHeader>
              <CardTitle className="text-foreground">Submit New Task</CardTitle>
              <CardDescription className="text-muted-foreground">
                Describe the task you want the AI agents to perform
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleSubmit} className="flex flex-col gap-4">
                <div>
                  <label htmlFor="taskDetails" className="block text-sm font-medium text-foreground mb-2">
                    Task Details *
                  </label>
                  <Textarea
                    id="taskDetails"
                    value={taskDetails}
                    onChange={(e) => setTaskDetails(e.target.value)}
                    placeholder="Describe what you want the agents to do..."
                    className="min-h-[200px] resize-y"
                    disabled={loading}
                  />
                  <p className="mt-2 text-xs text-muted-foreground">
                    Be specific about what you want to achieve
                  </p>
                </div>

                <div>
                  <label htmlFor="callbackType" className="block text-sm font-medium text-foreground mb-2">
                    Callback Type
                  </label>
                  <Select
                    value={callbackType}
                    onValueChange={(v) => setCallbackType(v as 'eventbridge' | 'sqs' | 'mcp')}
                    disabled={loading}
                  >
                    <SelectTrigger id="callbackType">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="eventbridge">EventBridge</SelectItem>
                      <SelectItem value="sqs">SQS Queue</SelectItem>
                      <SelectItem value="mcp">MCP Webhook</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="mt-2 text-xs text-muted-foreground">
                    Choose where to send task completion results
                  </p>
                </div>

                <div>
                  <label htmlFor="callbackUrl" className="block text-sm font-medium text-foreground mb-2">
                    Callback URL
                  </label>
                  <Input
                    id="callbackUrl"
                    type="text"
                    value={callbackUrl}
                    onChange={(e) => setCallbackUrl(e.target.value)}
                    placeholder={
                      callbackType === 'eventbridge' 
                        ? 'event-bus/bus-name or full ARN'
                        : callbackType === 'sqs'
                        ? 'https://sqs.region.amazonaws.com/account/queue-name'
                        : 'https://your-mcp-server.com/webhook/endpoint'
                    }
                    disabled={loading}
                  />
                  <p className="mt-2 text-xs text-muted-foreground">
                    {callbackType === 'eventbridge' && 'Default shows bus name only. Provide full ARN for custom bus.'}
                    {callbackType === 'sqs' && 'Full SQS queue URL'}
                    {callbackType === 'mcp' && 'HTTP/HTTPS webhook endpoint for MCP server'}
                  </p>
                </div>

                {/* Error Message */}
                {error && (
                  <div className="flex items-start gap-3 p-4 bg-destructive/10 border border-destructive/50 rounded-lg">
                    <AlertCircle className="size-5 text-destructive flex-shrink-0 mt-0.5" />
                    <div>
                      <p className="text-destructive font-medium">Error</p>
                      <p className="text-destructive text-sm mt-1">{error}</p>
                    </div>
                  </div>
                )}

                <div className="flex justify-end">
                  <Button
                    type="submit"
                    disabled={loading || !taskDetails.trim()}
                  >
                    {loading ? (
                      <>
                        <div className="animate-spin rounded-full size-4 border-b-2 border-border/50 mr-2"></div>
                        Submitting...
                      </>
                    ) : (
                      <>
                        <Play className="size-4 mr-2" />
                        Submit Task
                      </>
                    )}
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>

          {/* Info Card */}
          <Card className="bg-accent border-border">
            <CardHeader>
              <CardTitle className="text-foreground text-base">How It Works</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3 text-sm text-muted-foreground">
              <div className="flex gap-3">
                <div className="flex-shrink-0 size-6 rounded-full bg-primary/20 text-primary flex items-center justify-center text-xs font-bold">
                  1
                </div>
                <div>
                  <p className="text-foreground font-medium">Task Submission</p>
                  <p className="text-xs mt-1">Your task is sent to the Supervisor agent via EventBridge</p>
                </div>
              </div>
              <div className="flex gap-3">
                <div className="flex-shrink-0 size-6 rounded-full bg-primary/20 text-primary flex items-center justify-center text-xs font-bold">
                  2
                </div>
                <div>
                  <p className="text-foreground font-medium">Task Analysis</p>
                  <p className="text-xs mt-1">The Supervisor analyzes the task and determines which agents are needed</p>
                </div>
              </div>
              <div className="flex gap-3">
                <div className="flex-shrink-0 size-6 rounded-full bg-primary/20 text-primary flex items-center justify-center text-xs font-bold">
                  3
                </div>
                <div>
                  <p className="text-foreground font-medium">Agent Orchestration</p>
                  <p className="text-xs mt-1">The Supervisor coordinates multiple agents to complete the task</p>
                </div>
              </div>
              <div className="flex gap-3">
                <div className="flex-shrink-0 size-6 rounded-full bg-primary/20 text-primary flex items-center justify-center text-xs font-bold">
                  4
                </div>
                <div>
                  <p className="text-foreground font-medium">Results</p>
                  <p className="text-xs mt-1">You'll receive updates as the task progresses and completes</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Right Column - Message Bus Display */}
        <div className="flex-1">
          <AgentChatter isActive={isSubscribed} messages={chatterMessages} />
        </div>
      </div>
    </div>
  );
}
