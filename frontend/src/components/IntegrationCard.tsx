import { LucideIcon } from 'lucide-react';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { Integration } from '../services/integrationService';

interface IntegrationCardProps {
  integration: Integration;
  icon: LucideIcon;
  statusIcon: LucideIcon;
  onConfigure: (integration: Integration) => void;
  onTest?: (integration: Integration) => void;
  onConnect?: (integration: Integration) => void;
  onDisconnect?: (integration: Integration) => void;
  onDelete?: (integration: Integration) => void;
  backendStatus?: string;
  authMethod?: string;
}

type BadgeVariant = 'default' | 'secondary' | 'destructive' | 'outline' | 'success' | 'warning' | 'info';

const statusVariant: Record<string, BadgeVariant> = {
  connected: 'success',
  disconnected: 'secondary',
  error: 'destructive',
  configuring: 'secondary',
};

const pricingVariant: Record<string, BadgeVariant> = {
  free: 'success',
  paid: 'info',
  freemium: 'secondary',
};

const complexityVariant: Record<string, BadgeVariant> = {
  easy: 'success',
  medium: 'warning',
  advanced: 'destructive',
};

const protocolVariant: Record<string, BadgeVariant> = {
  "MCP": 'info',
  "REST": 'success',
  "A2A": 'secondary',
  "Direct API": 'warning',
  "Identity": 'info',
};

const authMethodVariant: Record<string, BadgeVariant> = {
  "API_KEY": 'info',
  "OAUTH2": 'secondary',
  "BASIC_AUTH": 'success',
  "BEARER_TOKEN": 'warning',
};

const authMethodLabels: Record<string, string> = {
  "API_KEY": "API Key",
  "OAUTH2": "OAuth 2.0",
  "BASIC_AUTH": "Basic Auth",
  "BEARER_TOKEN": "Bearer Token"
};

export function IntegrationCard({
  integration,
  icon: Icon,
  statusIcon: StatusIcon,
  onConfigure,
  onTest,
  onConnect,
  onDisconnect,
  onDelete,
  backendStatus,
  authMethod
}: IntegrationCardProps) {
  
  const showConfigureButton = !backendStatus || backendStatus === 'CREATED';
  const showTestButton = backendStatus === 'CONFIGURED' || backendStatus === 'CONNECTION_FAILED';
  const showConnectButton = backendStatus === 'TESTED' || backendStatus === 'DISCONNECTED';
  const showDisconnectButton = backendStatus === 'CONNECTED';
  
  return (
    <Card className="hover:shadow-lg transition-shadow bg-card border border-border">
      <CardHeader className="pb-4">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-white/5">
              <Icon className="size-6 text-muted-foreground" />
            </div>
            <div>
              <CardTitle className="text-lg flex items-center gap-2 text-foreground">
                {integration.name}
                {integration.isPopular && (
                  <Badge variant="secondary" className="text-xs">
                    Popular
                  </Badge>
                )}
              </CardTitle>
              <p className="text-xs text-muted-foreground">
                by {integration.provider}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <StatusIcon className="size-4" />
            <Badge variant={statusVariant[integration.status] || 'secondary'}>
              {integration.status.toUpperCase()}
            </Badge>
          </div>
        </div>
      </CardHeader>
      
      <CardContent className="flex flex-col gap-4">
        <CardDescription>
          {integration.description}
        </CardDescription>
        
        <div className="flex items-center justify-between text-sm">
          <div className="flex items-center gap-2">
            <Badge variant={pricingVariant[integration.pricing] || 'secondary'}>
              {integration.pricing}
            </Badge>
            <Badge variant={complexityVariant[integration.setupComplexity] || 'secondary'}>
              {integration.setupComplexity} setup
            </Badge>
          </div>
        </div>

        {integration.protocol && (
          <div className="flex gap-2">
            <Badge variant={protocolVariant[integration.protocol] || 'secondary'}>
              {integration.protocol}
            </Badge>
            {authMethod && (
              <Badge variant={authMethodVariant[authMethod] || 'secondary'}>
                {authMethodLabels[authMethod] || authMethod}
              </Badge>
            )}
          </div>
        )}
        
        {!integration.protocol && authMethod && (
          <div>
            <Badge variant={authMethodVariant[authMethod] || 'secondary'}>
              {authMethodLabels[authMethod] || authMethod}
            </Badge>
          </div>
        )}
        
        {integration.status === "connected" && (
          <div className="text-xs text-muted-foreground">
            Last sync: {integration.lastSync}
          </div>
        )}

        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium text-foreground">Key Features</span>
          <div className="flex flex-wrap gap-1">
            {integration.features.slice(0, 3).map((feature, index) => (
              <Badge key={index} variant="outline" className="text-xs">
                {feature}
              </Badge>
            ))}
            {integration.features.length > 3 && (
              <Badge variant="outline" className="text-xs">
                +{integration.features.length - 3} more
              </Badge>
            )}
          </div>
        </div>
        
        <div className="flex gap-2 pt-2">
          {showDisconnectButton ? (
            <>
              <Button variant="outline" size="sm" className="flex-1" onClick={() => onConfigure(integration)}>
                Configure
              </Button>
              <Button variant="destructive" size="sm" onClick={() => onDisconnect?.(integration)}>
                Disconnect
              </Button>
            </>
          ) : showConfigureButton ? (
            <>
              <Button size="sm" className="flex-1" onClick={() => onConfigure(integration)}>
                Configure
              </Button>
              {backendStatus && backendStatus !== 'CREATED' && onDelete && (
                <Button variant="destructive" size="sm" onClick={() => onDelete(integration)}>
                  Delete
                </Button>
              )}
            </>
          ) : showTestButton ? (
            <>
              <Button size="sm" className="flex-1" onClick={() => onTest?.(integration)}>
                Test Connection
              </Button>
              {onDelete && (
                <Button variant="destructive" size="sm" onClick={() => onDelete(integration)}>
                  Delete
                </Button>
              )}
            </>
          ) : showConnectButton ? (
            <>
              <Button size="sm" className="flex-1" onClick={() => onConnect?.(integration)}>
                Connect
              </Button>
              {onDelete && (
                <Button variant="destructive" size="sm" onClick={() => onDelete(integration)}>
                  Delete
                </Button>
              )}
            </>
          ) : integration.status === "error" ? (
            <>
              <Button variant="outline" size="sm" className="flex-1" onClick={() => onConfigure(integration)}>
                Reconfigure
              </Button>
              {onDelete && (
                <Button variant="destructive" size="sm" onClick={() => onDelete(integration)}>
                  Delete
                </Button>
              )}
            </>
          ) : (
            <>
              <Button size="sm" className="flex-1" onClick={() => onConfigure(integration)}>
                Setup
              </Button>
              {onDelete && (
                <Button variant="destructive" size="sm" onClick={() => onDelete(integration)}>
                  Delete
                </Button>
              )}
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
