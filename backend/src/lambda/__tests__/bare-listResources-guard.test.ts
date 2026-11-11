/**
 * Guard test: no MUTATING resolver may call the bare `listResources(` method.
 *
 * Mutation resolvers that act on the result of a registry listing (create,
 * replace, link, activate, approve) MUST use `listResourcesChecked` and
 * refuse when the listing is partial/throttled. The bare `listResources`
 * method is acceptable in READ-ONLY resolvers that surface the result to the
 * caller without mutating state.
 *
 * ALLOWLISTED read-only call sites (bare `listResources(` is fine here):
 */
import * as fs from "fs";
import * as path from "path";

// ── READ-ONLY call sites that may use bare listResources ────────────────
const READONLY_ALLOWLIST: Record<string, string> = {
  // agent-config-resolver: listAgentConfigsRegistry query (N+1 read path)
  "agent-config-resolver.ts": "listAgentConfigsRegistry query — read-only",
  // tool-config-resolver: listToolConfigsRegistry query (N+1 read path)
  "tool-config-resolver.ts": "listToolConfigsRegistry query — read-only",
  // governance-ui-resolver: governance health-check query — read-only
  "governance-ui-resolver.ts": "governance health-check query — read-only",
};

// ── ADAPTER call sites (non-resolver, read-only, tolerated) ─────────────
const ADAPTER_ALLOWLIST: Record<string, string> = {
  // agentcore-runtime-adapter: best-effort manifest lookup — read-only
  "agentcore-runtime-adapter.ts": "best-effort manifest lookup — read-only",
};

/** Source root under which resolvers live. */
const LAMBDA_DIR = path.resolve(__dirname, "..");
const ADAPTERS_DIR = path.resolve(__dirname, "../../adapters");

describe("bare listResources( guard — no mutating call sites", () => {
  it("only allowlisted read-only files use bare listResources(", () => {
    const violations: string[] = [];

    // Scan all .ts files in lambda/ (resolvers)
    const lambdaFiles = fs
      .readdirSync(LAMBDA_DIR)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"));

    for (const file of lambdaFiles) {
      if (READONLY_ALLOWLIST[file]) continue; // allowlisted
      const content = fs.readFileSync(path.join(LAMBDA_DIR, file), "utf-8");
      // Match bare .listResources( but not .listResourcesChecked(
      const barePattern = /\.listResources\s*\(/g;
      const checkedPattern = /\.listResourcesChecked\s*\(/g;
      const bareMatches = content.match(barePattern) ?? [];
      const checkedMatches = content.match(checkedPattern) ?? [];
      // Subtract checked from bare (listResourcesChecked also contains listResources)
      const netBare = bareMatches.length - checkedMatches.length;
      if (netBare > 0) {
        violations.push(`${file}: ${netBare} bare listResources( call(s)`);
      }
    }

    // Also scan adapters (non-allowlisted)
    const scanDir = (dir: string, prefix: string) => {
      if (!fs.existsSync(dir)) return;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          scanDir(path.join(dir, entry.name), `${prefix}${entry.name}/`);
        } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
          if (ADAPTER_ALLOWLIST[entry.name]) continue;
          const content = fs.readFileSync(
            path.join(dir, entry.name),
            "utf-8",
          );
          const barePattern = /\.listResources\s*\(/g;
          const checkedPattern = /\.listResourcesChecked\s*\(/g;
          const bareMatches = content.match(barePattern) ?? [];
          const checkedMatches = content.match(checkedPattern) ?? [];
          const netBare = bareMatches.length - checkedMatches.length;
          if (netBare > 0) {
            violations.push(
              `${prefix}${entry.name}: ${netBare} bare listResources( call(s)`,
            );
          }
        }
      }
    };
    scanDir(ADAPTERS_DIR, "adapters/");

    expect(violations).toEqual([]);
  });

  it("registry-service.ts itself defines listResources (not a violation)", () => {
    // Sanity: the service definition file is not scanned above (it's under
    // services/, not lambda/ or adapters/).
    const svcPath = path.resolve(
      __dirname,
      "../../services/registry-service.ts",
    );
    expect(fs.existsSync(svcPath)).toBe(true);
  });
});
