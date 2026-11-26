// Supply-chain guard over build output, not URL validation.
//
// After `vite build`, scan every JavaScript file in the build output for
// hosts that must never be fetched at runtime (public script CDNs). The
// app self-hosts its dependencies, so a hit means a dependency has pulled
// in a third-party script origin and the build must fail.
//
// Each host is matched as a word-bounded, dot-escaped regular expression
// against the file CONTENT. Nothing here parses or validates URLs.
//
// The scanned directory is the build.outDir declared in vite.config.ts
// (falling back to `build`), so the guard follows the real build output
// instead of a hardcoded folder. It never passes vacuously: a missing
// directory or a directory without any .js/.mjs file is an error.
//
// Usage: node scripts/assert-no-third-party-script-hosts.mjs [outDir]

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const deniedHosts = ['cdn.jsdelivr.net', 'unpkg.com', 'cdnjs.cloudflare.com'];
const scriptExtensions = ['.js', '.mjs'];
const defaultOutDir = 'build';

const frontendRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const hostPatterns = deniedHosts.map((host) => ({
  host,
  pattern: new RegExp(`\\b${escapeRegExp(host)}\\b`),
}));

const readOutDirFromViteConfig = () => {
  const configPath = join(frontendRoot, 'vite.config.ts');
  if (!existsSync(configPath)) {
    return defaultOutDir;
  }
  const match = readFileSync(configPath, 'utf8').match(/outDir\s*:\s*['"]([^'"]+)['"]/);
  return match ? match[1] : defaultOutDir;
};

const collectScriptFiles = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const fullPath = join(dir, name);
    if (statSync(fullPath).isDirectory()) {
      return collectScriptFiles(fullPath);
    }
    return scriptExtensions.some((extension) => name.endsWith(extension)) ? [fullPath] : [];
  });

const outDir = process.argv[2] ?? join(frontendRoot, readOutDirFromViteConfig());

if (!existsSync(outDir) || !statSync(outDir).isDirectory()) {
  console.error(`assert-no-third-party-script-hosts: build output directory not found: ${outDir}`);
  process.exit(1);
}

const filePaths = collectScriptFiles(outDir);

if (filePaths.length === 0) {
  console.error(
    `assert-no-third-party-script-hosts: no .js/.mjs files in ${outDir}; nothing was scanned, refusing to pass`
  );
  process.exit(1);
}

const hits = [];
for (const filePath of filePaths) {
  const content = readFileSync(filePath, 'utf8');
  for (const { host, pattern } of hostPatterns) {
    if (pattern.test(content)) {
      hits.push({ filePath, host });
    }
  }
}

if (hits.length > 0) {
  for (const { filePath, host } of hits) {
    console.error(`third-party script host found: ${host} in ${filePath}`);
  }
  process.exit(1);
}

console.log(
  `assert-no-third-party-script-hosts: OK (${filePaths.length} files in ${outDir}, ${deniedHosts.length} hosts checked)`
);
