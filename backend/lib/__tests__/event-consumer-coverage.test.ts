/**
 * CLASS test (decision 60f1fad5 follow-up): every EventBridge detail-type
 * emitted anywhere in backend/src or arbiter must have at least one rule
 * targeting a consumer in the synthesized templates — an emitted event with
 * no deployed rule silently stalls forever (exactly what
 * `governance.eval.case.judge.requested` was doing before this change).
 *
 * Discovery is intentionally literal-string-based (grep over `emitGovernance
 * Event("...")` and `DetailType: "..."` call sites in non-test source), not
 * full type-flow analysis — a handful of TS resolvers build `detailType` via
 * a local `emitEvent(eventType: string, ...)` wrapper whose `eventType` is
 * itself a caller-supplied string; tracing every call site of those wrappers
 * is out of scope here and would require a much larger refactor to make
 * statically discoverable (binding the string literal to the constant at the
 * call site). What this test DOES cover: every detail-type that appears as a
 * literal string in an event-emission call — which is how
 * `governance.eval.case.judge.requested` itself is emitted
 * (`eval-case-scorer.ts`/`eval-sample-scorer.ts`) and would have caught this
 * exact gap.
 *
 * ALLOWLIST: `governance.eval.baseline.designated`,
 * `governance.eval.comparison.completed`, `governance.eval.run.started`,
 * `governance.eval.suite.frozen`, `governance.eval.seed.heal.blocked` are
 * emitted (via `emitGovernanceEvent`) but have NO EventBridge rule anywhere
 * in `backend/lib` today (confirmed against the synthesized templates —
 * `GovernanceEventsRule` in governance-stack.ts is an explicit detail-type
 * allowlist that does not include any of these five). This is a PRE-
 * EXISTING gap unrelated to this task's scope (deploying eval_judge) — each
 * either has no interested internal consumer today (audit-trail-only
 * events, consumed solely by external log/SIEM tooling subscribing directly
 * to the event bus) or is a separate latent gap. Adding a consumer for any
 * of them is a distinct piece of work with its own design decision; they
 * are allowlisted here, NOT silently fixed as a side effect of this change,
 * so this test stays a precise regression guard on NEWLY-introduced gaps
 * rather than a backlog of unrelated work. Removing an entry from this
 * allowlist must be accompanied by the rule wiring that covers it.
 *
 * Mirrors dlq-coverage-structural.test.ts's synth-dependent, skip-when-
 * absent convention (run `cdk synth --all` first).
 */
import * as fs from "fs";
import * as path from "path";
import { guardCdkOutInCi } from "../../test/helpers/cdk-out-guard";

const ENV = process.env.SPLIT_GATES_ENV ?? "dev";
const CDK_OUT = path.resolve(__dirname, "..", "..", "cdk.out");
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

const STACK_NAMES = [
  `citadel-arbiter-${ENV}`,
  `citadel-backend-${ENV}`,
  `citadel-telemetry-${ENV}`,
  `citadel-governance-${ENV}`,
  `citadel-registry-${ENV}`,
  `citadel-projects-${ENV}`,
  `citadel-services-${ENV}`,
  `citadel-gateway-${ENV}`,
  `citadel-frontend-${ENV}`,
];

// Pre-existing, out-of-scope gaps — see the module docstring above for the
// justification required to add an entry here. Each entry needs a reason.
const ALLOWLIST: Record<string, string> = {
  "governance.eval.baseline.designated":
    "Emitted by eval-comparison-resolver.ts; no EventBridge rule exists " +
    "anywhere in backend/lib today (confirmed against synthesized " +
    "templates). Pre-existing gap, unrelated to the eval_judge deployment " +
    "this test was added alongside.",
  "governance.eval.comparison.completed":
    "Emitted by eval-comparison-resolver.ts; no EventBridge rule exists " +
    "anywhere in backend/lib today. Pre-existing gap.",
  "governance.eval.run.started":
    "Emitted by eval-run-resolver.ts; no EventBridge rule exists anywhere " +
    "in backend/lib today. Pre-existing gap.",
  "governance.eval.suite.frozen":
    "Emitted by eval-resolver.ts; no EventBridge rule exists anywhere in " +
    "backend/lib today. Pre-existing gap.",
  "governance.eval.seed.heal.blocked":
    "Emitted by seed-eval-suites/index.ts; no EventBridge rule exists " +
    "anywhere in backend/lib today. Pre-existing gap.",
  "governance.authority-graph-history.config.changed":
    "Emitted by governance-ui-resolver.ts's updateAuthorityGraphHistory" +
    "Settings via emitGovernanceEvent(... as never) — the function's own " +
    "comment states this detail-type is deliberately NOT part of the " +
    "compile-time GovernanceDetailType union ('the bus still accepts the " +
    "shape'), i.e. an audit-trail-only emission with no intended internal " +
    "consumer by design, not an oversight. Pre-existing, intentional.",
  "System-Task":
    "Appears only in arbiter/supervisor/index.py's `if __name__ == " +
    "'__main__'` local-dev test-harness fixture (invoking handler() " +
    "directly with a hand-built event for manual testing), never emitted " +
    "via a real PutEvents call in production code. The production path " +
    'matches on source="task.request" (TaskRequestRule, source-only ' +
    "pattern), which this test already treats as covered.",
  "document.ingestion.failed":
    "Surfaced by the format commit; previously invisible to the scanner " +
    "(the emit site used single quotes). Emitted with source " +
    "citadel.documents by document-ingestion-shared.ts; no EventBridge rule " +
    "matches this detail-type or that source in any synthesized template. " +
    "Pre-existing gap, tracked as a follow-up rather than fixed here.",
  "pdf.created":
    "Surfaced by the format commit; previously invisible to the scanner " +
    "(the emit site used single quotes). Emitted with source " +
    "citadel.documents by pdf-created-notifier.ts; no EventBridge rule " +
    "matches this detail-type or that source in any synthesized template. " +
    "Pre-existing gap, tracked as a follow-up rather than fixed here.",
};

interface CfnResource {
  Type: string;
  Properties?: Record<string, unknown>;
}
interface CfnTemplate {
  Resources: Record<string, CfnResource>;
}

function loadTemplate(stackName: string): CfnTemplate | undefined {
  const p = path.join(CDK_OUT, `${stackName}.template.json`);
  if (!fs.existsSync(p)) return undefined;
  return JSON.parse(fs.readFileSync(p, "utf-8")) as CfnTemplate;
}

/** Every literal detail-type string matched by any `EventPattern` across all templates. */
function discoverRuleDetailTypes(templates: CfnTemplate[]): Set<string> {
  const found = new Set<string>();
  for (const template of templates) {
    for (const res of Object.values(template.Resources)) {
      if (res.Type !== "AWS::Events::Rule") continue;
      const pattern = (res.Properties ?? {})["EventPattern"] as
        Record<string, unknown> | undefined;
      const detailTypes = pattern?.["detail-type"];
      if (Array.isArray(detailTypes)) {
        for (const dt of detailTypes) {
          if (typeof dt === "string") found.add(dt);
        }
      }
    }
  }
  return found;
}

// Source scanners. Each is a pure string -> literals function so the formatting
// matrix below can exercise it without the filesystem or cdk.out.
//
// The TypeScript scanners must not depend on formatting: a repo-wide prettier
// pass rewrote 'x' to "x" and re-wrapped call expressions, which changed what
// a quote-specific scanner could see. They therefore accept either quote
// character (group 1 opens the literal and is back-referenced to close it,
// group 2 is the value), optional quotes around the `DetailType` key
// (prettier's quoteProps "as-needed" unquotes it), and any whitespace
// including newlines between tokens.
//
// The Python scanner is deliberately left double-quote-only: arbiter/ is not
// prettier-formatted and several single-quoted PutEvents sites there are
// consumed through source-only rules, which this test's coverage model
// (detail-type vs rule detail-type) does not express. Widening it needs
// source-aware matching first; it is a separate piece of work.
const EMIT_GOVERNANCE_EVENT_RE = /emitGovernanceEvent\(\s*(["'])([^"'\n]+)\1/g;
const DETAIL_TYPE_RE = /["']?DetailType["']?\s*:\s*(["'])([^"'\n]+)\1/g;
const DETAIL_TYPE_PY_RE = /"DetailType":\s*"([^"\n]+)"/g;

/** The literal value (the last capture group) of every match of `re`. */
function extractLiterals(contents: string, re: RegExp): string[] {
  return Array.from(contents.matchAll(re), (m) => m[m.length - 1]);
}

/** Literal detail-type strings from `emitGovernanceEvent("...")` call sites. */
function discoverEmitGovernanceEventLiterals(root: string): Set<string> {
  const found = new Set<string>();
  walkTsFiles(root, (contents) => {
    for (const dt of extractLiterals(contents, EMIT_GOVERNANCE_EVENT_RE)) {
      found.add(dt);
    }
  });
  return found;
}

/** Literal detail-type strings from `DetailType: "..."` PutEvents call sites (TS). */
function discoverDetailTypeLiteralsTs(root: string): Set<string> {
  const found = new Set<string>();
  walkTsFiles(root, (contents) => {
    for (const dt of extractLiterals(contents, DETAIL_TYPE_RE)) {
      found.add(dt);
    }
  });
  return found;
}

/** Literal detail-type strings from `"DetailType": "..."` PutEvents call sites (Python). */
function discoverDetailTypeLiteralsPy(root: string): Set<string> {
  const found = new Set<string>();
  walkFiles(root, ".py", (contents) => {
    for (const dt of extractLiterals(contents, DETAIL_TYPE_PY_RE)) {
      found.add(dt);
    }
  });
  return found;
}

/** Source-only (no detail-type) literal event sources — matched by `source` alone. */
function discoverSourceOnlyLiterals(templates: CfnTemplate[]): Set<string> {
  const found = new Set<string>();
  for (const template of templates) {
    for (const res of Object.values(template.Resources)) {
      if (res.Type !== "AWS::Events::Rule") continue;
      const pattern = (res.Properties ?? {})["EventPattern"] as
        Record<string, unknown> | undefined;
      if (pattern?.["detail-type"]) continue;
      const sources = pattern?.["source"];
      if (Array.isArray(sources)) {
        for (const s of sources) {
          if (typeof s === "string") found.add(s);
        }
      }
    }
  }
  return found;
}

function walkFiles(
  dir: string,
  ext: string,
  onFile: (contents: string) => void,
): void {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "__tests__" || entry.name === "node_modules") continue;
    if (entry.name === ".hypothesis") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(full, ext, onFile);
    } else if (entry.name.endsWith(ext)) {
      onFile(fs.readFileSync(full, "utf-8"));
    }
  }
}

function walkTsFiles(dir: string, onFile: (contents: string) => void): void {
  walkFiles(dir, ".ts", onFile);
}

// Does not need cdk.out, so it always runs (the suite below skips without it).
describe("emit-site scanner is independent of source formatting", () => {
  const scanEmitGovernanceEvent = (src: string) =>
    extractLiterals(src, EMIT_GOVERNANCE_EVENT_RE);
  const scanDetailTypeTs = (src: string) =>
    extractLiterals(src, DETAIL_TYPE_RE);
  const scanDetailTypePy = (src: string) =>
    extractLiterals(src, DETAIL_TYPE_PY_RE);

  describe("DetailType in TypeScript", () => {
    it("finds a double-quoted literal", () => {
      expect(scanDetailTypeTs(`DetailType: "pdf.created",`)).toEqual([
        "pdf.created",
      ]);
    });

    it("finds a single-quoted literal (pre-format style)", () => {
      expect(scanDetailTypeTs(`DetailType: 'pdf.created',`)).toEqual([
        "pdf.created",
      ]);
    });

    it("finds a literal whose value starts on the next line", () => {
      expect(
        scanDetailTypeTs(`DetailType:\n      "document.ingestion.failed",`),
      ).toEqual(["document.ingestion.failed"]);
    });

    it("finds a literal when the property key itself is quoted", () => {
      expect(
        scanDetailTypeTs(`"DetailType": "a.b", 'DetailType': 'c.d'`),
      ).toEqual(["a.b", "c.d"]);
    });

    it("finds the same literal in the compact and prettier-wrapped layouts", () => {
      const compact =
        "await c.send(new PutEventsCommand({ Entries: [{ Source: 'citadel.documents', DetailType: 'x.y.z', Detail: '{}' }] }));";
      const wrapped = [
        "await c.send(",
        "  new PutEventsCommand({",
        "    Entries: [",
        "      {",
        '        Source: "citadel.documents",',
        '        DetailType: "x.y.z",',
        '        Detail: "{}",',
        "      },",
        "    ],",
        "  }),",
        ");",
      ].join("\n");
      expect(scanDetailTypeTs(compact)).toEqual(["x.y.z"]);
      expect(scanDetailTypeTs(wrapped)).toEqual(["x.y.z"]);
    });

    it("ignores a non-literal value", () => {
      expect(scanDetailTypeTs("DetailType: detailType,")).toEqual([]);
    });

    it("ignores a value with mismatched quotes", () => {
      expect(scanDetailTypeTs(`DetailType: "oops',`)).toEqual([]);
    });

    it("ignores a lower-case detailType property (not a PutEvents entry)", () => {
      expect(scanDetailTypeTs(`detailType: "not.an.entry",`)).toEqual([]);
    });

    it("does not capture sibling string properties such as Source", () => {
      expect(
        scanDetailTypeTs(`Source: 'citadel.documents', DetailType: 'a.b'`),
      ).toEqual(["a.b"]);
    });
  });

  describe("emitGovernanceEvent call sites", () => {
    it("finds a double-quoted first argument", () => {
      expect(
        scanEmitGovernanceEvent(`emitGovernanceEvent("g.a.b", {})`),
      ).toEqual(["g.a.b"]);
    });

    it("finds a single-quoted first argument", () => {
      expect(
        scanEmitGovernanceEvent(`emitGovernanceEvent('g.a.b', {})`),
      ).toEqual(["g.a.b"]);
    });

    it("finds a first argument wrapped onto its own line", () => {
      expect(
        scanEmitGovernanceEvent(`emitGovernanceEvent(\n  "g.a.b",\n  {},\n)`),
      ).toEqual(["g.a.b"]);
    });

    it("ignores a non-literal first argument", () => {
      expect(scanEmitGovernanceEvent("emitGovernanceEvent(type, {})")).toEqual(
        [],
      );
    });
  });

  describe("DetailType in Python", () => {
    it("finds a double-quoted key and value", () => {
      expect(scanDetailTypePy(`{"DetailType": "task.request"}`)).toEqual([
        "task.request",
      ]);
    });

    it("finds a value on the next line", () => {
      expect(scanDetailTypePy(`"DetailType":\n    "task.request",`)).toEqual([
        "task.request",
      ]);
    });

    it("ignores a variable value", () => {
      expect(scanDetailTypePy(`{"DetailType": detail_type}`)).toEqual([]);
    });
  });
});

describe("every emitted EventBridge detail-type has a deployed consumer rule", () => {
  const loadedTemplates = STACK_NAMES.map((name) => ({
    name,
    template: loadTemplate(name),
  }));
  const allTemplatesPresent = loadedTemplates.every((t) => t.template);

  if (!allTemplatesPresent) {
    const missing = loadedTemplates
      .filter((t) => !t.template)
      .map((t) => t.name)
      .join(", ");
    guardCdkOutInCi(missing, "cdk synth --all");
    it.skip(
      `skipped: one or more synthesized templates missing under cdk.out/ ` +
        `(run 'cdk synth --all' first). missing=[${missing}]`,
      () => {},
    );
    return;
  }

  const templates = loadedTemplates.map((t) => t.template as CfnTemplate);
  const ruleDetailTypes = discoverRuleDetailTypes(templates);
  const sourceOnlyLiterals = discoverSourceOnlyLiterals(templates);

  const backendSrcRoot = path.join(REPO_ROOT, "backend", "src");
  const arbiterRoot = path.join(REPO_ROOT, "arbiter");

  const emittedDetailTypes = new Set<string>([
    ...discoverEmitGovernanceEventLiterals(backendSrcRoot),
    ...discoverDetailTypeLiteralsTs(backendSrcRoot),
    ...discoverDetailTypeLiteralsPy(arbiterRoot),
  ]);

  it("discovers at least one emitted detail-type and at least one rule (sanity check the discovery walk)", () => {
    expect(emittedDetailTypes.size).toBeGreaterThan(0);
    expect(ruleDetailTypes.size).toBeGreaterThan(0);
  });

  it("governance.eval.case.judge.requested now has a deployed consumer rule (the gap this test was added to close)", () => {
    expect(ruleDetailTypes.has("governance.eval.case.judge.requested")).toBe(
      true,
    );
  });

  it("every emitted detail-type is either rule-covered, source-matched, or explicitly allowlisted", () => {
    const uncovered = [...emittedDetailTypes].filter(
      (dt) =>
        !ruleDetailTypes.has(dt) &&
        !sourceOnlyLiterals.has(dt) &&
        !(dt in ALLOWLIST),
    );
    expect(uncovered.sort()).toEqual([]);
  });

  it("the allowlist contains no entry that is actually covered (stale-allowlist guard)", () => {
    const staleEntries = Object.keys(ALLOWLIST).filter(
      (dt) => ruleDetailTypes.has(dt) || sourceOnlyLiterals.has(dt),
    );
    expect(staleEntries).toEqual([]);
  });

  it("a synthetic unconsumed detail-type would fail the guard (negative control)", () => {
    const synthetic = "synthetic.detail.type.with.no.rule.v1";
    expect(ruleDetailTypes.has(synthetic)).toBe(false);
    expect(sourceOnlyLiterals.has(synthetic)).toBe(false);
    expect(synthetic in ALLOWLIST).toBe(false);
  });
});
