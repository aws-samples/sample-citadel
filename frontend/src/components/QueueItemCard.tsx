import React from 'react';
import { FabricationQueueItem } from '../services/fabricatorQueueService';
import { Card } from './ui/card';
import { Clock, Loader2, CheckCircle, XCircle } from 'lucide-react';
import { Alert, AlertDescription } from './ui/alert';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from './ui/tooltip';

// Utility function to format time ago
const formatTimeAgo = (dateString: string): string => {
  const date = new Date(dateString);
  const now = new Date();
  const seconds = Math.floor((now.getTime() - date.getTime()) / 1000);

  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} ${minutes === 1 ? 'min' : 'mins'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? 'day' : 'days'} ago`;
};

interface QueueItemCardProps {
  item: FabricationQueueItem;
  onNavigate?: (view: string) => void;
}

const getStatusIcon = (status: string) => {
  switch (status) {
    case 'PENDING':
      return <Clock className="size-4 text-muted-foreground" />;
    case 'PROCESSING':
      return <Loader2 className="size-4 text-primary animate-spin" />;
    case 'COMPLETED':
      return <CheckCircle className="size-4 text-chart-2" />;
    case 'FAILED':
      return <XCircle className="size-4 text-destructive" />;
    default:
      return null;
  }
};

export const QueueItemCard: React.FC<QueueItemCardProps> = ({ item, onNavigate }) => {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Card className="p-4 bg-accent border-border hover:bg-accent transition-colors">
            <div className="flex items-start justify-between">
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  {getStatusIcon(item.status)}
                  <h4 className="font-medium text-foreground">{item.agentName}</h4>
                </div>
                {item.appId && item.appName && (
                  <span
                    data-testid={`app-badge-${item.appId}`}
                    className="inline-block mt-1 px-2 py-0.5 text-xs rounded bg-chart-5/20 text-chart-5 cursor-pointer hover:bg-chart-5/30 transition-colors"
                    onClick={(e) => {
                      e.stopPropagation();
                      onNavigate?.(`app-detail:${item.appId}`);
                    }}
                  >
                    {item.appName}
                  </span>
                )}
                <p className="text-sm text-muted-foreground mt-1">
                  {formatTimeAgo(item.submittedAt)}
                </p>
                {item.errorMessage && (
                  <Alert variant="destructive" className="mt-2">
                    <AlertDescription>{item.errorMessage}</AlertDescription>
                  </Alert>
                )}
              </div>
            </div>
          </Card>
        </TooltipTrigger>
        <TooltipContent>
          <div className="text-xs">
            <p><strong>Request ID:</strong> {item.requestId}</p>
            {item.metadata && (
              <p><strong>Metadata:</strong> {JSON.stringify(item.metadata)}</p>
            )}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
};
