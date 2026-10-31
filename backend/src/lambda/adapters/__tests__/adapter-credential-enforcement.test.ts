/**
 * Verifies that every adapter's data-plane operations refuse to run without
 * scoped credentials and correctly pass credentials to the SDK client when
 * provided.
 */
import { CredentialMissingError } from "../../../adapters/errors";

// Mock all AWS SDK clients before importing adapters
const mockSend = jest.fn().mockResolvedValue({});

jest.mock("@aws-sdk/client-s3", () => {
  const actual = jest.requireActual("@aws-sdk/client-s3");
  return {
    ...actual,
    S3Client: jest.fn().mockImplementation((config: unknown) => ({
      send: mockSend,
      _config: config,
    })),
  };
});

jest.mock("@aws-sdk/client-dynamodb", () => {
  const actual = jest.requireActual("@aws-sdk/client-dynamodb");
  return {
    ...actual,
    DynamoDBClient: jest.fn().mockImplementation((config: unknown) => ({
      send: mockSend.mockResolvedValue({
        Table: { TableStatus: "ACTIVE", ItemCount: 42, TableSizeBytes: 1024 },
      }),
      _config: config,
    })),
  };
});

jest.mock("@aws-sdk/client-rds", () => {
  const actual = jest.requireActual("@aws-sdk/client-rds");
  return {
    ...actual,
    RDSClient: jest.fn().mockImplementation((config: unknown) => ({
      send: mockSend.mockResolvedValue({
        DBInstances: [{ DBInstanceStatus: "available", AllocatedStorage: 20 }],
      }),
      _config: config,
    })),
  };
});

jest.mock("@aws-sdk/client-opensearchserverless", () => {
  const actual = jest.requireActual("@aws-sdk/client-opensearchserverless");
  return {
    ...actual,
    OpenSearchServerlessClient: jest
      .fn()
      .mockImplementation((config: unknown) => ({
        send: mockSend,
        _config: config,
      })),
  };
});

jest.mock("@aws-sdk/client-bedrock-agent", () => {
  const actual = jest.requireActual("@aws-sdk/client-bedrock-agent");
  return {
    ...actual,
    BedrockAgentClient: jest.fn().mockImplementation((config: unknown) => ({
      send: mockSend.mockResolvedValue({
        knowledgeBase: { status: "ACTIVE", knowledgeBaseArn: "arn:test" },
      }),
      _config: config,
    })),
  };
});

import { S3Adapter } from "../s3-adapter";
import { DynamoDBAdapter } from "../dynamodb-adapter";
import { RdsAdapter } from "../rds-adapter";
import { KnowledgeBaseAdapter } from "../knowledge-base-adapter";
import { S3Client } from "@aws-sdk/client-s3";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { RDSClient } from "@aws-sdk/client-rds";

const VALID_CREDS = {
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  sessionToken: "FwoGZXIvYXdzEBY…",
};

describe("adapter data-plane credential enforcement", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Suppress CredentialMissingError structured log noise
    jest.spyOn(console, "error").mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("S3Adapter", () => {
    const adapter = new S3Adapter();
    const config = { bucketName: "test-bucket" };

    it("connect without credentials throws CredentialMissingError", async () => {
      await expect(adapter.connect(config)).rejects.toThrow(
        CredentialMissingError,
      );
    });

    it("connect with credentials passes them to S3Client", async () => {
      mockSend.mockResolvedValueOnce({});
      await adapter.connect(config, VALID_CREDS);
      expect(S3Client).toHaveBeenCalledWith({
        credentials: expect.objectContaining({
          accessKeyId: VALID_CREDS.accessKeyId,
          secretAccessKey: VALID_CREDS.secretAccessKey,
          sessionToken: VALID_CREDS.sessionToken,
        }),
      });
    });

    it("testConnection without credentials throws CredentialMissingError", async () => {
      await expect(adapter.testConnection(config)).rejects.toThrow(
        CredentialMissingError,
      );
    });

    it("getMetrics without credentials throws CredentialMissingError", async () => {
      await expect(adapter.getMetrics(config)).rejects.toThrow(
        CredentialMissingError,
      );
    });

    it("getMetrics with credentials passes them to S3Client", async () => {
      mockSend.mockResolvedValue({ KeyCount: 5, IsTruncated: false });
      await adapter.getMetrics(config, undefined, VALID_CREDS);
      expect(S3Client).toHaveBeenCalledWith({
        credentials: expect.objectContaining({
          accessKeyId: VALID_CREDS.accessKeyId,
        }),
      });
    });

    it("provision without credentials throws CredentialMissingError", async () => {
      await expect(adapter.provision!(config)).rejects.toThrow(
        CredentialMissingError,
      );
    });
  });

  describe("DynamoDBAdapter", () => {
    const adapter = new DynamoDBAdapter();
    const config = { tableName: "test-table" };

    it("connect without credentials throws CredentialMissingError", async () => {
      await expect(adapter.connect(config)).rejects.toThrow(
        CredentialMissingError,
      );
    });

    it("connect with credentials passes them to DynamoDBClient", async () => {
      await adapter.connect(config, VALID_CREDS);
      expect(DynamoDBClient).toHaveBeenCalledWith({
        credentials: expect.objectContaining({
          accessKeyId: VALID_CREDS.accessKeyId,
        }),
      });
    });

    it("getMetrics without credentials throws CredentialMissingError", async () => {
      await expect(adapter.getMetrics(config)).rejects.toThrow(
        CredentialMissingError,
      );
    });
  });

  describe("RdsAdapter", () => {
    const adapter = new RdsAdapter("postgres");
    const config = { dbInstanceIdentifier: "test-db" };

    it("connect without credentials throws CredentialMissingError", async () => {
      await expect(adapter.connect(config)).rejects.toThrow(
        CredentialMissingError,
      );
    });

    it("connect with credentials passes them to RDSClient", async () => {
      await adapter.connect(config, VALID_CREDS);
      expect(RDSClient).toHaveBeenCalledWith({
        credentials: expect.objectContaining({
          accessKeyId: VALID_CREDS.accessKeyId,
        }),
      });
    });
  });

  describe("KnowledgeBaseAdapter", () => {
    const adapter = new KnowledgeBaseAdapter();
    const config = { knowledgeBaseId: "test-kb" };

    it("connect without credentials throws CredentialMissingError", async () => {
      await expect(adapter.connect(config)).rejects.toThrow(
        CredentialMissingError,
      );
    });

    it("getMetrics without credentials throws CredentialMissingError", async () => {
      await expect(adapter.getMetrics(config)).rejects.toThrow(
        CredentialMissingError,
      );
    });
  });
});
