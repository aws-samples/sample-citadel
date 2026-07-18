/**
 * Unit tests for the model-catalog-sync Lambda.
 *
 * Exercises syncModelCatalog() directly against mocked Bedrock + DynamoDB:
 * new-model discovery, operator-status preservation on refresh, deprecation of
 * entries the API no longer returns, inference-profile region mapping, the
 * provider-keyed capability overlay, and the summary event emission.
 *
 * Model ids in the fixtures are generic placeholders (`prov.model-*`); the
 * provider overlay is driven off the separate providerName field.
 */

import { mockClient } from 'aws-sdk-client-mock';
import {
  BedrockClient,
  ListFoundationModelsCommand,
  ListInferenceProfilesCommand,
} from '@aws-sdk/client-bedrock';
import {
  DynamoDBDocumentClient,
  ScanCommand,
  PutCommand,
} from '@aws-sdk/lib-dynamodb';

// Stub only publishEvent; keep createProjectEvent + EventTypes real.
jest.mock('../../utils/events', () => {
  const actual = jest.requireActual('../../utils/events');
  return { ...actual, publishEvent: jest.fn().mockResolvedValue(undefined) };
});

import { publishEvent, EventTypes } from '../../utils/events';

const bedrockMock = mockClient(BedrockClient);
const ddbMock = mockClient(DynamoDBDocumentClient);

// SUT reads MODEL_CATALOG_TABLE at module load — import lazily after env is set.
let syncModelCatalog: typeof import('../model-catalog-sync').syncModelCatalog;

const FOUNDATION_MODELS = [
  // New (not in catalog) + anthropic overlay + region profile target.
  {
    modelId: 'prov.model-a',
    providerName: 'Anthropic',
    outputModalities: ['TEXT'],
    responseStreamingSupported: true,
  },
  // Existing + cohere overlay; has stale metadata to prove a refresh.
  {
    modelId: 'prov.model-b',
    providerName: 'Cohere',
    outputModalities: ['TEXT'],
    responseStreamingSupported: true,
  },
  // New + stability overlay (tools disabled) + image modality.
  {
    modelId: 'prov.model-c',
    providerName: 'Stability',
    outputModalities: ['IMAGE'],
    responseStreamingSupported: false,
  },
];

const INFERENCE_PROFILES = [
  {
    inferenceProfileId: 'us.prov.model-a',
    models: [
      { modelArn: 'arn:aws:bedrock:us-east-1::foundation-model/prov.model-a' },
    ],
  },
];

const EXISTING_ITEMS = [
  {
    modelKey: 'prov-model-b',
    provider: 'cohere',
    baseModelId: 'prov.model-b',
    modality: 'other', // stale — should refresh to 'text'
    status: 'enabled', // operator-owned — must be preserved
    discoveredAt: '2020-01-01T00:00:00.000Z',
    supportsStreaming: false, // stale — should refresh to true
  },
  {
    modelKey: 'prov-model-old',
    provider: 'prov',
    baseModelId: 'prov.model-old',
    modality: 'text',
    status: 'enabled', // present in catalog but absent from API → deprecate
    discoveredAt: '2019-01-01T00:00:00.000Z',
  },
];

beforeAll(async () => {
  process.env.MODEL_CATALOG_TABLE = 'citadel-model-catalog-test';
  ({ syncModelCatalog } = await import('../model-catalog-sync'));
});

beforeEach(() => {
  bedrockMock.reset();
  ddbMock.reset();
  (publishEvent as jest.Mock).mockClear();

  bedrockMock
    .on(ListFoundationModelsCommand)
    .resolves({ modelSummaries: FOUNDATION_MODELS });
  bedrockMock
    .on(ListInferenceProfilesCommand)
    .resolves({ inferenceProfileSummaries: INFERENCE_PROFILES });
  ddbMock.on(ScanCommand).resolves({ Items: EXISTING_ITEMS });
  ddbMock.on(PutCommand).resolves({});
});

function putItems(): Record<string, unknown>[] {
  return ddbMock
    .commandCalls(PutCommand)
    .map((c) => c.args[0].input.Item as Record<string, unknown>);
}

function putFor(modelKey: string): Record<string, unknown> {
  return putItems().find((i) => i.modelKey === modelKey)!;
}

describe('model-catalog-sync', () => {
  test('writes a new model with status "discovered"', async () => {
    await syncModelCatalog();
    const item = putFor('prov-model-a');
    expect(item).toBeDefined();
    expect(item.status).toBe('discovered');
    expect(item.baseModelId).toBe('prov.model-a');
    expect(item.discoveredAt).toEqual(expect.any(String));
  });

  test('preserves operator status "enabled" while refreshing metadata', async () => {
    await syncModelCatalog();
    const item = putFor('prov-model-b');
    expect(item).toBeDefined();
    expect(item.status).toBe('enabled'); // preserved, not overwritten
    expect(item.discoveredAt).toBe('2020-01-01T00:00:00.000Z'); // preserved
    expect(item.modality).toBe('text'); // refreshed from stale 'other'
    expect(item.supportsStreaming).toBe(true); // refreshed from stale false
  });

  test('marks a catalog entry absent from the API as "deprecated"', async () => {
    await syncModelCatalog();
    const item = putFor('prov-model-old');
    expect(item).toBeDefined();
    expect(item.status).toBe('deprecated');
  });

  test('maps an "us.<modelId>" inference profile to regionProfiles.us', async () => {
    await syncModelCatalog();
    const item = putFor('prov-model-a');
    expect(item.regionProfiles).toEqual({ us: 'us.prov.model-a' });
  });

  test('applies the provider overlay: anthropic tools=true, stability tools=false', async () => {
    await syncModelCatalog();
    expect(putFor('prov-model-a').supportsTools).toBe(true);
    expect(putFor('prov-model-c').supportsTools).toBe(false);
    // Non-text modality drives invoke_model rather than converse.
    expect(putFor('prov-model-c').modality).toBe('image');
    expect(putFor('prov-model-c').invocationMode).toBe('invoke_model');
  });

  test('publishes MODEL_CATALOG_SYNCED once with the summary', async () => {
    const result = await syncModelCatalog();
    expect(result).toEqual({
      discovered: 2,
      updated: 1,
      deprecated: 1,
      total: 3,
      syncedAt: expect.any(String),
    });
    expect(publishEvent).toHaveBeenCalledTimes(1);
    const arg = (publishEvent as jest.Mock).mock.calls[0][0];
    expect(arg.eventType).toBe(EventTypes.MODEL_CATALOG_SYNCED);
    expect(arg.payload).toEqual(result);
  });
});
