/**
 * Guard test: no wildcard resource in S3 adapter policy statements.
 *
 * Scans S3 adapter files for provision and connect policy statements that
 * use `resources: ['*']` or `"*"`. All S3 actions must be scoped to the
 * specific bucket ARN.
 *
 * Allowlist: none. Every S3 statement must be resource-scoped.
 *
 * Note: OpenSearch adapter aoss:CreateCollection uses '*' because the
 * collection ARN is unknown at provision time — that is out of scope for
 * this PR and will be addressed in PR-3 (AOSS/KB scoping).
 */

import * as fs from "fs";
import * as path from "path";
import { getAdapter } from "../registry";

const ADAPTER_DIR = path.resolve(__dirname, "..");

describe("no-wildcard-s3-resource guard", () => {
  describe("runtime policy check via getAdapter", () => {
    const S3_ADAPTERS: Array<{
      type: string;
      config: Record<string, unknown>;
    }> = [
      {
        type: "S3",
        config: { bucketName: "citadel-test-bucket" },
      },
      {
        type: "S3_TABLES",
        config: {
          tableBucketName: "test-table-bucket",
          tableBucketArn:
            "arn:aws:s3tables:us-east-1:123456789012:bucket/test-table-bucket",
        },
      },
    ];

    for (const { type, config } of S3_ADAPTERS) {
      it(`${type} adapter does not grant s3 actions on bare '*' resource`, () => {
        const adapter = getAdapter(type);
        const policies = adapter.requiredPolicies(
          config,
          "123456789012",
          "us-east-1",
        );
        const allStatements = [...policies.provision, ...policies.connect];

        for (const stmt of allStatements) {
          const hasS3 = stmt.actions.some((a) => /^s3:/i.test(a));
          if (hasS3) {
            expect(stmt.resources).not.toContain("*");
            for (const r of stmt.resources) {
              expect(r).not.toBe("*");
            }
          }
        }
      });
    }
  });

  describe("source-level grep for literal wildcard strings", () => {
    const adapterFiles = fs
      .readdirSync(ADAPTER_DIR)
      .filter((f) => f.endsWith("-adapter.ts") && f.startsWith("s3"));

    for (const file of adapterFiles) {
      it(`${file} does not contain resources: ['*'] in s3 policy blocks`, () => {
        const content = fs.readFileSync(path.join(ADAPTER_DIR, file), "utf-8");
        const lines = content.split("\n");
        const violations: string[] = [];

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          // Match resources: ['*'] or resources: ["*"]
          if (/resources:\s*\[\s*(['"])\*\1\s*\]/.test(line)) {
            violations.push(`  L${i + 1}: ${line.trim()}`);
          }
        }

        expect(violations).toEqual([]);
      });
    }
  });
});
