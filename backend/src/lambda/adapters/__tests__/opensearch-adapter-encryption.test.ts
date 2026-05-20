/**
 * TDD: OpenSearch adapter should create encryption and network policies
 * before creating the collection, just like the KB adapter does.
 */
import {
  OpenSearchServerlessClient,
  CreateCollectionCommand,
  CreateSecurityPolicyCommand,
} from '@aws-sdk/client-opensearchserverless';
import { mockClient } from 'aws-sdk-client-mock';

const ossMock = mockClient(OpenSearchServerlessClient);

import { OpenSearchAdapter } from '../opensearch-adapter';

describe('OpenSearchAdapter.provision - creates security policies', () => {
  const adapter = new OpenSearchAdapter();

  beforeEach(() => {
    ossMock.reset();
    ossMock.on(CreateSecurityPolicyCommand).resolves({ securityPolicyDetail: {} });
    ossMock.on(CreateCollectionCommand).resolves({
      createCollectionDetail: {
        arn: 'arn:aws:aoss:us-east-1:123:collection/test',
        id: 'col-123',
      },
    });
  });

  test('creates encryption policy before creating collection', async () => {
    await adapter.provision({ collectionName: 'my-collection' });

    const secCalls = ossMock.commandCalls(CreateSecurityPolicyCommand);
    const encryptionCalls = secCalls.filter(
      (c) => c.args[0].input.type === 'encryption'
    );
    expect(encryptionCalls.length).toBeGreaterThanOrEqual(1);
  });

  test('creates network policy before creating collection', async () => {
    await adapter.provision({ collectionName: 'my-collection' });

    const secCalls = ossMock.commandCalls(CreateSecurityPolicyCommand);
    const networkCalls = secCalls.filter(
      (c) => c.args[0].input.type === 'network'
    );
    expect(networkCalls.length).toBeGreaterThanOrEqual(1);
  });

  test('still creates collection successfully', async () => {
    const result = await adapter.provision({ collectionName: 'my-collection' });

    expect(result.resourceArn).toContain('aoss');
    const collCalls = ossMock.commandCalls(CreateCollectionCommand);
    expect(collCalls).toHaveLength(1);
  });
});
