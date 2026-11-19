/**
 * Tests for health-monitor scoped-credential compliance.
 *
 * 1. Probe credentials returned by the health monitor's role-assume path
 *    satisfy isScopedCredentials (WeakSet provenance).
 * 2. A health probe against a guard-protected adapter succeeds when
 *    PolicyManager.assumeScopedRole provides the credentials.
 * 3. Guard-parity: every `new AssumeRoleCommand(` caller under backend/src
 *    either feeds no adapter path or marks its credentials. Allowlist with
 *    reasons for connection-tester.ts and trust-path.ts.
 */
import * as fs from "fs";
import * as path from "path";
import {
  STSClient,
  GetCallerIdentityCommand,
  AssumeRoleCommand,
} from "@aws-sdk/client-sts";
import { mockClient } from "aws-sdk-client-mock";
import { processHealthChecks } from "../health-monitor";
import {
  isScopedCredentials,
  requireScopedCredentials,
} from "../adapters/credential-guard";

// ---------------------------------------------------------------------------
// STS mock — required so health-monitor's processHealthChecks doesn't hang
// ---------------------------------------------------------------------------
const stsMock = mockClient(STSClient);

let savedAwsRegion: string | undefined;

beforeEach(() => {
  savedAwsRegion = process.env.AWS_REGION;
  process.env.AWS_REGION = "us-west-2";
  stsMock.reset();
  stsMock.on(GetCallerIdentityCommand).resolves({
    Account: "123456789012",
    Arn: "arn:aws:sts::123456789012:assumed-role/citadel-services-dev-HealthMonitorFunctionServiceRo-abc/handler",
  });
  stsMock.on(AssumeRoleCommand).resolves({
    Credentials: {
      AccessKeyId: "AKIAIOSFODNN7EXAMPLE",
      SecretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      SessionToken: "FwoGZXIvYXdzE...",
      Expiration: new Date("2099-01-01"),
    },
  });
});

afterEach(() => {
  if (savedAwsRegion !== undefined) {
    process.env.AWS_REGION = savedAwsRegion;
  } else {
    delete process.env.AWS_REGION;
  }
});

// ---------------------------------------------------------------------------
// 1. Probed credentials satisfy isScopedCredentials
// ---------------------------------------------------------------------------
describe("health-monitor credential provenance", () => {
  it("credentials passed to adapter.testConnection satisfy isScopedCredentials", async () => {
    let receivedCreds: unknown = undefined;

    const store = {
      dataStoreId: "ds-probe-001",
      orgId: "org-test",
      type: "S3",
      status: "CONNECTED" as const,
      config: JSON.stringify({ bucketName: "test-bucket" }),
    };

    const getAdapterFn = () => ({
      testConnection: async (
        _config: Record<string, unknown>,
        credentials?: Record<string, unknown>,
      ) => {
        receivedCreds = credentials;
        return { success: true, message: "OK" };
      },
    });

    const updateStoreFn = async () => {};

    await processHealthChecks([store], getAdapterFn, updateStoreFn);

    expect(receivedCreds).toBeDefined();
    expect(isScopedCredentials(receivedCreds)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Guard-protected adapter succeeds with health-monitor credentials
// ---------------------------------------------------------------------------
describe("guard-protected adapter with health-monitor credentials", () => {
  it("requireScopedCredentials accepts credentials from the health monitor path", async () => {
    let receivedCreds: Record<string, unknown> | undefined;

    const store = {
      dataStoreId: "ds-guard-001",
      orgId: "org-test",
      type: "S3",
      status: "ERROR" as const,
      config: JSON.stringify({ bucketName: "test-bucket" }),
    };

    const getAdapterFn = () => ({
      testConnection: async (
        _config: Record<string, unknown>,
        credentials?: Record<string, unknown>,
      ) => {
        receivedCreds = credentials;
        // Simulate what a guard-protected adapter does:
        const validated = requireScopedCredentials(credentials, {
          adapter: "test",
          op: "testConnection",
        });
        expect(validated.accessKeyId).toBe("AKIAIOSFODNN7EXAMPLE");
        return { success: true, message: "OK" };
      },
    });

    const updateStoreFn = async () => {};

    const results = await processHealthChecks(
      [store],
      getAdapterFn,
      updateStoreFn,
    );

    expect(receivedCreds).toBeDefined();
    expect(results[0].newStatus).toBe("CONNECTED");
  });
});

// ---------------------------------------------------------------------------
// 3. Guard-parity: AssumeRoleCommand caller audit
// ---------------------------------------------------------------------------
describe("AssumeRoleCommand caller guard-parity", () => {
  /**
   * Allowlist of files that call `new AssumeRoleCommand(` but do NOT feed
   * the result into an adapter path (no requireScopedCredentials).
   *
   * Each entry: { file, reason }
   */
  const ALLOWLIST: Array<{ file: string; reason: string }> = [
    {
      file: "src/utils/connection-tester.ts",
      reason:
        "Integration connection tests (Lambda, Smithy). Builds its own SDK clients directly for integration-type connections, never passes through adapter.makeClient/requireScopedCredentials.",
    },
    {
      file: "src/utils/trust-path.ts",
      reason:
        "IAM trust-path introspection probe. Not an adapter data-plane call — probes whether an STS assume succeeds, discards the credentials.",
    },
    {
      file: "src/utils/policy-manager.ts",
      reason:
        "The blessed path: PolicyManager.assumeScopedRole calls markScopedCredentials on the result. Cross-account hop also uses AssumeRoleCommand but feeds into the second hop, not an adapter directly.",
    },
  ];

  const allowedFiles = new Set(ALLOWLIST.map((a) => a.file));

  it("every AssumeRoleCommand caller under backend/src either marks credentials or is allowlisted", () => {
    const srcDir = path.resolve(__dirname, "../../..");
    const srcPath = path.join(srcDir, "src");

    // Recursively find all .ts files under backend/src (excluding tests)
    function findTsFiles(dir: string): string[] {
      const files: string[] = [];
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "__tests__" || entry.name === "node_modules")
            continue;
          files.push(...findTsFiles(full));
        } else if (
          entry.name.endsWith(".ts") &&
          !entry.name.endsWith(".test.ts") &&
          !entry.name.endsWith(".d.ts")
        ) {
          files.push(full);
        }
      }
      return files;
    }

    const tsFiles = findTsFiles(srcPath);
    const callersWithAssumeRole: string[] = [];

    for (const filePath of tsFiles) {
      const content = fs.readFileSync(filePath, "utf-8");
      if (content.includes("new AssumeRoleCommand(")) {
        const relative = path.relative(srcDir, filePath);
        callersWithAssumeRole.push(relative);
      }
    }

    // Every caller must be in the allowlist
    const unaccounted = callersWithAssumeRole.filter(
      (f) => !allowedFiles.has(f),
    );

    expect(unaccounted).toEqual([]);
    // Verify the allowlist entries actually exist (no stale entries)
    for (const entry of ALLOWLIST) {
      const fullPath = path.join(srcDir, entry.file);
      expect(fs.existsSync(fullPath)).toBe(true);
    }
  });
});
