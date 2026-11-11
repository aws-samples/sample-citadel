import { S3Adapter } from "../s3-adapter";
import {
  ProvisioningError,
  ConnectionError,
  PermissionError,
  ResourceNotFoundError,
  ValidationError,
  DataStoreError,
} from "../errors";
import { S3Client } from "@aws-sdk/client-s3";
import { MOCK_SCOPED_CREDENTIALS } from "./helpers/mock-credentials";

// Mock the entire @aws-sdk/client-s3 module
const mockSend = jest.fn();
jest.mock("@aws-sdk/client-s3", () => {
  return {
    S3Client: jest.fn().mockImplementation(() => ({ send: mockSend })),
    CreateBucketCommand: jest
      .fn()
      .mockImplementation((input) => ({ _type: "CreateBucket", input })),
    PutBucketVersioningCommand: jest
      .fn()
      .mockImplementation((input) => ({ _type: "PutBucketVersioning", input })),
    PutBucketTaggingCommand: jest
      .fn()
      .mockImplementation((input) => ({ _type: "PutBucketTagging", input })),
    GetBucketTaggingCommand: jest
      .fn()
      .mockImplementation((input) => ({ _type: "GetBucketTagging", input })),
    HeadBucketCommand: jest
      .fn()
      .mockImplementation((input) => ({ _type: "HeadBucket", input })),
    ListObjectsV2Command: jest
      .fn()
      .mockImplementation((input) => ({ _type: "ListObjectsV2", input })),
  };
});

describe("S3Adapter", () => {
  let adapter: S3Adapter;
  const config = {
    bucketName: "citadel-my-test-bucket",
    dataStoreId: "ds-001",
    orgId: "org-001",
  };

  beforeEach(() => {
    adapter = new S3Adapter();
    mockSend.mockReset();
  });

  describe("requiredPolicies", () => {
    it("returns scoped provision policies with no '*' resource", () => {
      const policies = adapter.requiredPolicies(
        config,
        "123456789012",
        "us-east-1",
      );
      expect(policies.provision).toHaveLength(3);

      // CreateBucket scoped to citadel- prefix
      expect(policies.provision[0].actions).toEqual(["s3:CreateBucket"]);
      expect(policies.provision[0].resources).toEqual([
        "arn:aws:s3:::citadel-*",
      ]);

      // Bucket-level actions scoped to specific bucket
      expect(policies.provision[1].actions).toContain("s3:DeleteBucket");
      expect(policies.provision[1].actions).toContain("s3:PutBucketVersioning");
      expect(policies.provision[1].actions).toContain("s3:GetBucketTagging");
      expect(policies.provision[1].actions).toContain("s3:PutBucketTagging");
      expect(policies.provision[1].resources).toEqual([
        "arn:aws:s3:::citadel-my-test-bucket",
      ]);

      // Object-level actions scoped to objects within the bucket
      expect(policies.provision[2].actions).toEqual(["s3:DeleteObject"]);
      expect(policies.provision[2].resources).toEqual([
        "arn:aws:s3:::citadel-my-test-bucket/*",
      ]);
    });

    it("provision policy snapshot has no '*' resource anywhere", () => {
      const policies = adapter.requiredPolicies(
        config,
        "123456789012",
        "us-east-1",
      );
      const allResources = policies.provision.flatMap((p) => p.resources);
      expect(allResources).not.toContain("*");
      for (const r of allResources) {
        expect(r).not.toBe("*");
      }
    });

    it("connect policies are scoped to bucket and objects", () => {
      const policies = adapter.requiredPolicies(
        config,
        "123456789012",
        "us-east-1",
      );
      expect(policies.connect).toHaveLength(1);
      expect(policies.connect[0].actions).toEqual([
        "s3:HeadBucket",
        "s3:ListBucket",
        "s3:ListObjectsV2",
        "s3:GetObject",
        "s3:PutObject",
        "s3:GetBucketTagging",
      ]);
      expect(policies.connect[0].resources).toEqual([
        "arn:aws:s3:::citadel-my-test-bucket",
        "arn:aws:s3:::citadel-my-test-bucket/*",
      ]);
    });
  });

  describe("provision — bucket name validation", () => {
    it("rejects bucket name without citadel- prefix", async () => {
      await expect(
        adapter.provision(
          { bucketName: "my-bucket", dataStoreId: "ds-1", orgId: "org-1" },
          MOCK_SCOPED_CREDENTIALS,
        ),
      ).rejects.toThrow(ValidationError);
    });

    it("rejects bucket name 'test-bucket' (no prefix)", async () => {
      await expect(
        adapter.provision(
          { bucketName: "test-bucket", dataStoreId: "ds-1", orgId: "org-1" },
          MOCK_SCOPED_CREDENTIALS,
        ),
      ).rejects.toThrow(/must start with "citadel-"/);
    });

    it("rejects bucket name with invalid characters after lowercasing", async () => {
      await expect(
        adapter.provision(
          {
            bucketName: "citadel-my_bucket!",
            dataStoreId: "ds-1",
            orgId: "org-1",
          },
          MOCK_SCOPED_CREDENTIALS,
        ),
      ).rejects.toThrow(ProvisioningError);
    });

    it("rejects bucket name that is too short", async () => {
      await expect(
        adapter.provision(
          { bucketName: "citadel-", dataStoreId: "ds-1", orgId: "org-1" },
          MOCK_SCOPED_CREDENTIALS,
        ),
      ).rejects.toThrow(ProvisioningError);
    });

    it("rejects missing bucketName", async () => {
      await expect(
        adapter.provision({}, MOCK_SCOPED_CREDENTIALS),
      ).rejects.toThrow(ProvisioningError);
    });

    it("accepts valid citadel-prefixed bucket name", async () => {
      mockSend.mockResolvedValueOnce({}); // CreateBucket
      mockSend.mockResolvedValueOnce({}); // PutBucketTagging
      const result = await adapter.provision(config, MOCK_SCOPED_CREDENTIALS);
      expect(result.resourceArn).toBe("arn:aws:s3:::citadel-my-test-bucket");
    });
  });

  describe("provision — tagging on creation", () => {
    it("tags the bucket with Citadel ownership metadata after creation", async () => {
      mockSend.mockResolvedValueOnce({}); // CreateBucket
      mockSend.mockResolvedValueOnce({}); // PutBucketTagging
      await adapter.provision(config, MOCK_SCOPED_CREDENTIALS);

      // Second call should be PutBucketTagging
      expect(mockSend).toHaveBeenCalledTimes(2);
      const tagCall = mockSend.mock.calls[1][0];
      expect(tagCall._type).toBe("PutBucketTagging");
      expect(tagCall.input.Bucket).toBe("citadel-my-test-bucket");
      expect(tagCall.input.Tagging.TagSet).toEqual(
        expect.arrayContaining([
          { Key: "ManagedBy", Value: "citadel" },
          { Key: "citadel:dataStoreId", Value: "ds-001" },
          { Key: "citadel:orgId", Value: "org-001" },
        ]),
      );
    });

    it("skips tagging when dataStoreId or orgId is absent", async () => {
      mockSend.mockResolvedValueOnce({}); // CreateBucket only
      await adapter.provision(
        { bucketName: "citadel-no-ids" },
        MOCK_SCOPED_CREDENTIALS,
      );
      // Only CreateBucket call, no PutBucketTagging
      expect(mockSend).toHaveBeenCalledTimes(1);
    });
  });

  describe("provision — adoption guard (BucketAlreadyOwnedByYou)", () => {
    const bucketExistsError = () => {
      const e = new Error("Bucket already owned by you");
      e.name = "BucketAlreadyOwnedByYou";
      return e;
    };

    it("adopts bucket with matching Citadel tags", async () => {
      mockSend.mockRejectedValueOnce(bucketExistsError()); // CreateBucket
      mockSend.mockResolvedValueOnce({
        TagSet: [
          { Key: "ManagedBy", Value: "citadel" },
          { Key: "citadel:dataStoreId", Value: "ds-001" },
          { Key: "citadel:orgId", Value: "org-001" },
        ],
      }); // GetBucketTagging

      const result = await adapter.provision(config, MOCK_SCOPED_CREDENTIALS);
      expect(result.resourceArn).toBe("arn:aws:s3:::citadel-my-test-bucket");
    });

    it("refuses adoption when bucket has no tags", async () => {
      mockSend.mockRejectedValueOnce(bucketExistsError());
      const noTags = new Error("No tags");
      noTags.name = "NoSuchTagSet";
      mockSend.mockRejectedValueOnce(noTags);

      try {
        await adapter.provision(config, MOCK_SCOPED_CREDENTIALS);
        fail("Expected ProvisioningError");
      } catch (err) {
        expect(err).toBeInstanceOf(ProvisioningError);
        expect((err as Error).message).toMatch(
          /Bucket ownership verification failed/i,
        );
      }
    });

    it("refuses adoption when tags belong to another datastore", async () => {
      mockSend.mockRejectedValueOnce(bucketExistsError());
      mockSend.mockResolvedValueOnce({
        TagSet: [
          { Key: "citadel:dataStoreId", Value: "ds-OTHER" },
          { Key: "citadel:orgId", Value: "org-OTHER" },
        ],
      });

      try {
        await adapter.provision(config, MOCK_SCOPED_CREDENTIALS);
        fail("Expected ProvisioningError");
      } catch (err) {
        expect(err).toBeInstanceOf(ProvisioningError);
        expect((err as Error).message).toMatch(
          /Bucket ownership verification failed/i,
        );
      }
    });

    it("refuses adoption when tags match org but not datastore", async () => {
      mockSend.mockRejectedValueOnce(bucketExistsError());
      mockSend.mockResolvedValueOnce({
        TagSet: [
          { Key: "citadel:dataStoreId", Value: "ds-OTHER" },
          { Key: "citadel:orgId", Value: "org-001" },
        ],
      });

      await expect(
        adapter.provision(config, MOCK_SCOPED_CREDENTIALS),
      ).rejects.toThrow(ProvisioningError);
    });

    it("refuses adoption when dataStoreId/orgId is missing from config", async () => {
      mockSend.mockRejectedValueOnce(bucketExistsError());

      try {
        await adapter.provision(
          { bucketName: "citadel-existing" },
          MOCK_SCOPED_CREDENTIALS,
        );
        fail("Expected ProvisioningError");
      } catch (err) {
        expect(err).toBeInstanceOf(ProvisioningError);
        expect((err as Error).message).toMatch(
          /Bucket ownership verification failed/i,
        );
      }
    });

    it("refuses adoption when GetBucketTagging fails with unexpected error", async () => {
      mockSend.mockRejectedValueOnce(bucketExistsError());
      const tagErr = new Error("InternalError");
      tagErr.name = "InternalError";
      mockSend.mockRejectedValueOnce(tagErr);

      try {
        await adapter.provision(config, MOCK_SCOPED_CREDENTIALS);
        fail("Expected ProvisioningError");
      } catch (err) {
        expect(err).toBeInstanceOf(ProvisioningError);
        expect((err as Error).message).toMatch(
          /Bucket ownership verification failed/i,
        );
      }
    });
  });

  describe("provision — BucketAlreadyExists (cross-account)", () => {
    it("refuses adoption for BucketAlreadyExists with matching tags", async () => {
      const e = new Error("Bucket already exists");
      e.name = "BucketAlreadyExists";
      mockSend.mockRejectedValueOnce(e);
      mockSend.mockResolvedValueOnce({
        TagSet: [
          { Key: "citadel:dataStoreId", Value: "ds-001" },
          { Key: "citadel:orgId", Value: "org-001" },
        ],
      });

      // BucketAlreadyExists triggers same adoption check
      const result = await adapter.provision(config, MOCK_SCOPED_CREDENTIALS);
      expect(result.resourceArn).toBe("arn:aws:s3:::citadel-my-test-bucket");
    });
  });

  describe("provision — general", () => {
    it("creates a bucket and returns the ARN", async () => {
      mockSend.mockResolvedValueOnce({}); // CreateBucket
      mockSend.mockResolvedValueOnce({}); // PutBucketTagging
      const result = await adapter.provision(config, MOCK_SCOPED_CREDENTIALS);
      expect(result.resourceArn).toBe("arn:aws:s3:::citadel-my-test-bucket");
    });

    it("enables versioning when config.versioning is true", async () => {
      mockSend.mockResolvedValueOnce({}); // CreateBucket
      mockSend.mockResolvedValueOnce({}); // PutBucketTagging
      mockSend.mockResolvedValueOnce({}); // PutBucketVersioning
      await adapter.provision(
        { ...config, versioning: true },
        MOCK_SCOPED_CREDENTIALS,
      );
      expect(mockSend).toHaveBeenCalledTimes(3);
    });

    it("wraps AccessDenied in PermissionError", async () => {
      const sdkError = new Error("Access Denied");
      sdkError.name = "AccessDenied";
      mockSend.mockRejectedValueOnce(sdkError);
      await expect(
        adapter.provision(config, MOCK_SCOPED_CREDENTIALS),
      ).rejects.toThrow(PermissionError);
    });

    it("wraps unknown SDK errors in ProvisioningError", async () => {
      const sdkError = new Error("Something broke");
      sdkError.name = "InternalError";
      mockSend.mockRejectedValueOnce(sdkError);
      await expect(
        adapter.provision(config, MOCK_SCOPED_CREDENTIALS),
      ).rejects.toThrow(ProvisioningError);
    });

    it("preserves the original SDK error as cause", async () => {
      const sdkError = new Error("Something broke");
      sdkError.name = "InternalError";
      mockSend.mockRejectedValueOnce(sdkError);
      try {
        await adapter.provision(config, MOCK_SCOPED_CREDENTIALS);
        fail("Expected ProvisioningError");
      } catch (err) {
        expect((err as DataStoreError).cause).toBe(sdkError);
      }
    });

    it("wraps versioning AccessDenied in PermissionError", async () => {
      mockSend.mockResolvedValueOnce({}); // CreateBucket succeeds
      mockSend.mockResolvedValueOnce({}); // PutBucketTagging
      const sdkError = new Error("Access Denied");
      sdkError.name = "AccessDenied";
      mockSend.mockRejectedValueOnce(sdkError);
      await expect(
        adapter.provision(
          { ...config, versioning: true },
          MOCK_SCOPED_CREDENTIALS,
        ),
      ).rejects.toThrow(PermissionError);
    });
  });

  describe("connect", () => {
    it("succeeds when HeadBucket succeeds", async () => {
      // CIT-298: ownership check fires first (GetBucketTagging)
      mockSend.mockResolvedValueOnce({
        TagSet: [
          { Key: "citadel:dataStoreId", Value: "ds-001" },
          { Key: "citadel:orgId", Value: "org-001" },
        ],
      });
      mockSend.mockResolvedValueOnce({}); // HeadBucket
      await expect(
        adapter.connect(config, MOCK_SCOPED_CREDENTIALS),
      ).resolves.toBeUndefined();
    });

    it("throws ResourceNotFoundError when bucket does not exist", async () => {
      mockSend.mockResolvedValueOnce({
        TagSet: [
          { Key: "citadel:dataStoreId", Value: "ds-001" },
          { Key: "citadel:orgId", Value: "org-001" },
        ],
      });
      const sdkError = new Error("Not Found");
      sdkError.name = "NotFound";
      mockSend.mockRejectedValueOnce(sdkError);
      await expect(
        adapter.connect(config, MOCK_SCOPED_CREDENTIALS),
      ).rejects.toThrow(ResourceNotFoundError);
    });

    it("throws PermissionError on AccessDenied", async () => {
      mockSend.mockResolvedValueOnce({
        TagSet: [
          { Key: "citadel:dataStoreId", Value: "ds-001" },
          { Key: "citadel:orgId", Value: "org-001" },
        ],
      });
      const sdkError = new Error("Forbidden");
      sdkError.name = "AccessDenied";
      mockSend.mockRejectedValueOnce(sdkError);
      await expect(
        adapter.connect(config, MOCK_SCOPED_CREDENTIALS),
      ).rejects.toThrow(PermissionError);
    });

    it("throws ConnectionError on other errors", async () => {
      mockSend.mockResolvedValueOnce({
        TagSet: [
          { Key: "citadel:dataStoreId", Value: "ds-001" },
          { Key: "citadel:orgId", Value: "org-001" },
        ],
      });
      const sdkError = new Error("Network issue");
      sdkError.name = "NetworkingError";
      mockSend.mockRejectedValueOnce(sdkError);
      await expect(
        adapter.connect(config, MOCK_SCOPED_CREDENTIALS),
      ).rejects.toThrow(ConnectionError);
    });

    it("preserves SDK error as cause in ConnectionError", async () => {
      mockSend.mockResolvedValueOnce({
        TagSet: [
          { Key: "citadel:dataStoreId", Value: "ds-001" },
          { Key: "citadel:orgId", Value: "org-001" },
        ],
      });
      const sdkError = new Error("Network issue");
      sdkError.name = "NetworkingError";
      mockSend.mockRejectedValueOnce(sdkError);
      try {
        await adapter.connect(config, MOCK_SCOPED_CREDENTIALS);
        fail("Expected ConnectionError");
      } catch (err) {
        expect((err as DataStoreError).cause).toBe(sdkError);
      }
    });
  });

  describe("disconnect", () => {
    it("is a no-op", async () => {
      await expect(
        adapter.disconnect(config, MOCK_SCOPED_CREDENTIALS),
      ).resolves.toBeUndefined();
    });
  });

  describe("testConnection", () => {
    it("returns success when HeadBucket succeeds", async () => {
      mockSend.mockResolvedValueOnce({});
      const result = await adapter.testConnection(
        config,
        MOCK_SCOPED_CREDENTIALS,
      );
      expect(result.success).toBe(true);
      expect(result.message).toContain("citadel-my-test-bucket");
    });

    it("returns failure when HeadBucket fails", async () => {
      const sdkError = new Error("Not Found");
      sdkError.name = "NotFound";
      mockSend.mockRejectedValueOnce(sdkError);
      const result = await adapter.testConnection(
        config,
        MOCK_SCOPED_CREDENTIALS,
      );
      expect(result.success).toBe(false);
      expect(result.message).toContain("Failed");
    });
  });

  describe("getMetrics", () => {
    it("returns object count from ListObjectsV2", async () => {
      mockSend.mockResolvedValueOnce({
        KeyCount: 42,
        IsTruncated: false,
      });
      const result = await adapter.getMetrics(
        config,
        undefined,
        MOCK_SCOPED_CREDENTIALS,
      );
      expect(result.records).toBe(42);
      expect(result.size).toBe("42 objects");
    });

    it("paginates through truncated results", async () => {
      mockSend.mockResolvedValueOnce({
        KeyCount: 1000,
        IsTruncated: true,
        NextContinuationToken: "token1",
      });
      mockSend.mockResolvedValueOnce({
        KeyCount: 500,
        IsTruncated: false,
      });
      const result = await adapter.getMetrics(
        config,
        undefined,
        MOCK_SCOPED_CREDENTIALS,
      );
      expect(result.records).toBe(1500);
    });

    it("wraps AccessDenied in PermissionError", async () => {
      const sdkError = new Error("Access Denied");
      sdkError.name = "AccessDenied";
      mockSend.mockRejectedValueOnce(sdkError);
      await expect(
        adapter.getMetrics(config, undefined, MOCK_SCOPED_CREDENTIALS),
      ).rejects.toThrow(PermissionError);
    });

    it("wraps other errors in ConnectionError", async () => {
      const sdkError = new Error("Timeout");
      sdkError.name = "TimeoutError";
      mockSend.mockRejectedValueOnce(sdkError);
      await expect(
        adapter.getMetrics(config, undefined, MOCK_SCOPED_CREDENTIALS),
      ).rejects.toThrow(ConnectionError);
    });
  });

  describe("scoped credentials", () => {
    it("constructs client with provided credentials", async () => {
      // CIT-298: ownership check mock + HeadBucket
      mockSend.mockResolvedValueOnce({
        TagSet: [
          { Key: "citadel:dataStoreId", Value: "ds-001" },
          { Key: "citadel:orgId", Value: "org-001" },
        ],
      });
      mockSend.mockResolvedValueOnce({});
      const creds = {
        accessKeyId: "AKIA...",
        secretAccessKey: "secret",
        sessionToken: "token",
      };
      await adapter.connect(config, creds);
      expect(S3Client).toHaveBeenCalledWith({
        credentials: {
          accessKeyId: "AKIA...",
          secretAccessKey: "secret",
          sessionToken: "token",
        },
      });
    });

    it("throws CredentialMissingError when no credentials provided", async () => {
      const { CredentialMissingError } =
        await import("../../../adapters/errors");
      await expect(adapter.connect(config)).rejects.toThrow(
        CredentialMissingError,
      );
    });
  });
});
