/**
 * Tests for secret-ref-safety.ts — CIT-254 SH-3.
 *
 * Table-driven vectors cover: valid path-style and ARN-style refs, wrong org,
 * non-Citadel-namespaced secrets, type constraints.
 */

import {
  assertSecretRefInOrgNamespace,
  SecretRefRejectedError,
} from "../secret-ref-safety";

const ORG_A = "org-alpha";
const ORG_B = "org-beta";

// ---------------------------------------------------------------------------
// Path-style refs
// ---------------------------------------------------------------------------

describe("assertSecretRefInOrgNamespace — path-style", () => {
  const accepts: Array<{
    label: string;
    ref: string;
    org: string;
    type?: string;
  }> = [
    {
      label: "agent secret for own org",
      ref: `/citadel/agents/${ORG_A}/secret-123`,
      org: ORG_A,
    },
    {
      label: "integration secret for own org",
      ref: `/citadel/integrations/${ORG_A}/confluence-int-456`,
      org: ORG_A,
    },
    {
      label: "agent secret with type constraint",
      ref: `/citadel/agents/${ORG_A}/secret-123`,
      org: ORG_A,
      type: "agents",
    },
    {
      label: "deep resource path",
      ref: `/citadel/agents/${ORG_A}/sub/path/secret`,
      org: ORG_A,
    },
  ];

  it.each(accepts)("accepts: $label", ({ ref, org, type }) => {
    expect(() =>
      assertSecretRefInOrgNamespace(ref, org, { type }),
    ).not.toThrow();
  });

  const rejections: Array<{
    label: string;
    ref: string;
    org: string;
    type?: string;
  }> = [
    {
      label: "different org",
      ref: `/citadel/agents/${ORG_B}/secret-123`,
      org: ORG_A,
    },
    {
      label: "wrong type constraint",
      ref: `/citadel/integrations/${ORG_A}/connector-1`,
      org: ORG_A,
      type: "agents",
    },
    {
      label: "non-Citadel path",
      ref: "my-other-secret",
      org: ORG_A,
    },
    {
      label: "bare secret name",
      ref: "admin-password",
      org: ORG_A,
    },
    {
      label: "path too short (no resourceId)",
      ref: `/citadel/agents/${ORG_A}`,
      org: ORG_A,
    },
    {
      label: "empty ref",
      ref: "",
      org: ORG_A,
    },
    {
      label: "empty org",
      ref: `/citadel/agents/any-org/secret`,
      org: "",
    },
    // Adversarial vectors — traversal, whitespace, missing leading slash
    {
      label: "path traversal ../orgB escapes org namespace",
      ref: `/citadel/agents/${ORG_A}/../${ORG_B}/secret-x`,
      org: ORG_A,
    },
    {
      label: "missing leading slash",
      ref: `citadel/agents/${ORG_A}/secret-123`,
      org: ORG_A,
    },
    {
      label: "trailing newline in ref",
      ref: `/citadel/agents/${ORG_A}/secret-123\n`,
      org: ORG_A,
    },
    {
      label: "trailing space in ref",
      ref: `/citadel/agents/${ORG_A}/secret-123 `,
      org: ORG_A,
    },
    {
      label: "tab character in ref",
      ref: `/citadel/agents/${ORG_A}/secret\t123`,
      org: ORG_A,
    },
  ];

  it.each(rejections)("rejects: $label", ({ ref, org, type }) => {
    expect(() => assertSecretRefInOrgNamespace(ref, org, { type })).toThrow(
      SecretRefRejectedError,
    );
    expect(() => assertSecretRefInOrgNamespace(ref, org, { type })).toThrow(
      "Access denied",
    );
  });
});

// ---------------------------------------------------------------------------
// ARN-style refs
// ---------------------------------------------------------------------------

describe("assertSecretRefInOrgNamespace — ARN-style", () => {
  const ACCOUNT = "123456789012";
  const REGION = "us-east-1";

  it("accepts own-org agent secret ARN", () => {
    const ref = `arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:/citadel/agents/${ORG_A}/sec-123-AbCdEf`;
    expect(() => assertSecretRefInOrgNamespace(ref, ORG_A)).not.toThrow();
  });

  it("accepts own-org integration secret ARN", () => {
    const ref = `arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:/citadel/integrations/${ORG_A}/conf-int-1-XyZaBC`;
    expect(() => assertSecretRefInOrgNamespace(ref, ORG_A)).not.toThrow();
  });

  const rejections: Array<{ label: string; ref: string; org: string }> = [
    {
      label: "ARN with different org",
      ref: `arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:/citadel/agents/${ORG_B}/sec-123-AbCdEf`,
      org: ORG_A,
    },
    {
      label: "ARN with non-Citadel secret name",
      ref: `arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:admin-password-AbCdEf`,
      org: ORG_A,
    },
    {
      label: "not a secretsmanager ARN",
      ref: `arn:aws:iam::${ACCOUNT}:role/my-role`,
      org: ORG_A,
    },
    {
      label: "truncated ARN",
      ref: `arn:aws:secretsmanager:${REGION}:${ACCOUNT}`,
      org: ORG_A,
    },
  ];

  it.each(rejections)("rejects: $label", ({ ref, org }) => {
    expect(() => assertSecretRefInOrgNamespace(ref, org)).toThrow(
      SecretRefRejectedError,
    );
  });

  it("every rejection has the same opaque message", () => {
    const allRejections = rejections;
    const messages = allRejections.map(({ ref, org }) => {
      try {
        assertSecretRefInOrgNamespace(ref, org);
        return "";
      } catch (e) {
        return (e as Error).message;
      }
    });
    expect(new Set(messages).size).toBe(1);
    expect(messages[0]).toBe("Access denied");
  });
});
