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
// Usage: node scripts/assert-no-third-party-script-hosts.mjs [assetsDir]
// assetsDir defaults to build/assets (build.outDir in vite.config.ts).

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const deniedHosts = ['cdn.jsdelivr.net', 'unpkg.com', 'cdnjs.cloudflare.com'];

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const hostPatterns = deniedHosts.map((host) => ({
  host,
  pattern: new RegExp(`\\b${escapeRegExp(host)}\\b`),
}));

const assetsDir = process.argv[2] ?? join('build', 'assets');

let fileNames;
try {
  fileNames = readdirSync(assetsDir).filter((name) => name.endsWith('.js'));
} catch (err) {
  console.error(`assert-no-third-party-script-hosts: cannot read ${assetsDir}`, err);
  process.exit(1);
}

if (fileNames.length === 0) {
  console.error(`assert-no-third-party-script-hosts: no .js files in ${assetsDir}`);
  process.exit(1);
}

const hits = [];
for (const fileName of fileNames) {
  const filePath = join(assetsDir, fileName);
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
  `assert-no-third-party-script-hosts: OK (${fileNames.length} files, ${deniedHosts.length} hosts checked)`
);
