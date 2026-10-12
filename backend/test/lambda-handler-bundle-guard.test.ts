import * as fs from "fs";
import * as path from "path";
import { globSync } from "glob";

/**
 * Structural guard: every Lambda handler whose CDK definition references a
 * sub-directory entrypoint (e.g. "seed-blueprints/index.handler") must have:
 *   (a) a corresponding src/lambda/<dir>/index.ts source file, AND
 *   (b) a matching `src/lambda/<dir>/*.ts` glob in the build:lambda script.
 *
 * This test catches the exact class of bug where a new seeder Lambda is
 * wired in CDK but its esbuild entrypoint pattern is never added to
 * package.json, causing a "Cannot find module" crash at INIT time.
 */
describe("Lambda handler bundle guard", () => {
  const backendRoot = path.resolve(__dirname, "..");
  const libDir = path.join(backendRoot, "lib");
  const srcLambdaDir = path.join(backendRoot, "src", "lambda");

  // Extract every handler: "<dir>/index.handler" from backend/lib/*.ts
  const handlerDirPattern =
    /handler:\s*["']([a-zA-Z0-9_-]+)\/index\.handler["']/g;

  const subDirHandlers: string[] = [];
  const libFiles = globSync("*.ts", { cwd: libDir, absolute: true });
  for (const file of libFiles) {
    const content = fs.readFileSync(file, "utf-8");
    let match: RegExpExecArray | null;
    while ((match = handlerDirPattern.exec(content)) !== null) {
      const dir = match[1];
      if (!subDirHandlers.includes(dir)) {
        subDirHandlers.push(dir);
      }
    }
  }

  // Parse the build:lambda script from package.json
  const pkg = JSON.parse(
    fs.readFileSync(path.join(backendRoot, "package.json"), "utf-8"),
  );
  const buildLambdaScript: string = pkg.scripts["build:lambda"];

  // Extract all entrypoint glob patterns from the esbuild commands.
  // Patterns look like: src/lambda/seed-blueprints/*.ts or src/lambda/*.ts
  const entrypointGlobs =
    buildLambdaScript.match(/src\/lambda\/[a-zA-Z0-9_*-]+(?:\/\*)?\.ts/g) ?? [];

  test("should discover at least one sub-directory handler", () => {
    expect(subDirHandlers.length).toBeGreaterThan(0);
  });

  test.each(subDirHandlers)("src/lambda/%s/index.ts exists on disk", (dir) => {
    const entryFile = path.join(srcLambdaDir, dir, "index.ts");
    expect(fs.existsSync(entryFile)).toBe(true);
  });

  test.each(subDirHandlers)(
    "%s is covered by a build:lambda entrypoint pattern",
    (dir) => {
      // The handler dir must be matched by at least one entrypoint glob.
      // Possible matching patterns:
      //   - src/lambda/<dir>/*.ts  (explicit sub-directory glob)
      //   - src/lambda/<dir>/index.ts  (explicit file)
      const matched = entrypointGlobs.some((glob) => {
        // Exact sub-dir glob: src/lambda/seed-blueprints/*.ts
        if (glob === `src/lambda/${dir}/*.ts`) return true;
        // Explicit file: src/lambda/seed-blueprints/index.ts
        if (glob === `src/lambda/${dir}/index.ts`) return true;
        return false;
      });
      expect(matched).toBe(true);
    },
  );
});
