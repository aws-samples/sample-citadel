/**
 * Import mapping tests — replay package -> EvalCase (CIT-101 §5).
 *
 * Tests against the REAL fixture
 * frontend/src/services/__tests__/fixtures/replay-package-v1.0.0.json (an
 * execution-kind package, producerCommit='a8e5d90', findings[0].decision
 * ==='PERMIT', toolResults.partial===true). A backend-local copy is kept
 * under __tests__/fixtures/ to avoid cross-package path coupling into
 * frontend/ from backend jest config roots.
 */
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import * as fs from "fs";
import * as path from "path";
import type { AuthContext } from "../../types";

const ddbMock = mockClient(DynamoDBDocumentClient);

process.env.EVAL_SUITES_TABLE = "citadel-eval-suites-test";
process.env.EVAL_CASES_TABLE = "citadel-eval-cases-test";
process.env.EVENT_BUS_NAME = "citadel-agents-test";

import {
  importReplayAsEvalCase,
  mapReplayPackageToEvalCase,
} from "../eval-resolver";

function authContextFor(): AuthContext {
  return {
    userId: "user-architect",
    username: "architect",
    groups: [],
    roles: ["architect"],
  };
}

function draftSuite(overrides: Record<string, unknown> = {}) {
  return {
    suiteId: "suite-1",
    orgId: "org-1",
    agentTargetId: "agent-intake-1",
    name: "Intake Suite",
    description: "",
    semver: "1.0.0",
    status: "DRAFT",
    version: 1,
    references: [],
    createdAt: "2026-04-29T00:00:00.000Z",
    createdBy: "user-architect",
    updatedAt: "2026-04-29T00:00:00.000Z",
    ...overrides,
  };
}

const FIXTURE_PATH = path.resolve(
  __dirname,
  "fixtures/replay-package-v1.0.0.json",
);

function loadFixture(): unknown {
  return JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8"));
}

describe("eval-resolver — replay import mapping", () => {
  beforeEach(() => {
    ddbMock.reset();
  });

  describe("mapReplayPackageToEvalCase (pure mapper) — real fixture", () => {
    test("execution-kind fixture: provenance.source, packageHash set, producerCommit=a8e5d90", () => {
      const pkg = loadFixture();
      const mapped = mapReplayPackageToEvalCase(pkg);

      expect(mapped.provenance.source).toBe("IMPORTED_FROM_REPLAY");
      expect(mapped.provenance.packageHash).toMatch(/^[0-9a-f]{64}$/);
      expect(mapped.provenance.producerCommit).toBe("a8e5d90");
    });

    test("execution-kind: input.structuredInput===null + limitation note stamped", () => {
      const pkg = loadFixture();
      const mapped = mapReplayPackageToEvalCase(pkg);

      expect(mapped.kind).toBe("EXECUTION");
      expect(mapped.input.structuredInput).toBeNull();
      expect(mapped.provenance.note).toMatch(/nodes\[\]\.inputs null upstream/);
    });

    test("expectedOutcome derived from nodes[].outputs", () => {
      const pkg = loadFixture();
      const mapped = mapReplayPackageToEvalCase(pkg);

      // Fixture node-1 outputs = '{"answer":42}'.
      expect(mapped.expectedOutcome.mode).toBe("JSON_SUBSET");
      expect(mapped.expectedOutcome.target).toBe('{"answer":42}');
    });

    test("expectedPolicyOutcome.decision derived from findings[0].decision === PERMIT", () => {
      const pkg = loadFixture();
      const mapped = mapReplayPackageToEvalCase(pkg);

      expect(mapped.expectedPolicyOutcome?.decision).toBe("PERMIT");
    });

    test("toolResults.partial===true -> toolResultsPartial stamped, requiredTools not fabricated from empty results", () => {
      const pkg = loadFixture();
      const mapped = mapReplayPackageToEvalCase(pkg);

      expect(mapped.provenance.toolResultsPartial).toBe(true);
      expect(mapped.requiredTools).toEqual([]);
    });

    test("producerCommit:null variant -> stored, treated as unknown, not rejected", () => {
      const pkg = loadFixture() as Record<string, unknown>;
      const variant = { ...pkg, producerCommit: null };
      const mapped = mapReplayPackageToEvalCase(variant);

      expect(mapped.provenance.producerCommit).toBeNull();
    });

    test("wrong-major schemaVersion (2.0.0) -> ValidationError", () => {
      const pkg = loadFixture() as Record<string, unknown>;
      const variant = { ...pkg, schemaVersion: "2.0.0" };
      expect(() => mapReplayPackageToEvalCase(variant)).toThrow(
        /ValidationError.*unsupported replay schemaVersion/,
      );
    });

    test("minor/patch variation on same major (1.5.2) is tolerated", () => {
      const pkg = loadFixture() as Record<string, unknown>;
      const variant = { ...pkg, schemaVersion: "1.5.2" };
      expect(() => mapReplayPackageToEvalCase(variant)).not.toThrow();
    });

    test("conversation-kind: findings partial-marker object (no join key) skips expectedPolicyOutcome derivation", () => {
      const conversationPkg = {
        schemaVersion: "1.0.0",
        producerCommit: "abc1234",
        kind: "conversation",
        correlationId: "conv-1",
        sections: {
          messages: [
            { role: "user", content: "hello there" },
            { role: "assistant", content: "hi!" },
          ],
          toolResults: { partial: true, results: [] },
          findings: { partial: true, results: [] }, // FindingsSection marker, not an array
        },
      };
      const mapped = mapReplayPackageToEvalCase(conversationPkg);
      expect(mapped.kind).toBe("CONVERSATION");
      expect(mapped.expectedPolicyOutcome).toBeUndefined();
      expect(mapped.input.prompt).toBe("hello there");
    });
  });

  describe("importReplayAsEvalCase (resolver, DDB-mocked)", () => {
    test("happy path: imports fixture into a DRAFT suite, lands DRAFT-only (case created)", async () => {
      ddbMock.on(GetCommand).resolves({ Item: draftSuite() });
      ddbMock.on(PutCommand).resolves({});
      const auth = authContextFor();

      const result = await importReplayAsEvalCase(
        "suite-1",
        loadFixture(),
        auth,
      );

      expect(result.provenance.source).toBe("IMPORTED_FROM_REPLAY");
      expect(result.kind).toBe("EXECUTION");
      const puts = ddbMock.commandCalls(PutCommand);
      expect(puts).toHaveLength(1);
      expect(puts[0].args[0].input.TableName).toBe("citadel-eval-cases-test");
    });

    test("import into a FROZEN suite -> rejected by immutability guard, zero writes", async () => {
      ddbMock
        .on(GetCommand)
        .resolves({ Item: draftSuite({ status: "FROZEN" }) });
      const auth = authContextFor();

      await expect(
        importReplayAsEvalCase("suite-1", loadFixture(), auth),
      ).rejects.toThrow(/frozen\/referenced and cannot be mutated/);
      expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    });

    test("import into a referenced suite -> rejected by immutability guard, zero writes", async () => {
      ddbMock.on(GetCommand).resolves({
        Item: draftSuite({ status: "DRAFT", references: ["release-1"] }),
      });
      const auth = authContextFor();

      await expect(
        importReplayAsEvalCase("suite-1", loadFixture(), auth),
      ).rejects.toThrow(/frozen\/referenced and cannot be mutated/);
      expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    });

    test("import without eval:author permission -> UnauthorizedError", async () => {
      const auth: AuthContext = {
        userId: "user-developer",
        roles: ["developer"],
      };
      await expect(
        importReplayAsEvalCase("suite-1", loadFixture(), auth),
      ).rejects.toThrow(/UnauthorizedError/);
    });
  });
});
