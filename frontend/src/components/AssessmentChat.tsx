import { useState, useEffect, useRef, useCallback } from 'react';
import { ArrowLeft, Send, Upload, FileText, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Card, CardContent } from './ui/card';
import { ScrollArea } from './ui/scroll-area';
import { Progress } from './ui/progress';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from './ui/accordion';
import type { Project } from '../services';
import {
  ConversationMessage,
  sendMessageToAgent,
  getConversationHistoryForProject,
  subscribeToConversation,
} from '../services/conversationService';
import { uploadDocument } from '../services/documentService';
import { projectService } from '../services/projectService';
import { DesignProgress } from './DesignProgress';

interface Message {
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
  id?: string;
}

interface UploadedDocument {
  id: string;
  name: string;
  size: number;
  uploadedAt: Date;
}

interface AssessmentChatProps {
  project: Project;
  onBack: () => void;
  onComplete: () => void;
}

export function AssessmentChat({ project, onBack, onComplete }: AssessmentChatProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [documents, setDocuments] = useState<UploadedDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [showGenerateReport, setShowGenerateReport] = useState(false);
  const [designComplete, setDesignComplete] = useState(projectService.isDesignComplete(project));
  const [generatingReport, setGeneratingReport] = useState(false);
  const [, setDesignProgress] = useState(0);
  const [generationTimeout, setGenerationTimeout] = useState<NodeJS.Timeout | null>(null);
  const [showTimeoutWarning, setShowTimeoutWarning] = useState(false);
  const [assessmentProgress, setAssessmentProgress] = useState<Array<{
    dimension: string;
    completionPercentage: number;
    isComplete: boolean;
  }>>([
    { dimension: 'Technical', completionPercentage: 0, isComplete: false },
    { dimension: 'Business', completionPercentage: 0, isComplete: false },
    { dimension: 'Commercial', completionPercentage: 0, isComplete: false },
    { dimension: 'Governance', completionPercentage: 0, isComplete: false },
  ]);
  const [sending, setSending] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const hasInitialMessage = useRef(false);

  const loadAssessmentProgress = useCallback(async () => {
    try {
      const progress = await projectService.getAssessmentProgress(project.id);
      console.log(progress)
      if (progress) {
        setAssessmentProgress(progress);
        const allComplete = progress.every(dim => dim.completionPercentage === 100);
        if (allComplete && !projectService.isDesignComplete(project)) {
          setShowGenerateReport(true);
        }
      }
    } catch (error) {
      console.error('Error loading assessment progress:', error);
    }
  }, [project.id, project.status]);

  const checkDesignProgress = async () => {
    try {
      const progress = await projectService.getProject(project.id);
      const designPct = progress.progress?.design || 0;
      setDesignProgress(designPct);
      if (designPct > 0 && designPct < 100) {
        setGeneratingReport(true);
        setShowGenerateReport(false);
      } else if (designPct === 100) {
        setDesignComplete(true);
        setGeneratingReport(false);
      }
    } catch (error) {
      console.error('Error checking design progress:', error);
    }
  };

  // Load conversation history and assessment progress on mount
  useEffect(() => {
    loadConversationHistory();
    loadAssessmentProgress();
    checkDesignProgress();
  }, [project.id, loadAssessmentProgress]);

  // Subscribe to new messages
  useEffect(() => {
    const unsubscribe = subscribeToConversation(
      project.id,
      (message) => {
        addConversationMessage(message);
      },
      (error) => {
        console.error('Subscription error:', error);
      }
    );

    return () => {
      unsubscribe();
    };
  }, [project.id]);

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  // Subscribe to progress updates to refresh assessment progress
  useEffect(() => {
    const unsubscribe = projectService.subscribeToProjectProgress(
      project.id,
      loadAssessmentProgress
    );
    return unsubscribe;
  }, [project.id, loadAssessmentProgress]);

  // Subscribe to assessment completion for Feature 1
  useEffect(() => {
    const unsubscribe = projectService.subscribeToAssessmentCompletion(
      project.id,
      (data) => {
        if (data.allDimensionsComplete && !projectService.isDesignComplete(project)) {
          setShowGenerateReport(true);
        }
      }
    );
    return unsubscribe;
  }, [project.id, project.status]);

  // Subscribe to design progress to detect completion
  useEffect(() => {
    const unsubscribe = projectService.subscribeToDesignProgress(
      project.id,
      (data) => {
        setDesignProgress(data.completionPercentage);
        if (generationTimeout) {
          clearTimeout(generationTimeout);
          setGenerationTimeout(null);
        }
        if (data.completionPercentage > 0 && data.completionPercentage < 100) {
          setGeneratingReport(true);
          setShowGenerateReport(false);
        } else if (data.completionPercentage === 100) {
          setDesignComplete(true);
          setGeneratingReport(false);
        }
      }
    );
    return () => {
      if (generationTimeout) clearTimeout(generationTimeout);
      unsubscribe();
    };
  }, [project.id, generationTimeout]);

  const loadConversationHistory = async () => {
    setLoading(true);
    try {
      const history = await getConversationHistoryForProject(project.id);

      if (history.items.length === 0 && !hasInitialMessage.current) {
        // Send initial greeting message if no history exists
        hasInitialMessage.current = true;
        await sendInitialGreeting();
      } else {
        // Convert conversation messages to UI messages
        const uiMessages = history.items.map(convertToUIMessage);
        setMessages(uiMessages);
      }
    } catch (error) {
      console.error('Error loading conversation history:', error);
    } finally {
      setLoading(false);
    }
  };

  const sendInitialGreeting = async () => {
    try {
      await sendMessageToAgent(
        project.id,
        `agent1`,
        'Initiate Assessment'
      );
    } catch (error) {
      console.error('Error sending initial greeting:', error);
    }
  };

  const convertToUIMessage = (msg: ConversationMessage): Message => {
    return {
      id: msg.id,
      role: msg.messageType === 'USER_INPUT' ? 'user' : 'assistant',
      content: msg.message,
      timestamp: new Date(msg.timestamp),
    };
  };

  const addConversationMessage = (msg: ConversationMessage) => {
    // Handle progress updates (agent is thinking)
    if (msg.messageType === 'PROGRESS_UPDATE') {
      setSending(true);
      return; // Don't add progress updates to message list
    }

    // When we receive an actual response, stop the loading state
    if (msg.messageType === 'AGENT_RESPONSE') {
      setSending(false);
      // Refresh assessment progress after agent response
      loadAssessmentProgress();
    }

    setMessages((prev) => {
      // Avoid duplicates
      if (prev.some((m) => m.id === msg.id)) {
        return prev;
      }
      return [...prev, convertToUIMessage(msg)];
    });
  };

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  const handleSend = async () => {
    if (!input.trim() || sending) return;

    const messageText = input.trim();
    setInput('');

    try {
      await sendMessageToAgent(project.id, 'agent1', messageText);
      // Message will appear via subscription
      // Loading state will be set by PROGRESS_UPDATE message from backend

      // Update progress based on message count
      // const userMessageCount = messages.filter(m => m.role === 'user').length + 1;
      // const newProgress = Math.min((userMessageCount / 7) * 100, 100);
      // setProgress(newProgress);
    } catch (error) {
      console.error('Error sending message:', error);
      toast.error('Failed to send message. Please try again.');
      setInput(messageText); // Restore message
      setSending(false);
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;

    for (const file of Array.from(files)) {
      if (documents.length >= 10) {
        toast.error('Maximum of 10 documents allowed per project');
        return;
      }

      if (file.size > 10 * 1024 * 1024) {
        toast.error(`File ${file.name} exceeds 10MB limit`);
        return;
      }

      const allowedTypes = ['.pdf', '.docx', '.txt', '.md'];
      const fileExt = '.' + file.name.split('.').pop()?.toLowerCase();
      if (!allowedTypes.includes(fileExt)) {
        toast.error(`File type ${fileExt} not supported. Use PDF, DOCX, TXT, or MD`);
        return;
      }

      // Create document entry with uploading status
      const docId = Math.random().toString(36).substring(2, 11);
      const doc: UploadedDocument = {
        id: docId,
        name: file.name,
        size: file.size,
        uploadedAt: new Date(),
      };

      setDocuments((prev) => [...prev, doc]);

      try {
        // Upload to S3
        const documentKey = await uploadDocument(project.id, file);
        console.log('Document uploaded successfully:', documentKey);

        // Notify agent about the upload
        await sendMessageToAgent(
          project.id,
          'agent1',
          `Uploaded document: ${file.name}`,
          { document_upload_key: file.name }
        );
      } catch (error) {
        console.error('Error uploading document:', error);
        toast.error(`Failed to upload ${file.name}. Please try again.`);
        // Remove failed upload from list
        setDocuments((prev) => prev.filter((d) => d.id !== docId));
      }
    }

    // Clear the input
    e.target.value = '';
  };

  const removeDocument = (id: string) => {
    setDocuments((prev) => prev.filter((doc) => doc.id !== id));
  };

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  };

  const formatTime = (date: Date) => {
    return new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      minute: 'numeric',
    }).format(date);
  };

  /**
   * Parse message content to extract all thinking tags
   * Returns { content: string, thinking: string | null }
   */
  const parseMessageContent = (content: string): { content: string; thinking: string | null } => {
    const thinkingRegex = /<thinking>([\s\S]*?)<\/thinking>/g;
    const matches = Array.from(content.matchAll(thinkingRegex));

    if (matches.length > 0) {
      // Extract all thinking sections
      const thinkingSections = matches.map((match, index) => {
        const thinking = match[1].trim();
        // Add section number if multiple thinking blocks
        if (matches.length > 1) {
          return `[Thought ${index + 1}]\n${thinking}`;
        }
        return thinking;
      });

      // Combine all thinking sections
      const combinedThinking = thinkingSections.join('\n\n---\n\n');

      // Remove all thinking tags from content
      const cleanContent = content.replace(thinkingRegex, '').trim();

      return { content: cleanContent, thinking: combinedThinking };
    }

    return { content, thinking: null };
  };

  return (
    <div className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6 flex gap-6">
      <div className="flex-1 flex flex-col gap-4">
        <Card className="flex-1 flex flex-col">
          <div className="p-4 border-b border-border">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={onBack}
                  className="size-8"
                >
                  <ArrowLeft className="size-4" />
                </Button>
                <h3 className="text-foreground">{project.progress?.currentPhase || 'Technical Feasibility Assessment'}</h3>
              </div>
              <span className="text-sm text-muted-foreground">{Math.round(project.progress?.assessment || 0)}% Complete</span>
            </div>
            <Progress value={project.progress?.assessment} className="h-2" />
          </div>

          <ScrollArea className="flex-1 max-h-[calc(100vh-400px)]">
            <div className="p-4">
              <DesignProgress projectId={project.id} isGenerating={generatingReport} />
              <div className="flex flex-col gap-4">
              {loading && (
                <div className="flex justify-center items-center py-8">
                  <div className="animate-spin rounded-full size-8 border-b-2 border-primary"></div>
                </div>
              )}

              {!loading && messages.length === 0 && (
                <div className="flex justify-center items-center py-8 text-muted-foreground">
                  <p>Starting conversation...</p>
                </div>
              )}

              {messages.map((message, index) => {
                const { content, thinking } = parseMessageContent(message.content);
                const isUser = message.role === 'user';

                return (
                  <div
                    key={message.id || index}
                    className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}
                  >
                    <div className={`max-w-[80%] ${isUser ? '' : 'w-full max-w-[80%]'}`}>
                      {/* Main message bubble */}
                      <div
                        className={`rounded-lg p-4 ${isUser
                            ? 'bg-primary text-primary-foreground'
                            : 'bg-card border border-border text-card-foreground'
                          }`}
                      >
                        <p className="whitespace-pre-wrap">{content}</p>
                        <span className="text-xs opacity-70 mt-2 block">
                          {formatTime(message.timestamp)}
                        </span>
                      </div>

                      {/* Thinking accordion (only for agent messages with thinking) */}
                      {!isUser && thinking && (
                        <Accordion type="single" collapsible className="mt-1">
                          <AccordionItem value="thinking" className="border-0">
                            <AccordionTrigger className="py-2 px-3 text-xs text-muted-foreground hover:text-foreground bg-muted/50 rounded-md hover:bg-muted transition-colors">
                              <div className="flex items-center gap-2">
                                <span className="text-xs">🧠 View thought process</span>
                              </div>
                            </AccordionTrigger>
                            <AccordionContent className="pt-2 pb-0">
                              <div className="bg-muted rounded-md p-3 text-xs text-muted-foreground border border-border">
                                <div className="flex items-start gap-2">
                                  <p className="whitespace-pre-wrap flex-1 leading-relaxed">
                                    {thinking}
                                  </p>
                                </div>
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
                  <div className="max-w-[80%] rounded-lg p-4 bg-card border border-border">
                    <div className="flex items-center gap-2">
                      <div className="animate-pulse">Agent is thinking...</div>
                    </div>
                  </div>
                </div>
              )}

              <div ref={messagesEndRef} />
              </div>
            </div>
          </ScrollArea>

          <div className="p-4 border-t border-border">
            <div className="flex gap-2">
              <Input
                placeholder="Type your response..."
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    handleSend();
                  }
                }}
                disabled={sending || loading}
              />
              <Button onClick={handleSend} size="icon" disabled={!input.trim() || sending || loading}>
                <Send className="size-4" />
              </Button>
            </div>
          </div>
        </Card>

        {showGenerateReport && !generatingReport && !designComplete && (
          <Card className="p-4 bg-accent border-primary">
            <div className="flex items-start justify-between">
              <div>
                <h4 className="text-foreground mb-1">Assessment Complete</h4>
                <p className="text-sm text-muted-foreground">
                  Ready to generate your High Level Design and recommendations
                </p>
              </div>
              <Button onClick={() => { 
                setGeneratingReport(true); 
                setShowTimeoutWarning(false);
                const timeout = setTimeout(() => {
                  setShowTimeoutWarning(true);
                }, 60000);
                setGenerationTimeout(timeout);
                onComplete(); 
              }}>Generate Report</Button>
            </div>
          </Card>
        )}

        {generatingReport && !designComplete && (
          <Card className={`p-4 ${showTimeoutWarning ? 'bg-chart-4/10 border-chart-4' : 'bg-accent border-primary'}`}>
            <div className="flex flex-col gap-3">
              <div>
                <h4 className="text-foreground mb-1">Generating Assessment Report</h4>
                <p className="text-sm text-muted-foreground">
                  Creating your assessment report...
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  This may take several minutes. Agent is generating 30 sections.
                </p>
                {showTimeoutWarning && (
                  <p className="text-xs text-chart-4 mt-2 font-medium">
                    ⚠️ Generation is taking longer than expected. Please check CloudWatch logs or wait a bit longer.
                  </p>
                )}
              </div>
              <DesignProgress projectId={project.id} isGenerating={true} />
            </div>
          </Card>
        )}

        {designComplete && (
          <Card className="p-4 bg-accent border-primary">
            <div className="flex items-start justify-between">
              <div>
                <h4 className="text-foreground mb-1">Report Ready</h4>
                <p className="text-sm text-muted-foreground">
                  Your High Level Design report has been generated
                </p>
              </div>
              <Button onClick={onComplete}>Download Assessment Report</Button>
            </div>
          </Card>
        )}
      </div>

      <div className="w-80">
        <Card>
          <div className="p-4 border-b border-border">
            <h3 className="text-foreground">Project Documents</h3>
            <p className="text-sm text-muted-foreground mt-1">
              Upload technical documentation (max 10 files)
            </p>
          </div>
          <CardContent className="p-4">
            <div className="flex flex-col gap-4">
              <div>
                <input
                  type="file"
                  id="file-upload"
                  className="hidden"
                  multiple
                  accept=".pdf,.docx,.txt,.md"
                  onChange={handleFileUpload}
                />
                <label htmlFor="file-upload">
                  <Button
                    variant="outline"
                    className="w-full gap-2"
                    onClick={() => document.getElementById('file-upload')?.click()}
                    type="button"
                    disabled={documents.length >= 10}
                  >
                    <Upload className="size-4" />
                    Upload Document
                  </Button>
                </label>
                <p className="text-xs text-muted-foreground mt-2">
                  Supports PDF, DOCX, TXT, MD (max 10MB)
                </p>
              </div>

              {documents.length > 0 && (
                <div className="flex flex-col gap-2">
                  <p className="text-sm text-muted-foreground">
                    {documents.length} of 10 documents
                  </p>
                  {documents.map((doc) => (
                    <Card
                      key={doc.id}
                      className="flex-row items-center gap-2 p-2 rounded-lg"
                    >
                      <FileText className="size-4 text-muted-foreground flex-shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm truncate">{doc.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {formatFileSize(doc.size)}
                        </p>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-6 flex-shrink-0"
                        onClick={() => removeDocument(doc.id)}
                      >
                        <X className="size-3" />
                      </Button>
                    </Card>
                  ))}
                </div>
              )}

              <div className="pt-4 border-t border-border">
                <h4 className="text-sm mb-2">Assessment Progress</h4>
                <div className="flex flex-col gap-2 text-sm">
                  {assessmentProgress.map((dim) => (
                    <div key={dim.dimension} className="flex justify-between items-center">
                      <span className="text-muted-foreground capitalize">{dim.dimension}</span>
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground">{dim.completionPercentage}%</span>
                        <span className={dim.isComplete ? 'text-primary' : 'text-muted-foreground'}>
                          {dim.isComplete ? '✓' : '○'}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
