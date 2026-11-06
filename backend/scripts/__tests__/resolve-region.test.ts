/**
 * Tests for the shared resolveRegion utility (CIT-287).
 *
 * Precedence: --region > AWS_REGION > AWS_DEFAULT_REGION > throw.
 */
import {
  resolveRegion,
  extractRegionFlag,
  RegionRequiredError,
} from "../lib/resolve-region";

describe("extractRegionFlag", () => {
  test("extracts --region and returns remaining args", () => {
    const result = extractRegionFlag([
      "--registry-id",
      "abc",
      "--region",
      "eu-west-1",
      "--apply",
    ]);
    expect(result.regionFlag).toBe("eu-west-1");
    expect(result.rest).toEqual(["--registry-id", "abc", "--apply"]);
  });

  test("returns undefined when --region is absent", () => {
    const result = extractRegionFlag(["--apply", "--dry-run"]);
    expect(result.regionFlag).toBeUndefined();
    expect(result.rest).toEqual(["--apply", "--dry-run"]);
  });
});

describe("resolveRegion", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test("1. --region flag wins over env vars", () => {
    process.env.AWS_REGION = "us-west-2";
    process.env.AWS_DEFAULT_REGION = "ap-southeast-1";
    const { region, rest } = resolveRegion([
      "--region",
      "eu-central-1",
      "--apply",
    ]);
    expect(region).toBe("eu-central-1");
    expect(rest).toEqual(["--apply"]);
  });

  test("2. AWS_REGION is used when no --region flag", () => {
    process.env.AWS_REGION = "us-west-2";
    process.env.AWS_DEFAULT_REGION = "ap-southeast-1";
    const { region } = resolveRegion(["--apply"]);
    expect(region).toBe("us-west-2");
  });

  test("3. AWS_DEFAULT_REGION is used when no --region and no AWS_REGION", () => {
    delete process.env.AWS_REGION;
    process.env.AWS_DEFAULT_REGION = "ap-southeast-1";
    const { region } = resolveRegion(["--apply"]);
    expect(region).toBe("ap-southeast-1");
  });

  test("4. throws RegionRequiredError when no source provides a region", () => {
    delete process.env.AWS_REGION;
    delete process.env.AWS_DEFAULT_REGION;
    expect(() => resolveRegion([])).toThrow(RegionRequiredError);
    expect(() => resolveRegion([])).toThrow(
      "Region required: pass --region or set AWS_REGION",
    );
  });
});
