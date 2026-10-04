import { parseTagPolicyViolation } from '../tag-policy-errors';

describe('parseTagPolicyViolation', () => {
  describe('positive — recognises tag-policy errors', () => {
    it('parses missing-key violations from a simple message', () => {
      const err = new Error(
        'tag_policy_violation: missing required keys: env',
      );
      const result = parseTagPolicyViolation(err);
      expect(result).not.toBeNull();
      expect(result!.violations).toEqual([
        { type: 'MISSING_KEY', key: 'env' },
      ]);
      expect(result!.action).toBe('ENFORCE');
    });

    it('parses multiple missing keys', () => {
      const err = new Error(
        'tag_policy_violation: missing required keys: env, team, cost-center',
      );
      const result = parseTagPolicyViolation(err);
      expect(result).not.toBeNull();
      expect(result!.violations).toHaveLength(3);
      expect(result!.violations.map((v) => v.key)).toEqual([
        'env',
        'team',
        'cost-center',
      ]);
    });

    it('parses invalid-value violations', () => {
      const err = new Error(
        'tag_policy_violation: invalid values for keys: team',
      );
      const result = parseTagPolicyViolation(err);
      expect(result).not.toBeNull();
      expect(result!.violations).toEqual([
        { type: 'INVALID_VALUE', key: 'team' },
      ]);
    });

    it('parses mixed missing + invalid', () => {
      const err = new Error(
        'tag_policy_violation: missing required keys: env; invalid values for keys: team',
      );
      const result = parseTagPolicyViolation(err);
      expect(result).not.toBeNull();
      expect(result!.violations).toHaveLength(2);
      expect(result!.violations[0]).toEqual({ type: 'MISSING_KEY', key: 'env' });
      expect(result!.violations[1]).toEqual({ type: 'INVALID_VALUE', key: 'team' });
    });

    it('detects the tag-policy segment inside a joined message', () => {
      const err = new Error(
        'Some unrelated error, tag_policy_violation: missing required keys: env',
      );
      const result = parseTagPolicyViolation(err);
      expect(result).not.toBeNull();
      expect(result!.violations[0].key).toBe('env');
    });

    it('accepts a plain string as input', () => {
      const result = parseTagPolicyViolation(
        'tag_policy_violation: missing required keys: env',
      );
      expect(result).not.toBeNull();
      expect(result!.violations[0].key).toBe('env');
    });

    it('accepts an object with a message property', () => {
      const result = parseTagPolicyViolation({
        message: 'tag_policy_violation: missing required keys: env',
      });
      expect(result).not.toBeNull();
    });

    it('returns a fallback violation when the prefix matches but no keys are parseable', () => {
      const result = parseTagPolicyViolation(
        new Error('tag_policy_violation: something unexpected'),
      );
      expect(result).not.toBeNull();
      expect(result!.violations).toHaveLength(1);
      expect(result!.violations[0].key).toBe('unknown');
    });

    it('detects WARN action when the message contains warn', () => {
      const result = parseTagPolicyViolation(
        new Error('tag_policy_violation: warn: missing required keys: env'),
      );
      expect(result).not.toBeNull();
      expect(result!.action).toBe('WARN');
    });
  });

  describe('negative — returns null for non-tag-policy errors', () => {
    it('returns null for a generic Error', () => {
      expect(parseTagPolicyViolation(new Error('Network error'))).toBeNull();
    });

    it('returns null for an approval_absent error', () => {
      expect(
        parseTagPolicyViolation(new Error('approval_absent:DRAFT')),
      ).toBeNull();
    });

    it('returns null for null input', () => {
      expect(parseTagPolicyViolation(null)).toBeNull();
    });

    it('returns null for undefined input', () => {
      expect(parseTagPolicyViolation(undefined)).toBeNull();
    });

    it('returns null for a number', () => {
      expect(parseTagPolicyViolation(42)).toBeNull();
    });
  });
});
