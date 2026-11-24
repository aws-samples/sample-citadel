/**
 * RED/GREEN: S3Adapter.requiredPolicies included the non-existent IAM
 * action "s3:ListObjectsV2" in both the provision and connect statement
 * sets. ListObjectsV2 is an S3 API operation, but the IAM action that
 * authorises it is `s3:ListBucket` — there is no `s3:ListObjectsV2` IAM
 * action. Assert every action returned by requiredPolicies is drawn from
 * a maintained allow-list of valid S3 IAM actions actually used in this
 * repo. No network calls — the list is maintained here, not fetched from
 * AWS's IAM action database.
 */
import { S3Adapter } from "../s3-adapter";

jest.mock("@aws-sdk/client-s3", () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: jest.fn() })),
  CreateBucketCommand: jest.fn(),
  PutBucketVersioningCommand: jest.fn(),
  PutBucketTaggingCommand: jest.fn(),
  GetBucketTaggingCommand: jest.fn(),
  HeadBucketCommand: jest.fn(),
  ListObjectsV2Command: jest.fn(),
  DeleteObjectsCommand: jest.fn(),
  DeleteBucketCommand: jest.fn(),
}));

// Valid S3 IAM actions actually used across this repo's adapters/policies.
// Maintained by hand — ListObjectsV2 deliberately excluded: the ListObjectsV2
// *API operation* is authorised by the `s3:ListBucket` *IAM action*; there is
// no `s3:ListObjectsV2` IAM action.
const VALID_S3_IAM_ACTIONS = new Set([
  "s3:CreateBucket",
  "s3:PutBucketVersioning",
  "s3:DeleteBucket",
  "s3:ListBucket",
  "s3:GetBucketTagging",
  "s3:PutBucketTagging",
  "s3:DeleteObject",
  "s3:HeadBucket",
  "s3:GetObject",
  "s3:PutObject",
]);

describe("S3Adapter.requiredPolicies — valid IAM actions only", () => {
  const adapter = new S3Adapter();
  const config = {
    bucketName: "citadel-action-check-bucket",
    dataStoreId: "ds-001",
    orgId: "org-001",
  };

  test("every provision + connect action is in the maintained valid-action list", () => {
    const policies = adapter.requiredPolicies(
      config,
      "123456789012",
      "us-east-1",
    );

    const allActions = [
      ...policies.provision.flatMap((p) => p.actions),
      ...policies.connect.flatMap((p) => p.actions),
    ];

    expect(allActions.length).toBeGreaterThan(0);
    for (const action of allActions) {
      expect(VALID_S3_IAM_ACTIONS.has(action)).toBe(true);
    }
  });

  test("does not include the non-existent s3:ListObjectsV2 IAM action anywhere", () => {
    const policies = adapter.requiredPolicies(
      config,
      "123456789012",
      "us-east-1",
    );

    const allActions = [
      ...policies.provision.flatMap((p) => p.actions),
      ...policies.connect.flatMap((p) => p.actions),
    ];

    expect(allActions).not.toContain("s3:ListObjectsV2");
  });

  test("ListBucket remains present so ListObjectsV2 API calls stay authorised", () => {
    const policies = adapter.requiredPolicies(
      config,
      "123456789012",
      "us-east-1",
    );

    expect(
      policies.provision.some((p) => p.actions.includes("s3:ListBucket")),
    ).toBe(true);
    expect(
      policies.connect.some((p) => p.actions.includes("s3:ListBucket")),
    ).toBe(true);
  });
});
