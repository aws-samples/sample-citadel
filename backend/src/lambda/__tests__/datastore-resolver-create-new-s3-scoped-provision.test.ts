/**
 * RED/GREEN regression test for the post-#634 (merge d9460125) production
 * incident: createDataStore for a NEW S3 datastore throws
 * CredentialMissingError from requireScopedCredentials inside
 * S3Adapter.makeClient, reached via S3Adapter.provision called by
 * createDataStore.
 *
 * Root cause: S3Adapter.provision routes through makeClient() ->
 * requireScopedCredentials(), which demands a credentials object carrying
 * the non-forgeable `markScopedCredentials` provenance marker
 * (credential-guard.ts). createDataStore's CREATE_NEW branch calls
 * `adapter.provision!(config, undefined)` BEFORE PolicyManager.ensureRole /
 * assumeScopedRole run (those happen afterwards, feeding only
 * connect/getMetrics). Unlike DynamoDBAdapter/RdsAdapter, which provision
 * via an ambient platformProvisionClient() and never call
 * requireScopedCredentials in provision(), S3Adapter never got that
 * treatment, so passing `undefined` credentials into its provision() is
 * guaranteed to throw.
 *
 * This test uses the REAL adapter (via the registry), the REAL
 * credential-guard module (markScopedCredentials / requireScopedCredentials),
 * and the REAL PolicyManager import surface (mocked at the module boundary
 * only), so it fails for the same reason production does: an unmarked /
 * undefined credentials object reaching S3Adapter.provision.
 */

const mockDynamoSend = jest.fn();
jest.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: jest.fn().mockImplementation(() => ({})),
}));
jest.mock("@aws-sdk/lib-dynamodb", () => {
  const actual = jest.requireActual("@aws-sdk/lib-dynamodb");
  return {
    ...actual,
    DynamoDBDocumentClient: {
      from: jest.fn().mockReturnValue({ send: mockDynamoSend }),
    },
    PutCommand: jest
      .fn()
      .mockImplementation((input) => ({ _type: "Put", input })),
    GetCommand: jest
      .fn()
      .mockImplementation((input) => ({ _type: "Get", input })),
    UpdateCommand: jest
      .fn()
      .mockImplementation((input) => ({ _type: "Update", input })),
    DeleteCommand: jest
      .fn()
      .mockImplementation((input) => ({ _type: "Delete", input })),
    QueryCommand: jest
      .fn()
      .mockImplementation((input) => ({ _type: "Query", input })),
  };
});

jest.mock("@aws-sdk/client-secrets-manager", () => ({
  SecretsManagerClient: jest.fn().mockImplementation(() => ({
    send: jest.fn().mockResolvedValue({ ARN: "arn:aws:secretsmanager:::fake" }),
  })),
  CreateSecretCommand: jest
    .fn()
    .mockImplementation((input) => ({ _type: "CreateSecret", input })),
  GetSecretValueCommand: jest
    .fn()
    .mockImplementation((input) => ({ _type: "GetSecretValue", input })),
  DeleteSecretCommand: jest
    .fn()
    .mockImplementation((input) => ({ _type: "DeleteSecret", input })),
}));

// Mock the S3 SDK client so S3Adapter.provision's internal calls resolve
// without hitting AWS, but keep S3Adapter's own code (and credential-guard)
// real, so the credential check in makeClient actually runs.
const mockS3Send = jest.fn();
let lastS3ClientCredentials: unknown;
// Maps the SDK command name (e.g. "CreateBucketCommand") to the credentials
// object the S3Client that issued it was constructed with — recorded only
// on the FIRST client to issue that command, since makeClient constructs a
// fresh S3Client per adapter method call.
let createBucketClientCredentials: Record<string, unknown>;
jest.mock("@aws-sdk/client-s3", () => {
  const actual = jest.requireActual("@aws-sdk/client-s3");
  return {
    ...actual,
    S3Client: jest.fn().mockImplementation((cfg: { credentials?: unknown }) => {
      lastS3ClientCredentials = cfg?.credentials;
      const creds = cfg?.credentials;
      return {
        send: (cmd: { constructor: { name: string } }) => {
          createBucketClientCredentials[cmd.constructor.name] =
            createBucketClientCredentials[cmd.constructor.name] ?? creds;
          return mockS3Send(cmd);
        },
      };
    }),
  };
});

jest.mock("uuid", () => ({ v4: jest.fn().mockReturnValue("test-uuid") }));

const mockPolicyManager = {
  getAccountContext: jest
    .fn()
    .mockResolvedValue({ accountId: "123456789012", region: "us-east-1" }),
  ensureRole: jest.fn().mockResolvedValue(undefined),
  assumeScopedRole: jest.fn(),
  deleteRole: jest.fn().mockResolvedValue(undefined),
};
jest.mock("../../utils/policy-manager", () => ({
  PolicyManager: jest.fn().mockImplementation(() => mockPolicyManager),
}));

process.env.DATASTORES_TABLE = "TestDataStoresTable";

import { handler } from "../datastore-resolver";
import { markScopedCredentials } from "../adapters/credential-guard";

type HandlerEvent = Parameters<typeof handler>[0];

describe("createDataStore - CREATE_NEW S3 must assume the scoped role before provisioning", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    lastS3ClientCredentials = undefined;
    createBucketClientCredentials = {};

    mockPolicyManager.assumeScopedRole.mockResolvedValue(
      markScopedCredentials({
        accessKeyId: "AKID",
        secretAccessKey: "SECRET",
        sessionToken: "TOKEN",
      }),
    );

    mockDynamoSend.mockImplementation(
      (cmd: { _type?: string; input?: Record<string, unknown> }) => {
        if (cmd._type === "Query") return Promise.resolve({ Items: [] });
        if (cmd._type === "Put") return Promise.resolve({});
        if (cmd._type === "Update") {
          const values = (cmd.input?.ExpressionAttributeValues ?? {}) as Record<
            string,
            unknown
          >;
          return Promise.resolve({
            Attributes: {
              dataStoreId: "test-uuid",
              status: values[":status"] ?? "CONNECTED",
              version: 1,
            },
          });
        }
        return Promise.resolve({});
      },
    );

    // S3 SDK calls succeed (CreateBucket, PutBucketTagging, HeadBucket,
    // ListObjectsV2 for getMetrics) once a client is actually constructed.
    // HeadBucketCommand (used both by preflight's platform client and by
    // connect) rejects NotFound so CREATE_NEW's preflight treats the
    // bucket as not-yet-existing (the expected case for a brand new
    // datastore) instead of falling into ownership verification.
    mockS3Send.mockImplementation((cmd: { constructor: { name: string } }) => {
      if (cmd.constructor.name === "HeadBucketCommand") {
        const err = new Error("Not Found") as Error & { name: string };
        err.name = "NotFound";
        return Promise.reject(err);
      }
      if (cmd.constructor.name === "ListObjectsV2Command") {
        return Promise.resolve({ Contents: [], KeyCount: 0 });
      }
      return Promise.resolve({});
    });
  });

  const makeCreateEvent = (input: Record<string, unknown>): HandlerEvent =>
    ({
      info: { fieldName: "createDataStore" },
      arguments: { input },
      identity: { username: "test-user", "custom:organization": "org-test" },
    }) as unknown as HandlerEvent;

  test("assumeScopedRole is called before provision, and provision/connect/getMetrics all receive the scoped credentials", async () => {
    const event = makeCreateEvent({
      name: "new-bucket",
      type: "S3",
      category: "S3_STORAGE",
      provisionMode: "CREATE_NEW",
      orgId: "org-test",
      config: JSON.stringify({ bucketName: "citadel-new-bucket" }),
      clientRequestToken: "tok-create-new-1",
    });

    const assumeCalls: boolean[] = [];
    mockPolicyManager.assumeScopedRole.mockImplementation(async () => {
      assumeCalls.push(true);
      return markScopedCredentials({
        accessKeyId: "AKID",
        secretAccessKey: "SECRET",
        sessionToken: "TOKEN",
      });
    });

    await handler(event);

    // 1. assumeScopedRole must have run at least once (the provision-scoped
    //    role vend) before CreateBucketCommand executes — this is the fix:
    //    provision() must receive scoped credentials, not undefined.
    expect(assumeCalls.length).toBeGreaterThan(0);

    // 2. The actual CreateBucketCommand call (S3Adapter.provision's core
    //    side effect) must have been issued by a client constructed with
    //    credentials that pass requireScopedCredentials. Before the fix,
    //    makeClient threw CredentialMissingError before the S3Client mock
    //    constructor for provision was ever reached with real credentials
    //    — reproducing the production CredentialMissingError.
    expect(createBucketClientCredentials["CreateBucketCommand"]).toEqual(
      expect.objectContaining({
        accessKeyId: "AKID",
        secretAccessKey: "SECRET",
        sessionToken: "TOKEN",
      }),
    );

    // 3. connect/getMetrics (via lastS3ClientCredentials, the final client
    //    constructed in the flow) also received scoped credentials.
    expect(lastS3ClientCredentials).toEqual(
      expect.objectContaining({
        accessKeyId: "AKID",
        secretAccessKey: "SECRET",
        sessionToken: "TOKEN",
      }),
    );
  });

  test("CONNECT_EXISTING still passes scoped credentials to connect/getMetrics", async () => {
    mockS3Send.mockImplementation((cmd: { constructor: { name: string } }) => {
      if (cmd.constructor.name === "GetBucketTaggingCommand") {
        return Promise.resolve({
          TagSet: [
            { Key: "citadel:dataStoreId", Value: "test-uuid" },
            { Key: "citadel:orgId", Value: "org-test" },
          ],
        });
      }
      if (cmd.constructor.name === "ListObjectsV2Command") {
        return Promise.resolve({ Contents: [], KeyCount: 0 });
      }
      return Promise.resolve({});
    });

    const event = makeCreateEvent({
      name: "existing-bucket",
      type: "S3",
      category: "S3_STORAGE",
      provisionMode: "CONNECT_EXISTING",
      orgId: "org-test",
      config: JSON.stringify({ bucketName: "citadel-existing-bucket" }),
      clientRequestToken: "tok-connect-existing-1",
    });

    await handler(event);

    expect(mockPolicyManager.assumeScopedRole).toHaveBeenCalledTimes(1);
    expect(lastS3ClientCredentials).toEqual(
      expect.objectContaining({
        accessKeyId: "AKID",
        secretAccessKey: "SECRET",
        sessionToken: "TOKEN",
      }),
    );
  });
});
