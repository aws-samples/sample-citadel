/**
 * replay-sanitize.ts — deep-walk bundle sanitizer (CIT-026 design §1c).
 * `sanitizeBundle` recursively redacts PII + secrets from every string at
 * every nesting depth. Property-tested with fast-check per the design's
 * "survival property": for ALL inputs (depth generator-controlled),
 * scanForSecrets(JSON.stringify(sanitizeBundle(x))) === [].
 */
import fc from "fast-check";
import { sanitizeBundle } from "../replay-sanitize";
import { scanForSecrets } from "../../../utils/secret-patterns";
// Fixture values below are assembled from fragments, never written as
// contiguous literals — see secret-fixture-helper.ts's file header for why.
import {
  githubToken,
  stripeLiveSecretKey,
  slackBotToken,
  googleApiKey,
  postgresUriWithCreds,
  awsAccessKeyId,
} from "../../../utils/__tests__/secret-fixture-helper";

const SECRET_SAMPLES = [
  githubToken(),
  stripeLiveSecretKey(),
  slackBotToken(),
  googleApiKey(),
  postgresUriWithCreds(),
  "token=supersecretvalue123",
];

const PII_SAMPLES = ["someone@example.com", awsAccessKeyId(), "+14155551234"];

/** Builds a nested container (object or array) of a given depth with a
 * planted leaf value at the bottom. */
function nestValue(value: unknown, depth: number): unknown {
  let node = value;
  for (let i = 0; i < depth; i++) {
    node =
      i % 2 === 0 ? { child: node, other: "benign text" } : [node, "benign"];
  }
  return node;
}

describe("sanitizeBundle — survival property (every secret/PII class, every depth)", () => {
  const allSecrets = [...SECRET_SAMPLES, ...PII_SAMPLES];

  test.each(allSecrets)(
    "planted secret %s is removed at depth 0 (top-level string)",
    (secret) => {
      const bundle = { field: secret };
      const sanitized = sanitizeBundle(bundle);
      expect(scanForSecrets(JSON.stringify(sanitized))).toEqual([]);
    },
  );

  test.each(allSecrets)(
    "planted secret %s is removed at depth 5 (deep nesting)",
    (secret) => {
      const bundle = nestValue(secret, 5);
      const sanitized = sanitizeBundle(bundle);
      expect(scanForSecrets(JSON.stringify(sanitized))).toEqual([]);
    },
  );

  test("planted secret inside an array of objects is removed", () => {
    const bundle = {
      nodes: [
        { id: "n1", output: "clean" },
        {
          id: "n2",
          output: `leaked key: ${githubToken()}`,
        },
      ],
    };
    const sanitized = sanitizeBundle(bundle);
    expect(scanForSecrets(JSON.stringify(sanitized))).toEqual([]);
  });

  test("planted secret inside a JSON-encoded string field is removed (parse-redact-reserialize)", () => {
    const inner = JSON.stringify({
      apiKey: stripeLiveSecretKey(),
    });
    const bundle = { nodeOutputJson: inner };
    const sanitized = sanitizeBundle(bundle) as { nodeOutputJson: string };
    expect(scanForSecrets(sanitized.nodeOutputJson)).toEqual([]);
  });

  test("fast-check: for all generated nested structures with a planted secret at a random depth, the survival property holds", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...allSecrets),
        fc.integer({ min: 0, max: 8 }),
        (secret, depth) => {
          const bundle = nestValue(secret, depth);
          const sanitized = sanitizeBundle(bundle);
          return scanForSecrets(JSON.stringify(sanitized)).length === 0;
        },
      ),
      { numRuns: 50 },
    );
  });
});

describe("sanitizeBundle — idempotency", () => {
  test("sanitizeBundle(sanitizeBundle(x)) deep-equals sanitizeBundle(x)", () => {
    const bundle = {
      a: "contact me at someone@example.com",
      b: [githubToken(), { c: stripeLiveSecretKey() }],
    };
    const once = sanitizeBundle(bundle);
    const twice = sanitizeBundle(once);
    expect(twice).toEqual(once);
  });
});

describe("sanitizeBundle — leaves keys, non-string values, and benign content untouched", () => {
  test("object keys are never redacted", () => {
    const sanitized = sanitizeBundle({
      password: "irrelevant-benign-value-x",
    }) as Record<string, unknown>;
    expect(Object.keys(sanitized)).toContain("password");
  });

  test("numbers, booleans, and null pass through unchanged", () => {
    const bundle = { count: 42, active: true, missing: null };
    expect(sanitizeBundle(bundle)).toEqual(bundle);
  });

  test("benign strings are unmodified", () => {
    const bundle = { status: "completed", nodeId: "node-1" };
    expect(sanitizeBundle(bundle)).toEqual(bundle);
  });
});
