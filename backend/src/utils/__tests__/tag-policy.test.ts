/**
 * Tests for validateTagsAgainstPolicy — CIT-042 PR2 pure tag-policy
 * enforcement validator.
 */
import fc from "fast-check";
import {
  validateTagsAgainstPolicy,
  type TagPolicy,
  type TagPolicyRule,
  type TagValidationResult,
} from "../../utils/tag-policy";

// ─── Helpers ────────────────────────────────────────────────────────────

function makePolicy(rules: TagPolicyRule[]): TagPolicy {
  return {
    requiredKeys: rules,
    version: 1,
    updatedBy: "test-user",
    updatedAt: new Date().toISOString(),
  };
}

// ─── Unit tests ─────────────────────────────────────────────────────────

describe("validateTagsAgainstPolicy", () => {
  describe("null policy (no org policy configured)", () => {
    it("returns ok when policy is null", () => {
      const result = validateTagsAgainstPolicy(null, { env: "prod" });
      expect(result).toEqual({ ok: true, violations: [] });
    });

    it("returns ok when policy is null and tags are undefined", () => {
      const result = validateTagsAgainstPolicy(null, undefined);
      expect(result).toEqual({ ok: true, violations: [] });
    });

    it("returns ok when policy is null and tags are null", () => {
      const result = validateTagsAgainstPolicy(null, null);
      expect(result).toEqual({ ok: true, violations: [] });
    });
  });

  describe("empty policy (no required keys)", () => {
    it("returns ok with no required keys", () => {
      const policy = makePolicy([]);
      const result = validateTagsAgainstPolicy(policy, { anything: "goes" });
      expect(result).toEqual({ ok: true, violations: [] });
    });

    it("returns ok with undefined tags and empty required keys", () => {
      const policy = makePolicy([]);
      expect(validateTagsAgainstPolicy(policy, undefined)).toEqual({
        ok: true,
        violations: [],
      });
    });
  });

  describe("MISSING_KEY violations", () => {
    it("reports a single missing required key", () => {
      const policy = makePolicy([{ key: "env" }]);
      const result = validateTagsAgainstPolicy(policy, {});
      expect(result.ok).toBe(false);
      expect(result.violations).toEqual([{ type: "MISSING_KEY", key: "env" }]);
    });

    it("reports multiple missing required keys", () => {
      const policy = makePolicy([{ key: "env" }, { key: "team" }]);
      const result = validateTagsAgainstPolicy(policy, {});
      expect(result.ok).toBe(false);
      expect(result.violations).toHaveLength(2);
      expect(result.violations[0]).toEqual({
        type: "MISSING_KEY",
        key: "env",
      });
      expect(result.violations[1]).toEqual({
        type: "MISSING_KEY",
        key: "team",
      });
    });

    it("reports missing key when tags are undefined", () => {
      const policy = makePolicy([{ key: "env" }]);
      const result = validateTagsAgainstPolicy(policy, undefined);
      expect(result.ok).toBe(false);
      expect(result.violations).toEqual([{ type: "MISSING_KEY", key: "env" }]);
    });

    it("reports missing key when tags are null", () => {
      const policy = makePolicy([{ key: "env" }]);
      const result = validateTagsAgainstPolicy(policy, null);
      expect(result.ok).toBe(false);
      expect(result.violations).toEqual([{ type: "MISSING_KEY", key: "env" }]);
    });
  });

  describe("INVALID_VALUE violations", () => {
    it("reports invalid value when key present but value not in allowedValues", () => {
      const policy = makePolicy([
        { key: "env", allowedValues: ["prod", "staging", "dev"] },
      ]);
      const result = validateTagsAgainstPolicy(policy, { env: "test" });
      expect(result.ok).toBe(false);
      expect(result.violations).toEqual([
        {
          type: "INVALID_VALUE",
          key: "env",
          suppliedValue: "test",
          allowedValues: ["prod", "staging", "dev"],
        },
      ]);
    });

    it("accepts value when it matches one of the allowedValues", () => {
      const policy = makePolicy([
        { key: "env", allowedValues: ["prod", "staging"] },
      ]);
      const result = validateTagsAgainstPolicy(policy, { env: "prod" });
      expect(result).toEqual({ ok: true, violations: [] });
    });

    it("accepts any value when allowedValues is undefined", () => {
      const policy = makePolicy([{ key: "env" }]);
      const result = validateTagsAgainstPolicy(policy, {
        env: "literally-anything",
      });
      expect(result).toEqual({ ok: true, violations: [] });
    });

    it("accepts any value when allowedValues is empty", () => {
      const policy = makePolicy([{ key: "env", allowedValues: [] }]);
      const result = validateTagsAgainstPolicy(policy, {
        env: "literally-anything",
      });
      expect(result).toEqual({ ok: true, violations: [] });
    });
  });

  describe("mixed violations", () => {
    it("reports both MISSING_KEY and INVALID_VALUE in one pass", () => {
      const policy = makePolicy([
        { key: "env", allowedValues: ["prod", "staging"] },
        { key: "team" },
      ]);
      const result = validateTagsAgainstPolicy(policy, { env: "oops" });
      expect(result.ok).toBe(false);
      expect(result.violations).toHaveLength(2);
      expect(result.violations[0].type).toBe("INVALID_VALUE");
      expect(result.violations[0].key).toBe("env");
      expect(result.violations[1].type).toBe("MISSING_KEY");
      expect(result.violations[1].key).toBe("team");
    });
  });

  describe("extra keys are ignored", () => {
    it("passes when required keys are present despite extra keys", () => {
      const policy = makePolicy([{ key: "env" }]);
      const result = validateTagsAgainstPolicy(policy, {
        env: "prod",
        extra: "ignored",
      });
      expect(result).toEqual({ ok: true, violations: [] });
    });
  });
});

// ─── Property-based tests ───────────────────────────────────────────────

describe("validateTagsAgainstPolicy (property tests)", () => {
  /**
   * Core property: ok is true if and only if EVERY required key is present
   * AND its value is in allowedValues (when defined).
   */
  it("ok iff every required key present with valid value", () => {
    // Arbitrary rule: key is a short alpha string, allowedValues is an
    // optional small set of short strings.
    const arbRule: fc.Arbitrary<TagPolicyRule> = fc
      .record({
        key: fc.stringMatching(/^[a-z]{1,8}$/),
        allowedValues: fc.option(
          fc.uniqueArray(fc.stringMatching(/^[a-z0-9]{1,10}$/), {
            minLength: 1,
            maxLength: 5,
          }),
          { nil: undefined },
        ),
      })
      .filter((r) => r.key.length > 0);

    const arbPolicy: fc.Arbitrary<TagPolicy> = fc
      .uniqueArray(arbRule, {
        minLength: 0,
        maxLength: 5,
        selector: (r) => r.key,
      })
      .map((rules) => makePolicy(rules));

    // Build tags that may or may not satisfy the policy
    const arbInput: fc.Arbitrary<{
      policy: TagPolicy;
      tags: Record<string, string>;
    }> = arbPolicy.chain((policy) => {
      // For each rule, optionally include the key with a value that may or
      // may not be in allowedValues.
      const tagEntries = policy.requiredKeys.map((rule) => {
        return fc.oneof(
          // absent — don't include this key
          fc.constant(null as [string, string] | null),
          // present with a value from allowedValues (valid)
          ...(rule.allowedValues && rule.allowedValues.length > 0
            ? [
                fc
                  .constantFrom(...rule.allowedValues)
                  .map((v) => [rule.key, v] as [string, string]),
              ]
            : []),
          // present with an arbitrary value (may be invalid)
          fc
            .stringMatching(/^[a-z0-9]{1,10}$/)
            .map((v) => [rule.key, v] as [string, string]),
        );
      });

      return fc
        .tuple(
          ...(tagEntries.length > 0
            ? tagEntries
            : [fc.constant(null as [string, string] | null)]),
        )
        .map((entries) => {
          const tags: Record<string, string> = {};
          for (const entry of entries) {
            if (entry !== null) {
              tags[entry[0]] = entry[1];
            }
          }
          return { policy, tags };
        });
    });

    fc.assert(
      fc.property(arbInput, ({ policy, tags }) => {
        const result: TagValidationResult = validateTagsAgainstPolicy(
          policy,
          tags,
        );

        // Compute expected ok independently
        const expectedOk = policy.requiredKeys.every((rule) => {
          if (!(rule.key in tags)) return false;
          if (
            rule.allowedValues &&
            rule.allowedValues.length > 0 &&
            !rule.allowedValues.includes(tags[rule.key])
          ) {
            return false;
          }
          return true;
        });

        expect(result.ok).toBe(expectedOk);

        // When not ok, every violation key must be a required key
        if (!result.ok) {
          for (const v of result.violations) {
            expect(policy.requiredKeys.map((r) => r.key)).toContain(v.key);
          }
        }

        // When ok, violations must be empty
        if (result.ok) {
          expect(result.violations).toHaveLength(0);
        }
      }),
      { numRuns: 500 },
    );
  });

  it("null policy always returns ok regardless of tags", () => {
    fc.assert(
      fc.property(
        fc.option(
          fc.dictionary(
            fc.stringMatching(/^[a-z]{1,8}$/),
            fc.stringMatching(/^[a-z0-9]{1,10}$/),
          ),
          { nil: undefined },
        ),
        (tags) => {
          const result = validateTagsAgainstPolicy(null, tags);
          expect(result.ok).toBe(true);
          expect(result.violations).toHaveLength(0);
        },
      ),
      { numRuns: 100 },
    );
  });
});
