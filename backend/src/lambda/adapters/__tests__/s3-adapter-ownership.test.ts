/**
 * CIT-298: Two-tenant negative test — S3 connect must refuse a bucket whose
 * ownership tags do not match the caller's dataStoreId + orgId.
 */
import { S3Adapter } from "../s3-adapter";
import { ProvisioningError } from "../errors";
import { MOCK_SCOPED_CREDENTIALS } from "./helpers/mock-credentials";

const mockSend = jest.fn();
jest.mock("@aws-sdk/client-s3", () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: mockSend })),
  HeadBucketCommand: jest
    .fn()
    .mockImplementation((input) => ({ _type: "HeadBucket", input })),
  GetBucketTaggingCommand: jest
    .fn()
    .mockImplementation((input) => ({ _type: "GetBucketTagging", input })),
  CreateBucketCommand: jest
    .fn()
    .mockImplementation((input) => ({ _type: "CreateBucket", input })),
  PutBucketVersioningCommand: jest
    .fn()
    .mockImplementation((input) => ({ _type: "PutBucketVersioning", input })),
  PutBucketTaggingCommand: jest
    .fn()
    .mockImplementation((input) => ({ _type: "PutBucketTagging", input })),
  ListObjectsV2Command: jest
    .fn()
    .mockImplementation((input) => ({ _type: "ListObjectsV2", input })),
  DeleteObjectsCommand: jest
    .fn()
    .mockImplementation((input) => ({ _type: "DeleteObjects", input })),
  DeleteBucketCommand: jest
    .fn()
    .mockImplementation((input) => ({ _type: "DeleteBucket", input })),
}));

describe("S3Adapter — CIT-298 bucket ownership on connect", () => {
  let adapter: S3Adapter;

  beforeEach(() => {
    adapter = new S3Adapter();
    mockSend.mockReset();
  });

  it("connect succeeds when bucket tags match caller org and datastore", async () => {
    // GetBucketTagging returns matching tags
    mockSend.mockImplementation((cmd: { _type: string }) => {
      if (cmd._type === "GetBucketTagging") {
        return {
          TagSet: [
            { Key: "citadel:dataStoreId", Value: "ds-001" },
            { Key: "citadel:orgId", Value: "org-001" },
          ],
        };
      }
      // HeadBucket succeeds
      return {};
    });

    await expect(
      adapter.connect(
        {
          bucketName: "citadel-my-bucket",
          dataStoreId: "ds-001",
          orgId: "org-001",
        },
        MOCK_SCOPED_CREDENTIALS,
      ),
    ).resolves.toBeUndefined();
  });

  it("connect refuses a bucket tagged for a different org (two-tenant negative)", async () => {
    mockSend.mockImplementation((cmd: { _type: string }) => {
      if (cmd._type === "GetBucketTagging") {
        return {
          TagSet: [
            { Key: "citadel:dataStoreId", Value: "ds-001" },
            { Key: "citadel:orgId", Value: "org-ATTACKER" },
          ],
        };
      }
      return {};
    });

    await expect(
      adapter.connect(
        {
          bucketName: "citadel-shared-bucket",
          dataStoreId: "ds-001",
          orgId: "org-001",
        },
        MOCK_SCOPED_CREDENTIALS,
      ),
    ).rejects.toThrow(ProvisioningError);

    // Error message must be opaque — no bucket name, org, or datastore ID leaked
    await expect(
      adapter.connect(
        {
          bucketName: "citadel-shared-bucket",
          dataStoreId: "ds-001",
          orgId: "org-001",
        },
        MOCK_SCOPED_CREDENTIALS,
      ),
    ).rejects.toThrow("Bucket ownership verification failed");
  });

  it("connect refuses a bucket tagged for a different datastore", async () => {
    mockSend.mockImplementation((cmd: { _type: string }) => {
      if (cmd._type === "GetBucketTagging") {
        return {
          TagSet: [
            { Key: "citadel:dataStoreId", Value: "ds-OTHER" },
            { Key: "citadel:orgId", Value: "org-001" },
          ],
        };
      }
      return {};
    });

    await expect(
      adapter.connect(
        {
          bucketName: "citadel-stolen",
          dataStoreId: "ds-001",
          orgId: "org-001",
        },
        MOCK_SCOPED_CREDENTIALS,
      ),
    ).rejects.toThrow(ProvisioningError);
  });

  it("connect refuses a bucket with no tags", async () => {
    mockSend.mockImplementation((cmd: { _type: string }) => {
      if (cmd._type === "GetBucketTagging") {
        const err = new Error("NoSuchTagSet") as Error & {
          name: string;
        };
        err.name = "NoSuchTagSet";
        throw err;
      }
      return {};
    });

    await expect(
      adapter.connect(
        {
          bucketName: "citadel-untagged",
          dataStoreId: "ds-001",
          orgId: "org-001",
        },
        MOCK_SCOPED_CREDENTIALS,
      ),
    ).rejects.toThrow(ProvisioningError);
  });

  it("connect skips ownership check if dataStoreId/orgId absent in config", async () => {
    // HeadBucket succeeds — no ownership check without IDs
    mockSend.mockResolvedValue({});

    await expect(
      adapter.connect(
        { bucketName: "citadel-legacy" },
        MOCK_SCOPED_CREDENTIALS,
      ),
    ).resolves.toBeUndefined();
  });

  it("emitBucketOwnershipRefused metric is logged on tag mismatch", async () => {
    const consoleSpy = jest.spyOn(console, "log").mockImplementation();
    mockSend.mockImplementation((cmd: { _type: string }) => {
      if (cmd._type === "GetBucketTagging") {
        return {
          TagSet: [
            { Key: "citadel:dataStoreId", Value: "ds-OTHER" },
            { Key: "citadel:orgId", Value: "org-OTHER" },
          ],
        };
      }
      return {};
    });

    await expect(
      adapter.connect(
        {
          bucketName: "citadel-bad",
          dataStoreId: "ds-001",
          orgId: "org-001",
        },
        MOCK_SCOPED_CREDENTIALS,
      ),
    ).rejects.toThrow(ProvisioningError);

    const metricLog = consoleSpy.mock.calls.find((args) => {
      try {
        const parsed = JSON.parse(args[0]);
        return parsed.BucketOwnershipRefused === 1;
      } catch {
        return false;
      }
    });
    expect(metricLog).toBeDefined();

    consoleSpy.mockRestore();
  });
});
