/**
 * replay-gate.test.ts — THE mandatory non-vacuous fail-closed gate proof
 * (CIT-026 design §1d/§1e, binding invariant from the orchestrator task:
 * "a pin/gate that never bites is theatre").
 *
 * Three legs, all required:
 *   (a) Gate trips on bypass: a raw secret injected AFTER redaction (i.e.
 *       simulating a redaction miss) must make assertBundleSecretFree throw
 *       with the firing pattern id.
 *   (b) MUTATION KILL (the non-vacuity proof): stub redactSecrets to
 *       identity (jest.spyOn) and rebuild the sanitize pipeline's output —
 *       the survival property must FAIL and the gate must THROW. This is
 *       the assertion that proves the gate is load-bearing: if redaction
 *       regresses, the build refuses, rather than silently publishing.
 *   (c) Clean pass: a fully-redacted bundle must NOT throw (no
 *       false-positive publication block on benign content).
 */
import * as secretPatterns from "../../../utils/secret-patterns";
import {
  sanitizeBundle,
  assertBundleSecretFree,
  ReplaySecretLeakError,
} from "../replay-sanitize";
// Fixture values below are assembled from fragments, never written as
// contiguous literals — see secret-fixture-helper.ts's file header for why.
import {
  githubToken,
  stripeLiveSecretKey,
  privateKeyBlock,
  jwtNoTyp,
  slackBotToken,
  googleApiKey,
  postgresUriWithCreds,
} from "../../../utils/__tests__/secret-fixture-helper";

describe("(a) gate trips on a bypassed/missed redaction", () => {
  test("a bundle carrying a raw secret AFTER the sanitize step throws ReplaySecretLeakError with the pattern id", () => {
    // Simulates a redaction miss: this string never went through
    // sanitizeBundle, so the raw secret is still present when the gate runs.
    const leakedBundle = {
      sections: { output: `leaked: ${githubToken()}` },
    };

    expect(() => assertBundleSecretFree(leakedBundle)).toThrow(
      ReplaySecretLeakError,
    );
    try {
      assertBundleSecretFree(leakedBundle);
      fail("expected assertBundleSecretFree to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ReplaySecretLeakError);
      expect((err as ReplaySecretLeakError).patternIds).toContain(
        "github-token",
      );
    }
  });
});

describe("(b) MUTATION KILL — non-vacuity proof (redactSecrets stubbed to identity)", () => {
  test("with redaction disabled, the survival property FAILS and the gate THROWS", () => {
    // Stub redactSecrets to identity (a no-op) — this simulates the
    // regression the gate exists to catch: redaction silently stops
    // working. If this test can pass with the stub in place, the gate is
    // vacuous — it would never actually catch a real regression.
    const spy = jest
      .spyOn(secretPatterns, "redactSecrets")
      .mockImplementation((s: string) => s);

    try {
      const bundle = {
        sections: {
          output: `here is a secret: ${stripeLiveSecretKey()}`,
        },
      };

      const sanitized = sanitizeBundle(bundle);

      // Survival property FAILS: the secret is still present because
      // redaction was stubbed out.
      const remaining =
        secretPatterns.SECRET_PATTERNS === secretPatterns.SECRET_PATTERNS; // no-op reference check to keep import used
      expect(remaining).toBe(true);
      const serialized = JSON.stringify(sanitized);
      expect(serialized).toContain(stripeLiveSecretKey());

      // And the gate — run against the UN-redacted (stub-passed-through)
      // sanitized output — must throw. This is the load-bearing assertion:
      // the gate independently re-scans the fully serialized bundle rather
      // than trusting sanitizeBundle's return value, so a redaction
      // regression is still caught at the gate.
      expect(() => assertBundleSecretFree(sanitized)).toThrow(
        ReplaySecretLeakError,
      );
    } finally {
      spy.mockRestore();
    }
  });
});

describe("(c) clean pass — no false-positive block on benign content", () => {
  test("a fully-sanitized bundle passes the gate without throwing", () => {
    const bundle = {
      sections: {
        output:
          "contact me at someone@example.com and use token=supersecretvalue123",
      },
    };
    const sanitized = sanitizeBundle(bundle);
    expect(() => assertBundleSecretFree(sanitized)).not.toThrow();
  });

  test("a bundle with no secrets at all passes the gate", () => {
    const bundle = { status: "completed", nodeId: "node-1", count: 3 };
    expect(() => assertBundleSecretFree(bundle)).not.toThrow();
  });
});

describe("per-class coverage — one planted example per class trips the gate pre-sanitize", () => {
  const classes: Array<[string, string]> = [
    ["private-key-block", privateKeyBlock("RSA", "abc")],
    ["jwt", jwtNoTyp()],
    ["github-token", githubToken()],
    ["slack-token", slackBotToken()],
    ["google-api-key", googleApiKey()],
    ["stripe-key", stripeLiveSecretKey()],
    ["db-uri", postgresUriWithCreds()],
  ];

  test.each(classes)(
    "class %s trips the gate when unsanitized",
    (_id, sample) => {
      expect(() => assertBundleSecretFree({ raw: sample })).toThrow(
        ReplaySecretLeakError,
      );
    },
  );

  test.each(classes)(
    "class %s does NOT trip the gate after sanitizeBundle",
    (_id, sample) => {
      const sanitized = sanitizeBundle({ raw: sample });
      expect(() => assertBundleSecretFree(sanitized)).not.toThrow();
    },
  );
});
