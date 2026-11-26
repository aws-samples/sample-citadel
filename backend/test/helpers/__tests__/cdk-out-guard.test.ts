/**
 * Unit tests for guardCdkOutInCi (finding e051a3c6).
 *
 * TDD note: these were run RED (helper threw unconditionally / did nothing
 * conditionally) before the implementation in ../cdk-out-guard.ts existed,
 * then GREEN against the final implementation. See the finding's fix
 * commits for the CI-side proof (CI=true + missing cdk.out => named
 * failure; CI unset => skip preserved; post-synth => pass).
 */
import { guardCdkOutInCi } from "../cdk-out-guard";

describe("guardCdkOutInCi", () => {
  const originalCi = process.env.CI;

  afterEach(() => {
    if (originalCi === undefined) {
      delete process.env.CI;
    } else {
      process.env.CI = originalCi;
    }
  });

  it("throws naming the missing synth step when CI is truthy", () => {
    process.env.CI = "true";
    expect(() =>
      guardCdkOutInCi("citadel-backend-dev", "npx cdk synth --all"),
    ).toThrow(/npx cdk synth --all/);
  });

  it("throws an error that names the missing description", () => {
    process.env.CI = "true";
    expect(() =>
      guardCdkOutInCi("citadel-arbiter-dev, citadel-backend-dev", "cdk synth --all"),
    ).toThrow(/citadel-arbiter-dev, citadel-backend-dev/);
  });

  it("does not throw when CI is unset (plain local run keeps skip semantics)", () => {
    delete process.env.CI;
    expect(() =>
      guardCdkOutInCi("citadel-backend-dev", "npx cdk synth --all"),
    ).not.toThrow();
  });

  it("does not throw when CI is falsy empty string", () => {
    process.env.CI = "";
    expect(() =>
      guardCdkOutInCi("citadel-backend-dev", "npx cdk synth --all"),
    ).not.toThrow();
  });
});
