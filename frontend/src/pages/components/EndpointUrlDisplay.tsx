import { useState, useCallback } from 'react';
import { Copy, Check } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { cn } from '../../components/ui/utils';

export interface EndpointUrlDisplayProps {
  endpointUrl: string;
}

/**
 * Displays the published app's endpoint URL with a copy-to-clipboard control.
 *
 * Rendered above the API Keys section on the API Dashboard when the app is
 * PUBLISHED. Reuses the code-block + copy-button pattern from
 * `PublishConfirmationScreen` so the visual treatment stays consistent across
 * the publish confirmation and dashboard surfaces.
 *
 * Behavior:
 * - Copy success shows a check icon + "Copied" label for 2 seconds
 *   (Requirement 5.5).
 * - Clipboard failure is swallowed silently — no error banner, no toast
 *   (Requirement 5.6).
 *
 * Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.5, 5.6
 */
export function EndpointUrlDisplay({ endpointUrl }: EndpointUrlDisplayProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(endpointUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Silent fallback when clipboard API is unavailable (Requirement 5.6)
    }
  }, [endpointUrl]);

  return (
    <Card className="rounded-lg p-6 gap-0">
      <label className="block text-sm font-medium text-muted-foreground mb-2">
        Endpoint URL
      </label>
      <Card className="flex-row items-center gap-2 rounded-lg border-border/50 bg-accent p-3">
        <code className="flex-1 font-mono text-sm text-foreground break-all">
          {endpointUrl}
        </code>
        <Button
          variant="ghost"
          size="icon"
          onClick={handleCopy}
          className={cn(
            'shrink-0 text-muted-foreground hover:text-foreground',
            copied && 'text-chart-2 hover:text-chart-2'
          )}
          aria-label="Copy endpoint URL"
        >
          {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
        </Button>
      </Card>
      {copied && (
        <span className="text-xs text-chart-2 mt-1 inline-block">Copied</span>
      )}
    </Card>
  );
}
