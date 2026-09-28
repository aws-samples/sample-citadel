import * as os from "os";
import * as path from "path";

const actualFs: typeof import("fs") = jest.requireActual("fs");

jest.mock("fs", () => {
  const real: typeof import("fs") = jest.requireActual("fs");
  return {
    ...real,
    readdirSync: jest.fn(real.readdirSync),
    readFileSync: jest.fn(real.readFileSync),
  };
});

import * as fsMocked from "fs";
import {
  listSourceFiles,
  readSourceFileOrNull,
} from "./fixtures/source-file-walker";

const fs = fsMocked as unknown as typeof import("fs") & {
  readdirSync: jest.MockedFunction<typeof import("fs").readdirSync>;
  readFileSync: jest.MockedFunction<typeof import("fs").readFileSync>;
};

describe("listSourceFiles", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = actualFs.mkdtempSync(
      path.join(os.tmpdir(), "source-file-walker-"),
    );
    fs.readdirSync.mockImplementation(
      actualFs.readdirSync as typeof import("fs").readdirSync,
    );
    fs.readFileSync.mockImplementation(
      actualFs.readFileSync as typeof import("fs").readFileSync,
    );
  });

  afterEach(() => {
    actualFs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.readdirSync.mockReset();
    fs.readFileSync.mockReset();
  });

  it("skips dot-prefixed directories", () => {
    actualFs.mkdirSync(path.join(tmpRoot, ".mutant-scratch"));
    actualFs.writeFileSync(
      path.join(tmpRoot, ".mutant-scratch", "sneaky.ts"),
      "export const x = 1;",
    );
    actualFs.writeFileSync(
      path.join(tmpRoot, "visible.ts"),
      "export const y = 2;",
    );

    const files = listSourceFiles(tmpRoot);

    expect(files).toEqual([path.join(tmpRoot, "visible.ts")]);
  });

  it("skips configured directories in addition to the defaults", () => {
    actualFs.mkdirSync(path.join(tmpRoot, "vendor"));
    actualFs.writeFileSync(
      path.join(tmpRoot, "vendor", "lib.ts"),
      "export const z = 3;",
    );
    actualFs.writeFileSync(path.join(tmpRoot, "app.ts"), "export const a = 4;");

    const files = listSourceFiles(tmpRoot, {
      skipDirs: ["vendor", "node_modules", "__tests__"],
    });

    expect(files).toEqual([path.join(tmpRoot, "app.ts")]);
  });

  it("tolerates a subdirectory vanishing between readdir calls and returns remaining files", () => {
    const vanishing = path.join(tmpRoot, "vanishing");
    actualFs.mkdirSync(vanishing);
    actualFs.writeFileSync(
      path.join(vanishing, "gone.ts"),
      "export const g = 1;",
    );
    actualFs.writeFileSync(
      path.join(tmpRoot, "stable.ts"),
      "export const s = 1;",
    );

    fs.readdirSync.mockImplementation(((
      dirPath: fs.PathLike,
      options: unknown,
    ) => {
      if (dirPath === vanishing) {
        const err: NodeJS.ErrnoException = new Error(
          `ENOENT: no such file or directory, scandir '${dirPath}'`,
        );
        err.code = "ENOENT";
        throw err;
      }
      return actualFs.readdirSync(dirPath, options as { withFileTypes: true });
    }) as typeof import("fs").readdirSync);

    const files = listSourceFiles(tmpRoot);

    expect(files).toEqual([path.join(tmpRoot, "stable.ts")]);
  });
});

describe("readSourceFileOrNull", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = actualFs.mkdtempSync(
      path.join(os.tmpdir(), "source-file-walker-read-"),
    );
    fs.readFileSync.mockImplementation(
      actualFs.readFileSync as typeof import("fs").readFileSync,
    );
  });

  afterEach(() => {
    actualFs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.readFileSync.mockReset();
  });

  it("returns null when the file is missing", () => {
    const missing = path.join(tmpRoot, "does-not-exist.ts");

    expect(readSourceFileOrNull(missing)).toBeNull();
  });

  it("rethrows non-ENOENT errors such as EACCES", () => {
    const target = path.join(tmpRoot, "restricted.ts");
    actualFs.writeFileSync(target, "export const r = 1;");

    fs.readFileSync.mockImplementation(() => {
      const err: NodeJS.ErrnoException = new Error(
        `EACCES: permission denied, open '${target}'`,
      );
      err.code = "EACCES";
      throw err;
    });

    expect(() => readSourceFileOrNull(target)).toThrow(/EACCES/);
  });
});
