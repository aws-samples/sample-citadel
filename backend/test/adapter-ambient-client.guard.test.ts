/**
 * Guard test: no ambient `Client({})` / `Client()` in adapter data-plane paths.
 *
 * Every AWS SDK client construction in adapters/** must go through
 * `requireScopedCredentials` (data-plane) or an explicitly named
 * `platformXxxClient()` method (control-plane). A bare `new XClient({})`
 * fallback uses the Lambda execution role's ambient credentials, which
 * violates the least-privilege scoped-credential contract.
 *
 * This test scans adapter source files and fails on any `new XClient({})`
 * or `new XClient()` that is NOT inside an allowlisted `platformXxxClient`
 * method.
 *
 * MUST FAIL on main (before fix) and pass after.
 */

import * as fs from "fs";
import * as path from "path";

const ADAPTER_DIR = path.resolve(__dirname, "../src/lambda/adapters");

// Control-plane functions in KnowledgeBaseAdapter that legitimately use the
// platform role. Each entry lists the method name and justification.
const PLATFORM_CLIENT_ALLOWLIST: Record<string, string> = {
  platformOssClient:
    "AOSS control-plane (create security/access/network policies, create collection) — runs under datastore-resolver Lambda direct AOSS grants",
  platformIamClient:
    "IAM control-plane (create/delete Bedrock KB service role citadel-ds-kb-svc-*) — runs under datastore-resolver Lambda direct IAM grants",
  platformStsClient:
    "STS GetCallerIdentity — read-only account context query under Lambda execution role",
  platformS3Client:
    "CIT-298: S3 preflight bucket ownership check (GetBucketTagging + HeadBucket) — runs under datastore-resolver Lambda direct S3 grants on citadel-* buckets before any scoped role is vended",
};

/**
 * Matches `new <Word>Client({})` or `new <Word>Client()` for AWS SDK v3 clients.
 * Excludes third-party driver constructors (DBSQLClient, net.Socket, etc.) by
 * checking the import source. The heuristic: AWS SDK v3 client class names end
 * in "Client" and are imported from `@aws-sdk/client-*` or `@aws-sdk/client-*`.
 */
const AWS_CLIENT_NAMES = [
  "S3Client",
  "DynamoDBClient",
  "RDSClient",
  "RedshiftClient",
  "OpenSearchServerlessClient",
  "ElastiCacheClient",
  "NeptuneClient",
  "KeyspacesClient",
  "DocDBClient",
  "LakeFormationClient",
  "S3TablesClient",
  "SageMakerClient",
  "TimestreamWriteClient",
  "BedrockAgentClient",
  "IAMClient",
  "STSClient",
];
const AMBIENT_CLIENT_PATTERN = new RegExp(
  `new\\s+(${AWS_CLIENT_NAMES.join("|")})\\(\\s*\\{?\\s*\\}?\\s*\\)`,
  "g",
);

describe("adapter-ambient-client guard", () => {
  const adapterFiles = fs
    .readdirSync(ADAPTER_DIR)
    .filter((f) => f.endsWith("-adapter.ts"));

  for (const file of adapterFiles) {
    it(`${file} has no ambient Client({}) outside platformClient allowlist`, () => {
      const content = fs.readFileSync(path.join(ADAPTER_DIR, file), "utf-8");
      const lines = content.split("\n");
      const violations: string[] = [];

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!AMBIENT_CLIENT_PATTERN.test(line)) continue;
        AMBIENT_CLIENT_PATTERN.lastIndex = 0; // reset regex state

        // Check if this line is inside an allowlisted platform method
        let insideAllowlisted = false;
        for (let j = i; j >= Math.max(0, i - 15); j--) {
          for (const methodName of Object.keys(PLATFORM_CLIENT_ALLOWLIST)) {
            if (lines[j].includes(methodName)) {
              insideAllowlisted = true;
              break;
            }
          }
          if (insideAllowlisted) break;
        }

        if (!insideAllowlisted) {
          violations.push(`  L${i + 1}: ${line.trim()}`);
        }
      }

      expect(violations).toEqual([]);
    });
  }

  it("platformClient allowlist covers only documented control-plane functions", () => {
    // Ensure every allowlisted method actually exists in the codebase
    const kbContent = fs.readFileSync(
      path.join(ADAPTER_DIR, "knowledge-base-adapter.ts"),
      "utf-8",
    );
    const s3Content = fs.readFileSync(
      path.join(ADAPTER_DIR, "s3-adapter.ts"),
      "utf-8",
    );
    const allContent = kbContent + "\n" + s3Content;
    for (const method of Object.keys(PLATFORM_CLIENT_ALLOWLIST)) {
      expect(allContent).toContain(`private ${method}(`);
    }
  });
});
