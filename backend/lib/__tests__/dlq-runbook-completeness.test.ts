/**
 * Runbook completeness guard (CIT-125 slice C, design C.3 #2).
 *
 * Ties the DLQ_REDRIVE runbook back to the synthesized reality: every
 * consumer Lambda that sets a shared per-stack async DLQ
 * (`citadel-<stack>-async-dlq-<env>`) as its `DeadLetterConfig` must be
 * mentioned in `docs/runbooks/DLQ_REDRIVE.md`. A new consumer wired to a
 * shared DLQ without a runbook row fails here — the on-call procedure
 * (§2 queue inventory + §3 redrive matrix) must never lag the deployed
 * consumer set.
 *
 * Matching is deliberately tolerant of naming-style drift between CDK
 * logical IDs and the runbook's prose/kebab-case: the consumer's logical
 * ID is stripped of its trailing CDK path hash and generic
 * Function/Handler/Fn/Agent/Scheduled suffixes, then both sides are
 * normalized to lowercase alphanumerics before a substring check
 * (`SupervisorAgent7CBC906A` → `supervisor`;
 * `WorkflowTimeoutWatchdogFunctionE2172B89` → `workflowtimeoutwatchdog`,
 * which matches the runbook's "workflow-timeout watchdog"). The negative
 * control below proves the matcher is falsifiable.
 *
 * Discovery mirrors backend/lib/__tests__/dlq-coverage-structural.test.ts
 * (same cdk.out templates, same skip-when-absent convention — run
 * `cdk synth --all` first). The structural guard pins the consumer sets;
 * this guard pins the runbook to them.
 */
import * as fs from "fs";
import * as path from "path";

const ENV = process.env.SPLIT_GATES_ENV ?? "dev";
const CDK_OUT = path.resolve(__dirname, "..", "..", "cdk.out");
const RUNBOOK_PATH = path.resolve(
  __dirname,
  "..",
  "..",
  "..",
  "docs",
  "runbooks",
  "DLQ_REDRIVE.md",
);

// Every stack that can own a shared async DLQ consumer (mirror of the
// structural guard's stack list).
const STACK_NAMES = [
  `citadel-arbiter-${ENV}`,
  `citadel-backend-${ENV}`,
  `citadel-telemetry-${ENV}`,
  `citadel-governance-${ENV}`,
  `citadel-registry-${ENV}`,
  `citadel-projects-${ENV}`,
  `citadel-services-${ENV}`,
];

const SHARED_ASYNC_DLQ_NAME = /^citadel-[a-z]+-async-dlq-/;

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

function resolveLogicalIdFromRef(ref: unknown): string | undefined {
  if (!ref || typeof ref !== "object") return undefined;
  const asRecord = ref as Record<string, unknown>;
  if (Array.isArray(asRecord["Fn::GetAtt"])) {
    const [logicalId] = asRecord["Fn::GetAtt"] as unknown[];
    return typeof logicalId === "string" ? logicalId : undefined;
  }
  if (typeof asRecord["Ref"] === "string") return asRecord["Ref"] as string;
  return undefined;
}

interface SharedDlqConsumer {
  stackName: string;
  consumerLogicalId: string;
  queueName: string;
}

/** Lambda functions whose DeadLetterConfig targets a shared async DLQ. */
function discoverSharedDlqConsumers(
  stackName: string,
  template: CfnTemplate,
): SharedDlqConsumer[] {
  const found: SharedDlqConsumer[] = [];
  for (const [logicalId, res] of Object.entries(template.Resources)) {
    if (res.Type !== "AWS::Lambda::Function") continue;
    const dlqConfig = (res.Properties ?? {})["DeadLetterConfig"] as
      Record<string, unknown> | undefined;
    const targetLogicalId = resolveLogicalIdFromRef(dlqConfig?.["TargetArn"]);
    if (!targetLogicalId) continue;
    const queue = template.Resources[targetLogicalId];
    if (!queue || queue.Type !== "AWS::SQS::Queue") continue;
    const queueName = (queue.Properties ?? {})["QueueName"];
    if (typeof queueName !== "string") continue;
    if (!SHARED_ASYNC_DLQ_NAME.test(queueName)) continue;
    found.push({ stackName, consumerLogicalId: logicalId, queueName });
  }
  return found;
}

/** `SupervisorAgent7CBC906A` → `Supervisor` (hash + generic suffixes off). */
function consumerBaseName(consumerLogicalId: string): string {
  // CDK logical IDs end with an 8-hex-char path hash (uppercase).
  let base = consumerLogicalId.replace(/[0-9A-F]{8}$/, "");
  const GENERIC_SUFFIXES = ["Function", "Handler", "Agent", "Fn", "Scheduled"];
  let stripped = true;
  while (stripped) {
    stripped = false;
    for (const suffix of GENERIC_SUFFIXES) {
      // Keep at least 6 chars of identity — never strip a name to mush.
      if (base.endsWith(suffix) && base.length - suffix.length >= 6) {
        base = base.slice(0, -suffix.length);
        stripped = true;
      }
    }
  }
  return base;
}

/** Lowercase alphanumerics only — style-insensitive comparison space. */
function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

const loadedTemplates = STACK_NAMES.map((name) => ({
  name,
  template: loadTemplate(name),
}));
const allTemplatesPresent = loadedTemplates.every((t) => t.template);

describe("DLQ_REDRIVE runbook completeness (every synthesized shared-DLQ consumer documented)", () => {
  if (!allTemplatesPresent) {
    const missing = loadedTemplates
      .filter((t) => !t.template)
      .map((t) => t.name)
      .join(", ");
    it.skip(
      `skipped: one or more synthesized templates missing under cdk.out/ ` +
        `(run 'cdk synth --all' first). missing=[${missing}]`,
      () => {},
    );
    return;
  }

  const consumers: SharedDlqConsumer[] = [];
  for (const { name, template } of loadedTemplates) {
    consumers.push(
      ...discoverSharedDlqConsumers(name, template as CfnTemplate),
    );
  }
  const runbook = fs.readFileSync(RUNBOOK_PATH, "utf-8");
  const normalizedRunbook = normalize(runbook);

  it("discovers shared-DLQ consumers in every synthesized stack (sanity check the discovery walk)", () => {
    expect(consumers.length).toBeGreaterThan(0);
    const stacksWithConsumers = new Set(consumers.map((c) => c.stackName));
    expect([...stacksWithConsumers].sort()).toEqual([...STACK_NAMES].sort());
  });

  it("every synthesized shared-DLQ consumer appears in docs/runbooks/DLQ_REDRIVE.md", () => {
    const undocumented = consumers.filter(
      (c) =>
        !normalizedRunbook.includes(
          normalize(consumerBaseName(c.consumerLogicalId)),
        ),
    );
    // A failure here means a consumer gained a shared-DLQ DeadLetterConfig
    // without a runbook entry: add it to §2's queue-inventory table AND a
    // §3 redrive-matrix row (SAFE / RECONCILE-FIRST / re-derive) before
    // updating anything in this test.
    expect(
      undocumented.map(
        (c) => `${c.stackName}:${c.consumerLogicalId} (${c.queueName})`,
      ),
    ).toEqual([]);
  });

  it("a consumer absent from the runbook would fail the guard (negative control on the matcher)", () => {
    const synthetic = "SyntheticUnrunbookedConsumerFnAB12CD34";
    expect(
      normalizedRunbook.includes(normalize(consumerBaseName(synthetic))),
    ).toBe(false);
  });

  it("normalization keeps enough identity to discriminate (no consumer collapses to a trivial token)", () => {
    for (const c of consumers) {
      expect(
        normalize(consumerBaseName(c.consumerLogicalId)).length,
      ).toBeGreaterThanOrEqual(6);
    }
  });
});
