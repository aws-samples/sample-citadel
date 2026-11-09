/**
 * Guard test: no direct writes to workflowIds or appId outside the binding
 * service. Every mutation to these fields MUST go through
 * app-workflow-binding.ts — direct UpdateCommand/TransactWriteCommand
 * touching either field in a resolver is a bug.
 *
 * CIT-286: this test fails if a new caller introduces a direct write.
 */
import * as fs from "fs";
import * as path from "path";

const BINDING_SERVICE = "app-workflow-binding.ts";

/** Files that are ALLOWED to write workflowIds/appId directly. */
const ALLOWLIST: ReadonlySet<string> = new Set([
  // The binding service itself
  path.resolve(__dirname, "../../services/app-workflow-binding.ts"),
  // The reconcile-apps-meta script mirrors workflowIds from the registry
  // manifest — it does NOT go through the binding service because it
  // handles ONLY the manifest→#META direction and never touches
  // workflow.appId.
  path.resolve(__dirname, "../../../scripts/reconcile-apps-meta.ts"),
  // apps-table-meta.ts helper writes workflowIds as part of bulk upsert —
  // called by reconcile-apps-meta and createApp (which doesn't bind).
  path.resolve(__dirname, "../../utils/apps-table-meta.ts"),
]);

/**
 * Patterns that indicate a direct write to workflowIds or appId on the
 * workflows table or apps table. Deliberate false-positive risk is
 * tolerable — if a new file trips this, the developer must either route
 * through the binding service or add it to ALLOWLIST with a justification.
 */
const SUSPICIOUS_PATTERNS = [
  // UpdateExpression writing workflowIds
  /["']#?workflowIds["'].*=.*:.*workflowId/i,
  /list_append.*workflowIds/i,
  // SET appId on a workflow row (not config or generic)
  /UpdateExpression.*SET.*#?appId\s*=/i,
  // TransactWrite with workflowIds or appId — but only in Lambda resolvers
  /TransactWriteCommand.*workflowIds/i,
];

function findTsFilesRecursively(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (
      entry.isDirectory() &&
      !entry.name.startsWith(".") &&
      entry.name !== "node_modules" &&
      entry.name !== "dist" &&
      entry.name !== "__tests__" &&
      entry.name !== "coverage"
    ) {
      files.push(...findTsFilesRecursively(full));
    } else if (
      entry.isFile() &&
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".d.ts")
    ) {
      files.push(full);
    }
  }
  return files;
}

describe("app-workflow-binding guard", () => {
  it("no direct writes to workflowIds/appId outside the binding service and allowlist", () => {
    const backendSrc = path.resolve(__dirname, "../..");
    const scriptsSrc = path.resolve(__dirname, "../../../scripts");

    const files = [
      ...findTsFilesRecursively(path.join(backendSrc, "lambda")),
      ...findTsFilesRecursively(scriptsSrc),
    ];

    const violations: string[] = [];

    for (const file of files) {
      if (ALLOWLIST.has(path.resolve(file))) continue;
      if (path.basename(file) === BINDING_SERVICE) continue;

      const content = fs.readFileSync(file, "utf-8");
      for (const pattern of SUSPICIOUS_PATTERNS) {
        if (pattern.test(content)) {
          violations.push(
            `${path.relative(backendSrc, file)} matches ${pattern}`,
          );
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
