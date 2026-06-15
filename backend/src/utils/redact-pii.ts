/**
 * PII redaction utility.
 *
 * Replaces common PII tokens with [REDACTED:<type>] sentinels. Idempotent —
 * calling redactPII(redactPII(x)) returns redactPII(x).
 *
 * Patterns covered:
 * - Email addresses (simplified RFC 5322 practical pattern)
 * - Phone numbers (E.164 + US-style hyphenated)
 * - AWS account IDs (12-digit runs)
 * - AWS access-key IDs (AKIA*, ASIA*)
 * - Credit-card-like numbers (13–19 digit runs)
 *
 * Ordering matters: we redact email first (emails contain @+host which could
 * trip other detectors), then AWS access keys (prefix-anchored), then AWS
 * account IDs (12-digit runs), then credit cards (13–19 digit runs), then
 * phones (most permissive).
 */

// Email local-part covers RFC 5322 atext: alphanumerics plus!#$%&'*+-/=?^_`{|}~
// and dots (.) as separators. Domain is standard host.tld form.
// QB-003-1 fix: atext + domain-label quantifiers bounded per RFC 5321/1035.
const EMAIL_RE = /[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~.]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})*\.[A-Za-z]{2,63}/g;
const AWS_ACCESS_KEY_RE = /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g;
const AWS_ACCOUNT_ID_RE = /\b\d{12}\b/g;
const CC_RE = /\b\d{13,19}\b/g;
const PHONE_E164_RE = /\+\d{7,15}/g;
const PHONE_US_RE = /\b\d{3}-\d{3,4}(?:-\d{4})?\b/g;

export function redactPII(text: string): string {
  if (!text) return text;
  let out = text;
  out = out.replace(EMAIL_RE, '[REDACTED:email]');
  out = out.replace(AWS_ACCESS_KEY_RE, '[REDACTED:aws-access-key-id]');
  out = out.replace(AWS_ACCOUNT_ID_RE, '[REDACTED:aws-account-id]');
  out = out.replace(CC_RE, '[REDACTED:cc]');
  out = out.replace(PHONE_E164_RE, '[REDACTED:phone]');
  out = out.replace(PHONE_US_RE, '[REDACTED:phone]');
  return out;
}
