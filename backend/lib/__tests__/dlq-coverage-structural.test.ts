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
 * PER-CONSUMER PIN (coverage-hardening follow-up): the queue-level guard
 * above only trips when a queue loses ALL of its consumers (total-queue
 * orphan). Removing ONE consumer's `deadLetterQueue` prop (say, dropping
 * the supervisor's DeadLetterConfig while the other five arbiter consumers
 * keep theirs) leaves the queue discovered and alarmed — silent coverage
 * loss. The `PINNED_COVERED_CONSUMERS` baseline below pins, per stack, the
 * exact set of consumer→DLQ edges derived from the synthesized templates,
 * so removing (or silently gaining) a single consumer's dead-letter wiring
 * fails the pin test. Updating the pin is a deliberate, reviewed act:
 * re-run `npx cdk synth --all --quiet`, read the failing diff, and move
 * the baseline only when the coverage change is intentional.
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
import { guardCdkOutInCi } from "../../test/helpers/cdk-out-guard";

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
  /**
   * Logical ID of the resource whose failure path feeds the DLQ: the
   * Lambda function (DeadLetterConfig), the event source mapping
   * (OnFailure), the source queue (RedrivePolicy), or the EventBridge
   * rule (RuleTarget). This is what the per-consumer pin keys on.
   */
  consumerLogicalId: string;
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

  for (const [consumerLogicalId, res] of Object.entries(template.Resources)) {
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
            consumerLogicalId,
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
            consumerLogicalId,
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
            consumerLogicalId,
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
              consumerLogicalId,
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

/**
 * Canonical, env-independent form of one consumer→DLQ coverage edge:
 * `<mechanism>:<consumerLogicalId>-><queueName minus the trailing -${ENV}>`.
 * Logical IDs are env-independent (the CDK path hash does not include the
 * environment), so the same pin validates dev/staging/prod synth output.
 */
function coverageEdge(d: DiscoveredDlq): string {
  const envSuffix = `-${ENV}`;
  const queueBase = d.queueName.endsWith(envSuffix)
    ? d.queueName.slice(0, -envSuffix.length)
    : d.queueName;
  return `${d.discoveredVia}:${d.consumerLogicalId}->${queueBase}`;
}

/**
 * PER-CONSUMER PINNED BASELINE — derived from `cdk synth --all` output
 * (all four discovery mechanisms above), NOT hand-authored. 42 edges:
 * the 32 shared-async-DLQ consumers from CIT-125 slice A plus the 10
 * pre-existing work-queue / stream / notifier / rule-target edges.
 *
 * WHY: the queue-level assertions in this file only fail when a DLQ loses
 * ALL consumers. This pin fails when ANY single consumer's dead-letter
 * wiring is removed, renamed, or silently added.
 *
 * TO UPDATE (deliberate coverage change only): re-synth, then rebuild the
 * failing stack's entries from the jest diff — each entry is
 * `mechanism:consumerLogicalId->queueNameWithoutEnvSuffix`. A hash-suffix
 * change caused by a construct-path refactor is expected to land here as
 * a reviewed diff; that is the point of pinning.
 */
const PINNED_COVERED_CONSUMERS: Record<string, readonly string[]> = {
  arbiter: [
    "DeadLetterConfig:ActivatorAgent74A6D68E->citadel-arbiter-async-dlq",
    "DeadLetterConfig:GovernanceGraphSnapshotFn8BC19523->citadel-arbiter-async-dlq",
    "DeadLetterConfig:GovernanceModeRefresherFn8358D228->citadel-arbiter-async-dlq",
    "DeadLetterConfig:StepRunnerFunctionBE4DB8E6->citadel-arbiter-async-dlq",
    "DeadLetterConfig:SupervisorAgent7CBC906A->citadel-arbiter-async-dlq",
    "DeadLetterConfig:WorkflowTimeoutWatchdogFunctionE2172B89->citadel-arbiter-async-dlq",
    "OnFailure:GovernanceFindingFanoutEventSourceMapping1803FCF3->citadel-governance-finding-fanout-dlq",
    "OnFailure:GovernanceGraphSnapshotOnChangeAuthorityUnitsESMD2494E8F->citadel-governance-graph-snapshot-on-change-dlq",
    "OnFailure:GovernanceGraphSnapshotOnChangeCaseLawESM9C755D01->citadel-governance-graph-snapshot-on-change-dlq",
    "OnFailure:GovernanceGraphSnapshotOnChangeCompositionContractsESM3FDE106E->citadel-governance-graph-snapshot-on-change-dlq",
    "OnFailure:GovernanceGraphSnapshotOnChangeConstitutionalLayersESME463D395->citadel-governance-graph-snapshot-on-change-dlq",
    "RedrivePolicy:fabricatorQueue414BE48B->citadel-fabricator-dlq",
    "RedrivePolicy:workerAgentQueueA757937E->citadel-worker-agent-dlq",
  ],
  backend: [
    "DeadLetterConfig:AgentMessageHandlerFunctionEF15B1DF->citadel-backend-async-dlq",
    "DeadLetterConfig:AppComponentRegistrationHandlerCD7DC5A3->citadel-backend-async-dlq",
    "DeadLetterConfig:AppInvokeHandlerFD7933F8->citadel-backend-async-dlq",
    "DeadLetterConfig:GatewayRegistrationHandler00584901->citadel-backend-async-dlq",
    "DeadLetterConfig:ModelCatalogSyncFunction25BE66F5->citadel-backend-async-dlq",
    "DeadLetterConfig:ReconcileAppsMetaScheduledFunction4D0CB960->citadel-backend-async-dlq",
    "DeadLetterConfig:WorkflowProgressFanoutFunctionB24A2000->citadel-backend-async-dlq",
  ],
  telemetry: [
    "DeadLetterConfig:CostBudgetEvaluator39D4C8D1->citadel-telemetry-async-dlq",
    "DeadLetterConfig:CostLedgerReconciler2D094117->citadel-telemetry-async-dlq",
    "DeadLetterConfig:CostLedgerWriter9749D180->citadel-telemetry-async-dlq",
    "DeadLetterConfig:EvalCaseScorerFunctionE7E10371->citadel-telemetry-async-dlq",
    "DeadLetterConfig:EvalDriftDetectorFunctionFB431D89->citadel-telemetry-async-dlq",
    "DeadLetterConfig:EvalDriftFindingWriterFunction99B43D60->citadel-telemetry-async-dlq",
    "DeadLetterConfig:EvalRunAggregatorFunction0C2BA6F9->citadel-telemetry-async-dlq",
    "DeadLetterConfig:EvalSampleScorerFunctionFCFB43C5->citadel-telemetry-async-dlq",
    "DeadLetterConfig:EvalSamplingSelectorFunction221FE615->citadel-telemetry-async-dlq",
  ],
  governance: [
    "DeadLetterConfig:AgentReleaseRollbackEvaluatorFunction1ABEF5A3->citadel-governance-async-dlq",
    "DeadLetterConfig:EvalRunnerFunction338D3E59->citadel-governance-async-dlq",
    "DeadLetterConfig:GovernanceNotifierFnAF80559D->citadel-governance-notifier-dlq",
    "RedrivePolicy:EvalDispatchQueueFD99DE58->citadel-eval-dispatch-dlq",
    "RuleTarget:GovernanceEventsRuleCAEA7CAA->citadel-governance-notifier-dlq",
  ],
  registry: [
    "DeadLetterConfig:AgentImportManifestResultHandlerAC7A0B8E->citadel-registry-async-dlq",
    "DeadLetterConfig:FabricationEventHandlerFunctionA425E3C0->citadel-registry-async-dlq",
    "RuleTarget:RegistrySyncRuleE4DF9965->citadel-registry-sync-dlq",
  ],
  projects: [
    "DeadLetterConfig:AssessmentCompletionNotifierF2243F8D->citadel-projects-async-dlq",
    "DeadLetterConfig:ChatterPublisherFunction40B50CEA->citadel-projects-async-dlq",
    "DeadLetterConfig:DesignProgressNotifier61A5E671->citadel-projects-async-dlq",
    "DeadLetterConfig:ProjectProgressUpdater66E18062->citadel-projects-async-dlq",
  ],
  services: [
    "DeadLetterConfig:DocumentIngestPollerFunction2ED9DA3B->citadel-services-async-dlq",
    "DeadLetterConfig:HealthMonitorFunctionE81A641C->citadel-services-async-dlq",
  ],
};

/** `citadel-arbiter-${ENV}` -> `arbiter` (keys of the pinned baseline). */
function stackSlug(stackName: string): string {
  return stackName.replace(/^citadel-/, "").replace(new RegExp(`-${ENV}$`), "");
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
    guardCdkOutInCi(missing, "cdk synth --all");
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

  describe("per-stack covered-consumer pin (single-consumer regressions trip here)", () => {
    // One test per stack so a failure names the stack directly. Sorted
    // string arrays give a readable jest diff: a MISSING entry means a
    // consumer lost its dead-letter wiring; an EXTRA entry means new
    // coverage that must be pinned (and, for shared-DLQ consumers, added
    // to docs/runbooks/DLQ_REDRIVE.md — see the runbook-completeness
    // guard in dlq-runbook-completeness.test.ts).
    it.each(STACK_NAMES)(
      "%s: covered-consumer set matches the synth-derived baseline",
      (stackName) => {
        const slug = stackSlug(stackName);
        const pinned = PINNED_COVERED_CONSUMERS[slug];
        expect(pinned).toBeDefined();
        const discovered = allDiscoveredDlqs
          .filter((d) => d.stackName === stackName)
          .map(coverageEdge)
          .sort();
        expect(discovered).toEqual([...pinned].sort());
      },
    );

    it("pinned baseline covers every synthesized stack (no stack silently dropped from the pin)", () => {
      expect(Object.keys(PINNED_COVERED_CONSUMERS).sort()).toEqual(
        STACK_NAMES.map(stackSlug).sort(),
      );
    });
  });
});
