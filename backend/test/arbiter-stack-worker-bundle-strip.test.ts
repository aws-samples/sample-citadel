import {
  buildStripLayerPackagesHook,
  LAYER_PROVIDED_PACKAGES,
} from "../lib/arbiter-stack";

/**
 * Verify that the afterBundling hook produces rm commands that strip every
 * package the common layer already provides from the asset output.
 * The hook is called with fake input/output dirs and the returned shell
 * commands are asserted against the expected package list.
 */
describe("ArbiterStack — stripLayerPackages bundling hook", () => {
  const hook = buildStripLayerPackagesHook();
  const FAKE_INPUT = "/asset-input";
  const FAKE_OUTPUT = "/asset-output";

  test("beforeBundling returns an empty array", () => {
    expect(hook.beforeBundling(FAKE_INPUT, FAKE_OUTPUT)).toEqual([]);
  });

  test("afterBundling returns one rm command per layer-provided package", () => {
    const cmds = hook.afterBundling(FAKE_INPUT, FAKE_OUTPUT);
    expect(cmds).toHaveLength(LAYER_PROVIDED_PACKAGES.length);
  });

  test.each([...LAYER_PROVIDED_PACKAGES])(
    "afterBundling removes %s and its dist-info",
    (pkg) => {
      const cmds = hook.afterBundling(FAKE_INPUT, FAKE_OUTPUT);
      const expected = `rm -rf ${FAKE_OUTPUT}/${pkg} ${FAKE_OUTPUT}/${pkg}-*.dist-info`;
      expect(cmds).toContain(expected);
    },
  );

  test("commands use the provided outputDir, not a hardcoded path", () => {
    const customOut = "/tmp/custom-bundle-out";
    const cmds = hook.afterBundling(FAKE_INPUT, customOut);
    for (const cmd of cmds) {
      expect(cmd).toContain(customOut);
      expect(cmd).not.toContain(FAKE_OUTPUT);
    }
  });

  test("package list includes the heaviest transitive deps (botocore, s3transfer)", () => {
    const pkgs = [...LAYER_PROVIDED_PACKAGES];
    expect(pkgs).toContain("botocore");
    expect(pkgs).toContain("s3transfer");
    expect(pkgs).toContain("boto3");
  });
});
