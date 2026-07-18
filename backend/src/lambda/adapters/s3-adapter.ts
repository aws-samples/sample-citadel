import {
  S3Client,
  CreateBucketCommand,
  PutBucketVersioningCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  DeleteBucketCommand,
} from '@aws-sdk/client-s3';
import {
  ConnectorAdapter,
  ConnectorCategory,
  ConnectorSpec,
  AuthenticationMethod,
  RequiredPolicies,
  ProvisionResult,
  ConnectionTestResult,
  MetricsResult,
} from '../../adapters/base';
import {
  ProvisioningError,
  ConnectionError,
  PermissionError,
  ResourceNotFoundError,
} from './errors';
import { SdkError, AwsCredentialFields } from './sdk-types';

export class S3Adapter implements ConnectorAdapter {
  readonly category: ConnectorCategory = 'datastore';
  readonly spec: ConnectorSpec = { type: 'S3', provider: 'Amazon Web Services', category: 'datastore', authentication: { method: AuthenticationMethod.IAM_ROLE, fields: [], secretStructure: {} }, configuration: { required: ['bucketName'], optional: ['versioning'], ssmParameters: [] } };
  private makeClient(creds?: Record<string, unknown>): S3Client {
    const c = creds as AwsCredentialFields | undefined;
    if (c?.accessKeyId && c?.secretAccessKey && c?.sessionToken) {
      return new S3Client({
        credentials: {
          accessKeyId: c.accessKeyId,
          secretAccessKey: c.secretAccessKey,
          sessionToken: c.sessionToken,
        },
      });
    }
    return new S3Client({});
  }

  requiredPolicies(
    config: Record<string, unknown>,
    _accountId: string,
    _region: string
  ): RequiredPolicies {
    const bucketName = config.bucketName as string | undefined;
    const bucketArn = `arn:aws:s3:::${bucketName}`;

    return {
      provision: [
        {
          actions: [
            's3:CreateBucket',
            's3:PutBucketVersioning',
            's3:DeleteBucket',
            's3:DeleteObject',
            's3:ListBucket',
            's3:ListObjectsV2',
          ],
          resources: ['*'],
        },
      ],
      connect: [
        {
          actions: [
            's3:HeadBucket',
            's3:ListBucket',
            's3:ListObjectsV2',
            's3:GetObject',
            's3:PutObject',
          ],
          resources: [bucketArn, `${bucketArn}/*`],
        },
      ],
    };
  }

  async provision(
    config: Record<string, unknown>,
    credentials?: Record<string, unknown>
  ): Promise<ProvisionResult> {
    const client = this.makeClient(credentials);
    const rawBucketName = config.bucketName as string | undefined;

    if (!rawBucketName) {
      throw new ProvisioningError(
        'Missing required config field: bucketName'
      );
    }

    // S3 bucket names must be lowercase, 3-63 chars, no uppercase
    const bucketName = rawBucketName.toLowerCase();
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucketName)) {
      throw new ProvisioningError(
        `Invalid bucket name "${rawBucketName}": must be 3-63 characters, lowercase letters, numbers, hyphens, and periods only`
      );
    }

    try {
      await client.send(new CreateBucketCommand({ Bucket: bucketName }));
    } catch (error) {
      const err = error as SdkError;
      if (err.name === 'BucketAlreadyOwnedByYou') {
        // Idempotent success — bucket already exists and is owned by us
      } else if (
        err.name === 'AccessDenied' ||
        err.name === 'AccessDeniedException'
      ) {
        throw new PermissionError(
          `Permission denied creating bucket ${bucketName}`,
          err
        );
      } else {
        throw new ProvisioningError(
          `Failed to create bucket ${bucketName}: ${err.message}`,
          err
        );
      }
    }

    if (config.versioning) {
      try {
        await client.send(
          new PutBucketVersioningCommand({
            Bucket: bucketName,
            VersioningConfiguration: { Status: 'Enabled' },
          })
        );
      } catch (error) {
        const err = error as SdkError;
        if (
          err.name === 'AccessDenied' ||
          err.name === 'AccessDeniedException'
        ) {
          throw new PermissionError(
            `Permission denied enabling versioning on bucket ${bucketName}`,
            err
          );
        }
        throw new ProvisioningError(
          `Failed to enable versioning on bucket ${bucketName}: ${err.message}`,
          err
        );
      }
    }

    return {
      resourceArn: `arn:aws:s3:::${bucketName}`,
    };
  }

  async connect(
    config: Record<string, unknown>,
    credentials?: Record<string, unknown>
  ): Promise<void> {
    const client = this.makeClient(credentials);
    const bucketName = config.bucketName as string | undefined;

    try {
      await client.send(new HeadBucketCommand({ Bucket: bucketName }));
    } catch (error) {
      const err = error as SdkError;
      if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) {
        throw new ResourceNotFoundError(
          `Bucket ${bucketName} does not exist`,
          err
        );
      }
      if (
        err.name === 'AccessDenied' ||
        err.name === 'AccessDeniedException' ||
        err.$metadata?.httpStatusCode === 403
      ) {
        throw new PermissionError(
          `Permission denied accessing bucket ${bucketName}`,
          err
        );
      }
      throw new ConnectionError(
        `Failed to connect to bucket ${bucketName}: ${err.message}`,
        true,
        err
      );
    }
  }

  async disconnect(_config: Record<string, unknown>): Promise<void> {
    // No-op: disconnecting from S3 doesn't require cleanup
  }

  async deprovision(
    config: Record<string, unknown>,
    credentials?: Record<string, unknown>
  ): Promise<void> {
    const client = this.makeClient(credentials);
    const bucketName = config.bucketName as string | undefined;

    // Empty the bucket first (DeleteBucket requires an empty bucket)
    try {
      let continuationToken: string | undefined;
      do {
        const listResponse = await client.send(
          new ListObjectsV2Command({
            Bucket: bucketName,
            ContinuationToken: continuationToken,
          })
        );

        const objects = listResponse.Contents;
        if (objects && objects.length > 0) {
          await client.send(
            new DeleteObjectsCommand({
              Bucket: bucketName,
              Delete: {
                Objects: objects.map((obj) => ({ Key: obj.Key! })),
                Quiet: true,
              },
            })
          );
        }

        continuationToken = listResponse.IsTruncated
          ? listResponse.NextContinuationToken
          : undefined;
      } while (continuationToken);
    } catch (error) {
      const err = error as SdkError;
      if (err.name === 'NoSuchBucket') {
        return; // Already gone
      }
      throw err;
    }

    // Delete the bucket
    await client.send(new DeleteBucketCommand({ Bucket: bucketName }));
  }

  async testConnection(
    config: Record<string, unknown>,
    credentials?: Record<string, unknown>
  ): Promise<ConnectionTestResult> {
    const client = this.makeClient(credentials);
    const bucketName = config.bucketName as string | undefined;

    try {
      await client.send(new HeadBucketCommand({ Bucket: bucketName }));
      return {
        success: true,
        message: `Successfully connected to bucket ${bucketName}`,
      };
    } catch (error) {
      const err = error as SdkError;
      return {
        success: false,
        message: `Failed to connect to bucket ${bucketName}: ${err.message}`,
        details: { errorName: err.name },
      };
    }
  }

  async getMetrics(
    config: Record<string, unknown>,
    _resourceArn?: string
  ): Promise<MetricsResult> {
    const client = this.makeClient();
    const bucketName = config.bucketName as string | undefined;

    try {
      let objectCount = 0;
      let continuationToken: string | undefined;

      do {
        const response = await client.send(
          new ListObjectsV2Command({
            Bucket: bucketName,
            ContinuationToken: continuationToken,
          })
        );
        objectCount += response.KeyCount ?? 0;
        continuationToken = response.IsTruncated
          ? response.NextContinuationToken
          : undefined;
      } while (continuationToken);

      return {
        size: `${objectCount} objects`,
        records: objectCount,
      };
    } catch (error) {
      const err = error as SdkError;
      if (
        err.name === 'AccessDenied' ||
        err.name === 'AccessDeniedException'
      ) {
        throw new PermissionError(
          `Permission denied listing objects in bucket ${bucketName}`,
          err
        );
      }
      throw new ConnectionError(
        `Failed to get metrics for bucket ${bucketName}: ${err.message}`,
        true,
        err
      );
    }
  }
}
