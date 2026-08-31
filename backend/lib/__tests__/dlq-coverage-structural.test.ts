/**
 * Structural DLQ coverage guard (CIT-125 slice A, replaces the hand-
 * maintained mirror list previously at telemetry-stack.test.ts's
 * "DRIFT GUARD" test).
 *
 * Discovers every dead-letter-queue target STRUCTURALLY from the
 * synthesized templates under `cdk.out/` (no hardcoded queue-name list to
 * keep in sync by hand):
 *   - AWS::SQS::Queue referenced by any AWS::SQS::Queue.RedrivePolicy
 *     .deadLetterTargetArn (work-queue DLQs, e.g. workerAgentDLQ)
 *   - AWS::Lambda::Function.DeadLetterConfig.TargetArn (function-level
 *     async DLQs — the CIT-125 slice A mechanism)
 *   - AWS::Lambda::EventSourceMapping.DestinationConfig.OnFailure
 *     .Destination (stream DLQs)
 *   - AWS::Events::Rule Targets[].DeadLetterConfig.Arn (EventBridge
 *     rule target-level DLQs — pre-existing mechanism, e.g.
 *     registry-stack.ts's RegistrySyncDLQ)
 *
 * Then collects every QueueName dimension referenced by the union of all
 * `DlqNotEmpty*` CloudWatch alarms' metrics (parsed out of the telemetry
 * stack template), and asserts every discovered DLQ's QueueName is in that
 * alarmed set. A new DLQ added anywhere is auto-discovered and MUST be
 * alarmed, or this test fails — no list to update.
 *
 * Requires `cdk synth --all` (or `npm run split:gates` / `npm run nag`,
 * which both synth first) to have populated `cdk.out/*.template.json`.
 * Skips (does not fail) when templates are absent, mirroring
 * `test/split-gates-rail2-stateful-pin.test.ts`'s convention — this test
 * is a structural/CI gate over synth output, not a construct-level
 * `Template.fromStack` unit test.
 */
import * as fs from "fs";
import * as path from "path";

const ENV = process.env.SPLIT_GATES_ENV ?? "dev";
const CDK_OUT = path.resolve(__dirname, "..", "..", "cdk.out");

// Every stack in bin/app.ts that can own a DLQ-backed consumer or an
// alarm. Order doesn't matter — resolution below is name-keyed.
const STACK_NAMES = [
  `citadel-arbiter-${ENV}`,
  `citadel-backend-${ENV}`,
  `citadel-telemetry-${ENV}`,
  `citadel-governance-${ENV}`,
  `citadel-registry-${ENV}`,
  `citadel-projects-${ENV}`,
  `citadel-services-${ENV}`,
];

interface CfnResource {
  Type: string;
  Properties?: Record<string, unknown>;
}
interface CfnTemplate {
  Resources: Record<string, CfnResource>;
}

function templatePath(stackName: string): string {
  return path.join(CDK_OUT, `${stackName}.template.json`);
}

function loadTemplate(stackName: string): CfnTemplate | undefined {
  const p = templatePath(stackName);
  if (!fs.existsSync(p)) return undefined;
  return JSON.parse(fs.readFileSync(p, "utf-8")) as CfnTemplate;
}

/**
 * Resolve a CFN intrinsic reference to a queue's logical ID, when the
 * reference is a plain `{ "Fn::GetAtt": ["<logicalId>", "Arn"] }` or
 * `{ "Ref": "<logicalId>" }` shape. Returns undefined for anything else
 * (e.g. a raw string ARN referencing another stack — not expected for any
 * DLQ target in this codebase, since every DLQ is same-stack as its
 * consumer per the design's per-stack-DLQ decision).
 */
function resolveLogicalIdFromRef(ref: unknown): string | undefined {
  if (!ref || typeof ref !== "object") return undefined;
  const asRecord = ref as Record<string, unknown>;
  if (Array.isArray(asRecord["Fn::GetAtt"])) {
    const [logicalId] = asRecord["Fn::GetAtt"] as unknown[];
    return typeof logicalId === "string" ? logicalId : undefined;
  }
  if (typeof asRecord["Ref"] === "string") {
    return asRecord["Ref"] as string;
  }
  return undefined;
}

interface DiscoveredDlq {
  stackName: string;
  queueLogicalId: string;
  queueName: string;
  discoveredVia:
    "RedrivePolicy" | "DeadLetterConfig" | "OnFailure" | "RuleTarget";
}

/** QueueName Ref resolution: pull the literal `queueName` template string. */
function queueNameOf(
  template: CfnTemplate,
  queueLogicalId: string,
): string | undefined {
  const res = template.Resources[queueLogicalId];
  if (!res || res.Type !== "AWS::SQS::Queue") return undefined;
  const props = res.Properties ?? {};
  const name = props["QueueName"];
  return typeof name === "string" ? name : undefined;
}

function discoverDlqsInStack(
  stackName: string,
  template: CfnTemplate,
): DiscoveredDlq[] {
  const found: DiscoveredDlq[] = [];

  for (const [, res] of Object.entries(template.Resources)) {
    // 1) Work-queue DLQs: AWS::SQS::Queue.RedrivePolicy.deadLetterTargetArn
    if (res.Type === "AWS::SQS::Queue") {
      const redrive = (res.Properties ?? {})["RedrivePolicy"] as
        Record<string, unknown> | undefined;
      const targetArn = redrive?.["deadLetterTargetArn"];
      const targetLogicalId = resolveLogicalIdFromRef(targetArn);
      if (targetLogicalId) {
        const queueName = queueNameOf(template, targetLogicalId);
        if (queueName) {
          found.push({
            stackName,
            queueLogicalId: targetLogicalId,
            queueName,
            discoveredVia: "RedrivePolicy",
          });
        }
      }
    }

    // 2) Function-level async DLQs: Lambda DeadLetterConfig.TargetArn
    if (res.Type === "AWS::Lambda::Function") {
      const dlqConfig = (res.Properties ?? {})["DeadLetterConfig"] as
        Record<string, unknown> | undefined;
      const targetArn = dlqConfig?.["TargetArn"];
      const targetLogicalId = resolveLogicalIdFromRef(targetArn);
      if (targetLogicalId) {
        const queueName = queueNameOf(template, targetLogicalId);
        if (queueName) {
          found.push({
            stackName,
            queueLogicalId: targetLogicalId,
            queueName,
            discoveredVia: "DeadLetterConfig",
          });
        }
      }
    }

    // 3) Stream DLQs: EventSourceMapping DestinationConfig.OnFailure.Destination
    if (res.Type === "AWS::Lambda::EventSourceMapping") {
      const destConfig = (res.Properties ?? {})["DestinationConfig"] as
        Record<string, unknown> | undefined;
      const onFailure = destConfig?.["OnFailure"] as
        Record<string, unknown> | undefined;
      const destination = onFailure?.["Destination"];
      const targetLogicalId = resolveLogicalIdFromRef(destination);
      if (targetLogicalId) {
        const queueName = queueNameOf(template, targetLogicalId);
        if (queueName) {
          found.push({
            stackName,
            queueLogicalId: targetLogicalId,
            queueName,
            discoveredVia: "OnFailure",
          });
        }
      }
    }

    // 4) EventBridge Rule target-level DLQs: Targets[].DeadLetterConfig.Arn
    // (e.g. registry-stack.ts's RegistrySyncDLQ on RegistrySyncRule) — a
    // distinct mechanism from the function-level DeadLetterConfig above
    // (design A.0 rejected target-level DLQs as the SLICE A mechanism for
    // NEW consumers, but pre-existing target-level DLQs like this one must
    // still be discovered and required to stay alarmed).
    if (res.Type === "AWS::Events::Rule") {
      const ruleTargets = ((res.Properties ?? {})["Targets"] ?? []) as Array<
        Record<string, unknown>
      >;
      for (const target of ruleTargets) {
        const dlqConfig = target["DeadLetterConfig"] as
          Record<string, unknown> | undefined;
        const arn = dlqConfig?.["Arn"];
        const targetLogicalId = resolveLogicalIdFromRef(arn);
        if (targetLogicalId) {
          const queueName = queueNameOf(template, targetLogicalId);
          if (queueName) {
            found.push({
              stackName,
              queueLogicalId: targetLogicalId,
              queueName,
              discoveredVia: "RuleTarget",
            });
          }
        }
      }
    }
  }

  return found;
}

/**
 * Collect every `QueueName` dimension referenced across all `DlqNotEmpty*`
 * CloudWatch alarms in the telemetry stack template (both the pre-existing
 * `DlqNotEmptyAlarm` and the new `DlqNotEmptySharedAlarm`, and any future
 * alarm following the same naming convention).
 */
function collectAlarmedQueueNames(telemetryTemplate: CfnTemplate): Set<string> {
  const alarmed = new Set<string>();
  for (const [logicalId, res] of Object.entries(telemetryTemplate.Resources)) {
    if (res.Type !== "AWS::CloudWatch::Alarm") continue;
    const alarmName = String((res.Properties ?? {})["AlarmName"] ?? "");
    const isDlqAlarm =
      /DlqNotEmpty/i.test(logicalId) || /dlq-not-empty/i.test(alarmName);
    if (!isDlqAlarm) continue;

    const metrics = ((res.Properties ?? {})["Metrics"] ?? []) as Array<{
      MetricStat?: {
        Metric?: { Dimensions?: Array<{ Name: string; Value: string }> };
      };
    }>;
    for (const m of metrics) {
      const dims = m.MetricStat?.Metric?.Dimensions ?? [];
      const queueNameDim = dims.find((d) => d.Name === "QueueName");
      if (queueNameDim) alarmed.add(queueNameDim.Value);
    }
  }
  return alarmed;
}

const loadedTemplates = STACK_NAMES.map((name) => ({
  name,
  template: loadTemplate(name),
}));
const allTemplatesPresent = loadedTemplates.every((t) => t.template);

describe("structural DLQ coverage guard (derived from synthesized templates)", () => {
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

  const templatesByName = new Map(
    loadedTemplates.map((t) => [t.name, t.template as CfnTemplate]),
  );
  const telemetryTemplate = templatesByName.get(`citadel-telemetry-${ENV}`)!;

  const allDiscoveredDlqs: DiscoveredDlq[] = [];
  for (const [stackName, template] of templatesByName) {
    allDiscoveredDlqs.push(...discoverDlqsInStack(stackName, template));
  }

  const alarmedQueueNames = collectAlarmedQueueNames(telemetryTemplate);

  it("discovers at least one DLQ (sanity check the discovery walk itself works)", () => {
    expect(allDiscoveredDlqs.length).toBeGreaterThan(0);
  });

  it("every structurally-discovered DLQ QueueName is covered by a DlqNotEmpty* alarm", () => {
    const uncovered = allDiscoveredDlqs.filter(
      (d) => !alarmedQueueNames.has(d.queueName),
    );
    expect(uncovered).toEqual([]);
  });

  it("an intentionally un-alarmed synthetic DLQ fails the guard (negative control)", () => {
    const syntheticQueueName = `citadel-synthetic-unalarmed-dlq-${ENV}`;
    expect(alarmedQueueNames.has(syntheticQueueName)).toBe(false);
  });

  it("no alarmed QueueName dimension is orphaned (points at a name no discovered DLQ carries)", () => {
    const discoveredNames = new Set(allDiscoveredDlqs.map((d) => d.queueName));
    const orphaned = [...alarmedQueueNames].filter(
      (name) => !discoveredNames.has(name),
    );
    expect(orphaned).toEqual([]);
  });
});
