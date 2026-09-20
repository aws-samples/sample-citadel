/**
 * Module-level meta-guard for the dispatch gate-enumeration family
 * (finding 41c1cd9b). The per-resolver guards
 * (src/lambda/__tests__/*-dispatch-gate-enumeration.test.ts and
 * *-path-gate-enumeration.test.ts) each pin ONE resolver's authz surface;
 * nothing until now failed when a NEW Lambda was wired as an AppSync data
 * source without any guard at all. This test closes that meta-gap:
 *
 *  1. DISCOVER every Lambda entry file wired as an AppSync data source by
 *     scanning backend/lib/*-stack.ts sources with the TypeScript AST —
 *     `new lambda.Function(..., { handler: "<entry>.handler" })`
 *     declarations joined against the three data-source registration
 *     shapes used across the stacks:
 *       (a) `appSyncApi.addLambdaDataSource(name, fn)` (backend-stack),
 *       (b) `makeLambdaDataSource(prefix, fn)` local helpers
 *           (projects/registry stacks),
 *       (c) raw `new appsyncCfn.CfnDataSource(..., { type: "AWS_LAMBDA",
 *           lambdaConfig: { lambdaFunctionArn: fn.functionArn } })`
 *           (governance/services/arbiter stacks).
 *     Source scanning (not cdk.out) is deliberate: unlike
 *     schema-resolver-parity-guard.test.ts (whose resolver-parity check
 *     needs synthesized templates and therefore skips without a prior
 *     `cdk synth`), this guard must run on every bare `npm test` — and
 *     the data-source→function join is explicit in the stack sources,
 *     whereas in synthesized CFN it dissolves into ARN refs.
 *  2. RESOLVE cross-stack imports (functions registered via
 *     `lambda.Function.fromFunctionAttributes` + an ARN passed in from
 *     bin/app.ts) through a documented map — an UNKNOWN unresolved
 *     reference fails the guard (fail on unclassified, never skip).
 *  3. ASSERT every discovered entry file either has a matching
 *     per-resolver guard test file OR appears in DOCUMENTED_EXEMPTIONS
 *     with a reason. Anything else fails. Stale exemptions (no longer
 *     discovered, or contradicted by an existing guard file) also fail.
 *  4. BITE: removing a module from the guard-file set in-memory must trip
 *     the coverage check — proving the comparison is not vacuous.
 */
import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";

const BACKEND_ROOT = path.resolve(__dirname, "..");
const LIB_DIR = path.join(BACKEND_ROOT, "lib");
const LAMBDA_DIR = path.join(BACKEND_ROOT, "src", "lambda");
const GUARD_DIR = path.join(LAMBDA_DIR, "__tests__");
const SCHEMA_PATH = path.join(BACKEND_ROOT, "src", "schema", "schema.graphql");

/**
 * Data sources registered against `lambda.Function.fromFunctionAttributes`
 * imports (ARN provided by bin/app.ts), where the creating stack — and so
 * the `handler:` string — is not visible from the registering call site.
 * Keyed by the imported-function variable name at the registration site.
 * An unresolved reference NOT listed here fails the guard.
 */
const CROSS_STACK_IMPORTS: ReadonlyMap<string, string> = new Map([
  // backend-stack.ts addPublishHandlerResolvers(): Lambda created in
  // gateway-stack.ts (handler: "app-publish-handler.handler"), ARN threaded
  // through bin/app.ts.
  ["publishHandlerFn", "app-publish-handler"],
  // backend-stack.ts addEvalSamplingConfigResolvers(): Lambda created in
  // telemetry-stack.ts (handler: "eval-sampling-config-resolver.handler"),
  // ARN threaded through bin/app.ts (DECISION d36fbbf7).
  ["resolverFn", "eval-sampling-config-resolver"],
]);

/**
 * Wired-as-data-source entry files that deliberately have NO per-resolver
 * dispatch/path gate-enumeration guard. Every entry MUST carry a reason.
 * Removing a module's guard test without adding it here (or vice versa)
 * fails; an entry that stops being wired, or that gains a guard file,
 * becomes stale and also fails.
 */
const DOCUMENTED_EXEMPTIONS: ReadonlyMap<string, string> = new Map([
  [
    "document-resolver",
    "Read-only document/report reads (no Put/Update/Delete commands); " +
      "org-reconciled up front via the shared assertProjectAccess gate " +
      "(../utils/project-access.ts, finding 60a5a6ae) before its dispatch " +
      "switch.",
  ],
  [
    "assessment-completion-resolver",
    "IAM-only pass-through publisher: Mutation.publishAssessmentCompletion " +
      "is @aws_iam in the schema (pinned below) with no end-user access; " +
      "the resolver performs no storage access at all.",
  ],
  [
    "assessment-progress-resolver",
    "Read-only progress lookup (GetCommand-only, no mutations) returning " +
      "per-dimension completion percentages for a session; no write " +
      "surface to enumerate.",
  ],
  [
    "chatter-subscription-authorizer",
    "Connect-time subscription authorizer, not a field resolver with a " +
      "dispatch to enumerate; its fail-closed legs and CDK attachments " +
      "(Subscription.onChatter in projects-stack, " +
      "Subscription.onFabricationEvent in registry-stack) are pinned " +
      "inside chatter-resolver-dispatch-gate-enumeration.test.ts.",
  ],
  [
    "fabrication-event-handler",
    "IAM-only publisher: Mutation.publishFabricationEvent is @aws_iam in " +
      "the schema (pinned below) with no end-user access; doubles as the " +
      "EventBridge fabrication-event consumer. The subscription it feeds " +
      "(onFabricationEvent) is connect-gated by the shared " +
      "chatter-subscription-authorizer (pinned in the chatter guard).",
  ],
  [
    "generate-report-url",
    "Read-only single-field Query (generateReportDownloadUrl) — no " +
      "dispatch to enumerate, no mutations. TODO(finding): it presigns an " +
      "S3 GET for a client-supplied projectId WITHOUT the shared " +
      "assertProjectAccess reconciliation its sibling document resolvers " +
      "use (cross-tenant assessment-report disclosure to any " +
      "authenticated user who knows/guesses a projectId). The fix is a " +
      "production change (call assertProjectAccess before presigning), " +
      "out of scope for this test-only guard; once fixed this module " +
      "should get a small guard and leave this list.",
  ],
]);

/** Mutations whose IAM-only schema directive an exemption reason relies on. */
const IAM_ONLY_SCHEMA_PINS: Record<string, string> = {
  "assessment-completion-resolver": "publishAssessmentCompletion",
  "fabrication-event-handler": "publishFabricationEvent",
};

interface DiscoveryResult {
  /** entry-file base name (no .ts) -> stack files that wire it */
  wired: Map<string, string[]>;
  /** data-source function references that no scanned declaration explains */
  unresolvedRefs: { ref: string; stackFile: string }[];
}

function walk(node: ts.Node, cb: (n: ts.Node) => void): void {
  cb(node);
  node.forEachChild((child) => walk(child, cb));
}

/** True when `node` sits inside the local makeLambdaDataSource helper
 * definition (whose internal CfnDataSource would otherwise double-count
 * every call to the helper via its `fn` parameter). */
function insideMakeLambdaDataSourceHelper(node: ts.Node): boolean {
  let cur: ts.Node | undefined = node.parent;
  while (cur) {
    if (
      ts.isVariableDeclaration(cur) &&
      ts.isIdentifier(cur.name) &&
      cur.name.text === "makeLambdaDataSource"
    ) {
      return true;
    }
    cur = cur.parent;
  }
  return false;
}

export function discoverAppSyncLambdaEntryFiles(): DiscoveryResult {
  const stackFiles = fs
    .readdirSync(LIB_DIR)
    .filter((f) => f.endsWith("-stack.ts"))
    .sort();
  expect(stackFiles.length).toBeGreaterThan(0);

  /** function variable/property name -> entry-file base name */
  const handlerByVar = new Map<string, string>();
  const dsRefs: { ref: string; stackFile: string }[] = [];

  for (const stackFile of stackFiles) {
    const source = fs.readFileSync(path.join(LIB_DIR, stackFile), "utf-8");
    const sf = ts.createSourceFile(
      stackFile,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );

    walk(sf, (n) => {
      // (1) new <lambda.|nodejs.>Function(this, id, { handler: "<x>.handler" })
      if (
        ts.isNewExpression(n) &&
        n.arguments &&
        n.arguments.length >= 3 &&
        /(^|\.)(Nodejs)?Function$/.test(n.expression.getText(sf)) &&
        ts.isObjectLiteralExpression(n.arguments[2])
      ) {
        const handlerProp = n.arguments[2].properties.find(
          (p): p is ts.PropertyAssignment =>
            ts.isPropertyAssignment(p) &&
            p.name.getText(sf) === "handler" &&
            ts.isStringLiteral(p.initializer),
        );
        if (handlerProp) {
          let cur: ts.Node | undefined = n.parent;
          let varName: string | null = null;
          while (cur && !varName) {
            if (ts.isVariableDeclaration(cur) && ts.isIdentifier(cur.name)) {
              varName = cur.name.text;
            } else if (
              ts.isBinaryExpression(cur) &&
              cur.operatorToken.kind === ts.SyntaxKind.EqualsToken
            ) {
              varName = cur.left.getText(sf).replace(/^this\./, "");
            }
            cur = cur.parent;
          }
          if (varName) {
            const entry = (
              handlerProp.initializer as ts.StringLiteral
            ).text.replace(/\.handler$/, "");
            handlerByVar.set(varName, entry);
          }
        }
      }

      // (2a) *.addLambdaDataSource(name, fnRef) and makeLambdaDataSource(prefix, fnRef)
      if (ts.isCallExpression(n) && n.arguments.length >= 2) {
        const calleeText = n.expression.getText(sf);
        if (
          /(^|\.)addLambdaDataSource$/.test(calleeText) ||
          calleeText === "makeLambdaDataSource"
        ) {
          dsRefs.push({
            ref: n.arguments[1].getText(sf).replace(/^this\./, ""),
            stackFile,
          });
        }
      }

      // (2b) new *CfnDataSource(..., { type: "AWS_LAMBDA", lambdaConfig: {...} })
      if (
        ts.isNewExpression(n) &&
        /CfnDataSource$/.test(n.expression.getText(sf)) &&
        n.arguments &&
        n.arguments.length >= 3 &&
        ts.isObjectLiteralExpression(n.arguments[2]) &&
        !insideMakeLambdaDataSourceHelper(n)
      ) {
        const props = n.arguments[2];
        const typeProp = props.properties.find(
          (p): p is ts.PropertyAssignment =>
            ts.isPropertyAssignment(p) && p.name.getText(sf) === "type",
        );
        const isLambdaType =
          typeProp !== undefined &&
          ts.isStringLiteral(typeProp.initializer) &&
          typeProp.initializer.text === "AWS_LAMBDA";
        if (isLambdaType) {
          const cfgProp = props.properties.find(
            (p): p is ts.PropertyAssignment =>
              ts.isPropertyAssignment(p) &&
              p.name.getText(sf) === "lambdaConfig",
          );
          let refText: string | null = null;
          if (cfgProp && ts.isObjectLiteralExpression(cfgProp.initializer)) {
            const arnProp = cfgProp.initializer.properties.find(
              (p): p is ts.PropertyAssignment =>
                ts.isPropertyAssignment(p) &&
                p.name.getText(sf) === "lambdaFunctionArn",
            );
            if (arnProp) refText = arnProp.initializer.getText(sf);
          }
          dsRefs.push({
            ref: (refText ?? "<no lambdaFunctionArn>")
              .replace(/^this\./, "")
              .replace(/\.functionArn$/, ""),
            stackFile,
          });
        }
      }
    });
  }

  const wired = new Map<string, string[]>();
  const unresolvedRefs: { ref: string; stackFile: string }[] = [];
  for (const { ref, stackFile } of dsRefs) {
    const entry = handlerByVar.get(ref) ?? CROSS_STACK_IMPORTS.get(ref);
    if (entry) {
      wired.set(entry, [...(wired.get(entry) ?? []), stackFile]);
    } else {
      unresolvedRefs.push({ ref, stackFile });
    }
  }
  return { wired, unresolvedRefs };
}

function guardFileExistsFor(entry: string): boolean {
  return (
    fs.existsSync(
      path.join(GUARD_DIR, `${entry}-dispatch-gate-enumeration.test.ts`),
    ) ||
    fs.existsSync(
      path.join(GUARD_DIR, `${entry}-path-gate-enumeration.test.ts`),
    )
  );
}

/** Pure coverage core, factored out so the bite test can drive it with a
 * mutated guard set. */
export function computeUnaccounted(
  wiredEntries: string[],
  hasGuard: (entry: string) => boolean,
  exemptions: ReadonlyMap<string, string>,
): string[] {
  return wiredEntries.filter((e) => !hasGuard(e) && !exemptions.has(e));
}

describe("dispatch gate-enumeration coverage meta-guard", () => {
  const { wired, unresolvedRefs } = discoverAppSyncLambdaEntryFiles();
  const wiredEntries = [...wired.keys()].sort();

  test("discovery is not vacuous: a healthy number of AppSync-wired Lambda entry files were found", () => {
    // 44 at the time of writing (42 same-stack + 2 cross-stack imports).
    expect(wiredEntries.length).toBeGreaterThanOrEqual(40);
    expect(wiredEntries).toEqual(
      expect.arrayContaining([
        "project-resolver",
        "workflow-resolver",
        "registry-agent-record-resolver",
        "eval-resolver",
        "intake-orchestration-resolver",
        "app-publish-handler",
        "eval-sampling-config-resolver",
      ]),
    );
  });

  test("every data-source function reference resolved (unknown cross-stack imports fail, never skip)", () => {
    expect(unresolvedRefs).toEqual([]);
  });

  test("every discovered entry file exists under backend/src/lambda (discovery is grounded, not fabricated)", () => {
    const missing = wiredEntries.filter(
      (e) => !fs.existsSync(path.join(LAMBDA_DIR, `${e}.ts`)),
    );
    expect(missing).toEqual([]);
  });

  test("every AppSync-wired Lambda entry file has a *-dispatch-gate-enumeration / *-path-gate-enumeration guard OR a documented exemption", () => {
    const unaccounted = computeUnaccounted(
      wiredEntries,
      guardFileExistsFor,
      DOCUMENTED_EXEMPTIONS,
    );
    expect(unaccounted).toEqual([]);
  });

  test("no stale exemptions: every exempt module is still wired and still guard-less", () => {
    const wiredSet = new Set(wiredEntries);
    const noLongerWired = [...DOCUMENTED_EXEMPTIONS.keys()].filter(
      (e) => !wiredSet.has(e),
    );
    expect(noLongerWired).toEqual([]);
    const contradicted = [...DOCUMENTED_EXEMPTIONS.keys()].filter((e) =>
      guardFileExistsFor(e),
    );
    expect(contradicted).toEqual([]);
  });

  test("every exemption reason is non-empty (no reasonless allowlisting)", () => {
    for (const [entry, reason] of DOCUMENTED_EXEMPTIONS) {
      expect({ entry, hasReason: reason.trim().length >= 30 }).toEqual({
        entry,
        hasReason: true,
      });
    }
  });

  test.each(Object.entries(IAM_ONLY_SCHEMA_PINS))(
    "exemption '%s' relies on @aws_iam-only access for %s — pinned against the schema",
    (_entry, mutationName) => {
      const schema = fs.readFileSync(SCHEMA_PATH, "utf-8");
      const line = schema
        .split("\n")
        .find((l) => l.includes(`${mutationName}(`));
      expect(line).toBeDefined();
      expect(line).toContain("@aws_iam");
      expect(line).not.toContain("@aws_cognito_user_pools");
    },
  );

  test("bite: removing a guarded module from the guard set in-memory trips the coverage check", () => {
    // project-resolver is wired and guarded; pretend its guard vanished.
    expect(wiredEntries).toContain("project-resolver");
    const withoutProject = (entry: string): boolean =>
      entry === "project-resolver" ? false : guardFileExistsFor(entry);
    const unaccounted = computeUnaccounted(
      wiredEntries,
      withoutProject,
      DOCUMENTED_EXEMPTIONS,
    );
    expect(unaccounted).toEqual(["project-resolver"]);
    expect(() => expect(unaccounted).toEqual([])).toThrow();
  });

  test("bite: a wired module that is neither guarded nor exempt is reported by name", () => {
    const phantom = "totally-new-unguarded-resolver";
    const unaccounted = computeUnaccounted(
      [...wiredEntries, phantom].sort(),
      guardFileExistsFor,
      DOCUMENTED_EXEMPTIONS,
    );
    expect(unaccounted).toEqual([phantom]);
  });
});
