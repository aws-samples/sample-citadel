/**
 * Shared document-ingestion primitives.
 *
 * Centralizes the Bedrock Knowledge Base ingestion logic that was previously
 * inlined in document-upload-resolver.ts so the resolver, the S3-triggered
 * ingest-start handler, and the scheduled poller all share one implementation.
 *
 * Status model (authoritative for the jobs table + poller):
 *   SUCCESS   = INDEXED | PARTIALLY_INDEXED      -> assessment trigger eligible
 *   FAILED    = FAILED | METADATA_UPDATE_FAILED
 *   TRANSIENT = everything else (STARTING, IN_PROGRESS, PENDING, NOT_FOUND,
 *               IGNORED, ...)
 *
 * Note on IGNORED: Bedrock's IngestKnowledgeBaseDocuments synchronously returns
 * IGNORED ("You submitted multiple requests for the same document") when the
 * customDocumentIdentifier already exists in the KB. That is a DEDUP/NO-OP, not
 * a failure — the document is actually indexed. IGNORED is therefore TRANSIENT;
 * the poller resolves the true status by GetKnowledgeBaseDocuments.
 */

import {
  BedrockAgentClient,
  IngestKnowledgeBaseDocumentsCommand,
  GetKnowledgeBaseDocumentsCommand,
} from '@aws-sdk/client-bedrock-agent';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';

const bedrockAgentClient = new BedrockAgentClient({});
const ssmClient = new SSMClient({});
const eventBridgeClient = new EventBridgeClient({});

/** Bedrock statuses that mean the document is usable for the assessment. */
export const SUCCESS_STATUSES = new Set<string>(['INDEXED', 'PARTIALLY_INDEXED']);

/**
 * Bedrock statuses that are terminal failures.
 *
 * IGNORED is intentionally NOT here: it is a Bedrock dedup/no-op (the document
 * already exists and is indexed), resolved by polling GetKnowledgeBaseDocuments
 * for the true status — so classifyStatus('IGNORED') is TRANSIENT and
 * isTerminal('IGNORED') is false.
 */
export const FAILED_STATUSES = new Set<string>(['FAILED', 'METADATA_UPDATE_FAILED']);

/**
 * Statuses the poller keeps re-polling. The jobs-table GSI is partitioned on
 * `status`, so transient rows are normalized into this bounded set to keep the
 * GSI query surface finite (see normalizeTransientStatus).
 */
export const POLLABLE_STATUSES = ['STARTING', 'IN_PROGRESS', 'PENDING'] as const;

/** Our own terminal markers layered on top of the Bedrock failure set. */
export const TERMINAL_STATUSES = new Set<string>([
  ...SUCCESS_STATUSES,
  ...FAILED_STATUSES,
  'TIMEOUT',
]);

export type IngestionDisposition = 'SUCCESS' | 'FAILED' | 'TRANSIENT';

/**
 * Total mapping from any Bedrock (or internal) status string to a disposition.
 * Defined over every possible string input — unknown/empty inputs map to
 * TRANSIENT so the poller keeps watching rather than silently dropping them.
 */
export function classifyStatus(status: string | undefined | null): IngestionDisposition {
  if (status && SUCCESS_STATUSES.has(status)) return 'SUCCESS';
  if (status && FAILED_STATUSES.has(status)) return 'FAILED';
  return 'TRANSIENT';
}

/** True if the row's status is terminal and should not be re-polled. */
export function isTerminal(status: string | undefined | null): boolean {
  return !!status && TERMINAL_STATUSES.has(status);
}

/**
 * Map an observed transient Bedrock status to one of POLLABLE_STATUSES so the
 * GSI partition stays bounded and the poller can always re-query the row.
 */
export function normalizeTransientStatus(status: string | undefined | null): string {
  if (status && (POLLABLE_STATUSES as readonly string[]).includes(status)) return status;
  return 'IN_PROGRESS';
}

let _kbId: string | undefined;
let _dsId: string | undefined;

/** Resolve (and container-cache) the Knowledge Base + data source ids from SSM. */
export async function getKbIds(): Promise<{ kbId: string; dsId: string }> {
  if (!_kbId || !_dsId) {
    const [kb, ds] = await Promise.all([
      ssmClient.send(new GetParameterCommand({ Name: process.env.KB_ID_PARAM! })),
      ssmClient.send(new GetParameterCommand({ Name: process.env.DS_ID_PARAM! })),
    ]);
    _kbId = kb.Parameter!.Value!;
    _dsId = ds.Parameter!.Value!;
  }
  return { kbId: _kbId, dsId: _dsId };
}

/** Reset the cached KB/DS ids — test seam only. */
export function _resetKbIdCache(): void {
  _kbId = undefined;
  _dsId = undefined;
}

export interface StartIngestionResult {
  documentKey: string;
  status: string;
  statusReason?: string;
}

/**
 * Start Bedrock ingestion of a single S3 document into the custom KB data source.
 * Returns the synchronously-reported status (often STARTING/IN_PROGRESS, but
 * can be FAILED immediately for malformed input).
 */
/**
 * Structural view of a Bedrock ingestion document detail. The runtime
 * response nests status fields differently across SDK versions, so both
 * layouts are modelled; the reader guards each access.
 */
interface IngestionDetailView {
  status?: { status?: string; statusReason?: string; failureReasons?: string[] };
  statusReason?: string;
  failureReasons?: string[];
}

export async function startIngestion(projectId: string, documentKey: string): Promise<StartIngestionResult> {
  const { kbId, dsId } = await getKbIds();
  const bucket = process.env.DOCUMENT_BUCKET!;
  const s3Uri = `s3://${bucket}/${documentKey}`;
  const parts = documentKey.split('/');
  const filename = parts.slice(1).join('/');

  const command = new IngestKnowledgeBaseDocumentsCommand({
    knowledgeBaseId: kbId,
    dataSourceId: dsId,
    documents: [{
      content: {
        dataSourceType: 'CUSTOM',
        custom: {
          customDocumentIdentifier: { id: documentKey },
          sourceType: 'S3_LOCATION',
          s3Location: { uri: s3Uri },
        },
      },
      metadata: {
        type: 'IN_LINE_ATTRIBUTE',
        inlineAttributes: [
          { key: 'session_id', value: { type: 'STRING', stringValue: projectId } },
          { key: 'filename', value: { type: 'STRING', stringValue: filename } },
        ],
      },
    }],
  });

  const response = (await bedrockAgentClient.send(command)) as {
    documentDetails?: IngestionDetailView[];
    ingestedDocuments?: IngestionDetailView[];
  };
  console.log('startIngestion Bedrock response:', JSON.stringify(response));
  const detail = response.documentDetails?.[0] ?? response.ingestedDocuments?.[0];
  const status = (typeof detail?.status === 'string' ? detail?.status : detail?.status?.status) ?? 'UNKNOWN';
  const statusReason = detail?.statusReason ?? detail?.status?.statusReason;
  const failureReasons = detail?.failureReasons ?? detail?.status?.failureReasons;
  if (status === 'FAILED' || statusReason || (failureReasons && failureReasons.length)) {
    console.error('startIngestion document ingestion problem:', { documentKey, status, statusReason, failureReasons });
  }
  return { documentKey, status, statusReason: statusReason ?? (failureReasons?.length ? String(failureReasons[0]) : undefined) };
}

export interface PolledStatus {
  status: string;
  statusReason?: string;
  updatedAt?: string;
}

/**
 * True when a polled result indicates the document is not present in the KB
 * yet: no row returned (undefined), an empty status, or an explicit NOT_FOUND.
 * Used by the poller to detect a stale STARTING job whose Bedrock ingestion was
 * never actually started (the start Lambda died after creating the jobs row).
 */
export function isDocumentAbsent(polled: PolledStatus | undefined): boolean {
  return !polled || !polled.status || polled.status === 'NOT_FOUND';
}

/**
 * Fetch current KB ingestion status for the given document keys.
 * The GetKnowledgeBaseDocuments API caps identifiers per call, so we chunk in
 * groups of <=10. Returns a map keyed by documentKey.
 */
export async function pollStatuses(documentKeys: string[]): Promise<Map<string, PolledStatus>> {
  const statusMap = new Map<string, PolledStatus>();
  if (documentKeys.length === 0) return statusMap;

  const { kbId, dsId } = await getKbIds();
  for (let i = 0; i < documentKeys.length; i += 10) {
    const chunk = documentKeys.slice(i, i + 10);
    const resp = await bedrockAgentClient.send(new GetKnowledgeBaseDocumentsCommand({
      knowledgeBaseId: kbId,
      dataSourceId: dsId,
      documentIdentifiers: chunk.map((id) => ({ dataSourceType: 'CUSTOM', custom: { id } })),
    }));
    for (const detail of resp.documentDetails || []) {
      const id = detail.identifier?.custom?.id;
      if (id) {
        statusMap.set(id, {
          status: detail.status ?? 'UNKNOWN',
          statusReason: detail.statusReason,
          updatedAt: detail.updatedAt?.toISOString(),
        });
      }
    }
  }
  return statusMap;
}

/**
 * Emit the assessment-trigger EventBridge event for a successfully-indexed
 * document. Callers are responsible for the exactly-once guard.
 */
export async function emitAssessmentTrigger(
  projectId: string,
  documentKey: string,
  fileName: string,
  fileSize: number,
  fileType: string,
): Promise<void> {
  const eventBusName = process.env.EVENT_BUS_NAME!;
  const sizeKB = Math.round((fileSize || 0) / 1024);
  await eventBridgeClient.send(new PutEventsCommand({
    Entries: [{
      Source: 'citadel',
      DetailType: 'message.sent_to_agent',
      Detail: JSON.stringify({
        projectId,
        agentId: 'agent_intake_single',
        message: `A document has been uploaded and indexed: ${fileName} (${sizeKB}KB, ${fileType}). Extract information from it.`,
        // Deterministic id derived from the document identity. The poller emits
        // this trigger BEFORE the conditional `triggered=true` claim, so two
        // overlapping runs can emit twice for the same document; a stable
        // messageId lets the consumer (agent-message-handler) dedupe logical
        // duplicates rather than treating each unique EventBridge envelope id
        // as a distinct message.
        messageId: `doc-indexed-${projectId}-${documentKey}`,
        userId: 'system',
        timestamp: new Date().toISOString(),
        metadata: { documentKey, trigger: 'document_indexed' },
      }),
      EventBusName: eventBusName,
    }],
  }));
}

/** Emit a failure event when a document ingestion terminally fails. */
export async function emitIngestionFailed(
  projectId: string,
  documentKey: string,
  fileName: string,
  status: string,
  statusReason?: string,
): Promise<void> {
  const eventBusName = process.env.EVENT_BUS_NAME!;
  await eventBridgeClient.send(new PutEventsCommand({
    Entries: [{
      Source: 'citadel.documents',
      DetailType: 'document.ingestion.failed',
      Detail: JSON.stringify({
        projectId,
        documentKey,
        fileName,
        status,
        statusReason: statusReason ?? null,
        timestamp: new Date().toISOString(),
      }),
      EventBusName: eventBusName,
    }],
  }));
}
