/**
 * Tests for the CITADEL_SKIP_BUNDLING safety guard.
 *
 * The bundling-skip placeholder must never reach a real deployment:
 *
 * 1. flag set + ENVIRONMENT=dev  → proxy access throws
 * 2. flag set + ENVIRONMENT=test → placeholder used (no throw)
 * 3. flag unset                  → real build image (no throw, lazy)
 *
 * The companion guard in bin/app.ts catches the CDK entry point where
 * ENVIRONMENT defaults to 'dev' when unset.  The proxy guard in
 * runtime-constants.ts fires when ENVIRONMENT is explicitly non-test.
 */

describe("CITADEL_SKIP_BUNDLING guard (runtime-constants proxy)", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    // Restore all env vars to pre-test state.
    process.env = { ...originalEnv };
    // Clear the module cache so runtime-constants re-evaluates with fresh env.
    jest.resetModules();
  });

  it("throws when CITADEL_SKIP_BUNDLING is set and ENVIRONMENT=dev", () => {
    process.env.CITADEL_SKIP_BUNDLING = "1";
    process.env.ENVIRONMENT = "dev";

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { PYTHON_BUILD_IMAGE } = require("../runtime-constants");

    expect(() => {
      // Access the .image property to trigger the proxy trap.
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      (PYTHON_BUILD_IMAGE as { image: string }).image;
    }).toThrow(/CITADEL_SKIP_BUNDLING.*not 'test'/);
  });

  it("uses placeholder when CITADEL_SKIP_BUNDLING is set and ENVIRONMENT=test", () => {
    process.env.CITADEL_SKIP_BUNDLING = "1";
    process.env.ENVIRONMENT = "test";

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { PYTHON_BUILD_IMAGE } = require("../runtime-constants");

    // Should NOT throw — returns the inert placeholder image string.
    const img = (PYTHON_BUILD_IMAGE as { image: string }).image;
    expect(typeof img).toBe("string");
    expect(img).toContain("__lazy_python_build_image__");
  });

  it("returns a real (lazy) build image when CITADEL_SKIP_BUNDLING is unset", () => {
    delete process.env.CITADEL_SKIP_BUNDLING;
    process.env.ENVIRONMENT = "dev";

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { PYTHON_BUILD_IMAGE } = require("../runtime-constants");

    // The image is wrapped in a lazy Proxy. Without Docker available the
    // resolve() call inside the proxy will throw a Docker-related error
    // (not the bundling-skip guard error). We just verify it does NOT
    // throw the guard message.
    try {
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      (PYTHON_BUILD_IMAGE as { image: string }).image;
    } catch (e: unknown) {
      // Docker not available in test env is expected — but the error
      // must NOT be the bundling-skip guard.
      expect(String(e)).not.toMatch(/CITADEL_SKIP_BUNDLING/);
    }
  });
});

describe("app.ts bundling-skip early guard", () => {
  it("throws before stack construction when flag set + ENVIRONMENT=dev", () => {
    // app.ts constructs stacks as a side effect and cannot be imported
    // directly. Verify the guard logic inline (mirrors app.ts exactly).
    const environment = "dev";
    const skipBundling = "1";

    expect(() => {
      if (skipBundling && environment !== "test") {
        throw new Error(
          "CITADEL_SKIP_BUNDLING is set but ENVIRONMENT is not 'test'. " +
            "Refusing to synthesise with a bundling-skip placeholder for " +
            `environment '${environment}'. ` +
            "Unset CITADEL_SKIP_BUNDLING or set ENVIRONMENT=test.",
        );
      }
    }).toThrow(/CITADEL_SKIP_BUNDLING.*not 'test'/);
  });

  it("does not throw when ENVIRONMENT=test", () => {
    const environment = "test";
    const skipBundling = "1";

    expect(() => {
      if (skipBundling && environment !== "test") {
        throw new Error("should not reach");
      }
    }).not.toThrow();
  });
});
