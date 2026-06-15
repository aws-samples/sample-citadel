import { useState, useEffect, useMemo } from 'react';
import {
  Loader2,
  AlertCircle,
  Check,
  LucideIcon,
  Cloud,
  Database,
  BarChart3,
  FileText,
  Zap,
  Search,
  BookOpen,
  Layers,
  Share2,
  Clock,
  Key,
  Shield,
  Brain,
  Globe,
  MessageSquare,
  Mail,
  Users,
  CreditCard,
  Settings,
  GitBranch,
  Lock,
} from 'lucide-react';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './ui/select';
import { Integration, integrationService } from '../services/integrationService';
import { filterIntegrationsByType } from './integration-picker-utils';

// --- Icon mapping ---
const iconMap: Record<string, LucideIcon> = {
  Cloud, Database, BarChart3, FileText, Zap, Search, BookOpen, Layers,
  Share2, Clock, Key, Shield, Brain, Globe, MessageSquare, Mail,
  Users, CreditCard, Settings, GitBranch, Lock,
};

const getIconComponent = (iconName: string): LucideIcon => iconMap[iconName] || Zap;

// --- Status badge styles ---
function getStatusBadgeStyle(status: string): string {
  switch (status) {
    case 'connected':
      return 'bg-chart-2/10 text-chart-2 border-chart-2/30';
    case 'configuring':
      return 'bg-chart-4/10 text-chart-4 border-chart-4/30';
    case 'error':
      return 'bg-destructive/10 text-destructive border-destructive/30';
    case 'disconnected':
    default:
      return 'bg-muted/10 text-muted-foreground border-border';
  }
}

// --- Component Props ---
export interface IntegrationPickerProps {
  onSelect: (integration: Integration) => void;
  selectedId?: string;
  filterTypes?: string[];
}

export function IntegrationPicker({ onSelect, selectedId, filterTypes }: IntegrationPickerProps) {
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState<string>('all');

  // Load connected integrations on mount
  useEffect(() => {
    const load = async () => {
      try {
        setLoading(true);
        setLoadError(null);
        const connected = await integrationService.getConnectedIntegrations();
        setIntegrations(connected);
      } catch (err: any) {
        console.error('Failed to load integrations:', err);
        setLoadError(err.message || 'Failed to load integrations');
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  // Compute available types for the filter dropdown
  const availableTypes = useMemo(() => {
    const propFiltered = filterIntegrationsByType(integrations, filterTypes);
    const types = new Set(propFiltered.map((i) => i.category));
    return Array.from(types).sort();
  }, [integrations, filterTypes]);

  // Apply both prop-level filterTypes and user-selected type filter
  const displayedIntegrations = useMemo(() => {
    let filtered = filterIntegrationsByType(integrations, filterTypes);
    if (typeFilter !== 'all') {
      filtered = filtered.filter((i) => i.category === typeFilter);
    }
    return filtered;
  }, [integrations, filterTypes, typeFilter]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="size-8 text-primary animate-spin" />
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="bg-destructive/10 border border-destructive/50 rounded-lg p-4">
        <p className="text-destructive">{loadError}</p>
      </div>
    );
  }

  return (
    <div>
      {/* Type filter dropdown */}
      {availableTypes.length > 1 && (
        <div className="mb-4">
          <Select value={typeFilter} onValueChange={setTypeFilter}>
            <SelectTrigger
              className="w-auto text-sm"
              aria-label="Filter by integration type"
            >
              <SelectValue placeholder="All Types" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Types</SelectItem>
              {availableTypes.map((type) => (
                <SelectItem key={type} value={type}>
                  {type.charAt(0).toUpperCase() + type.slice(1).replace(/-/g, ' ')}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {/* Integration cards grid */}
      {displayedIntegrations.length === 0 ? (
        <div className="text-center py-12">
          <div className="size-12 rounded-full bg-accent border border-border flex items-center justify-center mx-auto mb-4">
            <AlertCircle className="size-6 text-muted-foreground" />
          </div>
          <p className="text-muted-foreground text-sm">No integrations match the current filter.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {displayedIntegrations.map((integration) => {
            const Icon = getIconComponent(integration.icon);
            const isSelected = selectedId === integration.id;

            return (
              <Button
                key={integration.id}
                type="button"
                variant="outline"
                onClick={() => onSelect(integration)}
                className={`relative flex h-auto items-start gap-3 whitespace-normal justify-start p-4 rounded-lg border transition-all text-left ${
                  isSelected
                    ? 'bg-primary/10 border-primary'
                    : 'bg-card border-border hover:border-input'
                }`}
              >
                <div
                  className={`size-10 rounded-lg flex items-center justify-center shrink-0 ${
                    isSelected ? 'bg-primary/20' : 'bg-accent'
                  }`}
                >
                  <Icon className={`size-5 ${isSelected ? 'text-primary' : 'text-muted-foreground'}`} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <h4 className="text-foreground text-sm font-medium truncate">{integration.name}</h4>
                    {isSelected && <Check className="size-4 text-primary shrink-0" />}
                  </div>
                  <p className="text-muted-foreground text-xs mt-0.5 line-clamp-2">
                    {integration.description}
                  </p>
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    <Badge variant="secondary" className="text-xs bg-card text-muted-foreground border-border">
                      {integration.category}
                    </Badge>
                    <Badge variant="secondary" className="text-xs bg-card text-muted-foreground border-border">
                      {integration.provider}
                    </Badge>
                    {integration.protocol && (
                      <Badge variant="secondary" className="text-xs bg-card text-muted-foreground border-border">
                        {integration.protocol}
                      </Badge>
                    )}
                    <Badge variant="secondary" className={`text-xs ${getStatusBadgeStyle(integration.status)}`}>
                      {integration.status}
                    </Badge>
                  </div>
                </div>
              </Button>
            );
          })}
        </div>
      )}
    </div>
  );
}
