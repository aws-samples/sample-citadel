import { useState } from 'react';
import {
  ArrowLeft,
  Cloud,
  Link2,
  FileJson,
  Upload,
  Loader2,
  CheckCircle2,
  XCircle,
  ShieldCheck,
  AlertTriangle,
  Check,
} from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Textarea } from './ui/textarea';
import { Label } from './ui/label';
import { Badge } from './ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Checkbox } from './ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './ui/select';
import { agentImportService } from '../services/agentImportService';
import type {
  AgentCandidate,
  AgentCapabilityDescriptor,
  AgentInvocationAuthMode,
  AgentInvocationMode,
  AgentInvocationProtocol,
  DiscoverAgentsInput,
  DiscoverySource,
  ImportAgentInput,
  ImportAgentResult,
  ImportConflictPolicy,
} from '../types/agentImport';

interface ImportAgentWizardProps {
  onBack: () => void;
  onComplete: () => void;
}

type Step = 'source' | 'candidates' | 'review' | 'configure' | 'register';

const STEPS: { id: Step; label: string }[] = [
  { id: 'source', label: 'Source' },
  { id: 'candidates', label: 'Candidates' },
  { id: 'review', label: 'Review' },
  { id: 'configure', label: 'Configure & Test' },
  { id: 'register', label: 'Governance & Register' },
];

const PROTOCOL_OPTIONS: AgentInvocationProtocol[] = [
  'AGENTCORE_RUNTIME',
  'BEDROCK_AGENT',
  'LAMBDA_INVOKE',
  'HTTP_ENDPOINT',
  'MCP',
  'A2A',
  'STEP_FUNCTIONS',
  'SAGEMAKER_ENDPOINT',
  'SQS_ASYNC',
];

const AUTH_MODE_OPTIONS: AgentInvocationAuthMode[] = [
  'NONE',
  'SIGV4',
  'API_KEY',
  'OAUTH2',
  'COGNITO',
];

const MODE_OPTIONS: { value: AgentInvocationMode; label: string }[] = [
  { value: 'sync', label: 'Synchronous (request/response)' },
  { value: 'async_callback', label: 'Asynchronous (callback)' },
];

// Auth modes that require a caller-supplied secret at import time.
const AUTH_MODES_NEEDING_SECRET: AgentInvocationAuthMode[] = [
  'API_KEY',
  'OAUTH2',
  'COGNITO',
];

const CONFLICT_OPTIONS: {
  value: ImportConflictPolicy;
  label: string;
  hint: string;
}[] = [
  {
    value: 'LINK',
    label: 'Link to existing',
    hint: 'Attach this source to the existing agent record.',
  },
  {
    value: 'REPLACE',
    label: 'Replace existing',
    hint: 'Overwrite the existing record with this descriptor.',
  },
  {
    value: 'COPY',
    label: 'Import as a new copy',
    hint: 'Create a separate record, leaving the existing one untouched.',
  },
];

const errorMessage = (err: unknown, fallback: string): string =>
  err instanceof Error ? err.message : fallback;

const confidenceClass = (level: string): string => {
  switch (level) {
    case 'high':
      return 'bg-chart-2/10 text-chart-2 border border-chart-2/40';
    case 'medium':
      return 'bg-chart-3/10 text-chart-3 border border-chart-3/40';
    default:
      return 'bg-destructive/10 text-destructive border border-destructive/40';
  }
};

export function ImportAgentWizard({ onBack, onComplete }: ImportAgentWizardProps) {
  const [currentStep, setCurrentStep] = useState<Step>('source');

  // Step 1 — Source
  const [source, setSource] = useState<DiscoverySource>('SCAN');
  const [region, setRegion] = useState('');
  const [tagKey, setTagKey] = useState('');
  const [tagValue, setTagValue] = useState('');
  const [pasteRef, setPasteRef] = useState('');
  const [manifestText, setManifestText] = useState('');

  // Step 2 — Candidates
  const [candidates, setCandidates] = useState<AgentCandidate[]>([]);
  const [candidatesLoading, setCandidatesLoading] = useState(false);
  const [candidatesError, setCandidatesError] = useState<string | null>(null);
  const [selectedRefs, setSelectedRefs] = useState<string[]>([]);

  // Step 3 — Review descriptor
  const [descriptor, setDescriptor] = useState<AgentCapabilityDescriptor | null>(null);
  const [descriptorLoading, setDescriptorLoading] = useState(false);
  const [descriptorError, setDescriptorError] = useState<string | null>(null);
  const [editedName, setEditedName] = useState('');
  const [categoriesText, setCategoriesText] = useState('');
  const [confirmedFields, setConfirmedFields] = useState<Record<string, boolean>>({});

  // Step 4 — Configure invocation + auth + test
  const [protocol, setProtocol] = useState<AgentInvocationProtocol>('HTTP_ENDPOINT');
  const [target, setTarget] = useState('');
  const [authMode, setAuthMode] = useState<AgentInvocationAuthMode>('NONE');
  const [secret, setSecret] = useState('');
  const [invocationMode, setInvocationMode] = useState<AgentInvocationMode>('sync');
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'pass' | 'fail'>('idle');
  const [testError, setTestError] = useState<string | null>(null);

  // Step 5 — Governance & register
  const [registering, setRegistering] = useState(false);
  const [registerError, setRegisterError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<ImportAgentResult | null>(null);
  const [conflictChoice, setConflictChoice] = useState<ImportConflictPolicy | null>(null);
  const [registered, setRegistered] = useState(false);

  const activeRef = selectedRefs[0] ?? null;
  const fieldConfidence = descriptor?.fieldConfidence ?? {};
  const lowConfidenceFields = Object.keys(fieldConfidence).filter(
    (k) => fieldConfidence[k] === 'low',
  );
  const allLowConfirmed = lowConfidenceFields.every((f) => confirmedFields[f]);
  const authNeedsSecret = AUTH_MODES_NEEDING_SECRET.includes(authMode);
  const currentIndex = STEPS.findIndex((s) => s.id === currentStep);

  const parseManifestSafe = (): Record<string, unknown> | null => {
    const raw = manifestText.trim();
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        return parsed as Record<string, unknown>;
      }
      return null;
    } catch {
      return null;
    }
  };

  const invalidateTest = (): void => {
    setTestStatus('idle');
    setTestError(null);
  };

  const runDiscovery = async (): Promise<void> => {
    setCandidatesLoading(true);
    setCandidatesError(null);
    setCandidates([]);
    setSelectedRefs([]);
    try {
      let input: DiscoverAgentsInput;
      if (source === 'SCAN') {
        input = {
          source: 'SCAN',
          region: region.trim() || undefined,
          tagKey: tagKey.trim() || undefined,
          tagValue: tagValue.trim() || undefined,
        };
      } else if (source === 'PASTE') {
        input = { source: 'PASTE', ref: pasteRef.trim() };
      } else {
        input = { source: 'MANIFEST', manifest: parseManifestSafe() ?? undefined };
      }
      const found = await agentImportService.discoverAgents(input);
      setCandidates(found);
    } catch (err) {
      setCandidatesError(errorMessage(err, 'Failed to discover agents'));
    } finally {
      setCandidatesLoading(false);
    }
  };

  const loadDescriptor = async (ref: string): Promise<void> => {
    setDescriptorLoading(true);
    setDescriptorError(null);
    try {
      const d = await agentImportService.describeAgentCandidate(ref);
      setDescriptor(d);
      setEditedName(d.name);
      setCategoriesText((d.categories ?? []).join(', '));
      setConfirmedFields({});
      setProtocol(d.invocation.protocol);
      setTarget(d.invocation.target);
      setAuthMode(d.invocation.auth.mode);
      setInvocationMode(d.invocation.mode);
      setSecret('');
      invalidateTest();
    } catch (err) {
      setDescriptor(null);
      setDescriptorError(errorMessage(err, 'Failed to describe agent candidate'));
    } finally {
      setDescriptorLoading(false);
    }
  };

  const testConnection = async (): Promise<void> => {
    if (!activeRef) return;
    setTestStatus('testing');
    setTestError(null);
    try {
      await agentImportService.describeAgentCandidate(activeRef);
      setTestStatus('pass');
    } catch (err) {
      setTestStatus('fail');
      setTestError(errorMessage(err, 'Connection test failed'));
    }
  };

  const buildImportInput = (onConflict?: ImportConflictPolicy): ImportAgentInput => {
    const categories = categoriesText
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const origin = descriptor?.origin;
    return {
      name: editedName.trim(),
      manifest: source === 'MANIFEST' ? parseManifestSafe() ?? undefined : undefined,
      invocationProtocol: protocol,
      invocationTarget: target.trim(),
      invocationAuthMode: authMode,
      invocationSecretRef: descriptor?.invocation.auth.secretRef,
      invocationSecret: authNeedsSecret && secret.trim() ? secret.trim() : undefined,
      invocationMode,
      region: origin?.region,
      account: origin?.account,
      sourceArn: origin?.sourceArn,
      substrate: origin?.substrate ?? '',
      categories,
      onConflict,
    };
  };

  const handleRegister = async (onConflict?: ImportConflictPolicy): Promise<void> => {
    setRegistering(true);
    setRegisterError(null);
    try {
      const result = await agentImportService.importAgent(buildImportInput(onConflict));
      if (result.conflict) {
        setConflict(result);
      } else {
        setConflict(null);
        setRegistered(true);
      }
    } catch (err) {
      setRegisterError(errorMessage(err, 'Failed to import agent'));
    } finally {
      setRegistering(false);
    }
  };

  const toggleCandidate = (ref: string): void => {
    setSelectedRefs((prev) =>
      prev.includes(ref) ? prev.filter((r) => r !== ref) : [...prev, ref],
    );
  };

  const canProceed = (): boolean => {
    switch (currentStep) {
      case 'source':
        if (source === 'SCAN') return region.trim() !== '';
        if (source === 'PASTE') return pasteRef.trim() !== '';
        return parseManifestSafe() !== null;
      case 'candidates':
        return !candidatesLoading && selectedRefs.length > 0;
      case 'review':
        return (
          !!descriptor &&
          !descriptorLoading &&
          editedName.trim() !== '' &&
          allLowConfirmed
        );
      case 'configure':
        return target.trim() !== '' && testStatus === 'pass';
      default:
        return false;
    }
  };

  const handleNext = async (): Promise<void> => {
    if (currentStep === 'source') {
      setCurrentStep('candidates');
      await runDiscovery();
    } else if (currentStep === 'candidates') {
      setCurrentStep('review');
      if (activeRef) await loadDescriptor(activeRef);
    } else if (currentStep === 'review') {
      setCurrentStep('configure');
    } else if (currentStep === 'configure') {
      setCurrentStep('register');
    }
  };

  const handlePrevious = (): void => {
    if (currentIndex > 0) setCurrentStep(STEPS[currentIndex - 1].id);
  };

  const handleManifestFile = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setManifestText(typeof reader.result === 'string' ? reader.result : '');
    };
    reader.readAsText(file);
  };

  const sourceOptions: {
    value: DiscoverySource;
    label: string;
    description: string;
    icon: typeof Cloud;
  }[] = [
    {
      value: 'SCAN',
      label: 'Scan AWS account',
      description: 'Discover agent runtimes in a region, optionally filtered by tag.',
      icon: Cloud,
    },
    {
      value: 'PASTE',
      label: 'Paste a reference',
      description: 'Provide an ARN or an HTTPS endpoint URL for a single agent.',
      icon: Link2,
    },
    {
      value: 'MANIFEST',
      label: 'Provide a manifest',
      description: 'Paste or upload a JSON manifest describing the agent(s).',
      icon: FileJson,
    },
  ];

  const renderSourceStep = () => (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">Discovery source</h2>
        <p className="text-sm text-muted-foreground">
          Choose how Citadel should locate the external agent you want to import.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {sourceOptions.map((opt) => {
          const Icon = opt.icon;
          const selected = source === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              aria-pressed={selected}
              onClick={() => setSource(opt.value)}
              className={`flex flex-col gap-2 rounded-lg border p-4 text-left cursor-pointer transition-colors ${
                selected
                  ? 'border-primary bg-primary/5'
                  : 'border-border bg-card hover:bg-accent'
              }`}
            >
              <Icon className="size-5 text-primary" />
              <span className="text-sm font-medium text-foreground">{opt.label}</span>
              <span className="text-xs text-muted-foreground">{opt.description}</span>
            </button>
          );
        })}
      </div>

      {source === 'SCAN' && (
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="region-input">AWS Region</Label>
            <Input
              id="region-input"
              value={region}
              onChange={(e) => setRegion(e.target.value)}
              placeholder="us-east-1"
            />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="tag-key">Tag key (optional)</Label>
              <Input
                id="tag-key"
                value={tagKey}
                onChange={(e) => setTagKey(e.target.value)}
                placeholder="team"
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="tag-value">Tag value (optional)</Label>
              <Input
                id="tag-value"
                value={tagValue}
                onChange={(e) => setTagValue(e.target.value)}
                placeholder="payments"
              />
            </div>
          </div>
        </div>
      )}

      {source === 'PASTE' && (
        <div className="flex flex-col gap-2">
          <Label htmlFor="paste-ref">Agent reference (ARN or endpoint URL)</Label>
          <Input
            id="paste-ref"
            value={pasteRef}
            onChange={(e) => setPasteRef(e.target.value)}
            placeholder="arn:aws:… or https://…"
          />
        </div>
      )}

      {source === 'MANIFEST' && (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-2">
            <Label htmlFor="manifest-json">Agent manifest (JSON)</Label>
            <Textarea
              id="manifest-json"
              value={manifestText}
              onChange={(e) => setManifestText(e.target.value)}
              rows={8}
              placeholder='{ "agents": [ … ] }'
              className="font-mono text-sm"
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="manifest-file" className="cursor-pointer">
              <Upload className="size-4" />
              Upload manifest file
            </Label>
            <Input
              id="manifest-file"
              type="file"
              accept="application/json,.json"
              onChange={handleManifestFile}
              className="cursor-pointer"
            />
          </div>
          {manifestText.trim() !== '' && parseManifestSafe() === null && (
            <p role="alert" className="text-xs text-destructive">
              Manifest is not valid JSON.
            </p>
          )}
        </div>
      )}
    </div>
  );

  const renderCandidatesStep = () => (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-lg font-semibold text-foreground">Discovered candidates</h2>
        <p className="text-sm text-muted-foreground">
          Select an agent to import. Multiple may be selected; the first is imported now.
        </p>
      </div>

      {candidatesLoading && (
        <div className="flex items-center gap-2 text-muted-foreground py-8 justify-center">
          <Loader2 className="size-4 animate-spin" />
          <span>Discovering agents…</span>
        </div>
      )}

      {!candidatesLoading && candidatesError && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-destructive"
        >
          <AlertTriangle className="size-4 mt-0.5" />
          <span className="text-sm">{candidatesError}</span>
        </div>
      )}

      {!candidatesLoading && !candidatesError && candidates.length === 0 && (
        <div className="text-center py-8 text-muted-foreground text-sm">
          No importable agents found for this source.
        </div>
      )}

      {!candidatesLoading && !candidatesError && candidates.length > 0 && (
        <div className="flex flex-col gap-2">
          {candidates.map((c) => {
            const selected = selectedRefs.includes(c.reference);
            return (
              <button
                key={c.reference}
                type="button"
                aria-pressed={selected}
                onClick={() => toggleCandidate(c.reference)}
                className={`flex items-center justify-between gap-3 rounded-lg border p-3 text-left cursor-pointer transition-colors ${
                  selected
                    ? 'border-primary bg-primary/5'
                    : 'border-border bg-card hover:bg-accent'
                }`}
              >
                <div className="flex flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <Badge variant="secondary">{c.substrate}</Badge>
                    <span className="text-sm font-medium text-foreground">
                      {c.displayName}
                    </span>
                  </div>
                  <span className="text-xs text-muted-foreground break-all">
                    {c.reference}
                  </span>
                </div>
                {selected && (
                  <Badge className="bg-chart-2 text-foreground shrink-0">
                    <Check className="size-3 mr-1" />
                    Selected
                  </Badge>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );

  const renderConfidenceBadge = (field: string) => {
    const level = fieldConfidence[field];
    if (!level) return null;
    return (
      <Badge
        data-testid={`confidence-${field}`}
        className={`${confidenceClass(level)} capitalize`}
      >
        {level}
      </Badge>
    );
  };

  const renderReviewStep = () => {
    if (descriptorLoading) {
      return (
        <div className="flex items-center gap-2 text-muted-foreground py-8 justify-center">
          <Loader2 className="size-4 animate-spin" />
          <span>Loading agent descriptor…</span>
        </div>
      );
    }
    if (descriptorError) {
      return (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-destructive"
        >
          <AlertTriangle className="size-4 mt-0.5" />
          <span className="text-sm">{descriptorError}</span>
        </div>
      );
    }
    if (!descriptor) return null;

    return (
      <div className="flex flex-col gap-5">
        <div>
          <h2 className="text-lg font-semibold text-foreground">Review descriptor</h2>
          <p className="text-sm text-muted-foreground">
            Confirm the inferred capability descriptor. Low-confidence fields must be
            acknowledged before continuing.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <Label htmlFor="review-name">Agent name</Label>
              {renderConfidenceBadge('name')}
            </div>
            <Input
              id="review-name"
              value={editedName}
              onChange={(e) => setEditedName(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="review-categories">Categories (comma-separated)</Label>
            <Input
              id="review-categories"
              value={categoriesText}
              onChange={(e) => setCategoriesText(e.target.value)}
              placeholder="commerce, support"
            />
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-foreground">Description</span>
            {renderConfidenceBadge('description')}
          </div>
          <p className="text-sm text-muted-foreground">{descriptor.description}</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
          <div className="flex flex-col gap-1">
            <span className="font-medium text-foreground">Version</span>
            <span className="text-muted-foreground">Version {descriptor.version}</span>
          </div>
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <span className="font-medium text-foreground">Invocation</span>
              {renderConfidenceBadge('invocation')}
            </div>
            <span className="text-muted-foreground break-all">
              {descriptor.invocation.protocol} → {descriptor.invocation.target}
            </span>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium text-foreground">Skills</span>
          <div className="flex flex-wrap gap-2">
            {descriptor.skills.map((skill) => (
              <Badge key={skill} variant="secondary">
                {skill}
              </Badge>
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-foreground">Origin</span>
          <span className="text-muted-foreground break-all">
            {descriptor.origin.substrate} · {descriptor.origin.ownership}
            {descriptor.origin.sourceArn ? ` · ${descriptor.origin.sourceArn}` : ''}
          </span>
        </div>

        {lowConfidenceFields.length > 0 && (
          <div className="flex flex-col gap-2 rounded-lg border border-chart-3/40 bg-chart-3/5 p-4">
            <div className="flex items-center gap-2 text-chart-3">
              <AlertTriangle className="size-4" />
              <span className="text-sm font-medium">
                Confirm low-confidence fields
              </span>
            </div>
            {lowConfidenceFields.map((f) => (
              <div key={f} className="flex items-center gap-2">
                <Checkbox
                  id={`confirm-${f}`}
                  checked={!!confirmedFields[f]}
                  onCheckedChange={(v) =>
                    setConfirmedFields((prev) => ({ ...prev, [f]: v === true }))
                  }
                  className="cursor-pointer"
                />
                <Label htmlFor={`confirm-${f}`} className="cursor-pointer">
                  Confirm low-confidence field: {f}
                </Label>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  };

  const renderConfigureStep = () => (
    <div className="flex flex-col gap-5">
      <div>
        <h2 className="text-lg font-semibold text-foreground">
          Configure invocation &amp; test
        </h2>
        <p className="text-sm text-muted-foreground">
          Confirm how Citadel will reach this agent, then run a reachability check.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium text-foreground">Protocol</span>
          <Select
            value={protocol}
            onValueChange={(v) => {
              setProtocol(v as AgentInvocationProtocol);
              invalidateTest();
            }}
          >
            <SelectTrigger aria-label="Invocation protocol" className="cursor-pointer">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PROTOCOL_OPTIONS.map((p) => (
                <SelectItem key={p} value={p}>
                  {p}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="invocation-target">Invocation target</Label>
          <Input
            id="invocation-target"
            value={target}
            onChange={(e) => {
              setTarget(e.target.value);
              invalidateTest();
            }}
            placeholder="arn:aws:… or https://…"
          />
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium text-foreground">Authentication mode</span>
          <Select
            value={authMode}
            onValueChange={(v) => {
              setAuthMode(v as AgentInvocationAuthMode);
              invalidateTest();
            }}
          >
            <SelectTrigger aria-label="Authentication mode" className="cursor-pointer">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {AUTH_MODE_OPTIONS.map((m) => (
                <SelectItem key={m} value={m}>
                  {m}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium text-foreground">Invocation mode</span>
          <Select
            value={invocationMode}
            onValueChange={(v) => {
              setInvocationMode(v as AgentInvocationMode);
              invalidateTest();
            }}
          >
            <SelectTrigger aria-label="Invocation mode" className="cursor-pointer">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MODE_OPTIONS.map((m) => (
                <SelectItem key={m.value} value={m.value}>
                  {m.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {authNeedsSecret && (
        <div className="flex flex-col gap-2">
          <Label htmlFor="invocation-secret">Invocation secret</Label>
          <Input
            id="invocation-secret"
            type="password"
            value={secret}
            onChange={(e) => {
              setSecret(e.target.value);
              invalidateTest();
            }}
            placeholder="API key / client secret (stored in Secrets Manager)"
          />
          <p className="text-xs text-muted-foreground">
            Stored as a managed secret on import — the raw value never lands on the record.
          </p>
        </div>
      )}

      <div className="flex items-center gap-3">
        <Button
          type="button"
          variant="outline"
          onClick={testConnection}
          disabled={testStatus === 'testing' || target.trim() === ''}
          className="cursor-pointer"
        >
          {testStatus === 'testing' ? (
            <Loader2 className="size-4 mr-2 animate-spin" />
          ) : null}
          Test connection
        </Button>

        {testStatus === 'pass' && (
          <span className="flex items-center gap-1.5 text-sm text-chart-2">
            <CheckCircle2 className="size-4" />
            Connection verified
          </span>
        )}
        {testStatus === 'fail' && (
          <span role="alert" className="flex items-center gap-1.5 text-sm text-destructive">
            <XCircle className="size-4" />
            {testError ?? 'Connection test failed'}
          </span>
        )}
      </div>
    </div>
  );

  const renderRegisterStep = () => {
    if (registered) {
      return (
        <div className="flex flex-col items-center gap-3 py-8 text-center">
          <CheckCircle2 className="size-10 text-chart-2" />
          <h2 className="text-lg font-semibold text-foreground">Agent imported</h2>
          <p className="text-sm text-muted-foreground max-w-md">
            <span className="font-medium text-foreground">{editedName}</span> was created
            as a <span className="font-medium text-foreground">DRAFT</span> record, pending
            governance attestation before it can be activated.
          </p>
        </div>
      );
    }

    const options = conflict?.options && conflict.options.length > 0
      ? CONFLICT_OPTIONS.filter((o) => conflict.options!.includes(o.value))
      : CONFLICT_OPTIONS;

    return (
      <div className="flex flex-col gap-5">
        <div>
          <h2 className="text-lg font-semibold text-foreground">Governance &amp; register</h2>
          <p className="text-sm text-muted-foreground">
            Review the summary and register the agent. It will be created as a DRAFT
            pending governance attestation.
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2 text-foreground">
              <ShieldCheck className="size-4 text-primary" />
              Import summary
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 text-sm">
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground">Name</span>
              <span className="text-foreground font-medium">{editedName}</span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground">Substrate</span>
              <span className="text-foreground">{descriptor?.origin.substrate}</span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground">Protocol</span>
              <span className="text-foreground">{protocol}</span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground">Target</span>
              <span className="text-foreground break-all text-right">{target}</span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground">Auth</span>
              <span className="text-foreground">
                {authMode} · {invocationMode}
              </span>
            </div>
          </CardContent>
        </Card>

        {registerError && (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-destructive"
          >
            <AlertTriangle className="size-4 mt-0.5" />
            <span className="text-sm">{registerError}</span>
          </div>
        )}

        {conflict && (
          <div className="flex flex-col gap-3 rounded-lg border border-chart-3/40 bg-chart-3/5 p-4">
            <div className="flex items-start gap-2 text-chart-3">
              <AlertTriangle className="size-4 mt-0.5" />
              <div className="flex flex-col">
                <span className="text-sm font-medium">
                  {conflict.reason ?? 'An agent with the same source already exists'}
                </span>
                {conflict.existingId && (
                  <span className="text-xs text-muted-foreground">
                    Existing agent: {conflict.existingId}
                  </span>
                )}
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
              {options.map((o) => {
                const selected = conflictChoice === o.value;
                return (
                  <button
                    key={o.value}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => setConflictChoice(o.value)}
                    className={`flex flex-col gap-1 rounded-lg border p-3 text-left cursor-pointer transition-colors ${
                      selected
                        ? 'border-primary bg-primary/5'
                        : 'border-border bg-card hover:bg-accent'
                    }`}
                  >
                    <span className="text-sm font-medium text-foreground">{o.label}</span>
                    <span className="text-xs text-muted-foreground">{o.hint}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="flex flex-col gap-6 max-w-3xl mx-auto p-4">
      {/* Header */}
      <div className="flex flex-col gap-3">
        <Button
          variant="ghost"
          onClick={onBack}
          className="self-start text-foreground hover:bg-accent cursor-pointer"
        >
          <ArrowLeft className="size-4 mr-2" />
          Back to Catalog
        </Button>
        <h1 className="text-2xl font-semibold text-foreground">Import Agent</h1>
      </div>

      {/* Progress */}
      <ol className="flex flex-wrap items-center gap-2">
        {STEPS.map((step, index) => {
          const isActive = step.id === currentStep;
          const isComplete = index < currentIndex;
          return (
            <li key={step.id} className="flex items-center gap-2">
              <span
                className={`flex items-center gap-2 rounded-full px-3 py-1 text-xs font-medium ${
                  isActive
                    ? 'bg-primary text-primary-foreground'
                    : isComplete
                      ? 'bg-chart-2/20 text-chart-2'
                      : 'bg-accent text-muted-foreground'
                }`}
              >
                <span className="inline-flex size-5 items-center justify-center rounded-full bg-background/30">
                  {isComplete ? <Check className="size-3" /> : index + 1}
                </span>
                {step.label}
              </span>
              {index < STEPS.length - 1 && (
                <span className="text-muted-foreground/50">/</span>
              )}
            </li>
          );
        })}
      </ol>

      {/* Step content */}
      <div className="min-h-[18rem]">
        {currentStep === 'source' && renderSourceStep()}
        {currentStep === 'candidates' && renderCandidatesStep()}
        {currentStep === 'review' && renderReviewStep()}
        {currentStep === 'configure' && renderConfigureStep()}
        {currentStep === 'register' && renderRegisterStep()}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between border-t border-border pt-4">
        <Button
          variant="outline"
          onClick={handlePrevious}
          disabled={currentIndex === 0 || registering}
          className="cursor-pointer"
        >
          Previous
        </Button>

        {currentStep !== 'register' ? (
          <Button
            onClick={handleNext}
            disabled={!canProceed()}
            className="bg-primary text-primary-foreground hover:bg-primary/90 cursor-pointer"
          >
            Next
          </Button>
        ) : registered ? (
          <Button
            onClick={onComplete}
            className="bg-chart-2 text-foreground hover:bg-chart-2/90 cursor-pointer"
          >
            Done
          </Button>
        ) : conflict ? (
          <Button
            onClick={() => handleRegister(conflictChoice ?? undefined)}
            disabled={registering || !conflictChoice}
            className="bg-primary text-primary-foreground hover:bg-primary/90 cursor-pointer"
          >
            {registering ? 'Resubmitting…' : 'Resubmit import'}
          </Button>
        ) : (
          <Button
            onClick={() => handleRegister()}
            disabled={registering}
            className="bg-primary text-primary-foreground hover:bg-primary/90 cursor-pointer"
          >
            {registering ? 'Registering…' : 'Register agent'}
          </Button>
        )}
      </div>
    </div>
  );
}
