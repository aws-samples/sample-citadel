/**
 * Tests for resolveProjectDocumentKey — the shared helper that binds every
 * document read/delete to the project's own key prefix.
 *
 * Fixtures use the real project id 35e479a1-8324-4d87-b0e5-da0531d2e773 and
 * key shapes observed in production DynamoDB rows.
 */
import {
  resolveProjectDocumentKey,
  DocumentKeyError,
} from "../../utils/document-key";

const PROJECT_A = "35e479a1-8324-4d87-b0e5-da0531d2e773";
const PROJECT_B = "c8f1e204-91ab-4d3c-b6f7-1a2b3c4d5e6f";

/** Real key shape from the documents table: ${projectId}/${docName}.${ext} */
const REAL_KEY_A = `${PROJECT_A}/quarterly-report.pdf`;

describe("resolveProjectDocumentKey", () => {
  // ── Happy-path: basename and full-key both accepted ──────────────────

  test("accepts a bare basename and prefixes it", () => {
    expect(resolveProjectDocumentKey(PROJECT_A, "quarterly-report.pdf")).toBe(
      REAL_KEY_A,
    );
  });

  test("accepts a full key already prefixed (idempotent)", () => {
    expect(resolveProjectDocumentKey(PROJECT_A, REAL_KEY_A)).toBe(REAL_KEY_A);
  });

  test("accepts a sub-path suffix", () => {
    expect(
      resolveProjectDocumentKey(PROJECT_A, "design/technical_design.md"),
    ).toBe(`${PROJECT_A}/design/technical_design.md`);
  });

  test("accepts a full key with sub-path", () => {
    const full = `${PROJECT_A}/design/technical_design.md`;
    expect(resolveProjectDocumentKey(PROJECT_A, full)).toBe(full);
  });

  // ── Two-project negatives: project A cannot read/delete project B ────

  test("rejects project B's full key when called for project A (cross-project read)", () => {
    // The key starts with PROJECT_B, not PROJECT_A — the prefix strip
    // leaves it intact, and the canonical key would be
    // `${PROJECT_A}/${PROJECT_B}/secret.pdf`, not under PROJECT_B.
    // But more importantly, if an attacker passes `../PROJECT_B/secret.pdf`
    // that's caught by the ".." check.
    expect(() =>
      resolveProjectDocumentKey(PROJECT_A, `../${PROJECT_B}/secret.pdf`),
    ).toThrow(DocumentKeyError);
  });

  test("rejects traversal attack to escape project A's prefix", () => {
    expect(() =>
      resolveProjectDocumentKey(PROJECT_A, `../${PROJECT_B}/secret.pdf`),
    ).toThrow('must not contain ".."');
  });

  test("rejects percent-encoded traversal", () => {
    expect(() =>
      resolveProjectDocumentKey(PROJECT_A, `%2e%2e/${PROJECT_B}/secret.pdf`),
    ).toThrow('must not contain ".."');
  });

  // ── Rejection cases ──────────────────────────────────────────────────

  test("rejects empty documentKey", () => {
    expect(() => resolveProjectDocumentKey(PROJECT_A, "")).toThrow(
      DocumentKeyError,
    );
  });

  test("rejects empty projectId", () => {
    expect(() => resolveProjectDocumentKey("", "report.pdf")).toThrow(
      DocumentKeyError,
    );
  });

  test("rejects leading slash", () => {
    expect(() => resolveProjectDocumentKey(PROJECT_A, "/etc/passwd")).toThrow(
      'must not start with "/"',
    );
  });

  test("rejects double slashes", () => {
    expect(() => resolveProjectDocumentKey(PROJECT_A, "foo//bar.pdf")).toThrow(
      'must not contain "//"',
    );
  });

  test("rejects control characters", () => {
    expect(() =>
      resolveProjectDocumentKey(PROJECT_A, "report\x00.pdf"),
    ).toThrow("control characters");
  });

  test("rejects key that is just the projectId prefix (empty suffix)", () => {
    expect(() => resolveProjectDocumentKey(PROJECT_A, `${PROJECT_A}/`)).toThrow(
      "empty suffix",
    );
  });

  test("rejects invalid percent-encoding", () => {
    expect(() => resolveProjectDocumentKey(PROJECT_A, "report%ZZ.pdf")).toThrow(
      "invalid percent-encoding",
    );
  });
});
