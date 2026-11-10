import {
  S3Client,
  CreateBucketCommand,
  PutBucketVersioningCommand,
  PutBucketTaggingCommand,
  GetBucketTaggingCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  DeleteBucketCommand,
} from "@aws-sdk/client-s3";
import {
  ConnectorAdapter,
  ConnectorCategory,
  ConnectorSpec,
  AuthenticationMethod,
  RequiredPolicies,
  ProvisionResult,
  ConnectionTestResult,
  MetricsResult,
} from "../../adapters/base";
import {
  ProvisioningError,
  ConnectionError,
  PermissionError,
  ResourceNotFoundError,
  ValidationError,
} from "./errors";
import { SdkError } from "./sdk-types";
import { requireScopedCredentials } from "./credential-guard";

/**
 * Citadel-managed S3 buckets must start with this prefix.
 * Enforced only on new provisions (CREATE_NEW); existing buckets connected
 * via CONNECT_EXISTING are exempt.
 */
const CITADEL_BUCKET_PREFIX = "citadel-";

/**
 * S3 DNS-safe bucket name pattern.
 * 3-63 chars, lowercase letters, numbers, hyphens, and periods only.
 */
const BUCKET_NAME_PATTERN = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

export class S3Adapter implements ConnectorAdapter {
  readonly category: ConnectorCategory = "datastore";
  readonly spec: ConnectorSpec = {
    type: "S3",
    provider: "Amazon Web Services",
    category: "datastore",
    authentication: {
      method: AuthenticationMethod.IAM_ROLE,
      fields: [],
      secretStructure: {},
    },
    configuration: {
      required: ["bucketName"],
      optional: ["versioning"],
      ssmParameters: [],
    },
  };
  private makeClient(
    creds: Record<string, unknown> | undefined,
    op: string,
  ): S3Client {
    const credentials = requireScopedCredentials(creds, {
      adapter: "S3Adapter",
      op,
    });
    return new S3Client({ credentials });
  }

  /**
   * CIT-298: Platform-role S3 client for preflight ownership checks.
   * Uses the Lambda execution role's ambient credentials intentionally —
   * preflight runs BEFORE any scoped role is vended, to prove bucket
   * ownership. Scoped to s3:GetBucketTagging + s3:HeadBucket on
   * citadel-* buckets via the CDK grant in backend-stack.ts.
   */
  private platformS3Client(): S3Client {
    return new S3Client({});
  }

  requiredPolicies(
    config: Record<string, unknown>,
    _accountId: string,
    _region: string,
  ): RequiredPolicies {
    const bucketName = config.bucketName as string | undefined;
    const bucketArn = `arn:aws:s3:::${bucketName}`;

    return {
      provision: [
        {
          // CreateBucket requires '*' — the bucket doesn't exist yet
          actions: ["s3:CreateBucket"],
          resources: [`arn:aws:s3:::${CITADEL_BUCKET_PREFIX}*`],
        },
        {
          // All other bucket-level actions scoped to the specific bucket
          actions: [
            "s3:PutBucketVersioning",
            "s3:DeleteBucket",
            "s3:ListBucket",
            "s3:ListObjectsV2",
            "s3:GetBucketTagging",
            "s3:PutBucketTagging",
          ],
          resources: [bucketArn],
        },
        {
          // Object-level actions scoped to objects within the bucket only
          actions: ["s3:DeleteObject"],
          resources: [`${bucketArn}/*`],
        },
      ],
      connect: [
        {
          actions: [
            "s3:HeadBucket",
            "s3:ListBucket",
            "s3:ListObjectsV2",
            "s3:GetObject",
            "s3:PutObject",
            "s3:GetBucketTagging",
          ],
          resources: [bucketArn, `${bucketArn}/*`],
        },
      ],
    };
  }

  async provision(
    config: Record<string, unknown>,
    credentials?: Record<string, unknown>,
  ): Promise<ProvisionResult> {
    const client = this.makeClient(credentials, "provision");
    const rawBucketName = config.bucketName as string | undefined;

    if (!rawBucketName) {
      throw new ProvisioningError("Missing required config field: bucketName");
    }

    // S3 bucket names must be lowercase, 3-63 chars, no uppercase
    const bucketName = rawBucketName.toLowerCase();

    // Citadel-managed buckets must use the platform prefix
    if (!bucketName.startsWith(CITADEL_BUCKET_PREFIX)) {
      throw new ValidationError(
        `Bucket name "${rawBucketName}" must start with "${CITADEL_BUCKET_PREFIX}". ` +
          `To connect an existing bucket without the prefix, use the connect operation instead.`,
      );
    }

    if (!BUCKET_NAME_PATTERN.test(bucketName)) {
      throw new ProvisioningError(
        `Invalid bucket name "${rawBucketName}": must be 3-63 characters, lowercase letters, numbers, hyphens, and periods only`,
      );
    }

    const dataStoreId = config.dataStoreId as string | undefined;
    const orgId = config.orgId as string | undefined;

    try {
      await client.send(new CreateBucketCommand({ Bucket: bucketName }));

      // Tag the new bucket with Citadel ownership metadata
      if (dataStoreId && orgId) {
        await client.send(
          new PutBucketTaggingCommand({
            Bucket: bucketName,
            Tagging: {
              TagSet: [
                { Key: "ManagedBy", Value: "citadel" },
                { Key: "citadel:dataStoreId", Value: dataStoreId },
                { Key: "citadel:orgId", Value: orgId },
              ],
            },
          }),
        );
      }
    } catch (error) {
      const err = error as SdkError;
      if (
        err.name === "BucketAlreadyOwnedByYou" ||
        err.name === "BucketAlreadyExists"
      ) {
        // Bucket exists — verify Citadel ownership before adopting
        await this.verifyBucketOwnership(
          client,
          bucketName,
          dataStoreId,
          orgId,
        );
      } else if (
        err.name === "AccessDenied" ||
        err.name === "AccessDeniedException"
      ) {
        throw new PermissionError(
          `Permission denied creating bucket ${bucketName}`,
          err,
        );
      } else {
        throw new ProvisioningError(
          `Failed to create bucket ${bucketName}: ${err.message}`,
          err,
        );
      }
    }

    if (config.versioning) {
      try {
        await client.send(
          new PutBucketVersioningCommand({
            Bucket: bucketName,
            VersioningConfiguration: { Status: "Enabled" },
          }),
        );
      } catch (error) {
        const err = error as SdkError;
        if (
          err.name === "AccessDenied" ||
          err.name === "AccessDeniedException"
        ) {
          throw new PermissionError(
            `Permission denied enabling versioning on bucket ${bucketName}`,
            err,
          );
        }
        throw new ProvisioningError(
          `Failed to enable versioning on bucket ${bucketName}: ${err.message}`,
          err,
        );
      }
    }

    return {
      resourceArn: `arn:aws:s3:::${bucketName}`,
    };
  }

  /**
   * Verifies that an existing bucket was created by Citadel for the given
   * datastore and org. Reads bucket tags via the scoped credential; if the
   * tags don't match, the bucket is not adopted and an opaque
   * ProvisioningError is thrown. Emits a `Citadel/Adapters BucketOwnershipRefused`
   * metric on failure (CIT-298).
   */
  private async verifyBucketOwnership(
    client: S3Client,
    bucketName: string,
    dataStoreId: string | undefined,
    orgId: string | undefined,
  ): Promise<void> {
    if (!dataStoreId || !orgId) {
      this.emitBucketOwnershipRefused();
      throw new ProvisioningError("Bucket ownership verification failed");
    }
    try {
      const tagging = await client.send(
        new GetBucketTaggingCommand({ Bucket: bucketName }),
      );
      const tags = tagging.TagSet || [];
      const hasCitadelDs = tags.some(
        (t) => t.Key === "citadel:dataStoreId" && t.Value === dataStoreId,
      );
      const hasCitadelOrg = tags.some(
        (t) => t.Key === "citadel:orgId" && t.Value === orgId,
      );
      if (!hasCitadelDs || !hasCitadelOrg) {
        console.warn("Bucket ownership tag mismatch", {
          bucketName,
          expectedDataStoreId: dataStoreId,
          expectedOrgId: orgId,
        });
        this.emitBucketOwnershipRefused();
        throw new ProvisioningError("Bucket ownership verification failed");
      }
    } catch (error) {
      if (error instanceof ProvisioningError) throw error;
      const err = error as SdkError;
      if (err.name === "NoSuchTagSet") {
        this.emitBucketOwnershipRefused();
        throw new ProvisioningError("Bucket ownership verification failed");
      }
      this.emitBucketOwnershipRefused();
      throw new ProvisioningError("Bucket ownership verification failed", err);
    }
  }

  /** Emit a CloudWatch EMF metric for a refused bucket ownership check. */
  private emitBucketOwnershipRefused(): void {
    try {
      console.log(
        JSON.stringify({
          _aws: {
            Timestamp: Date.now(),
            CloudWatchMetrics: [
              {
                Namespace: "Citadel/Adapters",
                Dimensions: [["Adapter"]],
                Metrics: [{ Name: "BucketOwnershipRefused", Unit: "Count" }],
              },
            ],
          },
          Adapter: "S3",
          BucketOwnershipRefused: 1,
        }),
      );
    } catch {
      // metrics must never break the caller
    }
  }

  /**
   * CIT-298: preflight ownership check using the PLATFORM Lambda credentials
   * (not scoped creds). Called BEFORE ensureRole so no IAM role is created
   * unless ownership is proven.
   *
   * For CONNECT_EXISTING: bucket must exist and carry
   *   citadel:dataStoreId == ctx.dataStoreId AND citadel:orgId == ctx.orgId.
   * For CREATE_NEW: bucket must NOT exist, OR must be tagged for this
   *   datastore (idempotent re-provision).
   */
  async preflight(
    config: Record<string, unknown>,
    ctx: { dataStoreId: string; orgId: string; provisionMode?: string },
  ): Promise<void> {
    const bucketName = config.bucketName as string | undefined;
    if (!bucketName) return; // validated later

    // Platform client — NO scoped credentials, uses the Lambda execution role
    const client = this.platformS3Client();

    if (ctx.provisionMode === "CREATE_NEW") {
      // For new provisions, the bucket should not exist yet.
      // If it does (idempotent retry), verify tags.
      try {
        await client.send(new HeadBucketCommand({ Bucket: bucketName }));
        // Bucket exists — must be tagged for THIS datastore + org
        await this.verifyBucketOwnership(
          client,
          bucketName,
          ctx.dataStoreId,
          ctx.orgId,
        );
      } catch (error) {
        if (error instanceof ProvisioningError) throw error;
        const err = error as SdkError;
        // 404/NotFound = bucket doesn't exist yet — that's expected for CREATE_NEW
        if (err.name === "NotFound" || err.$metadata?.httpStatusCode === 404) {
          return;
        }
        // 403 = bucket exists in another account — refuse
        if (
          err.name === "AccessDenied" ||
          err.name === "AccessDeniedException" ||
          err.$metadata?.httpStatusCode === 403
        ) {
          this.emitBucketOwnershipRefused();
          throw new ProvisioningError("Bucket ownership verification failed");
        }
        // Any other error — fail closed
        this.emitBucketOwnershipRefused();
        throw new ProvisioningError("Bucket ownership verification failed");
      }
    } else {
      // CONNECT_EXISTING: bucket must exist and be tagged for this datastore
      await this.verifyBucketOwnership(
        client,
        bucketName,
        ctx.dataStoreId,
        ctx.orgId,
      );
    }
  }

  async connect(
    config: Record<string, unknown>,
    credentials?: Record<string, unknown>,
  ): Promise<void> {
    const client = this.makeClient(credentials, "connect");
    const bucketName = config.bucketName as string | undefined;

    // CIT-298: prove bucket ownership BEFORE any role grant / policy computation.
    // The bucket must be tagged with the caller's dataStoreId + orgId.
    const dataStoreId = config.dataStoreId as string | undefined;
    const orgId = config.orgId as string | undefined;
    if (dataStoreId && orgId) {
      await this.verifyBucketOwnership(
        client,
        bucketName as string,
        dataStoreId,
        orgId,
      );
    }

    try {
      await client.send(new HeadBucketCommand({ Bucket: bucketName }));
    } catch (error) {
      const err = error as SdkError;
      if (err.name === "NotFound" || err.$metadata?.httpStatusCode === 404) {
        throw new ResourceNotFoundError(
          `Bucket ${bucketName} does not exist`,
          err,
        );
      }
      if (
        err.name === "AccessDenied" ||
        err.name === "AccessDeniedException" ||
        err.$metadata?.httpStatusCode === 403
      ) {
        throw new PermissionError(
          `Permission denied accessing bucket ${bucketName}`,
          err,
        );
      }
      throw new ConnectionError(
        `Failed to connect to bucket ${bucketName}: ${err.message}`,
        true,
        err,
      );
    }
  }

  async disconnect(
    _config: Record<string, unknown>,
    _credentials?: Record<string, unknown>,
  ): Promise<void> {
    // No-op: disconnecting from S3 doesn't require cleanup
  }

  async deprovision(
    config: Record<string, unknown>,
    credentials?: Record<string, unknown>,
  ): Promise<void> {
    const client = this.makeClient(credentials, "deprovision");
    const bucketName = config.bucketName as string | undefined;

    // Empty the bucket first (DeleteBucket requires an empty bucket)
    try {
      let continuationToken: string | undefined;
      do {
        const listResponse = await client.send(
          new ListObjectsV2Command({
            Bucket: bucketName,
            ContinuationToken: continuationToken,
          }),
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
            }),
          );
        }

        continuationToken = listResponse.IsTruncated
          ? listResponse.NextContinuationToken
          : undefined;
      } while (continuationToken);
    } catch (error) {
      const err = error as SdkError;
      if (err.name === "NoSuchBucket") {
        return; // Already gone
      }
      throw err;
    }

    // Delete the bucket
    await client.send(new DeleteBucketCommand({ Bucket: bucketName }));
  }

  async testConnection(
    config: Record<string, unknown>,
    credentials?: Record<string, unknown>,
  ): Promise<ConnectionTestResult> {
    const client = this.makeClient(credentials, "testConnection");
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
    _resourceArn?: string,
    credentials?: Record<string, unknown>,
  ): Promise<MetricsResult> {
    const client = this.makeClient(credentials, "getMetrics");
    const bucketName = config.bucketName as string | undefined;

    try {
      let objectCount = 0;
      let continuationToken: string | undefined;

      do {
        const response = await client.send(
          new ListObjectsV2Command({
            Bucket: bucketName,
            ContinuationToken: continuationToken,
          }),
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
      if (err.name === "AccessDenied" || err.name === "AccessDeniedException") {
        throw new PermissionError(
          `Permission denied listing objects in bucket ${bucketName}`,
          err,
        );
      }
      throw new ConnectionError(
        `Failed to get metrics for bucket ${bucketName}: ${err.message}`,
        true,
        err,
      );
    }
  }
}
