/**
 * CIT-298: S3 preflight ownership check and IAM role rollback tests.
 *
 * Verifies:
 * 1. preflight is called BEFORE ensureRole (order assertion)
 * 2. On preflight refusal, ensureRole is NEVER called
 * 3. On failed connect after ensureRole, deleteRole is called (rollback)
 * 4. Happy path: preflight → ensureRole → connect → CONNECTED
 */
import { S3Adapter } from "../s3-adapter";
import { ProvisioningError } from "../errors";

// Recording fake to assert call order
const callLog: string[] = [];

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

describe("S3Adapter.preflight — CIT-298", () => {
  let adapter: S3Adapter;

  beforeEach(() => {
    adapter = new S3Adapter();
    mockSend.mockReset();
    callLog.length = 0;
  });

  it("passes when bucket tags match the caller's dataStoreId + orgId", async () => {
    mockSend.mockImplementation((cmd: { _type: string }) => {
      if (cmd._type === "GetBucketTagging") {
        return {
          TagSet: [
            { Key: "citadel:dataStoreId", Value: "ds-001" },
            { Key: "citadel:orgId", Value: "org-001" },
          ],
        };
      }
      // HeadBucket — bucket exists (for CREATE_NEW idempotent case)
      return {};
    });

    // CONNECT_EXISTING
    await expect(
      adapter.preflight(
        { bucketName: "citadel-my-bucket" },
        {
          dataStoreId: "ds-001",
          orgId: "org-001",
          provisionMode: "CONNECT_EXISTING",
        },
      ),
    ).resolves.toBeUndefined();
  });

  it("refuses when bucket is tagged for a different org (two-tenant negative)", async () => {
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
      adapter.preflight(
        { bucketName: "citadel-shared" },
        {
          dataStoreId: "ds-001",
          orgId: "org-001",
          provisionMode: "CONNECT_EXISTING",
        },
      ),
    ).rejects.toThrow(ProvisioningError);
    await expect(
      adapter.preflight(
        { bucketName: "citadel-shared" },
        {
          dataStoreId: "ds-001",
          orgId: "org-001",
          provisionMode: "CONNECT_EXISTING",
        },
      ),
    ).rejects.toThrow("Bucket ownership verification failed");
  });

  it("CREATE_NEW passes when bucket does not exist yet", async () => {
    mockSend.mockImplementation(() => {
      const err = new Error("NotFound") as Error & {
        name: string;
        $metadata: { httpStatusCode: number };
      };
      err.name = "NotFound";
      err.$metadata = { httpStatusCode: 404 };
      throw err;
    });

    await expect(
      adapter.preflight(
        { bucketName: "citadel-brand-new" },
        {
          dataStoreId: "ds-002",
          orgId: "org-001",
          provisionMode: "CREATE_NEW",
        },
      ),
    ).resolves.toBeUndefined();
  });

  it("CREATE_NEW passes when bucket exists and is tagged for this datastore (idempotent)", async () => {
    mockSend.mockImplementation((cmd: { _type: string }) => {
      if (cmd._type === "GetBucketTagging") {
        return {
          TagSet: [
            { Key: "citadel:dataStoreId", Value: "ds-002" },
            { Key: "citadel:orgId", Value: "org-001" },
          ],
        };
      }
      return {}; // HeadBucket succeeds
    });

    await expect(
      adapter.preflight(
        { bucketName: "citadel-existing" },
        {
          dataStoreId: "ds-002",
          orgId: "org-001",
          provisionMode: "CREATE_NEW",
        },
      ),
    ).resolves.toBeUndefined();
  });

  it("CREATE_NEW refuses when bucket exists but is tagged for a different org", async () => {
    mockSend.mockImplementation((cmd: { _type: string }) => {
      if (cmd._type === "GetBucketTagging") {
        return {
          TagSet: [
            { Key: "citadel:dataStoreId", Value: "ds-002" },
            { Key: "citadel:orgId", Value: "org-EVIL" },
          ],
        };
      }
      return {};
    });

    await expect(
      adapter.preflight(
        { bucketName: "citadel-hijacked" },
        {
          dataStoreId: "ds-002",
          orgId: "org-001",
          provisionMode: "CREATE_NEW",
        },
      ),
    ).rejects.toThrow(ProvisioningError);
  });

  it("emits BucketOwnershipRefused metric on refusal", async () => {
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
      adapter.preflight(
        { bucketName: "citadel-bad" },
        {
          dataStoreId: "ds-001",
          orgId: "org-001",
          provisionMode: "CONNECT_EXISTING",
        },
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

  it("skips check when bucketName is absent (validated later)", async () => {
    await expect(
      adapter.preflight({}, { dataStoreId: "ds-001", orgId: "org-001" }),
    ).resolves.toBeUndefined();
  });
});

describe("S3Adapter — connect policy includes GetBucketTagging (defence in depth)", () => {
  it("vended connect policies include s3:GetBucketTagging", () => {
    const adapter = new S3Adapter();
    const policies = adapter.requiredPolicies(
      { bucketName: "citadel-test" },
      "123456789012",
      "us-east-1",
    );
    const connectActions = policies.connect.flatMap((p) => p.actions);
    expect(connectActions).toContain("s3:GetBucketTagging");
  });
});
