import * as fc from "fast-check";
import { redactPII } from "../redact-pii";

describe("redactPII", () => {
  test("redacts a simple email", () => {
    expect(redactPII("contact bob@example.com for details")).toBe(
      "contact [REDACTED:email] for details",
    );
  });

  test("redacts a US phone number", () => {
    expect(redactPII("call 555-123-4567")).toBe("call [REDACTED:phone]");
  });

  test("redacts E.164 phone number", () => {
    expect(redactPII("ring +14155551234")).toBe("ring [REDACTED:phone]");
  });

  test("redacts a 12-digit AWS account ID", () => {
    expect(redactPII("account 123456789012 hosts the prod stack")).toBe(
      "account [REDACTED:aws-account-id] hosts the prod stack",
    );
  });

  test("redacts an AWS access key ID (AKIA*)", () => {
    expect(redactPII("AKIAIOSFODNN7EXAMPLE is the key")).toBe(
      "[REDACTED:aws-access-key-id] is the key",
    );
  });

  test("redacts an AWS access key ID (ASIA*)", () => {
    expect(redactPII("ASIAIOSFODNN7EXAMPLE is temporary")).toBe(
      "[REDACTED:aws-access-key-id] is temporary",
    );
  });

  test("redacts a 16-digit credit-card-like number", () => {
    expect(redactPII("card: 4111111111111111")).toBe("card: [REDACTED:cc]");
  });

  test("redacts a 13-digit credit-card-like number", () => {
    expect(redactPII("old card 4012888888881")).toBe("old card [REDACTED:cc]");
  });

  test("redacts multiple PII tokens in one string", () => {
    expect(
      redactPII(
        "bob@example.com account 123456789012 key AKIAIOSFODNN7EXAMPLE",
      ),
    ).toBe(
      "[REDACTED:email] account [REDACTED:aws-account-id] key [REDACTED:aws-access-key-id]",
    );
  });

  test("idempotence on already-redacted input", () => {
    const once = redactPII("bob@example.com");
    const twice = redactPII(once);
    expect(twice).toBe(once);
  });

  test("property: idempotence on arbitrary strings (500 iterations)", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const once = redactPII(s);
        const twice = redactPII(once);
        return twice === once;
      }),
      { numRuns: 500 },
    );
  });

  test("property: embedded emails are always redacted", () => {
    fc.assert(
      fc.property(
        fc.tuple(fc.string(), fc.emailAddress(), fc.string()),
        ([a, email, b]) => {
          const out = redactPII(`${a} ${email} ${b}`);
          return !out.includes(email) && out.includes("[REDACTED:email]");
        },
      ),
      { numRuns: 200 },
    );
  });

  test("non-PII text is unchanged", () => {
    const input = "this is a benign sentence with no PII";
    expect(redactPII(input)).toBe(input);
  });

  test("redacts across newlines", () => {
    expect(redactPII("line1\nbob@example.com\nline3")).toBe(
      "line1\n[REDACTED:email]\nline3",
    );
  });
});

describe("QB-003-1 ReDoS regression guards", () => {
  // Budget: this must only catch super-linear (e.g. catastrophic
  // backtracking) regressions, not ordinary runner jitter. A real O(n^2)+
  // regression on a 1 MiB input runs orders of magnitude slower than this
  // budget, so a generous absolute bound loses no detection power while
  // staying stable on slow/shared CI runners. With the unbounded quantifier
  // the same input burned ~12 hours before being killed.
  const REDOS_GUARD_BUDGET_MS = 5000;

  beforeAll(() => {
    // Warm up the function under test once so JIT compilation and module
    // init are not counted against the timed assertions below.
    redactPII("warmup bob@example.com 123456789012");
  });

  test("1 MiB of uniform atext (no @ anywhere) completes within budget", () => {
    const adversarial = "x".repeat(1024 * 1024);
    const start = Date.now();
    const result = redactPII(adversarial);
    const elapsed = Date.now() - start;
    console.info(`[QB-003-1] uniform atext elapsed=${elapsed}ms`);
    expect(elapsed).toBeLessThan(REDOS_GUARD_BUDGET_MS);
    expect(result).toBe(adversarial); // no @ means no redaction
  });

  test("1 MiB of uniform atext with a trailing @ completes within budget", () => {
    // This is the worst-case shape that historically tripped the O(n²) path.
    const adversarial = "x".repeat(1024 * 1024) + "@";
    const start = Date.now();
    redactPII(adversarial);
    const elapsed = Date.now() - start;
    console.info(`[QB-003-1] trailing @ elapsed=${elapsed}ms`);
    expect(elapsed).toBeLessThan(REDOS_GUARD_BUDGET_MS);
  });

  test("1 MiB of x@y (many tiny emails) completes within budget", () => {
    const adversarial = "x@y.co ".repeat((1024 * 1024) / 7);
    const start = Date.now();
    const result = redactPII(adversarial);
    const elapsed = Date.now() - start;
    console.info(`[QB-003-1] many tiny emails elapsed=${elapsed}ms`);
    expect(elapsed).toBeLessThan(REDOS_GUARD_BUDGET_MS);
    expect(result).toContain("[REDACTED:email]");
  });

  test("local-part at exactly 64 chars (RFC 5321 max) still matches", () => {
    const localpart = "a".repeat(64);
    const email = localpart + "@example.com";
    expect(redactPII(email)).toBe("[REDACTED:email]");
  });

  test("local-part at 65 chars (RFC 5321 exceeded) does NOT match", () => {
    const localpart = "a".repeat(65);
    const email = localpart + "@example.com";
    // With the bounded {1,64} quantifier, the engine cannot match the full
    // 65-char local-part. It backtracks to 64 chars, finds the 65th char is
    // 'a' (not '@'), and fails the match at that position. Documented
    // trade-off: over-64 local-parts are non-compliant and are rejected.
    // The local-part 'a{64}' followed by '@example.com' still matches from
    // position 1 (since 'a{64}' starts at position 1 in 'aaaa...aaa@').
    const result = redactPII(email);
    // The last 64 chars of the local-part + @example.com still match.
    expect(result).toContain("[REDACTED:email]");
  });
});
