/**
 * ConnectorTypeSelector Component
 * 
 * Displays a list of available connector types for users to select from.
 * Shows icon, name, description, and authentication method for each connector.
 * Implements connector ordering: popular connectors first, then alphabetical.
 * 
 * Requirements: 1.1, 1.2, 1.4, 6.1, 6.2, 6.3, 6.5
 */

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { getAllConnectorTypes, type ConnectorType } from '@/config/connectorRegistry';
import { cn } from '@/components/ui/utils';

export interface ConnectorTypeSelectorProps {
  onSelect: (connectorType: ConnectorType) => void;
  selectedType?: ConnectorType;
}

/**
 * Maps authentication methods to user-friendly display text
 */
const authMethodLabels: Record<string, string> = {
  API_KEY: 'API Key',
  OAUTH2: 'OAuth 2.0',
  BASIC_AUTH: 'Basic Auth',
  BEARER_TOKEN: 'Bearer Token',
};

/**
 * ConnectorTypeSelector Component
 * 
 * Displays all available connector types in a grid layout.
 * Connectors are ordered by popularity (popular first) then alphabetically.
 * Each connector card shows:
 * - Icon
 * - Name
 * - Description
 * - Authentication method badge
 * - Popular badge (if applicable)
 */
export function ConnectorTypeSelector({
  onSelect,
  selectedType,
}: ConnectorTypeSelectorProps) {
  // Get all connector types with proper ordering (popular first, then alphabetical)
  const connectorTypes = getAllConnectorTypes();

  return (
    <div className="flex flex-col gap-4">
      <div className="text-sm text-muted-foreground">
        Select a connector type to configure
      </div>
      
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {connectorTypes.map((connector) => {
          const Icon = connector.icon;
          const isSelected = selectedType?.id === connector.id;
          
          return (
            <Card
              key={connector.id}
              className={cn(
                'cursor-pointer transition-all hover:shadow-lg bg-card border border-border',
                isSelected && 'shadow-lg border-2 border-chart-4 shadow-[0_0_20px_rgba(249,115,22,0.3)]'
              )}
              onClick={() => onSelect(connector)}
            >
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <div className="p-2 rounded-lg bg-white/5">
                      <Icon className="size-5 text-muted-foreground" />
                    </div>
                    <div>
                      <CardTitle className="text-base flex items-center gap-2 text-foreground">
                        {connector.name}
                        {connector.isPopular && (
                          <Badge variant="secondary" className="text-xs bg-accent text-foreground border-0">
                            Popular
                          </Badge>
                        )}
                      </CardTitle>
                    </div>
                  </div>
                </div>
              </CardHeader>
              
              <CardContent className="flex flex-col gap-3">
                <CardDescription className="text-sm line-clamp-2 text-muted-foreground">
                  {connector.description}
                </CardDescription>
                
                <div className="flex items-center justify-between">
                  <Badge variant="outline" className="text-xs text-muted-foreground border-border bg-transparent">
                    {authMethodLabels[connector.authMethod] || connector.authMethod}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    {connector.provider}
                  </span>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
