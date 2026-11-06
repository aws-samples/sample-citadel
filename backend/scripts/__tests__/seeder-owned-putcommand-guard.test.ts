/**
 * Guard test: no script under backend/scripts/ may issue a raw PutCommand
 * against the agents or tools cache tables without going through the
 * seeder-owned row guard.
 *
 * Allowlisted exceptions:
 *   - reconcile-seeded-rows.ts — intentionally writes canonical+pointer rows
 *     for seeder-owned agents as part of the twin-collapse reconciliation.
 *
 * Any new script that needs to PutCommand on agents/tools must either:
 *   1. Use isSeederOwnedRow + mergeOnlySeederRow from lib/seeder-owned-row.ts
 *   2. Be added to ALLOWLIST with justification.
 */
import * as fs from "fs";
import * as path from "path";

// Scripts explicitly allowed to use raw PutCommand on agents/tools tables.
const ALLOWLIST = new Set([
  // Reconcile-seeded-rows intentionally writes full canonical rows as part of
  // the twin-collapse reconciliation — this is the reconcile tool itself.
  "reconcile-seeded-rows.ts",
]);

const SCRIPTS_DIR = path.resolve(__dirname, "..");

describe("seeder-owned-row guard: no unguarded PutCommand on agents/tools tables", () => {
  it("every script using PutCommand also imports seeder-owned-row guard (or is allowlisted)", () => {
    const scripts = fs
      .readdirSync(SCRIPTS_DIR)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"));

    const violations: string[] = [];

    for (const file of scripts) {
      if (ALLOWLIST.has(file)) continue;

      const filePath = path.join(SCRIPTS_DIR, file);
      const content = fs.readFileSync(filePath, "utf-8");

      // Check if the script imports PutCommand
      const usesPutCommand =
        content.includes("PutCommand") && content.includes("new PutCommand");

      if (!usesPutCommand) continue;

      // Check if it targets agents or tools tables (heuristic: references
      // tableAgents/tableTools/AGENT_CONFIG/TOOLS_CONFIG or the script name
      // suggests it touches agent/tool projection rows)
      const targetsAgentToolTables =
        /table-?[Aa]gents|table-?[Tt]ools|AGENT_CONFIG_TABLE|TOOLS_CONFIG_TABLE|TableName:\s*table(Agents|Tools)/i.test(
          content,
        );

      if (!targetsAgentToolTables) continue;

      // The script uses PutCommand on agents/tools tables — it MUST import
      // the seeder-owned guard.
      const importsGuard =
        content.includes("seeder-owned-row") ||
        content.includes("isSeederOwnedRow") ||
        content.includes("mergeOnlySeederRow");

      if (!importsGuard) {
        violations.push(file);
      }
    }

    expect(violations).toEqual([]);
  });
});
