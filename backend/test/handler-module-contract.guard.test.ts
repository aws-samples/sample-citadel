/**
 * Handler module-contract guard — catches Lambda handlers that reference
 * AWS SDK clients not provided by the Lambda runtime as external requires.
 *
 * The Node.js 24 Lambda runtime ships @aws-sdk v3 core clients (DynamoDB,
 * S3, STS, etc.) but does NOT ship newer/specialist clients such as
 * @aws-sdk/client-agent-registry-control. If esbuild externalises those
 * (via --external:@aws-sdk/*) the handler crashes at cold-start with:
 *   Cannot find module '@aws-sdk/client-agent-registry-control'
 *
 * This guard scans every built handler in dist/lambda/ for require() calls
 * to SDK packages that are NOT available in the Lambda runtime and asserts
 * they are bundled (i.e. NOT left as bare external requires).
 *
 * Prerequisite: run `npm run build:lambda` before this test.
 */
import * as fs from "fs";
import * as path from "path";

const DIST_LAMBDA = path.resolve(__dirname, "..", "dist", "lambda");

/**
 * SDK packages that are NOT shipped with the Node.js 24 Lambda runtime and
 * MUST be bundled into any handler that uses them. Extend this list as new
 * specialist SDK clients are adopted.
 */
const SDK_PACKAGES_NOT_IN_RUNTIME: string[] = [
  "@aws-sdk/client-agent-registry",
  "@aws-sdk/client-agent-registry-control",
  "@aws-sdk/client-bedrock-agentcore",
  "@aws-sdk/client-bedrock-agentcore-control",
];

/**
 * Recursively find all .js files under a directory.
 */
function findJsFiles(dir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir.toString(), entry.name);
    if (entry.isDirectory()) {
      results.push(...findJsFiles(full));
    } else if (entry.name.endsWith(".js")) {
      results.push(full);
    }
  }
  return results;
}

describe("Handler module-contract guard", () => {
  const bundles = findJsFiles(DIST_LAMBDA);

  test("dist/lambda/ contains built handler bundles (sanity)", () => {
    expect(bundles.length).toBeGreaterThan(10);
  });

  test.each(SDK_PACKAGES_NOT_IN_RUNTIME)(
    "no handler leaves %s as an external require",
    (pkg) => {
      const violations: string[] = [];

      // Pattern: require("<pkg>") — esbuild emits this exact form for externals.
      // Bundled code inlines the package and does NOT emit a top-level require
      // for the package name.
      const externalPattern = `require("${pkg}")`;

      for (const bundle of bundles) {
        const content = fs.readFileSync(bundle, "utf8");
        if (content.includes(externalPattern)) {
          const rel = path.relative(DIST_LAMBDA, bundle);
          violations.push(rel);
        }
      }

      if (violations.length > 0) {
        throw new Error(
          `The following handler bundles leave ${pkg} as an external require ` +
            `(will crash at Lambda cold-start):\n` +
            violations.map((v) => `  - ${v}`).join("\n") +
            `\n\nFix: add the handler to the second esbuild pass in ` +
            `package.json's build:lambda (the pass WITHOUT --external:@aws-sdk/*).`,
        );
      }
    },
  );
});
