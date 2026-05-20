import { LucideIcon, Trash2, AlertTriangle } from 'lucide-react';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { Tooltip, TooltipTrigger, TooltipContent } from './ui/tooltip';
import { DataStore, DataStoreStatus, DataStoreCategory, DataStoreUsage } from '../services/datastoreService';

interface DataStoreCardProps {
  dataStore: DataStore;
  icon: LucideIcon;
  statusIcon: LucideIcon;
  onConfigure: (dataStore: DataStore) => void;
  onConnect?: (dataStore: DataStore) => void;
  onDisconnect?: (dataStore: DataStore) => void;
  onDelete?: (dataStore: DataStore) => void;
}

const statusColors: Record<string, string> = {
  [DataStoreStatus.CREATED]: "bg-transparent text-muted-foreground border border-border",
  [DataStoreStatus.CONNECTING]: "bg-transparent text-primary border border-primary/50",
  [DataStoreStatus.CONNECTED]: "bg-transparent text-chart-2 border border-chart-2/50",
  [DataStoreStatus.PROVISIONING]: "bg-transparent text-primary border border-primary/50",
  [DataStoreStatus.PROVISIONED]: "bg-transparent text-chart-2 border border-chart-2/50",
  [DataStoreStatus.DISCONNECTED]: "bg-transparent text-muted-foreground border border-border",
  [DataStoreStatus.ERROR]: "bg-transparent text-destructive border border-destructive/50",
  [DataStoreStatus.DELETING]: "bg-transparent text-chart-4 border border-chart-4/50",
};

const categoryColors: Record<string, string> = {
  [DataStoreCategory.KNOWLEDGE_BASE]: "bg-transparent text-primary border border-primary/50",
  [DataStoreCategory.NOSQL_DATABASE]: "bg-transparent text-chart-2 border border-chart-2/50",
  [DataStoreCategory.RELATIONAL_DATABASE]: "bg-transparent text-chart-2 border border-chart-2/50",
  [DataStoreCategory.S3_STORAGE]: "bg-transparent text-chart-4 border border-chart-4/50",
  [DataStoreCategory.DATA_WAREHOUSE]: "bg-transparent text-chart-5 border border-chart-5/50",
  [DataStoreCategory.DATA_LAKE]: "bg-transparent text-chart-5 border border-chart-5/50",
  [DataStoreCategory.SEARCH_ENGINE]: "bg-transparent text-chart-3 border border-chart-3/50",
  [DataStoreCategory.GRAPH_DATABASE]: "bg-transparent text-indigo-400 border border-indigo-500/50",
  [DataStoreCategory.TIME_SERIES]: "bg-transparent text-chart-4 border border-chart-4/50",
  [DataStoreCategory.DOCUMENT_DATABASE]: "bg-transparent text-teal-400 border border-teal-500/50",
  [DataStoreCategory.CACHE]: "bg-transparent text-pink-400 border border-pink-500/50",
  [DataStoreCategory.EXTERNAL]: "bg-transparent text-muted-foreground border border-border",
};

const usageColors: Record<string, string> = {
  [DataStoreUsage.KNOWLEDGE]: "bg-transparent text-primary border border-primary/50",
  [DataStoreUsage.OPERATIONAL]: "bg-transparent text-amber-300 border border-amber-400/50",
};

const usageLabels: Record<string, string> = {
  [DataStoreUsage.KNOWLEDGE]: "Knowledge",
  [DataStoreUsage.OPERATIONAL]: "Operational",
};

export function DataStoreCard({
  dataStore,
  icon: Icon,
  statusIcon: StatusIcon,
  onConfigure,
  onConnect,
  onDisconnect,
  onDelete
}: DataStoreCardProps) {
  return (
    <Card 
      className="hover:shadow-lg transition-shadow bg-card border border-border"
    >
      <CardHeader className="pb-4">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-white/5">
              <Icon className="size-6 text-muted-foreground" />
            </div>
            <div>
              <CardTitle className="text-lg flex items-center gap-2 text-foreground">
                {dataStore.name}
                {dataStore.errorMessage && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <AlertTriangle className="size-4 text-chart-4 cursor-help" />
                    </TooltipTrigger>
                    <TooltipContent side="top">
                      <p>{dataStore.errorMessage}</p>
                    </TooltipContent>
                  </Tooltip>
                )}
              </CardTitle>
              <p className="text-xs text-muted-foreground">
                {dataStore.category}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <StatusIcon 
              className={`size-4 ${
                dataStore.status === DataStoreStatus.CONNECTED 
                  ? 'text-chart-2' 
                  : dataStore.status === DataStoreStatus.CONNECTING || dataStore.status === DataStoreStatus.PROVISIONING
                  ? 'text-primary'
                  : dataStore.status === DataStoreStatus.ERROR 
                  ? 'text-destructive' 
                  : 'text-muted-foreground'
              }`} 
            />
            <Badge className={statusColors[dataStore.status] || statusColors[DataStoreStatus.DISCONNECTED]} variant="secondary">
              {dataStore.status}
            </Badge>
          </div>
        </div>
      </CardHeader>
      
      <CardContent className="flex flex-col gap-4">
        <CardDescription className="text-muted-foreground">
          {dataStore.description}
        </CardDescription>
        
        <div className="flex items-center justify-between text-sm">
          <div className="flex items-center gap-2">
            <Badge 
              className={categoryColors[dataStore.category] || categoryColors[DataStoreCategory.EXTERNAL]} 
              variant="secondary"
            >
              {dataStore.category.replace(/_/g, ' ')}
            </Badge>
            {dataStore.usage && dataStore.usage === DataStoreUsage.BOTH ? (
              <>
                <Badge
                  className={usageColors[DataStoreUsage.KNOWLEDGE]}
                  variant="secondary"
                >
                  {usageLabels[DataStoreUsage.KNOWLEDGE]}
                </Badge>
                <Badge
                  className={usageColors[DataStoreUsage.OPERATIONAL]}
                  variant="secondary"
                >
                  {usageLabels[DataStoreUsage.OPERATIONAL]}
                </Badge>
              </>
            ) : dataStore.usage ? (
              <Badge
                className={usageColors[dataStore.usage] || usageColors[DataStoreUsage.KNOWLEDGE]}
                variant="secondary"
              >
                {usageLabels[dataStore.usage] || dataStore.usage}
              </Badge>
            ) : null}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <span className="text-muted-foreground">Size</span>
            <p className="font-semibold text-foreground">{dataStore.size || '—'}</p>
          </div>
          <div>
            <span className="text-muted-foreground">Records</span>
            <p className="font-semibold text-foreground">{dataStore.records != null ? dataStore.records.toLocaleString() : '—'}</p>
          </div>
        </div>
        
        <div className="text-xs text-muted-foreground">
          Last sync: {dataStore.lastSync || 'Never'}
        </div>

        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium text-muted-foreground">Features</span>
          <div className="flex flex-wrap gap-1">
            {(dataStore.features || []).slice(0, 3).map((feature, index) => (
              <Badge 
                key={index} 
                variant="outline" 
                className="text-xs text-muted-foreground border-border bg-transparent"
              >
                {feature}
              </Badge>
            ))}
            {(dataStore.features || []).length > 3 && (
              <Badge 
                variant="outline" 
                className="text-xs text-muted-foreground border-border bg-transparent"
              >
                +{(dataStore.features || []).length - 3} more
              </Badge>
            )}
          </div>
        </div>

        <div className="text-xs text-muted-foreground pt-2 border-t border-border">
          Provider: {dataStore.provider}
        </div>
        
        <div className="flex gap-2 pt-2">
          {dataStore.status === DataStoreStatus.CONNECTED || dataStore.status === DataStoreStatus.PROVISIONED ? (
            <>
              <Button
                variant="outline"
                size="sm"
                className="flex-1 bg-transparent border-border text-muted-foreground hover:bg-accent hover:text-foreground"
                onClick={() => onConfigure(dataStore)}
              >
                Configure
              </Button>
              <Button 
                variant="outline" 
                size="sm" 
                className="bg-transparent border-border text-muted-foreground hover:bg-accent hover:text-foreground"
                onClick={() => onDisconnect?.(dataStore)}
              >
                Disconnect
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="bg-transparent border-destructive/50 text-destructive hover:bg-destructive/80 hover:text-destructive"
                onClick={() => onDelete?.(dataStore)}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </>
          ) : dataStore.status === DataStoreStatus.ERROR ? (
            <>
              <Button
                size="sm"
                className="flex-1 bg-transparent border border-border text-muted-foreground hover:bg-accent hover:text-foreground"
                onClick={() => onConnect?.(dataStore)}
              >
                Reconnect
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="bg-transparent border-destructive/50 text-destructive hover:bg-destructive/80 hover:text-destructive"
                onClick={() => onDelete?.(dataStore)}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </>
          ) : (
            <>
              <Button
                size="sm"
                className="flex-1 bg-primary text-primary-foreground hover:bg-primary/90"
                onClick={() => onConnect?.(dataStore)}
              >
                Connect
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="bg-transparent border-destructive/50 text-destructive hover:bg-destructive/80 hover:text-destructive"
                onClick={() => onDelete?.(dataStore)}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
