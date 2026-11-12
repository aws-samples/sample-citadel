/**
 * Pure helpers for the arbiter layer import smoke test.
 *
 * Extracted so they can be unit-tested in the normal (fast, no-Docker) suite.
 */
import * as fs from "fs";
import * as path from "path";

/**
 * Given a list of `.so` filenames and an expected architecture tag
 * (e.g. `"aarch64"` or `"x86_64"`), return every arch-tagged `.so`
 * whose filename contains the *wrong* architecture.
 *
 * "Arch-tagged" means the filename matches `cpython-\d+-<tag>…\.so`.
 * Files without an arch tag (pure-Python C extensions with no platform
 * triple) are ignored.
 */
export function wrongArchFiles(files: string[], expectedTag: string): string[] {
  const archTagged = files.filter((f) => /cpython-\d+-.+\.so$/.test(f));
  return archTagged.filter((f) => !f.includes(expectedTag));
}

/**
 * Deterministically locate the catalog layer's asset directory from a
 * synthesised CDK template.
 *
 * Reads the template JSON, finds the first `AWS::Lambda::LayerVersion`
 * resource whose `Content.S3Key` is present, strips the `.zip` suffix to
 * get the asset hash, and returns the corresponding `cdk.out/asset.<hash>`
 * directory path.
 *
 * @param templatePath  Absolute path to the synthesised `.template.json`.
 * @returns Absolute path to the asset directory, or `undefined` if not found.
 */
export function layerAssetDirFromTemplate(
  templatePath: string,
): string | undefined {
  if (!fs.existsSync(templatePath)) return undefined;

  const template = JSON.parse(fs.readFileSync(templatePath, "utf-8"));
  const resources: Record<
    string,
    { Type?: string; Properties?: Record<string, unknown> }
  > = template.Resources ?? {};

  for (const [, resource] of Object.entries(resources)) {
    if (resource.Type !== "AWS::Lambda::LayerVersion") continue;
    const s3Key = (
      resource.Properties?.Content as Record<string, unknown> | undefined
    )?.S3Key;
    if (typeof s3Key !== "string") continue;
    const hash = s3Key.replace(/\.zip$/, "");
    const assetDir = path.join(path.dirname(templatePath), `asset.${hash}`);
    const pythonDir = path.join(assetDir, "python");
    if (
      fs.existsSync(pythonDir) &&
      fs.existsSync(path.join(pythonDir, "catalog")) &&
      fs.existsSync(path.join(pythonDir, "common"))
    ) {
      return assetDir;
    }
  }
  return undefined;
}
