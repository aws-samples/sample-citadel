import { useState, useEffect, useCallback } from 'react';
import { ArrowLeft, RefreshCw, Code, FileText } from 'lucide-react';
import { Button } from '../components/ui/button';
import { ScrollArea } from '../components/ui/scroll-area';
import { getProjectDocument } from '../services/documentService';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface ImplementationPageProps {
  projectId: string;
  projectName: string;
  onBack: () => void;
}

export function ImplementationPage({ projectId, projectName, onBack }: ImplementationPageProps) {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchDocument = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const doc = await getProjectDocument(projectId, 'design/technical_design.md');
      setContent(doc?.content ?? null);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to load document';
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    fetchDocument();
  }, [fetchDocument]);

  return (
    <div className="h-full flex flex-col bg-background">
      <div className="flex-1 overflow-y-auto">
        <div className="flex flex-col gap-6 m-[15px]">
          <div className="flex items-center justify-between">
            <Button
              variant="ghost"
              size="sm"
              onClick={onBack}
              className="gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              <ArrowLeft className="size-4" /> Back
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={fetchDocument}
              disabled={loading}
              className="gap-1 text-xs"
            >
              <RefreshCw className={`size-4 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
          </div>

          <div className="flex items-center gap-3 px-2">
            <div className="size-10 rounded-lg bg-primary/20 flex items-center justify-center">
              <Code className="size-5 text-primary" />
            </div>
            <div>
              <h1 className="text-xl font-semibold text-foreground">{projectName}</h1>
              <p className="text-xs text-muted-foreground">Implementation Recommendations</p>
            </div>
          </div>

          {loading && (
            <div className="flex items-center justify-center py-24">
              <div className="text-center">
                <div className="animate-spin rounded-full size-10 border-b-2 border-primary mx-auto mb-4" />
                <p className="text-sm text-muted-foreground">Loading implementation details…</p>
              </div>
            </div>
          )}

          {error && !loading && (
            <div className="bg-destructive/10 border border-destructive/50 rounded-lg p-4 text-center">
              <p className="text-destructive text-sm mb-2">{error}</p>
              <Button variant="outline" size="sm" onClick={fetchDocument} className="gap-2">
                <RefreshCw className="size-4" /> Retry
              </Button>
            </div>
          )}

          {!loading && !error && content === null && (
            <div className="flex flex-col items-center justify-center py-24 text-center">
              <div className="size-16 rounded-full bg-accent border-2 border-border flex items-center justify-center mb-4">
                <FileText className="size-8 text-muted-foreground" />
              </div>
              <p className="text-sm text-muted-foreground max-w-md">
                No implementation recommendations available yet. Complete the assessment and planning phases first.
              </p>
            </div>
          )}

          {!loading && !error && content !== null && (
            <ScrollArea className="h-[calc(100vh-220px)]">
              <div className="prose prose-invert prose-sm max-w-none px-2">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {content}
                </ReactMarkdown>
              </div>
            </ScrollArea>
          )}
        </div>
      </div>
    </div>
  );
}
