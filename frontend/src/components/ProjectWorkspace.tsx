import { useState, useEffect, useRef, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ArrowLeft, Send, Upload, FileText, X, Download, History, GitCompare, RefreshCw, PanelRightOpen, PanelRightClose } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { Input } from './ui/input';
import { ScrollArea } from './ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from './ui/accordion';
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from './ui/resizable';
import { Panel as ResizablePanelDirect } from 'react-resizable-panels';
import type { ImperativePanelHandle } from 'react-resizable-panels';
import type { Project } from '../services';
import { projectService, type ProjectProgress } from '../services/projectService';
import { sendMessageToAgent, getConversationHistoryForProject, subscribeToConversation, type ConversationMessage } from '../services/conversationService';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from './ui/dialog';
import {
  uploadDocument, ingestDocument, getProjectDocument, listDocumentVersions,
  getDocumentVersion, generateDocumentPdf, waitForDocumentIndexed, notifyDocumentReady,
  deleteDocument as deleteDocumentApi, listProjectDocuments,
  type ProjectDocument, type DocumentVersion,
} from '../services/documentService';
import { diffLines, type Change } from 'diff';

// ── Types ────────────────────────────────────────────────────────────────────

interface Message {
  id?: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
}

interface UploadedFile {
  id: string;
  name: string;
  size: number;
  status: 'uploading' | 'ingesting' | 'indexing' | 'ready' | 'failed' | 'timeout' | 'deleting';
  documentKey?: string;
  fileType?: string;
}

interface DocTab {
  id: string;
  label: string;
  documentKey: string;
  progressKey: 'design' | 'planning';
  planningOrder?: number; // 0=resourcing, 1=business, 2=commercial
}

const DOC_TABS: DocTab[] = [
  { id: 'technical_design',  label: 'Technical Design',  documentKey: 'design/technical_design.md', progressKey: 'design' },
  { id: 'resourcing',        label: 'Resourcing',         documentKey: 'design/resourcing_report.md', progressKey: 'planning', planningOrder: 0 },
  { id: 'business_plan',     label: 'Business Plan',      documentKey: 'planning/business_plan.md', progressKey: 'planning', planningOrder: 1 },
  { id: 'commercial_plan',   label: 'Commercial Plan',    documentKey: 'planning/commercial_plan.md', progressKey: 'planning', planningOrder: 2 },
];

const WELCOME_MESSAGE: Message = {
  id: 'welcome',
  role: 'assistant',
  content: 'Welcome! Upload a document or describe your project to begin the assessment. I\'ll guide you through evaluating whether your business process is suitable for agentification.',
  timestamp: new Date(),
};

// ── Diff Viewer ──────────────────────────────────────────────────────────────

function DiffViewer({ oldText, newText }: { oldText: string; newText: string }) {
  const changes: Change[] = diffLines(oldText, newText);
  return (
    <div className="flex flex-col overflow-auto p-3 gap-1">
      {changes.map((change, i) => (
        <div
          key={i}
          className={`rounded px-2 py-1 text-sm ${
            change.added ? 'bg-chart-2/80 border-l-2 border-chart-2' :
            change.removed ? 'bg-destructive/80 border-l-2 border-destructive' :
            'text-muted-foreground'
          }`}
        >
          <div className={`prose prose-invert prose-sm max-w-none ${
            change.added ? 'text-chart-2' :
            change.removed ? 'text-destructive line-through opacity-70' :
            ''
          }`}>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{change.value}</ReactMarkdown>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Version History Panel ────────────────────────────────────────────────────

function VersionPanel({
  projectId, documentKey, currentContent, onClose,
}: {
  projectId: string;
  documentKey: string;
  currentContent: string;
  onClose: () => void;
}) {
  const [versions, setVersions] = useState<DocumentVersion[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [compareDoc, setCompareDoc] = useState<ProjectDocument | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    listDocumentVersions(projectId, documentKey)
      .then(setVersions)
      .finally(() => setLoading(false));
  }, [projectId, documentKey]);

  const handleSelect = async (versionId: string) => {
    setSelected(versionId);
    const doc = await getDocumentVersion(projectId, documentKey, versionId);
    setCompareDoc(doc);
  };

  return (
    <div className="flex flex-col h-full border-l border-border bg-card">
      <div className="flex items-center justify-between p-3 border-b border-border">
        <span className="text-sm font-medium text-foreground flex items-center gap-2"><History className="size-4" /> Version History</span>
        <Button variant="ghost" size="icon" className="size-6" onClick={onClose}><X className="size-3" /></Button>
      </div>
      <div className="flex flex-1 overflow-hidden">
        {/* Version list */}
        <div className="w-48 border-r border-border overflow-y-auto">
          {loading ? (
            <p className="text-xs text-muted-foreground p-3">Loading...</p>
          ) : versions.length === 0 ? (
            <p className="text-xs text-muted-foreground p-3">No versions yet</p>
          ) : versions.map((v) => (
            <Button
              key={v.versionId}
              variant="ghost"
              onClick={() => handleSelect(v.versionId)}
              className={`w-full h-auto flex-col items-start justify-start text-left px-3 py-2 text-xs border-b border-border/50 rounded-none whitespace-normal transition-colors ${
                selected === v.versionId ? 'bg-accent text-foreground hover:bg-accent' : 'text-muted-foreground hover:bg-accent'
              }`}
            >
              <div className="font-medium">{v.isLatest ? 'Current' : new Date(v.lastModified).toLocaleString()}</div>
              <div className="text-muted-foreground">{(v.size / 1024).toFixed(1)} KB</div>
            </Button>
          ))}
        </div>
        {/* Diff panel */}
        <div className="flex-1 overflow-auto">
          {compareDoc ? (
            <DiffViewer oldText={compareDoc.content} newText={currentContent} />
          ) : (
            <p className="text-xs text-muted-foreground p-4">Select a version to compare</p>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Document Tab Content ─────────────────────────────────────────────────────

function DocTabContent({ projectId, tab, phaseProgress, phaseExpected }: { projectId: string; tab: DocTab; phaseProgress: number; phaseExpected: boolean }) {
  const [doc, setDoc] = useState<ProjectDocument | null>(null);
  const [loading, setLoading] = useState(true);
  const [showHistory, setShowHistory] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const d = await getProjectDocument(projectId, tab.documentKey);
    setDoc(d);
    setLoading(false);
  }, [projectId, tab.documentKey]);

  useEffect(() => { load(); }, [load]);

  const handleDownload = async () => {
    setDownloading(true);
    try {
      const url = await generateDocumentPdf(projectId, tab.documentKey);
      window.open(url, '_blank');
    } catch {
      toast.error('Failed to generate PDF. Please try again.');
    } finally {
      setDownloading(false);
    }
  };

  if (loading) return <div className="flex items-center justify-center h-40"><div className="animate-spin rounded-full size-8 border-b-2 border-primary" /></div>;

  if (!doc) {
    const isInProgress = (() => {
      if (phaseProgress >= 100) return false;
      if (tab.progressKey === 'design') return phaseExpected || phaseProgress > 0;
      // Planning tabs: only the currently generating plan shows as in progress
      const thresholds = [0, 33, 66];
      const completedAt = [33, 66, 100];
      const order = tab.planningOrder ?? 0;
      return (phaseExpected || phaseProgress > 0) && phaseProgress >= thresholds[order] && phaseProgress < completedAt[order];
    })();
    const radius = 36;
    const circumference = 2 * Math.PI * radius;
    const offset = circumference - (phaseProgress / 100) * circumference;
    return (
      <div className="flex flex-col items-center justify-center h-40 text-muted-foreground text-sm gap-3">
        {isInProgress ? (
          <>
            {tab.progressKey === 'design' && (
              <div className="relative size-24">
                <svg className="size-24 -rotate-90" viewBox="0 0 80 80">
                  <circle cx="40" cy="40" r={radius} fill="none" stroke="currentColor" strokeWidth="4" className="text-surface-2" />
                  <circle cx="40" cy="40" r={radius} fill="none" stroke="currentColor" strokeWidth="4" className="text-primary" strokeLinecap="round" strokeDasharray={circumference} strokeDashoffset={offset} style={{ transition: 'stroke-dashoffset 0.5s' }} />
                </svg>
                <span className="absolute inset-0 flex items-center justify-center text-foreground text-sm font-medium">{Math.round(phaseProgress)}%</span>
              </div>
            )}
            <p className="animate-pulse text-primary">
              {tab.id === 'technical_design'
                ? 'Generating technical design — this typically takes 5–10 minutes...'
                : 'Generating... this may take up to 5 mins'}
            </p>
          </>
        ) : (
          <>
            <FileText className="size-8" />
            <p>Not generated yet. Ask the agent to create this document.</p>
          </>
        )}
        <Button variant="ghost" size="sm" className="h-7 text-xs gap-1" onClick={load}>
          <RefreshCw className="size-3" /> Refresh
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-4 py-2 border-b border-border">
        <span className="text-xs text-muted-foreground">
          {doc.lastModified ? `Last updated ${new Date(doc.lastModified).toLocaleString()}` : ''}
        </span>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" className="h-7 text-xs gap-1" onClick={load}>
            <RefreshCw className="size-3" /> Refresh
          </Button>
          <Button variant="ghost" size="sm" className="h-7 text-xs gap-1" onClick={() => setShowHistory(!showHistory)}>
            <GitCompare className="size-3" /> History
          </Button>
          <Button variant="ghost" size="sm" className="h-7 text-xs gap-1" onClick={handleDownload} disabled={downloading}>
            <Download className="size-3" /> {downloading ? 'Generating...' : 'Download PDF'}
          </Button>
        </div>
      </div>
      <div className="flex flex-1 overflow-hidden">
        <ScrollArea className="flex-1 p-4">
          <div className="prose prose-invert prose-sm max-w-none text-muted-foreground">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{doc.content}</ReactMarkdown>
          </div>
        </ScrollArea>
        {showHistory && (
          <div className="w-[480px]">
            <VersionPanel
              projectId={projectId}
              documentKey={tab.documentKey}
              currentContent={doc.content}
              onClose={() => setShowHistory(false)}
            />
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main Component ───────────────────────────────────────────────────────────

interface ProjectWorkspaceProps {
  project: Project;
  onBack: () => void;
}

export function ProjectWorkspace({ project, onBack }: ProjectWorkspaceProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [uploadedFiles, setUploadedFiles] = useState<UploadedFile[]>([]);
  const [uploadModal, setUploadModal] = useState<{ open: boolean; fileName: string; status: string; error?: string }>({ open: false, fileName: '', status: '' });
  const [docPanelCollapsed, setDocPanelCollapsed] = useState(false);
  const [progress, setProgress] = useState<ProjectProgress | null>(project.progress ?? null);
  const [activeDocTab, setActiveDocTab] = useState('technical_design');
  const autoSwitchedRef = useRef(false);
  const [historyNextToken, setHistoryNextToken] = useState<string | null>(null);
  const prevProgressRef = useRef<ProjectProgress | null>(null);
  const docTabRefreshRef = useRef(0);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const docPanelRef = useRef<ImperativePanelHandle>(null);

  // ── Auto-collapse doc panel until assessment is complete ────────────────

  const initialCollapseRef = useRef(false);
  useEffect(() => {
    if (initialCollapseRef.current) return;
    initialCollapseRef.current = true;
    const assessmentDone = (project.progress?.assessment ?? 0) >= 100;
    if (!assessmentDone) {
      docPanelRef.current?.collapse();
    }
  }, []);

  // ── Poll project progress every 10s ────────────────────────────────────

  // ── Load previously uploaded documents ─────────────────────────────────
  useEffect(() => {
    listProjectDocuments(project.id).then((docs) => {
      setUploadedFiles(docs.map((d) => ({
        id: d.documentKey,
        name: d.fileName,
        size: d.size,
        status: 'ready' as const,
        documentKey: d.documentKey,
      })));
    }).catch(() => {});
  }, [project.id]);

  // ── Poll project progress ─────────────────────────────────────────────

  useEffect(() => {
    const poll = async () => {
      try {
        const p = await projectService.getProject(project.id);
        setProgress((prev) => {
          prevProgressRef.current = prev;
          // Auto-expand doc panel when assessment completes
          if (prev && (prev.assessment ?? 0) < 100 && (p.progress?.assessment ?? 0) >= 100) {
            docPanelRef.current?.expand();
          }
          // Bump refresh key when any doc-producing phase changes
          if (prev && (
            (p.progress?.design ?? 0) !== (prev.design ?? 0) ||
            (p.progress?.planning ?? 0) !== (prev.planning ?? 0)
          )) {
            docTabRefreshRef.current += 1;
          }
          // Auto-switch tab based on current phase (only on first poll)
          if (!autoSwitchedRef.current) {
            autoSwitchedRef.current = true;
            const phase = p.progress?.currentPhase ?? '';
            if (phase === 'DESIGN_IN_PROGRESS') {
              setActiveDocTab('technical_design');
            } else if (phase === 'DESIGN_COMPLETE' || phase === 'PLANNING_IN_PROGRESS') {
              const pl = p.progress?.planning ?? 0;
              if (pl < 33) setActiveDocTab('resourcing');
              else if (pl < 66) setActiveDocTab('business_plan');
              else setActiveDocTab('commercial_plan');
            } else if (phase === 'PLANNING_COMPLETE') {
              setActiveDocTab('commercial_plan');
            }
          }
          return p.progress ?? prev;
        });
      } catch { /* ignore */ }
    };
    poll();
    const interval = setInterval(poll, 10_000);
    return () => clearInterval(interval);
  }, [project.id]);

  // ── Load history ──────────────────────────────────────────────────────────

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const result = await getConversationHistoryForProject(project.id, 50);
        const history = result.items || result;
        setHistoryNextToken(result.nextToken || null);
        if (history.length === 0) {
          setMessages([WELCOME_MESSAGE]);
        } else {
          setMessages(history.map(toUIMessage));
        }
      } finally {
        setLoading(false);
      }
    })();
  }, [project.id]);

  // ── Subscription ──────────────────────────────────────────────────────────

  const sendingTimerRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    return subscribeToConversation(project.id, (msg) => {
      if (msg.messageType === 'PROGRESS_UPDATE') { setSending(true); return; }
      if (msg.messageType === 'AGENT_RESPONSE') {
        setSending(false);
        setMessages(prev => prev.filter(m => m.id !== 'thinking'));
        if (sendingTimerRef.current) { clearTimeout(sendingTimerRef.current); sendingTimerRef.current = null; }
      }
      setMessages((prev) => {
        if (msg.id && prev.some((m) => m.id === msg.id)) return prev;
        if (msg.messageType === 'USER_INPUT' && prev.some((m) => m.role === 'user' && m.content === msg.message)) return prev;
        return [...prev.filter(m => m.id !== 'thinking'), toUIMessage(msg)];
      });
    });
  }, [project.id]);

  // Safety timeout: reset sending state if no response after 10 min
  useEffect(() => {
    if (sending) {
      sendingTimerRef.current = setTimeout(() => {
        setSending(false);
        setMessages((prev) => [...prev, {
          role: 'assistant' as const,
          content: '⚠️ The agent is taking longer than expected. Your request may still be processing — please wait a moment and try again if needed.',
          timestamp: new Date(),
        }]);
      }, 10 * 60 * 1000);
    } else if (sendingTimerRef.current) {
      clearTimeout(sendingTimerRef.current);
      sendingTimerRef.current = null;
    }
    return () => { if (sendingTimerRef.current) clearTimeout(sendingTimerRef.current); };
  }, [sending]);

  // Fallback: poll history if subscription goes quiet while sending
  useEffect(() => {
    if (!sending) return;
    const interval = setInterval(async () => {
      try {
        const result = await getConversationHistoryForProject(project.id, 1);
        const items = result.items || result;
        const lastMsg = items[0];
        if (lastMsg?.messageType === 'AGENT_RESPONSE') {
          setMessages((prev) => {
            if (prev.some((m) => m.id === lastMsg.id)) return prev;
            return [...prev, toUIMessage(lastMsg)];
          });
          setSending(false);
        }
      } catch { /* ignore */ }
    }, 30_000); // poll every 30s
    return () => clearInterval(interval);
  }, [sending, project.id]);

  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  // ── Helpers ───────────────────────────────────────────────────────────────

  function toUIMessage(msg: ConversationMessage): Message {
    return {
      id: msg.id,
      role: msg.messageType === 'USER_INPUT' ? 'user' : 'assistant',
      content: msg.message,
      timestamp: new Date(msg.timestamp),
    };
  }

  function parseContent(content: string) {
    const thinkingRegex = /<thinking>([\s\S]*?)<\/thinking>/g;
    const actionsRegex = /```actions\n([\s\S]*?)\n```/g;
    const matches = Array.from(content.matchAll(thinkingRegex));
    const actionMatches = Array.from(content.matchAll(actionsRegex));
    const thinking = matches.length ? matches.map((m) => m[1].trim()).join('\n\n---\n\n') : null;
    let actions: { label: string; value: string }[] | null = null;
    if (actionMatches.length) {
      try { actions = JSON.parse(actionMatches[actionMatches.length - 1][1]); } catch { /* ignore */ }
    }
    const cleaned = content.replace(thinkingRegex, '').replace(actionsRegex, '').trim();
    return { content: cleaned, thinking, actions };
  }

  // ── Send message ──────────────────────────────────────────────────────────

  const handleSend = async () => {
    if (!input.trim() || sending) return;
    const text = input.trim();
    setInput('');
    setMessages((prev) => [...prev, { role: 'user' as const, content: text, timestamp: new Date() }]);
    setSending(true);
    // Optimistic thinking indicator
    setMessages(prev => [...prev.filter(m => m.id !== 'thinking'), {
      id: 'thinking',
      role: 'assistant',
      content: 'Agent is thinking...',
      timestamp: new Date(),
    }]);
    try {
      await sendMessageToAgent(project.id, 'agent_intake_single', text);
    } catch {
      toast.error('Failed to send message.');
      setInput(text);
      setSending(false);
      setMessages(prev => prev.filter(m => m.id !== 'thinking'));
    }
  };

  // ── File upload ───────────────────────────────────────────────────────────

  const loadEarlierMessages = async () => {
    if (!historyNextToken) return;
    try {
      const result = await getConversationHistoryForProject(project.id, 50, historyNextToken);
      const older = (result.items || result).map(toUIMessage);
      setMessages(prev => [...older, ...prev]);
      setHistoryNextToken(result.nextToken || null);
    } catch {
      console.error('Failed to load earlier messages');
    }
  };

  // ── File upload (continued) ───────────────────────────────────────────────

  const isUploading = uploadedFiles.some((f) => ['uploading', 'ingesting', 'indexing'].includes(f.status));

  const updateFileStatus = (id: string, update: Partial<UploadedFile>) =>
    setUploadedFiles((prev) => prev.map((f) => (f.id === id ? { ...f, ...update } : f)));

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || isUploading) return;
    const file = files[0]; // single upload only
    if (!file) return;
    const id = Math.random().toString(36).slice(2);
    setUploadedFiles((prev) => [...prev, { id, name: file.name, size: file.size, status: 'uploading', fileType: file.type }]);
    setUploadModal({ open: true, fileName: file.name, status: 'Uploading...' });
    try {
      const documentKey = await uploadDocument(project.id, file);
      updateFileStatus(id, { status: 'ingesting', documentKey });
      setUploadModal((m) => ({ ...m, status: 'Processing document...' }));
      await ingestDocument(project.id, documentKey);
      updateFileStatus(id, { status: 'indexing' });
      setUploadModal((m) => ({ ...m, status: 'Indexing document...' }));
      await waitForDocumentIndexed(project.id, documentKey, {
        timeoutMs: 300_000,
        pollIntervalMs: 3_000,
        onStatusChange: (s) => {
          const labels: Record<string, string> = { STARTING: 'Submitting...', PENDING: 'Queued for indexing...', IN_PROGRESS: 'Indexing document...' };
          setUploadModal((m) => ({ ...m, status: labels[s] || 'Indexing document...' }));
        },
      });
      updateFileStatus(id, { status: 'ready' });
      setUploadModal((m) => ({ ...m, status: 'Finalising index...' }));
      // Allow OpenSearch index to become searchable after INDEXED status
      await new Promise((r) => setTimeout(r, 10_000));
      setUploadModal((m) => ({ ...m, status: 'Document ready! Extracting information...' }));
      await notifyDocumentReady(project.id, documentKey, file.name, file.size, file.type);
      // Wait for agent response before closing modal
      await new Promise<void>((resolve) => {
        const unsub = subscribeToConversation(project.id, (msg) => {
          if (msg.messageType === 'AGENT_RESPONSE') { unsub(); resolve(); }
        });
        // Safety timeout — don't block forever
        setTimeout(() => { unsub(); resolve(); }, 300_000);
      });
      setUploadModal({ open: false, fileName: '', status: '' });
    } catch (err: any) {
      if (err?.message === 'TIMEOUT') {
        updateFileStatus(id, { status: 'timeout' });
        setUploadModal((m) => ({ ...m, status: 'Indexing timed out', error: 'Document indexing is taking longer than expected. You can close this and continue chatting.' }));
      } else {
        updateFileStatus(id, { status: 'failed' });
        setUploadModal((m) => ({ ...m, status: 'Upload failed', error: err?.message || 'An error occurred' }));
      }
    }
    e.target.value = '';
  };

  const handleDeleteFile = async (file: UploadedFile) => {
    if (!file.documentKey) {
      setUploadedFiles((prev) => prev.filter((f) => f.id !== file.id));
      return;
    }
    updateFileStatus(file.id, { status: 'deleting' });
    try {
      await deleteDocumentApi(project.id, file.documentKey);
    } catch { /* best effort */ }
    setUploadedFiles((prev) => prev.filter((f) => f.id !== file.id));
  };

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="flex h-[calc(100vh-60px)] bg-background">
      {/* Upload progress modal */}
      <Dialog open={uploadModal.open} onOpenChange={(open) => { if (!open && uploadModal.error) setUploadModal((m) => ({ ...m, open: false })); }}>
        <DialogContent className="sm:max-w-md" onPointerDownOutside={(e) => { if (!uploadModal.error) e.preventDefault(); }}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FileText className="size-5" />
              {uploadModal.error ? 'Upload Issue' : 'Uploading Document'}
            </DialogTitle>
            <DialogDescription>{uploadModal.fileName}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col items-center gap-4 py-4">
            {!uploadModal.error && (
              <div className="size-10 border-2 border-primary border-t-transparent rounded-full animate-spin" />
            )}
            {uploadModal.error ? (
              <>
                <span className="text-2xl">{uploadModal.status === 'Indexing timed out' ? '⚠️' : '❌'}</span>
                <p className="text-sm text-center text-muted-foreground">{uploadModal.error}</p>
                <Button variant="outline" size="sm" onClick={() => setUploadModal((m) => ({ ...m, open: false }))}>Close</Button>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">{uploadModal.status}</p>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <ResizablePanelGroup direction="horizontal">
        {/* Left: Chat */}
        <ResizablePanel defaultSize={35} minSize={25}>
          <div className="flex flex-col h-full">
            {/* Header */}
            <div className="flex items-center gap-2 px-4 py-3 border-b border-border/50">
              <Button variant="ghost" size="icon" className="size-7" onClick={onBack}>
                <ArrowLeft className="size-4" />
              </Button>
              <div className="flex-1 min-w-0">
                <p className="text-foreground text-sm font-medium truncate">{project.name}</p>
                <p className="text-muted-foreground text-xs">{project.status}</p>
              </div>
              <Button
                variant="ghost" size="icon" className="size-7"
                onClick={() => {
                  if (docPanelCollapsed) docPanelRef.current?.expand();
                  else docPanelRef.current?.collapse();
                }}
                title={docPanelCollapsed ? 'Show documents' : 'Hide documents'}
              >
                {docPanelCollapsed ? <PanelRightOpen className="size-4" /> : <PanelRightClose className="size-4" />}
              </Button>
            </div>

            {/* Progress bar */}
            {progress && (
              <div className="px-4 py-2 border-b border-border/50 bg-card">
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-xs text-muted-foreground">Phase: <span className="text-foreground capitalize">{progress.currentPhase || 'assessment'}</span></span>
                </div>
                <div className="flex gap-1">
                  {([
                    { key: 'assessment', label: 'Assessment' },
                    { key: 'design', label: 'Design' },
                    { key: 'planning', label: 'Planning' },
                    { key: 'implementation', label: 'Build' },
                  ] as const).map(({ key, label }) => {
                    const pct = (progress as any)[key] ?? 0;
                    const isActive = pct > 0 && pct < 100;
                    return (
                      <div key={key} className="flex-1" title={`${label}: ${Math.round(pct)}%`}>
                        <div className={`text-[10px] mb-0.5 text-center ${isActive ? 'text-primary animate-pulse font-medium' : pct >= 100 ? 'text-chart-2' : 'text-muted-foreground'}`}>{label}</div>
                        <div className="h-1.5 rounded-full bg-accent overflow-hidden">
                          <div
                            className={`h-full rounded-full transition-all duration-500 ${pct >= 100 ? 'bg-chart-2' : pct > 0 ? 'bg-primary' : 'bg-accent'}`}
                            style={{ width: `${Math.min(pct, 100)}%` }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Messages */}
            <ScrollArea className="flex-1 min-h-0 px-4 py-3">
              {loading && <div className="flex justify-center py-8"><div className="animate-spin rounded-full size-8 border-b-2 border-primary" /></div>}
              {historyNextToken && (
                <Button variant="ghost" onClick={loadEarlierMessages} className="w-full h-auto py-2 text-xs text-muted-foreground hover:text-foreground transition-colors">
                  Load earlier messages
                </Button>
              )}
              <div className="flex flex-col gap-3">
                {messages.map((msg, i) => {
                  const { content, thinking, actions } = parseContent(msg.content);
                  const isUser = msg.role === 'user';
                  const isLastAssistant = !isUser && i === messages.map((m, idx) => m.role === 'assistant' ? idx : -1).filter((x) => x >= 0).pop();
                  return (
                    <div key={msg.id ?? i} className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
                      <div className="max-w-[85%]">
                        <div className={`rounded-lg px-3 py-2 text-sm ${isUser ? 'bg-primary text-primary-foreground' : 'bg-accent border border-border text-muted-foreground'}`}>
                          {isUser ? (
                            <p className="whitespace-pre-wrap">{content}</p>
                          ) : (
                            <div className="prose prose-invert prose-sm max-w-none">
                              <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
                            </div>
                          )}
                          <span className="text-xs opacity-50 mt-1 block">
                            {new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: 'numeric' }).format(msg.timestamp)}
                          </span>
                        </div>
                        {!isUser && actions && (
                          <div className="flex flex-wrap gap-2 mt-2">
                            {actions.map((action, ai) => (
                              <Button
                                key={ai}
                                variant="outline"
                                size="sm"
                                className="h-7 text-xs"
                                disabled={sending || !isLastAssistant}
                                onClick={() => {
                                  setInput('');
                                  setSending(true);
                                  sendMessageToAgent(project.id, 'agent_intake_single', action.value).catch(() => setSending(false));
                                }}
                              >
                                {action.label}
                              </Button>
                            ))}
                          </div>
                        )}
                        {!isUser && thinking && (
                          <Accordion type="single" collapsible className="mt-1">
                            <AccordionItem value="t" className="border-0">
                              <AccordionTrigger className="py-1 px-2 text-xs text-muted-foreground hover:text-foreground bg-card rounded-md">
                                🧠 Thought process
                              </AccordionTrigger>
                              <AccordionContent>
                                <div className="bg-card rounded-md p-2 text-xs text-muted-foreground border border-border">
                                  <p className="whitespace-pre-wrap">{thinking}</p>
                                </div>
                              </AccordionContent>
                            </AccordionItem>
                          </Accordion>
                        )}
                      </div>
                    </div>
                  );
                })}
                {sending && (
                  <div className="flex justify-start">
                    <Card className="bg-accent rounded-lg px-3 py-2 text-sm text-muted-foreground animate-pulse gap-0">
                      Thinking...
                    </Card>
                  </div>
                )}
                <div ref={messagesEndRef} />
              </div>
            </ScrollArea>

            {/* Uploaded files */}
            {uploadedFiles.length > 0 && (
              <div className="flex flex-col px-4 py-2 border-t border-border/50 gap-1">
                {uploadedFiles.map((f) => {
                  const inProgress = ['uploading', 'ingesting', 'indexing', 'deleting'].includes(f.status);
                  const statusText: Record<string, string> = {
                    uploading: 'Uploading...', ingesting: 'Processing...', indexing: 'Indexing...',
                    ready: 'Ready', failed: 'Failed', timeout: 'Timed out', deleting: 'Removing...',
                  };
                  const statusIcon: Record<string, string> = {
                    ready: '✅', failed: '❌', timeout: '⚠️',
                  };
                  return (
                    <div key={f.id} className="flex items-center gap-2 text-xs text-muted-foreground">
                      {inProgress ? (
                        <div className="size-3 border border-current border-t-transparent rounded-full animate-spin" />
                      ) : (
                        <span>{statusIcon[f.status] || ''}</span>
                      )}
                      <span className="truncate flex-1">{f.name}</span>
                      <span className="text-muted-foreground">{statusText[f.status]}</span>
                      <Button
                        variant="ghost" size="icon" className="size-4"
                        disabled={inProgress}
                        onClick={() => handleDeleteFile(f)}
                      >
                        <X className="size-3" />
                      </Button>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Input */}
            <div className="px-4 py-3 border-t border-border/50 flex gap-2">
              <input type="file" id="ws-file-upload" className="hidden" multiple accept=".pdf,.docx,.txt,.md" onChange={handleFileUpload} />
              <Button variant="ghost" size="icon" className="size-9 shrink-0" disabled={isUploading} onClick={() => document.getElementById('ws-file-upload')?.click()}>
                <Upload className="size-4" />
              </Button>
              <Input
                placeholder="Message the agent..."
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
                disabled={sending || loading}
                className="flex-1"
              />
              <Button size="icon" className="size-9 shrink-0" onClick={handleSend} disabled={!input.trim() || sending || loading}>
                <Send className="size-4" />
              </Button>
            </div>
          </div>
        </ResizablePanel>

        <ResizableHandle withHandle />

        {/* Right: Documents */}
        <ResizablePanelDirect
          ref={docPanelRef}
          defaultSize={65}
          minSize={30}
          collapsible
          collapsedSize={0}
          onCollapse={() => setDocPanelCollapsed(true)}
          onExpand={() => setDocPanelCollapsed(false)}
        >
          <div className="flex flex-col h-full overflow-hidden">
            <Tabs value={activeDocTab} onValueChange={setActiveDocTab} className="flex flex-col h-full">
              <TabsList className="shrink-0 bg-card border-b border-border/50 rounded-none justify-start px-4 h-10">
                {DOC_TABS.map((tab) => (
                  <TabsTrigger key={tab.id} value={tab.id} className="text-xs data-[state=active]:bg-accent">
                    {tab.label}
                  </TabsTrigger>
                ))}
              </TabsList>
              {DOC_TABS.map((tab) => (
                <TabsContent key={tab.id} value={tab.id} className="flex-1 overflow-hidden mt-0">
                  <DocTabContent
                    projectId={project.id}
                    tab={tab}
                    phaseProgress={(progress as any)?.[tab.progressKey] ?? 0}
                    phaseExpected={
                      tab.progressKey === 'design' ? (progress?.assessment ?? 0) >= 100
                      : (progress?.design ?? 0) >= 100
                    }
                    key={`${tab.id}-${docTabRefreshRef.current}`}
                  />
                </TabsContent>
              ))}
            </Tabs>
          </div>
        </ResizablePanelDirect>
      </ResizablePanelGroup>
    </div>
  );
}
