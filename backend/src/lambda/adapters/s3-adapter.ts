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

export class S3Adapter implements ConnectorAdapter {
  readonly category: ConnectorCategory = 'datastore';
  readonly spec: ConnectorSpec = { type: 'S3', provider: 'Amazon Web Services', category: 'datastore', authentication: { method: AuthenticationMethod.IAM_ROLE, fields: [], secretStructure: {} }, configuration: { required: ['bucketName'], optional: ['versioning'], ssmParameters: [] } };
  private makeClient(creds?: Record<string, any>): S3Client {
    if (creds?.accessKeyId && creds?.secretAccessKey && creds?.sessionToken) {
      return new S3Client({
        credentials: {
          accessKeyId: creds.accessKeyId,
          secretAccessKey: creds.secretAccessKey,
          sessionToken: creds.sessionToken,
        },
      });
    }
    return new S3Client({});
  }

  requiredPolicies(
    config: Record<string, any>,
    _accountId: string,
    _region: string
  ): RequiredPolicies {
    const bucketName = config.bucketName;
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
    config: Record<string, any>,
    credentials?: Record<string, any>
  ): Promise<ProvisionResult> {
    const client = this.makeClient(credentials);
    const rawBucketName = config.bucketName;

    if (!rawBucketName) {
      throw new ProvisioningError(
        'Missing required config field: bucketName'
      );
    }

    // S3 bucket names must be lowercase, 3-63 chars, no uppercase
    const bucketName = rawBucketName.toLowerCase();
    if (!/^[a-z0-9][a-z0-9.\-]{1,61}[a-z0-9]$/.test(bucketName)) {
      throw new ProvisioningError(
        `Invalid bucket name "${rawBucketName}": must be 3-63 characters, lowercase letters, numbers, hyphens, and periods only`
      );
    }

    try {
      await client.send(new CreateBucketCommand({ Bucket: bucketName }));
    } catch (error: any) {
      if (error.name === 'BucketAlreadyOwnedByYou') {
        // Idempotent success — bucket already exists and is owned by us
      } else if (
        error.name === 'AccessDenied' ||
        error.name === 'AccessDeniedException'
      ) {
        throw new PermissionError(
          `Permission denied creating bucket ${bucketName}`,
          error
        );
      } else {
        throw new ProvisioningError(
          `Failed to create bucket ${bucketName}: ${error.message}`,
          error
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
      } catch (error: any) {
        if (
          error.name === 'AccessDenied' ||
          error.name === 'AccessDeniedException'
        ) {
          throw new PermissionError(
            `Permission denied enabling versioning on bucket ${bucketName}`,
            error
          );
        }
        throw new ProvisioningError(
          `Failed to enable versioning on bucket ${bucketName}: ${error.message}`,
          error
        );
      }
    }

    return {
      resourceArn: `arn:aws:s3:::${bucketName}`,
    };
  }

  async connect(
    config: Record<string, any>,
    credentials?: Record<string, any>
  ): Promise<void> {
    const client = this.makeClient(credentials);
    const bucketName = config.bucketName;

    try {
      await client.send(new HeadBucketCommand({ Bucket: bucketName }));
    } catch (error: any) {
      if (error.name === 'NotFound' || error.$metadata?.httpStatusCode === 404) {
        throw new ResourceNotFoundError(
          `Bucket ${bucketName} does not exist`,
          error
        );
      }
      if (
        error.name === 'AccessDenied' ||
        error.name === 'AccessDeniedException' ||
        error.$metadata?.httpStatusCode === 403
      ) {
        throw new PermissionError(
          `Permission denied accessing bucket ${bucketName}`,
          error
        );
      }
      throw new ConnectionError(
        `Failed to connect to bucket ${bucketName}: ${error.message}`,
        true,
        error
      );
    }
  }

  async disconnect(_config: Record<string, any>): Promise<void> {
    // No-op: disconnecting from S3 doesn't require cleanup
  }

  async deprovision(
    config: Record<string, any>,
    credentials?: Record<string, any>
  ): Promise<void> {
    const client = this.makeClient(credentials);
    const bucketName = config.bucketName;

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
    } catch (error: any) {
      if (error.name === 'NoSuchBucket') {
        return; // Already gone
      }
      throw error;
    }

    // Delete the bucket
    await client.send(new DeleteBucketCommand({ Bucket: bucketName }));
  }

  async testConnection(
    config: Record<string, any>,
    credentials?: Record<string, any>
  ): Promise<ConnectionTestResult> {
    const client = this.makeClient(credentials);
    const bucketName = config.bucketName;

    try {
      await client.send(new HeadBucketCommand({ Bucket: bucketName }));
      return {
        success: true,
        message: `Successfully connected to bucket ${bucketName}`,
      };
    } catch (error: any) {
      return {
        success: false,
        message: `Failed to connect to bucket ${bucketName}: ${error.message}`,
        details: { errorName: error.name },
      };
    }
  }

  async getMetrics(
    config: Record<string, any>,
    _resourceArn?: string
  ): Promise<MetricsResult> {
    const client = this.makeClient();
    const bucketName = config.bucketName;

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
    } catch (error: any) {
      if (
        error.name === 'AccessDenied' ||
        error.name === 'AccessDeniedException'
      ) {
        throw new PermissionError(
          `Permission denied listing objects in bucket ${bucketName}`,
          error
        );
      }
      throw new ConnectionError(
        `Failed to get metrics for bucket ${bucketName}: ${error.message}`,
        true,
        error
      );
    }
  }
}
