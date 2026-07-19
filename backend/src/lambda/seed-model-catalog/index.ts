/**
 * Seed Model Catalog — CloudFormation Custom Resource Lambda
 *
 * Loads the initial baseline model-selection rows on deployment:
 *   - one catalog entry (the default invokable model), and
 *   - one platform-scoped config entry (the resolved defaults).
 *
 * These are BASELINE values only. Both writes use a ConditionExpression so a
 * re-deploy never clobbers changes operators have made in DynamoDB afterwards.
 * This file is the single sanctioned place a concrete model id appears.
 *
 * Follows the existing seed-blueprints Custom Resource pattern.
 */

import * as https from 'https';
import * as url from 'url';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import type {
  CloudFormationCustomResourceEvent,
  CloudFormationCustomResourceHandler,
  Context,
} from 'aws-lambda';

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const MODEL_CATALOG_TABLE = process.env.MODEL_CATALOG_TABLE!;
const MODEL_CONFIG_TABLE = process.env.MODEL_CONFIG_TABLE!;

/** Baseline catalog entry — the default invokable model. Operators may edit later. */
export const SEED_MODEL_CATALOG_ITEM = {
  modelKey: 'anthropic-claude-sonnet-5',
  provider: 'anthropic',
  baseModelId: 'anthropic.claude-sonnet-5',
  status: 'enabled',
  modality: 'text',
  invocationMode: 'converse',
  supportsTools: true,
  supportsSystemPrompt: true,
  supportsStreaming: true,
  regionProfiles: {
    us: 'us.anthropic.claude-sonnet-5',
    global: 'global.anthropic.claude-sonnet-5',
  },
};

/** Baseline platform config entry — resolved defaults. Operators may edit later. */
export const SEED_MODEL_CONFIG_ITEM = {
  scope: 'platform',
  globalDefaultKey: 'anthropic-claude-sonnet-5',
  slotDefaults: {},
  orgDefaults: {},
  agentOverrides: {},
  localityMode: 'off',
};

/**
 * Seed the baseline catalog + config rows. Exported so it can be unit-tested
 * without CloudFormation plumbing. Each Put is conditional on the partition key
 * not already existing; a ConditionalCheckFailedException is swallowed so
 * re-runs never overwrite operator changes.
 */
export async function seedModelCatalog(
  doc: DynamoDBDocumentClient,
  catalogTable: string,
  configTable: string,
): Promise<void> {
  try {
    await doc.send(
      new PutCommand({
        TableName: catalogTable,
        Item: SEED_MODEL_CATALOG_ITEM,
        ConditionExpression: 'attribute_not_exists(modelKey)',
      }),
    );
    console.log(`✓ Seeded model catalog entry: ${SEED_MODEL_CATALOG_ITEM.modelKey}`);
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'ConditionalCheckFailedException') {
      console.log(
        `⊘ Model catalog entry already exists, skipping: ${SEED_MODEL_CATALOG_ITEM.modelKey}`,
      );
    } else {
      throw err;
    }
  }

  try {
    await doc.send(
      new PutCommand({
        TableName: configTable,
        Item: SEED_MODEL_CONFIG_ITEM,
        // `scope` is a DynamoDB reserved word — escape it via an alias.
        ConditionExpression: 'attribute_not_exists(#scope)',
        ExpressionAttributeNames: { '#scope': 'scope' },
      }),
    );
    console.log(`✓ Seeded model config entry: ${SEED_MODEL_CONFIG_ITEM.scope}`);
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'ConditionalCheckFailedException') {
      console.log(
        `⊘ Model config entry already exists, skipping: ${SEED_MODEL_CONFIG_ITEM.scope}`,
      );
    } else {
      throw err;
    }
  }
}

/** Send CloudFormation Custom Resource response. */
async function sendCfnResponse(
  event: CloudFormationCustomResourceEvent,
  context: Context,
  status: 'SUCCESS' | 'FAILED',
  data: Record<string, unknown>,
): Promise<void> {
  const responseBody = JSON.stringify({
    Status: status,
    Reason: `See CloudWatch Log Stream: ${context.logStreamName}`,
    PhysicalResourceId: context.logStreamName,
    StackId: event.StackId,
    RequestId: event.RequestId,
    LogicalResourceId: event.LogicalResourceId,
    Data: data,
  });

  const parsedUrl = url.parse(event.ResponseURL);

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: parsedUrl.hostname,
        port: 443,
        path: parsedUrl.path,
        method: 'PUT',
        headers: {
          'Content-Type': '',
          'Content-Length': responseBody.length,
        },
      },
      () => resolve(),
    );
    req.on('error', reject);
    req.write(responseBody);
    req.end();
  });
}

export const handler: CloudFormationCustomResourceHandler = async (event, context) => {
  console.log('Event:', JSON.stringify(event));

  if (event.RequestType === 'Delete') {
    await sendCfnResponse(event, context, 'SUCCESS', { Message: 'Nothing to clean up' });
    return;
  }

  try {
    await seedModelCatalog(docClient, MODEL_CATALOG_TABLE, MODEL_CONFIG_TABLE);

    await sendCfnResponse(event, context, 'SUCCESS', {
      Message: 'Model catalog seeded successfully',
    });
  } catch (err: unknown) {
    console.error('Error seeding model catalog:', err);
    await sendCfnResponse(event, context, 'FAILED', { Message: err instanceof Error ? err.message : String(err) });
    throw err;
  }
};
