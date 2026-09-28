/**
 * Shared recursive source-file walker for the backend guard tests
 * (app-access-control-dead-code-guard, no-caller-org-fallback-idiom.guard,
 * release-store-choke-point.guard, no-old-namespace-registry-ops.guard).
 *
 * Fixes CIT-200: the copy-pasted per-test walkers did not skip dot-prefixed
 * directories (so `.mutant-scratch` scratch files from
 * eval-immutability.property.test.ts were scanned) and did not tolerate a
 * directory or file vanishing mid-walk (ENOENT from a concurrent jest
 * worker's cleanup crashed the whole scan).
 *
 * Lives under __tests__/fixtures/ so jest imports it without treating it as
 * a test suite (fixtures/ is in testPathIgnorePatterns).
 */

import * as fs from "fs";
import * as path from "path";

export interface ListSourceFilesOptions {
  extensions?: string[];
  skipDirs?: string[];
}

const DEFAULT_EXTENSIONS = [".ts", ".tsx"];
const DEFAULT_SKIP_DIRS = ["node_modules", "__tests__"];

function isVanishedDirError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * Recursively lists source files under rootDir.
 *
 * Skips any entry whose name starts with "." (dot-directories and
 * dot-files), plus the configured skipDirs (defaults: node_modules,
 * __tests__). Tolerates a subdirectory vanishing mid-walk (ENOENT/ENOTDIR
 * on readdirSync) by treating it as having no entries and returning
 * whatever files were already collected.
 */
export function listSourceFiles(
  rootDir: string,
  opts: ListSourceFilesOptions = {},
): string[] {
  const extensions = opts.extensions ?? DEFAULT_EXTENSIONS;
  const skipDirs = new Set(opts.skipDirs ?? DEFAULT_SKIP_DIRS);

  const out: string[] = [];
  const stack: string[] = [rootDir];

  while (stack.length > 0) {
    const current = stack.pop()!;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (err) {
      if (isVanishedDirError(err)) {
        continue;
      }
      throw err;
    }

    for (const entry of entries) {
      if (entry.name.startsWith(".")) {
        continue;
      }
      if (entry.isDirectory() && skipDirs.has(entry.name)) {
        continue;
      }

      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (
        entry.isFile() &&
        extensions.some((ext) => entry.name.endsWith(ext))
      ) {
        out.push(full);
      }
    }
  }

  return out;
}

/**
 * Reads a source file, returning null if it vanished (ENOENT) between
 * being listed and being read. Rethrows any other error.
 */
export function readSourceFileOrNull(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return null;
    }
    throw err;
  }
}
