/**
 * move-manifest.ts hardcoded satellite stack names and MOVED_RESOLVERS /
 * MOVED_LAMBDA_ROLES keys to the `-dev` suffix. Running the split gates
 * with ENVIRONMENT=test therefore diffed a fresh test-env synth against
 * dev-suffixed manifest data, producing large spurious rail 3/6/7
 * failures that look like baseline staleness (they are not — see decision
 * 453d1acc, which forbids regenerating the committed baseline).
 *
 * These tests assert:
 *   1. The manifest derives satellite stack names / mapping keys from a
 *      given environment (covering both "dev" and a non-dev "test" value).
 *   2. Gate invocation with a non-dev environment fails fast with a loud,
 *      explicit message stating test-env runs are unsupported and that any
 *      resulting failures are NOT baseline staleness.
 */
import {
  satelliteStackNamesFor,
  movedResolversFor,
  movedLambdaRolesFor,
  assertDevOnlyGateEnvironment,
  SATELLITE_STACK_NAMES,
  MOVED_RESOLVERS,
  MOVED_LAMBDA_ROLES,
} from "../split-gates/move-manifest";

describe("move-manifest — environment-derived satellite stack names", () => {
  it("derives dev satellite stack names for environment 'dev'", () => {
    expect(satelliteStackNamesFor("dev")).toEqual([
      "citadel-projects-dev",
      "citadel-registry-dev",
    ]);
  });

  it("derives test satellite stack names for environment 'test'", () => {
    expect(satelliteStackNamesFor("test")).toEqual([
      "citadel-projects-test",
      "citadel-registry-test",
    ]);
  });

  it("defaults to dev when no environment is given", () => {
    expect(satelliteStackNamesFor()).toEqual(satelliteStackNamesFor("dev"));
  });

  it("SATELLITE_STACK_NAMES (default export) still matches the dev derivation", () => {
    expect(SATELLITE_STACK_NAMES).toEqual(satelliteStackNamesFor("dev"));
  });
});

describe("move-manifest — environment-derived MOVED_RESOLVERS", () => {
  it("re-keys every satelliteStackName to the given environment's suffix, same fieldKeys and count", () => {
    const dev = movedResolversFor("dev");
    const test = movedResolversFor("test");

    expect(test).toHaveLength(dev.length);
    expect(test.map((r) => r.fieldKey)).toEqual(dev.map((r) => r.fieldKey));

    for (let i = 0; i < dev.length; i++) {
      expect(dev[i].satelliteStackName.endsWith("-dev")).toBe(true);
      expect(test[i].satelliteStackName.endsWith("-test")).toBe(true);
      // same stack family (projects vs registry), different suffix only
      expect(test[i].satelliteStackName).toBe(
        dev[i].satelliteStackName.replace(/-dev$/, "-test"),
      );
    }
  });

  it("movedResolversFor('dev') matches the legacy MOVED_RESOLVERS export exactly", () => {
    expect(movedResolversFor("dev")).toEqual(MOVED_RESOLVERS);
  });

  it("contains a known field key mapped to the correctly-suffixed projects stack", () => {
    const test = movedResolversFor("test");
    const getProject = test.find((r) => r.fieldKey === "Query.getProject");
    expect(getProject).toBeDefined();
    expect(getProject?.satelliteStackName).toBe("citadel-projects-test");
  });
});

describe("move-manifest — environment-derived MOVED_LAMBDA_ROLES", () => {
  it("re-keys every satelliteStackName to the given environment's suffix, same logical-id pairs", () => {
    const dev = movedLambdaRolesFor("dev");
    const test = movedLambdaRolesFor("test");

    expect(test).toHaveLength(dev.length);

    for (let i = 0; i < dev.length; i++) {
      expect(dev[i].baselineLogicalId).toBe(test[i].baselineLogicalId);
      expect(dev[i].satelliteLogicalId).toBe(test[i].satelliteLogicalId);
      expect(test[i].satelliteStackName).toBe(
        dev[i].satelliteStackName.replace(/-dev$/, "-test"),
      );
    }
  });

  it("movedLambdaRolesFor('dev') matches the legacy MOVED_LAMBDA_ROLES export exactly", () => {
    expect(movedLambdaRolesFor("dev")).toEqual(MOVED_LAMBDA_ROLES);
  });
});

describe("move-manifest — assertDevOnlyGateEnvironment loud guard", () => {
  it("does not throw for 'dev'", () => {
    expect(() => assertDevOnlyGateEnvironment("dev")).not.toThrow();
  });

  it("throws for 'test' with a message saying test-env runs are unsupported", () => {
    expect(() => assertDevOnlyGateEnvironment("test")).toThrow(
      /test-env runs? (are|is) unsupported/i,
    );
  });

  it("throws for any other non-dev environment", () => {
    expect(() => assertDevOnlyGateEnvironment("staging")).toThrow(
      /unsupported/i,
    );
  });

  it("the thrown message explicitly states resulting failures are NOT baseline staleness", () => {
    expect(() => assertDevOnlyGateEnvironment("test")).toThrow(
      /not\s+baseline\s+staleness/i,
    );
  });
});
