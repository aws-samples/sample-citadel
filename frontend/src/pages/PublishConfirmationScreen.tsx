import { useState, useCallback } from 'react';
import { ArrowLeft, Copy, Check, Globe, AlertTriangle } from 'lucide-react';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Card } from '../components/ui/card';
import { cn } from '../components/ui/utils';

export interface PublishConfirmationScreenProps {
  appId: string;
  appName: string;
  endpointUrl: string;
  apiKey: string;
  onBack: () => void;
  onNavigate?: (view: string) => void;
}

export function PublishConfirmationScreen({
  appId,
  appName,
  endpointUrl,
  apiKey,
  onBack,
  onNavigate,
}: PublishConfirmationScreenProps) {
  const [copiedField, setCopiedField] = useState<'endpoint' | 'apiKey' | null>(null);

  const handleCopy = useCallback(async (text: string, field: 'endpoint' | 'apiKey') => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedField(field);
      setTimeout(() => setCopiedField(null), 2000);
    } catch {
      // Fail silently when clipboard API is unavailable (Requirement 3.4)
    }
  }, []);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="max-w-2xl mx-auto px-6 py-10">
        {/* Header */}
        <div className="flex items-center gap-3 mb-8">
          <Button
            variant="ghost"
            size="icon"
            onClick={onBack}
            className="text-muted-foreground hover:text-foreground"
            aria-label="Back to App"
          >
            <ArrowLeft className="size-5" />
          </Button>
          <h1 className="text-2xl font-bold">{appName}</h1>
          <Badge className="bg-chart-5/20 text-chart-5 border-transparent">
            PUBLISHED
          </Badge>
        </div>

        {/* Success message */}
        <div className="mb-8">
          <div className="flex items-center gap-2 text-chart-2 mb-2">
            <Globe className="size-5" />
            <span className="text-lg font-semibold">App Published Successfully</span>
          </div>
          <p className="text-muted-foreground">
            Your app is now live. Save the credentials below — the API key is shown only once.
          </p>
        </div>

        {/* Endpoint URL */}
        <div className="mb-6">
          <label className="block text-sm font-medium text-muted-foreground mb-2">Endpoint URL</label>
          <Card className="flex-row items-center gap-2 rounded-lg border-border/50 p-3">
            <code className="flex-1 font-mono text-sm text-foreground break-all">{endpointUrl}</code>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => handleCopy(endpointUrl, 'endpoint')}
              className={cn(
                'shrink-0 text-muted-foreground hover:text-foreground',
                copiedField === 'endpoint' && 'text-chart-2 hover:text-chart-2'
              )}
              aria-label="Copy endpoint URL"
            >
              {copiedField === 'endpoint' ? <Check className="size-4" /> : <Copy className="size-4" />}
            </Button>
          </Card>
          {copiedField === 'endpoint' && (
            <span className="text-xs text-chart-2 mt-1 inline-block">Copied</span>
          )}
        </div>

        {/* API Key */}
        <div className="mb-6">
          <label className="block text-sm font-medium text-muted-foreground mb-2">API Key</label>
          <Card className="flex-row items-center gap-2 rounded-lg border-border/50 p-3">
            <code className="flex-1 font-mono text-sm text-foreground break-all">{apiKey}</code>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => handleCopy(apiKey, 'apiKey')}
              className={cn(
                'shrink-0 text-muted-foreground hover:text-foreground',
                copiedField === 'apiKey' && 'text-chart-2 hover:text-chart-2'
              )}
              aria-label="Copy API key"
            >
              {copiedField === 'apiKey' ? <Check className="size-4" /> : <Copy className="size-4" />}
            </Button>
          </Card>
          {copiedField === 'apiKey' && (
            <span className="text-xs text-chart-2 mt-1 inline-block">Copied</span>
          )}
        </div>

        {/* Warning banner */}
        <div className="flex items-start gap-3 rounded-lg border border-chart-4/30 bg-chart-4/10 p-4 mb-8">
          <AlertTriangle className="size-5 text-chart-4 shrink-0 mt-0.5" />
          <p className="text-sm text-chart-4">
            This API key is shown only once and cannot be retrieved later. Copy it now.
          </p>
        </div>

        {/* Navigation buttons */}
        <div className="flex items-center gap-3">
          <Button
            variant="outline"
            onClick={onBack}
            className="border-border/50 text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-4" />
            Back to App
          </Button>
          <Button
            onClick={() => onNavigate?.(`app-api-dashboard:${appId}`)}
            className="bg-chart-5 hover:bg-chart-5 text-foreground"
          >
            Go to API Dashboard
          </Button>
        </div>
      </div>
    </div>
  );
}
