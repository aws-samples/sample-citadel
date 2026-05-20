import { useState, useCallback } from 'react';
import { Copy, Check, AlertTriangle } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { cn } from '../../components/ui/utils';

interface PlaintextKeyRevealProps {
  plaintext: string;
  keyName: string;
  onDismiss: () => void;
}

/**
 * Shared component for displaying a plaintext API key after creation or rotation.
 * Shows a monospace code block, copy button with 2-second feedback, and a
 * "shown only once" warning banner.
 */
export function PlaintextKeyReveal({ plaintext, keyName, onDismiss }: PlaintextKeyRevealProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(plaintext);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Silent fallback
    }
  }, [plaintext]);

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        API key <span className="font-medium text-foreground">{keyName}</span> has been generated.
      </p>
      <div className="flex items-center gap-2 rounded-lg border border-border/50 bg-accent p-3">
        <code className="flex-1 font-mono text-sm text-chart-2 break-all">{plaintext}</code>
        <Button
          variant="ghost"
          size="icon"
          onClick={handleCopy}
          className={cn(
            'shrink-0 text-muted-foreground hover:text-foreground',
            copied && 'text-chart-2 hover:text-chart-2',
          )}
          aria-label="Copy API key"
        >
          {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
        </Button>
      </div>
      {copied && <span className="text-xs text-chart-2">Copied</span>}
      <div className="flex items-start gap-3 rounded-lg border border-chart-4/30 bg-chart-4/10 p-3">
        <AlertTriangle className="size-4 text-chart-4 shrink-0 mt-0.5" />
        <p className="text-xs text-chart-4">
          This API key is shown only once and cannot be retrieved later. Copy it now.
        </p>
      </div>
      <div className="flex justify-end">
        <Button onClick={onDismiss} className="bg-primary hover:bg-primary text-foreground">
          Done
        </Button>
      </div>
    </div>
  );
}
