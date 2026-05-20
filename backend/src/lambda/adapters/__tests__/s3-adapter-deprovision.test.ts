/**
 * TDD Tests for S3Adapter.deprovision
 *
 * When a data store is deleted and was provisioned (CREATE_NEW mode),
 * the underlying S3 bucket should be emptied and deleted.
 */
import { S3Client, DeleteBucketCommand, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';

const s3Mock = mockClient(S3Client);

import { S3Adapter } from '../s3-adapter';

describe('S3Adapter.deprovision', () => {
  const adapter = new S3Adapter();

  beforeEach(() => {
    s3Mock.reset();
  });

  test('deprovision method exists', () => {
    expect(adapter.deprovision).toBeDefined();
    expect(typeof adapter.deprovision).toBe('function');
  });

  test('empties bucket then deletes it', async () => {
    // Mock empty bucket
    s3Mock.on(ListObjectsV2Command).resolves({ Contents: [], IsTruncated: false });
    s3Mock.on(DeleteBucketCommand).resolves({});

    await adapter.deprovision!({ bucketName: 'test-bucket' });

    const deleteBucketCalls = s3Mock.commandCalls(DeleteBucketCommand);
    expect(deleteBucketCalls).toHaveLength(1);
    expect(deleteBucketCalls[0].args[0].input.Bucket).toBe('test-bucket');
  });

  test('deletes objects before deleting bucket', async () => {
    s3Mock.on(ListObjectsV2Command).resolvesOnce({
      Contents: [{ Key: 'file1.txt' }, { Key: 'file2.txt' }],
      IsTruncated: false,
    });
    s3Mock.on(DeleteObjectsCommand).resolves({});
    s3Mock.on(DeleteBucketCommand).resolves({});

    await adapter.deprovision!({ bucketName: 'test-bucket' });

    const deleteObjectsCalls = s3Mock.commandCalls(DeleteObjectsCommand);
    expect(deleteObjectsCalls).toHaveLength(1);
    expect(deleteObjectsCalls[0].args[0].input.Delete!.Objects).toHaveLength(2);

    expect(s3Mock.commandCalls(DeleteBucketCommand)).toHaveLength(1);
  });

  test('handles paginated object listing', async () => {
    s3Mock.on(ListObjectsV2Command)
      .resolvesOnce({
        Contents: [{ Key: 'a.txt' }],
        IsTruncated: true,
        NextContinuationToken: 'token1',
      })
      .resolvesOnce({
        Contents: [{ Key: 'b.txt' }],
        IsTruncated: false,
      });
    s3Mock.on(DeleteObjectsCommand).resolves({});
    s3Mock.on(DeleteBucketCommand).resolves({});

    await adapter.deprovision!({ bucketName: 'test-bucket' });

    const deleteObjectsCalls = s3Mock.commandCalls(DeleteObjectsCommand);
    expect(deleteObjectsCalls).toHaveLength(2);
  });

  test('succeeds gracefully if bucket already deleted', async () => {
    const noSuchBucket = new Error('NoSuchBucket');
    noSuchBucket.name = 'NoSuchBucket';
    s3Mock.on(ListObjectsV2Command).rejects(noSuchBucket);

    await expect(adapter.deprovision!({ bucketName: 'gone-bucket' })).resolves.toBeUndefined();
  });
});
