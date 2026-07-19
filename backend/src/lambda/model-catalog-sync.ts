/**
 * Model Catalog Sync — EventBridge-scheduled discovery Lambda.
 *
 * Keeps the model-catalog table current with what Bedrock actually exposes in
 * this account/region. Runs daily: it discovers new invokable foundation
 * models, refreshes API-derived metadata on known ones (preserving the
 * operator-owned `status`), and marks entries Bedrock no longer returns as
 * `deprecated`.
 *
 * This handler is entirely DATA-DRIVEN from the Bedrock API — it contains no
 * model-id or model-family literals. Capabilities the API does not expose
 * (tool use, system-prompt, Converse support) are layered on via a small
 * overlay keyed by PROVIDER NAME only, with a conservative default fallback.
 */

import {
  BedrockClient,
  ListFoundationModelsCommand,
  ListInferenceProfilesCommand,
} from '@aws-sdk/client-bedrock';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  ScanCommand,
  PutCommand,
} from '@aws-sdk/lib-dynamodb';
import { publishEvent, createProjectEvent, EventTypes } from '../utils/events';

const bedrock = new BedrockClient({});
const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const CATALOG_TABLE = process.env.MODEL_CATALOG_TABLE!;

interface ProviderCaps {
  supportsTools: boolean;
  supportsSystemPrompt: boolean;
  supportsConverse: boolean;
}

/**
 * Capability overlay keyed by lowercase provider name. The Bedrock
 * ListFoundationModels API does not report tool/system-prompt/Converse
 * support, so we layer known provider-family behaviour on top of the
 * API-derived fields. Keyed by PROVIDER only — never by model id/family.
 */
const PROVIDER_CAPABILITIES: Record<string, ProviderCaps> = {
  anthropic: { supportsTools: true, supportsSystemPrompt: true, supportsConverse: true },
  mistral: { supportsTools: true, supportsSystemPrompt: true, supportsConverse: true },
  meta: { supportsTools: true, supportsSystemPrompt: true, supportsConverse: true },
  amazon: { supportsTools: true, supportsSystemPrompt: true, supportsConverse: true },
  cohere: { supportsTools: true, supportsSystemPrompt: true, supportsConverse: true },
  ai21: { supportsTools: true, supportsSystemPrompt: true, supportsConverse: true },
  openai: { supportsTools: true, supportsSystemPrompt: true, supportsConverse: true },
  deepseek: { supportsTools: false, supportsSystemPrompt: true, supportsConverse: true },
  stability: { supportsTools: false, supportsSystemPrompt: false, supportsConverse: false },
};

/** Conservative fallback for providers not in the overlay. */
const DEFAULT_CAPS: ProviderCaps = {
  supportsTools: false,
  supportsSystemPrompt: true,
  supportsConverse: true,
};

/** Derive a stable, slug-like partition key from a raw Bedrock model id. */
function modelKeyFromId(id: string): string {
  return id
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Collapse Bedrock output modalities into a single coarse modality bucket. */
function modalityFrom(outputModalities?: string[]): string {
  const mods = outputModalities || [];
  if (mods.includes('TEXT')) return 'text';
  if (mods.includes('EMBEDDING')) return 'embedding';
  if (mods.includes('IMAGE')) return 'image';
  return 'other';
}

/**
 * Reconcile the model-catalog table against the live Bedrock inventory.
 * Exported so it can be unit-tested without the scheduled-handler wrapper.
 */
export async function syncModelCatalog(): Promise<{
  discovered: number;
  updated: number;
  deprecated: number;
  total: number;
  syncedAt: string;
}> {
  const now = new Date().toISOString();

  // 1. Foundation models — a single, non-paginated list call.
  const fmResp = await bedrock.send(new ListFoundationModelsCommand({}));
  const modelSummaries = fmResp.modelSummaries || [];

  // 2. Inference profiles — paginated by nextToken.
  // Structural view of the Bedrock summary shapes — only the fields this
  // mapper reads, so we stay decoupled from SDK internals.
  const inferenceProfileSummaries: Array<{
    inferenceProfileId?: string;
    models?: Array<{ modelArn?: string }>;
  }> = [];
  let nextToken: string | undefined;
  do {
    const ipResp = await bedrock.send(
      new ListInferenceProfilesCommand({ nextToken }),
    );
    for (const profile of ipResp.inferenceProfileSummaries || []) {
      inferenceProfileSummaries.push(profile);
    }
    nextToken = ipResp.nextToken;
  } while (nextToken);

  // 3. Map baseModelId -> { regionPrefix -> inferenceProfileId }.
  const regionProfileMap: Record<string, Record<string, string>> = {};
  for (const profile of inferenceProfileSummaries) {
    const profileId: string = profile.inferenceProfileId || '';
    if (!profileId) continue;
    const prefix = profileId.split('.')[0];
    for (const model of profile.models || []) {
      const modelArn: string = model.modelArn || '';
      const baseModelId = modelArn.split('foundation-model/')[1];
      if (!baseModelId) continue;
      if (!regionProfileMap[baseModelId]) regionProfileMap[baseModelId] = {};
      regionProfileMap[baseModelId][prefix] = profileId;
    }
  }

  // 4. Existing catalog rows, keyed by modelKey (scan is paginated).
  // DynamoDB rows are schemaless here; model them as unknown-valued records
  // plus the two operator-owned fields the overlay merge preserves.
  const existingByKey: Record<
    string,
    { status?: string; discoveredAt?: string; [key: string]: unknown }
  > = {};
  let scanStartKey: Record<string, unknown> | undefined;
  do {
    const scanResp = await docClient.send(
      new ScanCommand({
        TableName: CATALOG_TABLE,
        ExclusiveStartKey: scanStartKey,
      }),
    );
    for (const item of scanResp.Items || []) {
      if (item.modelKey) existingByKey[item.modelKey] = item;
    }
    scanStartKey = scanResp.LastEvaluatedKey;
  } while (scanStartKey);

  // 5. Upsert each live foundation model.
  const seenKeys = new Set<string>();
  let discovered = 0;
  let updated = 0;
  let deprecated = 0;

  for (const summary of modelSummaries) {
    const modelId = summary.modelId || '';
    if (!modelId) continue;

    const key = modelKeyFromId(modelId);
    seenKeys.add(key);

    const provider = (summary.providerName || '').toLowerCase();
    const caps = PROVIDER_CAPABILITIES[provider] || DEFAULT_CAPS;
    const modality = modalityFrom(summary.outputModalities);
    const regionProfiles = regionProfileMap[modelId] || {};

    const apiDerived = {
      modelKey: key,
      provider,
      baseModelId: modelId,
      modality,
      invocationMode: modality === 'text' ? 'converse' : 'invoke_model',
      supportsTools: caps.supportsTools,
      supportsSystemPrompt: caps.supportsSystemPrompt,
      supportsStreaming: !!summary.responseStreamingSupported,
      regionProfiles,
    };

    const existing = existingByKey[key];
    if (!existing) {
      await docClient.send(
        new PutCommand({
          TableName: CATALOG_TABLE,
          Item: { ...apiDerived, status: 'discovered', discoveredAt: now },
        }),
      );
      discovered++;
    } else {
      // Refresh API-derived metadata but PRESERVE the operator-owned status.
      await docClient.send(
        new PutCommand({
          TableName: CATALOG_TABLE,
          Item: {
            ...existing,
            ...apiDerived,
            status: existing.status,
            discoveredAt: existing.discoveredAt || now,
          },
        }),
      );
      updated++;
    }
  }

  // 6. Deprecate catalog entries Bedrock no longer returns.
  for (const [key, entry] of Object.entries(existingByKey)) {
    if (!seenKeys.has(key) && entry.status !== 'deprecated') {
      await docClient.send(
        new PutCommand({
          TableName: CATALOG_TABLE,
          Item: { ...entry, status: 'deprecated' },
        }),
      );
      deprecated++;
    }
  }

  // 7. Emit a summary event and return it.
  const summary = {
    discovered,
    updated,
    deprecated,
    total: modelSummaries.length,
    syncedAt: now,
  };
  await publishEvent(
    createProjectEvent(EventTypes.MODEL_CATALOG_SYNCED, 'catalog', summary),
  );
  return summary;
}

/**
 * EventBridge-scheduled entry point. Takes no event args; lets the Lambda
 * retry policy handle transient failures by re-throwing.
 */
export const handler = async (): Promise<{
  statusCode: number;
  body: string;
}> => {
  try {
    const summary = await syncModelCatalog();
    console.log('[model-catalog-sync] summary:', JSON.stringify(summary));
    return { statusCode: 200, body: JSON.stringify(summary) };
  } catch (err) {
    console.error('model-catalog-sync failed', err);
    throw err;
  }
};
