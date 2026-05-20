import { useEffect, useRef } from 'react';
import { Radio, Activity } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';

interface ChatterMessage {
  id: string;
  timestamp: string;
  source: string;
  detailType: string;
  detail: any;
}

interface AgentChatterProps {
  isActive: boolean;
  messages: ChatterMessage[];
}

export function AgentChatter({ isActive, messages }: AgentChatterProps) {
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const formatTimestamp = (timestamp: string) => {
    const date = new Date(timestamp);
    return date.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
  };

  const getSourceColor = (source: string) => {
    const colors: Record<string, string> = {
      'citadel': 'text-primary',
      'agent1.assessment': 'text-chart-2',
      'agent2.design': 'text-chart-5',
      'agent3.planning': 'text-chart-4',
      'agent4.implementation': 'text-chart-4',
      'citadel.assessment': 'text-chart-2',
      'supervisor': 'text-chart-3',
    };
    return colors[source] || 'text-muted-foreground';
  };

  const getDetailTypeColor = (detailType: string) => {
    if (detailType.includes('completed')) return 'bg-chart-2/20 text-chart-2';
    if (detailType.includes('progress')) return 'bg-primary/20 text-primary';
    if (detailType.includes('error')) return 'bg-destructive/20 text-destructive';
    if (detailType.includes('started')) return 'bg-chart-4/20 text-chart-4';
    return 'bg-muted/20 text-muted-foreground';
  };

  return (
    <Card className="bg-accent border-border h-full">
      <CardHeader>
        <CardTitle className="text-foreground flex items-center gap-2">
          <Radio className="size-5 text-primary" />
          Agent Communication
          {isActive && (
            <span className="flex items-center gap-1 text-xs text-chart-2 font-normal">
              <Activity className="size-3 animate-pulse" />
              Live
            </span>
          )}
        </CardTitle>
        <CardDescription className="text-muted-foreground">
          Real-time messages between Supervisor and Worker agents
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col min-h-[500px] max-h-[700px] overflow-y-auto gap-3 pr-2">
          {messages.length === 0 ? (
            <div className="flex items-center justify-center h-[500px] text-muted-foreground">
              <div className="text-center">
                <Radio className="size-12 mx-auto mb-3 opacity-50" />
                <p className="text-sm">
                  {isActive ? 'Listening for agent messages...' : 'No active tasks'}
                </p>
                <p className="text-xs mt-1">
                  {isActive ? 'Messages will appear here in real-time' : 'Submit a task to see agent communication'}
                </p>
              </div>
            </div>
          ) : (
            <>
              {messages.map((message, index) => {
                // Parse detail if it's a JSON string
                let detailObj = message.detail;
                if (typeof message.detail === 'string') {
                  try {
                    detailObj = JSON.parse(message.detail);
                  } catch (e) {
                    detailObj = message.detail;
                  }
                }
                
                return (
                  <div
                    key={`${message.id}-${index}`}
                    className="p-3 bg-card border border-border rounded-lg hover:border-input transition-colors"
                  >
                    <div className="flex items-start justify-between gap-2 mb-2">
                      <div className="flex items-center gap-2 flex-1 min-w-0">
                        <span className={`text-xs font-mono font-semibold ${getSourceColor(message.source)} truncate`}>
                          {message.source}
                        </span>
                        <span className={`text-xs px-2 py-0.5 rounded ${getDetailTypeColor(message.detailType)}`}>
                          {message.detailType}
                        </span>
                      </div>
                      <span className="text-xs text-muted-foreground whitespace-nowrap">
                        {formatTimestamp(message.timestamp)}
                      </span>
                    </div>
                    <div className="text-sm text-muted-foreground font-mono">
                      <pre className="whitespace-pre-wrap break-words text-xs">
                        {JSON.stringify(detailObj, null, 2)}
                      </pre>
                    </div>
                  </div>
                );
              })}
              <div ref={messagesEndRef} />
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
