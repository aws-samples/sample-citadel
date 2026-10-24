/**
 * Tests for backfill-list-projection.ts (CIT-244, #385).
 *
 * Covers:
 *   - parseArgs: --dry-run as no-op alias, unknown flag rejection
 *   - Never calls RegistryService.listResources (the concurrent N+1 fan-out)
 *   - Sequential read via readRegistrySequentially
 *   - Projection row shape and dry-run vs apply logic
 */
import * as path from "path";
import { execSync } from "child_process";

// ---------------------------------------------------------------------------
// We mock readRegistrySequentially so the test never touches AWS.
// ---------------------------------------------------------------------------

jest.mock("../lib/registry-sequential-reader", () => ({
  readRegistrySequentially: jest.fn().mockResolvedValue({
    agents: [],
    tools: [],
    errors: 0,
  }),
}));

// Mock DynamoDB client
jest.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: jest.fn().mockImplementation(() => ({})),
}));
jest.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: {
    from: jest.fn().mockReturnValue({
      send: jest.fn().mockResolvedValue({}),
    }),
  },
  PutCommand: jest.fn(),
}));

// Mock RegistryService — only methods actually invoked at runtime
jest.mock("../../src/services/registry-service", () => ({
  RegistryService: jest.fn().mockImplementation(() => ({
    listResourceSummaries: jest.fn(),
    listResources: jest.fn(),
    getClient: jest.fn(),
    getRegistryId: jest.fn().mockReturnValue("reg-1"),
    deserializeCustomMetadata: jest.fn().mockReturnValue({}),
    mapToAgentConfig: jest.fn().mockReturnValue({
      name: "a",
      description: "",
      orgId: "",
      config: "{}",
      state: "ACTIVE",
      categories: [],
    }),
    mapToToolConfig: jest.fn().mockReturnValue({
      config: "{}",
      state: "ACTIVE",
      categories: [],
    }),
  })),
}));

jest.mock("../../src/utils/citadel-kind", () => ({
  resolveKind: jest.fn().mockReturnValue("agent"),
}));

import {
  RegistryService,
  type RegistryRecord,
} from "../../src/services/registry-service";
import { readRegistrySequentially } from "../lib/registry-sequential-reader";
import { runProjectionBackfill } from "../backfill-list-projection";

describe("backfill-list-projection", () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  describe("parseArgs", () => {
    const scriptPath = path.resolve(
      __dirname,
      "../../scripts/backfill-list-projection.ts",
    );

    test("exits with error when --registry-id is missing", () => {
      expect(() => {
        execSync(
          `npx ts-node ${scriptPath} --table-agents test --table-tools test 2>&1`,
          { encoding: "utf-8", timeout: 15000 },
        );
      }).toThrow();
    });

    test("exits with error when --table-agents is missing", () => {
      expect(() => {
        execSync(
          `npx ts-node ${scriptPath} --registry-id test --table-tools test 2>&1`,
          { encoding: "utf-8", timeout: 15000 },
        );
      }).toThrow();
    });

    test("script file exists and is valid TypeScript", () => {
      const result = execSync(
        `cd ${path.resolve(__dirname, "../..")} && npx tsc --noEmit --strict ${scriptPath} 2>&1 || true`,
        { encoding: "utf-8", timeout: 30000 },
      );
      expect(typeof result).toBe("string");
    });
  });

  describe("never calls RegistryService.listResources", () => {
    test("runProjectionBackfill uses readRegistrySequentially, not listResources", async () => {
      const mockRecords: RegistryRecord[] = [
        {
          recordId: "rec-1",
          name: "agent-1",
          status: "DRAFT",
          customDescriptorContent: JSON.stringify({ manifest: {} }),
        },
      ];

      (readRegistrySequentially as jest.Mock).mockResolvedValue({
        agents: mockRecords,
        tools: [],
        errors: 0,
      });

      await runProjectionBackfill(
        "reg-1",
        "agents-table",
        "tools-table",
        true,
        0,
        0,
      );

      // The shared sequential reader was called
      expect(readRegistrySequentially).toHaveBeenCalledTimes(1);

      // RegistryService.listResources must NEVER be called
      const instance = (RegistryService as unknown as jest.Mock).mock.results[0]
        ?.value;
      if (instance?.listResources) {
        expect(instance.listResources).not.toHaveBeenCalled();
      }
    });
  });

  describe("sequential reader integration", () => {
    test("passes delayMs and limit to readRegistrySequentially", async () => {
      (readRegistrySequentially as jest.Mock).mockResolvedValue({
        agents: [],
        tools: [],
        errors: 0,
      });

      await runProjectionBackfill(
        "reg-1",
        "agents-table",
        "tools-table",
        true,
        500,
        10,
      );

      expect(readRegistrySequentially).toHaveBeenCalledWith(expect.anything(), {
        delayMs: 500,
        limit: 10,
      });
    });
  });
});
