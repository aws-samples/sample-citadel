/**
 * secret-patterns.ts — single shared secret-pattern module (CIT-026 design
 * §1b/§1c). Every NEW pattern gets a positive `.test()` assertion AND a
 * near-miss negative assertion (practices lesson: "Validate regex changes
 * against RegExp.test() before declaring done" — visual review of a regex
 * is not evidence it matches real input).
 *
 * `scanForSecrets` must report pattern IDs only, never raw matched text
 * (mirrors sanitize-agent-output.ts's logging discipline).
 * `redactSecrets` must be idempotent (redactSecrets(redactSecrets(x)) ===
 * redactSecrets(x)) via the same [REDACTED:<id>] sentinel convention as
 * redact-pii.ts.
 */
import {
  SECRET_PATTERNS,
  scanForSecrets,
  redactSecrets,
} from "../secret-patterns";
// Fixture values below are assembled from fragments, never written as
// contiguous literals — see secret-fixture-helper.ts's file header for why.
import {
  privateKeyBlock,
  awsSecretAccessKeyValue,
  awsSecretAccessKeyValueNearMiss,
  jwt,
  githubToken,
  githubFineGrainedToken,
  slackBotToken,
  googleApiKey,
  stripeLiveSecretKey,
  stripeLiveRestrictedKey,
  stripeTestSecretKey,
  postgresUriWithCreds,
  mongoUriWithCreds,
  highEntropyBase64Run,
  highEntropyHexRun,
  highEntropyBase64Run65,
  highEntropyBase64Run200,
  highEntropyHexRun80,
  pemHeaderOnly,
  shortHexRun31,
} from "./secret-fixture-helper";

describe("SECRET_PATTERNS — module shape", () => {
  test("every pattern has a unique, log-safe id", () => {
    const ids = SECRET_PATTERNS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(/^[a-z0-9-]+$/);
    }
  });
});

describe("private-key blocks", () => {
  const positive = [
    privateKeyBlock("RSA", "MIIEow=="),
    privateKeyBlock("EC", "abc"),
    privateKeyBlock("OPENSSH", "abc"),
    privateKeyBlock("PLAIN", "abc"),
  ];
  for (const p of positive) {
    test(`fires on: ${p.slice(0, 24)}...`, () => {
      expect(scanForSecrets(p)).toContain("private-key-block");
    });
  }

  test("near-miss: the phrase 'private key' in prose does NOT fire", () => {
    expect(
      scanForSecrets("Please rotate your private key soon."),
    ).not.toContain("private-key-block");
  });

  test("fires on a PEM block with header but NO footer (truncated key — H27 fix)", () => {
    const truncated = pemHeaderOnly("RSA");
    expect(scanForSecrets(truncated)).toContain("private-key-block");
  });

  test("redacts PEM block without footer through end of input", () => {
    const truncated = pemHeaderOnly("RSA");
    const out = redactSecrets(truncated);
    expect(out).not.toContain("MIIEow");
    expect(out).toContain("[REDACTED:private-key-block]");
  });

  test("redacts private key block content", () => {
    const out = redactSecrets(positive[0]);
    expect(out).not.toContain("MIIEow==");
    expect(out).toContain("[REDACTED:private-key-block]");
  });
});

describe("AWS secret access key (context-anchored)", () => {
  const positive = `aws_secret_access_key = "${awsSecretAccessKeyValue()}"`;
  test("fires when context-anchored to aws_secret/SecretAccessKey", () => {
    expect(scanForSecrets(positive)).toContain("aws-secret-access-key");
  });
  test('fires on "SecretAccessKey": "..." JSON shape', () => {
    expect(
      scanForSecrets(`{"SecretAccessKey": "${awsSecretAccessKeyValue()}"}`),
    ).toContain("aws-secret-access-key");
  });
  test("near-miss: a bare 40-char base64-looking string with NO context anchor does NOT fire", () => {
    expect(
      scanForSecrets(`randomvalue=${awsSecretAccessKeyValueNearMiss()}`),
    ).not.toContain("aws-secret-access-key");
  });
});

describe("Bearer / Authorization header values", () => {
  test("fires on Authorization: Bearer <token>", () => {
    expect(
      scanForSecrets("Authorization: Bearer abc123.def456-token_value"),
    ).toContain("bearer-token");
  });
  test("near-miss: the word 'Bearer' alone in prose does NOT fire", () => {
    expect(
      scanForSecrets("The bearer of this message should reply."),
    ).not.toContain("bearer-token");
  });
});

describe("JWT", () => {
  const jwtSample = jwt();
  test("fires on a well-formed JWT", () => {
    expect(scanForSecrets(jwtSample)).toContain("jwt");
  });
  test("near-miss: a single eyJ-prefixed base64 segment with no dots does NOT fire", () => {
    expect(scanForSecrets(jwtSample.split(".")[0])).not.toContain("jwt");
  });
});

describe("GitHub tokens", () => {
  test("fires on ghp_ token", () => {
    expect(scanForSecrets(githubToken())).toContain("github-token");
  });
  test("fires on github_pat_ token", () => {
    expect(scanForSecrets(githubFineGrainedToken())).toContain("github-token");
  });
  test("near-miss: the literal string 'ghost_writer' does NOT fire", () => {
    expect(scanForSecrets("ghost_writer_module_name")).not.toContain(
      "github-token",
    );
  });
});

describe("Slack tokens", () => {
  test("fires on xoxb- token", () => {
    expect(scanForSecrets(slackBotToken())).toContain("slack-token");
  });
  test("near-miss: 'xoxo' hug-and-kiss shorthand does NOT fire", () => {
    expect(scanForSecrets("xoxo, see you later")).not.toContain("slack-token");
  });
});

describe("Google API keys", () => {
  test("fires on AIza-prefixed key", () => {
    expect(scanForSecrets(googleApiKey())).toContain("google-api-key");
  });
  test("near-miss: AIza-prefixed but too short does NOT fire", () => {
    expect(scanForSecrets("AIzaShort123")).not.toContain("google-api-key");
  });
});

describe("Stripe keys", () => {
  test("fires on sk_live_ key", () => {
    expect(scanForSecrets(stripeLiveSecretKey())).toContain("stripe-key");
  });
  test("fires on rk_live_ key", () => {
    expect(scanForSecrets(stripeLiveRestrictedKey())).toContain("stripe-key");
  });
  test("near-miss: sk_test_ (test-mode key) does NOT fire (production-key scope only)", () => {
    expect(scanForSecrets(stripeTestSecretKey())).not.toContain("stripe-key");
  });
});

describe("assignment-style secrets (key=/secret=/password=/token=)", () => {
  const cases: Array<[string, string]> = [
    ['key="supersecretvalue123"', "assignment-secret"],
    ["secret='supersecretvalue123'", "assignment-secret"],
    ["password: supersecretvalue123", "assignment-secret"],
    ["token=supersecretvalue123", "assignment-secret"],
  ];
  for (const [input, id] of cases) {
    test(`fires on: ${input}`, () => {
      expect(scanForSecrets(input)).toContain(id);
    });
  }

  // H26 fix: JSON-style quoted identifiers
  test('fires on JSON form: "api_key": "supersecretvalue123"', () => {
    expect(scanForSecrets('{"api_key": "supersecretvalue123"}')).toContain(
      "assignment-secret",
    );
  });
  test("fires on single-quoted JSON form: 'api_key': 'supersecretvalue123'", () => {
    expect(scanForSecrets("{'api_key': 'supersecretvalue123'}")).toContain(
      "assignment-secret",
    );
  });
  test("fires on YAML form: api_key: supersecretvalue123", () => {
    expect(scanForSecrets("api_key: supersecretvalue123")).toContain(
      "assignment-secret",
    );
  });
  test('fires on JSON form with double-quoted key and value: "token": "abcdef12345678"', () => {
    expect(scanForSecrets('{"token": "abcdef12345678"}')).toContain(
      "assignment-secret",
    );
  });

  test("near-miss: UUID value in assignment does NOT fire (not a secret)", () => {
    expect(
      scanForSecrets('{"api_key": "550e8400-e29b-41d4-a716-446655440000"}'),
    ).not.toContain("assignment-secret");
  });
  test("near-miss: password field placeholder text does NOT fire", () => {
    expect(scanForSecrets("password: <your-password-here>")).not.toContain(
      "assignment-secret",
    );
  });
  test("near-miss: empty assignment does NOT fire", () => {
    expect(scanForSecrets("token=")).not.toContain("assignment-secret");
  });
});

describe("DB connection URIs", () => {
  test("fires on postgres:// with credentials", () => {
    expect(scanForSecrets(postgresUriWithCreds())).toContain("db-uri");
  });
  test("fires on mongodb:// with credentials", () => {
    expect(scanForSecrets(mongoUriWithCreds())).toContain("db-uri");
  });
  test("near-miss: a DB URI with NO credentials does NOT fire", () => {
    expect(scanForSecrets("postgres://db.example.com:5432/mydb")).not.toContain(
      "db-uri",
    );
  });
});

describe("high-entropy bounded base64/hex runs", () => {
  test("fires (via assignment-secret) on a long high-entropy base64-looking run in a secret-ish assignment context", () => {
    expect(scanForSecrets(`api_key=${highEntropyBase64Run()}`)).toContain(
      "assignment-secret",
    );
  });
  test("near-miss: a short common word run does NOT trigger the entropy pattern", () => {
    expect(scanForSecrets("hello world this is fine")).toEqual([]);
  });

  // Standalone `high-entropy-run` class (design §1b): fires on the bare
  // shape with NO context anchor (no key=/token= prefix needed).
  test("fires on a bare high-entropy base64-looking run with no assignment context", () => {
    expect(scanForSecrets(highEntropyBase64Run())).toContain(
      "high-entropy-run",
    );
  });
  test("fires on a bare 40-char hex run with no assignment context", () => {
    expect(scanForSecrets(highEntropyHexRun())).toContain("high-entropy-run");
  });
  test("near-miss: ordinary lowercase prose (no digits, no case-mixing) does NOT trigger high-entropy-run", () => {
    expect(
      scanForSecrets("the quick brown fox jumps over the lazy dog again"),
    ).not.toContain("high-entropy-run");
  });
  test("near-miss: a short base64-ish run below the 32-char floor does NOT trigger high-entropy-run", () => {
    expect(scanForSecrets("Sh0rtValue123")).not.toContain("high-entropy-run");
  });

  // H27 fix: tokens longer than the old 64-char cap
  test("fires on a 65-char high-entropy base64 run (above old {32,64} cap)", () => {
    expect(scanForSecrets(highEntropyBase64Run65())).toContain(
      "high-entropy-run",
    );
  });
  test("fires on a ~200-char high-entropy base64 run", () => {
    expect(scanForSecrets(highEntropyBase64Run200())).toContain(
      "high-entropy-run",
    );
  });
  test("fires on an 80-char hex run (above old {32,64} cap)", () => {
    expect(scanForSecrets(highEntropyHexRun80())).toContain("high-entropy-run");
  });
  test("near-miss: a 31-char hex run (below 32-char floor) does NOT fire", () => {
    expect(scanForSecrets(shortHexRun31())).not.toContain("high-entropy-run");
  });
});

describe("scanForSecrets — reporting discipline", () => {
  test("never returns the raw matched text, only pattern ids", () => {
    const hits = scanForSecrets(githubToken());
    for (const id of hits) {
      expect(id).not.toContain("ghp_");
    }
  });

  test("returns empty array for clean text", () => {
    expect(
      scanForSecrets("Just a normal sentence with no secrets at all."),
    ).toEqual([]);
  });
});

describe("redactSecrets — idempotency", () => {
  test("redactSecrets(redactSecrets(x)) === redactSecrets(x)", () => {
    const input = `here is a token=supersecretvalue123 and a key ${githubToken()}`;
    const once = redactSecrets(input);
    const twice = redactSecrets(once);
    expect(twice).toBe(once);
  });

  test("redacted output contains no scanForSecrets hits", () => {
    const input = `${stripeLiveSecretKey()} and ${slackBotToken()}`;
    const redacted = redactSecrets(input);
    expect(scanForSecrets(redacted)).toEqual([]);
  });

  test("empty/falsy input returns input unchanged", () => {
    expect(redactSecrets("")).toBe("");
  });
});

describe("SECRET_PATTERNS — ReDoS safety (high-entropy-run {32,512})", () => {
  // Property test: ensure the expanded upper bound does not cause
  // catastrophic backtracking. 1 MB of near-miss input (mixed alpha with
  // no digits, so the base64 lookahead fails but the engine still has to
  // attempt matching at every position) must complete well under 1 second.
  // cf. redact-pii ReDoS flake history in practices doc.
  test("scanForSecrets completes on 1 MB near-miss input in < 1 s", () => {
    // Near-miss: all lowercase + uppercase but no digits — base64 variant
    // lookahead fails, hex variant fails (has uppercase). This is the
    // worst case for backtracking because the engine tries all lookaheads.
    const chunk = "AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGh"; // 34 chars, no digits
    const input = chunk.repeat(Math.ceil(1_000_000 / chunk.length));
    const start = performance.now();
    scanForSecrets(input);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(1000);
  });

  test("redactSecrets completes on 1 MB near-miss input in < 1 s", () => {
    const chunk = "AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGh";
    const input = chunk.repeat(Math.ceil(1_000_000 / chunk.length));
    const start = performance.now();
    redactSecrets(input);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(1000);
  });
});
