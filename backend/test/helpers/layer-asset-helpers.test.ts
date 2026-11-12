import {
  wrongArchFiles,
  layerAssetDirFromTemplate,
} from "./layer-asset-helpers";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ---------------------------------------------------------------------------
// wrongArchFiles
// ---------------------------------------------------------------------------

describe("wrongArchFiles", () => {
  // arch-literal-guard allowlist: bite-case fixture strings for wrongArchFiles
  const AARCH64_SO = [
    "_pydantic_core.cpython-315-aarch64-linux-gnu.so", // arch-literal-guard allowlist: fixture
    "_cffi_backend.cpython-315-aarch64-linux-gnu.so", // arch-literal-guard allowlist: fixture
  ];

  const X86_64_SO = [
    "_pydantic_core.cpython-315-x86_64-linux-gnu.so", // arch-literal-guard allowlist: fixture
    "_cffi_backend.cpython-315-x86_64-linux-gnu.so", // arch-literal-guard allowlist: fixture
  ];

  // Untagged .so — no arch triple, should be ignored.
  const PLAIN_SO = ["_speedups.so", "parser.so"];

  test("returns empty when all .so match the expected aarch64 tag", () => {
    expect(wrongArchFiles(AARCH64_SO, "aarch64")).toEqual([]); // arch-literal-guard allowlist: assertion
  });

  test("returns empty when all .so match the expected x86_64 tag", () => {
    expect(wrongArchFiles(X86_64_SO, "x86_64")).toEqual([]); // arch-literal-guard allowlist: assertion
  });

  test("detects aarch64 .so when x86_64 is expected (bite case)", () => {
    const wrong = wrongArchFiles(AARCH64_SO, "x86_64"); // arch-literal-guard allowlist: bite-case
    expect(wrong).toEqual(AARCH64_SO);
  });

  test("detects x86_64 .so when aarch64 is expected (bite case)", () => {
    const wrong = wrongArchFiles(X86_64_SO, "aarch64"); // arch-literal-guard allowlist: bite-case
    expect(wrong).toEqual(X86_64_SO);
  });

  test("ignores untagged .so files (no arch triple)", () => {
    expect(wrongArchFiles(PLAIN_SO, "aarch64")).toEqual([]); // arch-literal-guard allowlist: assertion
    expect(wrongArchFiles(PLAIN_SO, "x86_64")).toEqual([]); // arch-literal-guard allowlist: assertion
  });

  test("handles mixed tagged and untagged files", () => {
    const mixed = [...AARCH64_SO, ...PLAIN_SO];
    expect(wrongArchFiles(mixed, "aarch64")).toEqual([]); // arch-literal-guard allowlist: assertion
    expect(wrongArchFiles(mixed, "x86_64")).toEqual(AARCH64_SO); // arch-literal-guard allowlist: assertion
  });

  test("returns empty for an empty list", () => {
    expect(wrongArchFiles([], "aarch64")).toEqual([]); // arch-literal-guard allowlist: assertion
  });
});

// ---------------------------------------------------------------------------
// layerAssetDirFromTemplate
// ---------------------------------------------------------------------------

describe("layerAssetDirFromTemplate", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "layer-helper-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeTemplate(
    resources: Record<string, unknown>,
    filename = "test.template.json",
  ): string {
    const templatePath = path.join(tmpDir, filename);
    fs.writeFileSync(templatePath, JSON.stringify({ Resources: resources }));
    return templatePath;
  }

  function createAssetDir(hash: string): void {
    const pythonDir = path.join(tmpDir, `asset.${hash}`, "python");
    fs.mkdirSync(path.join(pythonDir, "catalog"), { recursive: true });
    fs.mkdirSync(path.join(pythonDir, "common"), { recursive: true });
  }

  test("finds layer asset from a well-formed template", () => {
    const hash = "abc123def456";
    createAssetDir(hash);
    const tpl = writeTemplate({
      MyLayer: {
        Type: "AWS::Lambda::LayerVersion",
        Properties: { Content: { S3Key: `${hash}.zip` } },
      },
    });
    expect(layerAssetDirFromTemplate(tpl)).toBe(
      path.join(tmpDir, `asset.${hash}`),
    );
  });

  test("returns undefined when template does not exist", () => {
    expect(
      layerAssetDirFromTemplate(path.join(tmpDir, "nonexistent.json")),
    ).toBeUndefined();
  });

  test("returns undefined when no LayerVersion resource exists", () => {
    const tpl = writeTemplate({
      MyFunc: {
        Type: "AWS::Lambda::Function",
        Properties: {},
      },
    });
    expect(layerAssetDirFromTemplate(tpl)).toBeUndefined();
  });

  test("returns undefined when asset dir does not contain python/catalog+common", () => {
    const hash = "missingpython";
    // Create asset dir without python/catalog/common
    fs.mkdirSync(path.join(tmpDir, `asset.${hash}`), { recursive: true });
    const tpl = writeTemplate({
      MyLayer: {
        Type: "AWS::Lambda::LayerVersion",
        Properties: { Content: { S3Key: `${hash}.zip` } },
      },
    });
    expect(layerAssetDirFromTemplate(tpl)).toBeUndefined();
  });

  test("strips .zip suffix from S3Key to derive asset hash", () => {
    const hash = "deadbeef0000";
    createAssetDir(hash);
    const tpl = writeTemplate({
      CatalogLayer: {
        Type: "AWS::Lambda::LayerVersion",
        Properties: { Content: { S3Key: `${hash}.zip` } },
      },
    });
    const result = layerAssetDirFromTemplate(tpl);
    expect(result).toContain(`asset.${hash}`);
  });
});
