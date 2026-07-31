/**
 * Unit tests for the FRONTEND_ORIGIN resolver (finding d7d3dd61).
 *
 * Covers: precedence (env > context > placeholder), trailing-slash
 * normalization, and the placeholder+warn decision helper. Pure functions —
 * no CDK synth required (that's covered separately in telemetry-stack.test.ts
 * and app-frontend-origin.test.ts).
 */
import {
  FRONTEND_ORIGIN_PLACEHOLDER,
  normalizeOrigin,
  remediationMessage,
  resolveFrontendOrigin,
  shouldWarnOnPlaceholder,
} from "../frontend-origin";

describe("normalizeOrigin", () => {
  it("strips a single trailing slash", () => {
    expect(normalizeOrigin("https://example.com/")).toBe("https://example.com");
  });

  it("leaves an origin with no trailing slash unchanged", () => {
    expect(normalizeOrigin("https://example.com")).toBe("https://example.com");
  });

  it("does not strip slashes that are part of a path, only the trailing one", () => {
    expect(normalizeOrigin("https://example.com/app/")).toBe(
      "https://example.com/app",
    );
  });
});

describe("resolveFrontendOrigin — precedence", () => {
  it("prefers the env var over context when both are set", () => {
    const result = resolveFrontendOrigin(
      "https://env.example.com",
      "https://context.example.com",
    );
    expect(result).toEqual({
      origin: "https://env.example.com",
      isPlaceholder: false,
    });
  });

  it("falls back to context when env var is unset", () => {
    const result = resolveFrontendOrigin(
      undefined,
      "https://context.example.com",
    );
    expect(result).toEqual({
      origin: "https://context.example.com",
      isPlaceholder: false,
    });
  });

  it("falls back to context when env var is empty string", () => {
    const result = resolveFrontendOrigin("", "https://context.example.com");
    expect(result).toEqual({
      origin: "https://context.example.com",
      isPlaceholder: false,
    });
  });

  it("falls back to the placeholder when both env var and context are unset", () => {
    const result = resolveFrontendOrigin(undefined, undefined);
    expect(result).toEqual({
      origin: FRONTEND_ORIGIN_PLACEHOLDER,
      isPlaceholder: true,
    });
  });

  it("falls back to the placeholder when both env var and context are empty strings", () => {
    const result = resolveFrontendOrigin("", "");
    expect(result).toEqual({
      origin: FRONTEND_ORIGIN_PLACEHOLDER,
      isPlaceholder: true,
    });
  });

  it("normalizes a trailing slash from the env var", () => {
    const result = resolveFrontendOrigin("https://env.example.com/", undefined);
    expect(result.origin).toBe("https://env.example.com");
  });

  it("normalizes a trailing slash from the context value", () => {
    const result = resolveFrontendOrigin(
      undefined,
      "https://context.example.com/",
    );
    expect(result.origin).toBe("https://context.example.com");
  });
});

describe("shouldWarnOnPlaceholder", () => {
  it("returns false for the local environment", () => {
    expect(shouldWarnOnPlaceholder("local")).toBe(false);
  });

  it("returns false for the test environment", () => {
    expect(shouldWarnOnPlaceholder("test")).toBe(false);
  });

  it("is case-insensitive for silent environments", () => {
    expect(shouldWarnOnPlaceholder("LOCAL")).toBe(false);
    expect(shouldWarnOnPlaceholder("Test")).toBe(false);
  });

  it("returns true for dev", () => {
    expect(shouldWarnOnPlaceholder("dev")).toBe(true);
  });

  it("returns true for staging", () => {
    expect(shouldWarnOnPlaceholder("staging")).toBe(true);
  });

  it("returns true for prod", () => {
    expect(shouldWarnOnPlaceholder("prod")).toBe(true);
  });
});

describe("remediationMessage", () => {
  it("includes the placeholder origin so the warning is self-explanatory", () => {
    expect(remediationMessage("dev")).toContain(FRONTEND_ORIGIN_PLACEHOLDER);
  });

  it("includes an exact, copy-pasteable remediation command referencing the environment", () => {
    const msg = remediationMessage("dev");
    expect(msg).toContain("citadel-frontend-dev");
    expect(msg).toContain("citadel-telemetry-dev");
    expect(msg).toContain(
      "FRONTEND_ORIGIN=$(aws cloudformation describe-stacks",
    );
    expect(msg).toContain("./deploy.sh citadel-telemetry-dev");
  });

  it("documents the bootstrap-ordering rationale (warning, not a throw)", () => {
    const msg = remediationMessage("dev");
    expect(msg).toMatch(/fresh-account bootstrap/i);
  });
});
