/**
 * RED/GREEN: S3Adapter.requiredPolicies built the bucket ARN from raw
 * config.bucketName while provision() lowercases the name before creating
 * the bucket. Mixed-case input therefore produced a policy ARN that did
 * NOT match the actual created bucket's ARN. Normalise the bucket name
 * once (lowercase) and use that single value everywhere, including the
 * config persisted on the record.
 */
import { S3Adapter } from "../s3-adapter";
import { MOCK_SCOPED_CREDENTIALS } from "./helpers/mock-credentials";

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
    DeleteObjectsCommand: jest
      .fn()
      .mockImplementation((input) => ({ _type: "DeleteObjects", input })),
    DeleteBucketCommand: jest
      .fn()
      .mockImplementation((input) => ({ _type: "DeleteBucket", input })),
  };
});

describe("S3Adapter — bucket name normalisation", () => {
  let adapter: S3Adapter;

  beforeEach(() => {
    adapter = new S3Adapter();
    mockSend.mockReset();
    mockSend.mockResolvedValue({});
  });

  test("mixed-case bucketName yields a requiredPolicies ARN equal to the created bucket's ARN", async () => {
    const mixedCaseName = "Citadel-Mixed-Case-Bucket";
    const config: Record<string, unknown> = {
      bucketName: mixedCaseName,
      dataStoreId: "ds-001",
      orgId: "org-001",
    };

    const provisionResult = await adapter.provision(
      config,
      MOCK_SCOPED_CREDENTIALS,
    );

    const policies = adapter.requiredPolicies(
      config,
      "123456789012",
      "us-east-1",
    );

    // provision() created the bucket under the lowercased name.
    expect(provisionResult.resourceArn).toBe(
      "arn:aws:s3:::citadel-mixed-case-bucket",
    );

    // requiredPolicies must reference the SAME (lowercased) ARN, not one
    // derived from the raw mixed-case input.
    const connectResources = policies.connect[0].resources;
    expect(connectResources).toContain(
      "arn:aws:s3:::citadel-mixed-case-bucket",
    );
    expect(connectResources).not.toContain(`arn:aws:s3:::${mixedCaseName}`);

    const bucketLevelProvisionStatement = policies.provision[1];
    expect(bucketLevelProvisionStatement.resources).toEqual([
      "arn:aws:s3:::citadel-mixed-case-bucket",
    ]);
  });

  test("provision persists the normalised (lowercased) bucketName onto config", async () => {
    const config: Record<string, unknown> = {
      bucketName: "Citadel-Another-Mixed-Bucket",
      dataStoreId: "ds-002",
      orgId: "org-002",
    };

    await adapter.provision(config, MOCK_SCOPED_CREDENTIALS);

    // The config object the resolver persists must carry the normalised
    // name, so a later connect/getMetrics call (and requiredPolicies)
    // reads the same value that was actually created.
    expect(config.bucketName).toBe("citadel-another-mixed-bucket");
  });

  test("requiredPolicies normalises bucketName even without provision having run (CONNECT_EXISTING)", () => {
    const config: Record<string, unknown> = {
      bucketName: "Citadel-Existing-Bucket",
      dataStoreId: "ds-003",
      orgId: "org-003",
    };

    const policies = adapter.requiredPolicies(
      config,
      "123456789012",
      "us-east-1",
    );

    expect(policies.connect[0].resources).toEqual([
      "arn:aws:s3:::citadel-existing-bucket",
      "arn:aws:s3:::citadel-existing-bucket/*",
    ]);
  });
});
