/**
 * Cross-stack export guard: no recreatable resource identity shared via a
 * CloudFormation export (CIT-205).
 *
 * Incident class this guards against (finding 8b7ee8af): CloudFormation
 * refuses to update/remove an export while any stack imports it. If the
 * exporting resource is a kind that gets recreated as a normal operational
 * move (a Custom::* provisioner, a Bedrock KnowledgeBase, an AgentCore
 * Gateway, a Cognito UserPoolClient with a rotated secret, ...), the
 * exported id/ARN cannot be republished until every importer stops
 * importing it first — a two-phase manual dance that deadlocks routine
 * deploys. AgentCoreRegistry hit exactly this; consumers were migrated to
 * read SSM parameters instead (see registry-ssm.ts).
 *
 * This test synthesizes no stacks itself for the main check — it reads the
 * pre-synthesized `cdk.out/citadel-<stack>-${SPLIT_GATES_ENV}.template.json`
 * files (mirrors test/duplicate-alarm-name-guard.test.ts), because the
 * export/import relationship is whole-app: most exports only resolve once
 * every stack in the app is synthesized together. Run
 * `npm run build && npx cdk synth --all` first for a real local result;
 * guardCdkOutInCi makes a missing-synth run fail loud in CI instead of
 * silently skipping (finding e051a3c6).
 */
import * as fs from "fs";
import * as path from "path";
import * as cdk from "aws-cdk-lib";
import { CfnOutput, CfnResource, Stack } from "aws-cdk-lib";

import { guardCdkOutInCi } from "./helpers/cdk-out-guard";

const ENV = process.env.SPLIT_GATES_ENV ?? "dev";
const CDK_OUT = path.resolve(__dirname, "..", "cdk.out");

// Every stack the app factory (bin/app.ts) instantiates.
const ALL_STACKS = [
  "backend",
  "projects",
  "registry",
  "services",
  "governance",
  "arbiter",
  "telemetry",
  "frontend",
  "gateway",
];

// ---------------------------------------------------------------------------
// Rule
// ---------------------------------------------------------------------------

/**
 * Resource/parameter types whose identity is recreatable under a normal
 * operational deploy (provisioner-generated, no stable name, and either
 * holds no durable user data or has a documented replace path). Exporting
 * one of these lets a future recreate deadlock against its importers,
 * exactly like finding 8b7ee8af (AgentCoreRegistry).
 */
const DENY_TYPE_PATTERNS: RegExp[] = [
  /^AWS::CloudFormation::CustomResource$/,
  /^Custom::/,
  /^AWS::BedrockAgentCore::/,
  /^AWS::Bedrock::(KnowledgeBase|DataSource|Agent|AgentAlias)$/,
  /^AWS::OpenSearchServerless::Collection$/,
  /^AWS::Cognito::(UserPoolClient|UserPoolDomain|UserPoolResourceServer)$/,
];

function isDeniedType(type: string | undefined): boolean {
  if (!type) return false;
  return DENY_TYPE_PATTERNS.some((re) => re.test(type));
}

interface CfnTemplate {
  Parameters?: Record<string, { Type?: string }>;
  Resources: Record<string, { Type?: string; Properties?: unknown }>;
  Outputs?: Record<string, { Value?: unknown; Export?: { Name?: unknown } }>;
}

interface Violation {
  stack: string;
  output: string;
  exportName: string;
  logicalId: string;
  resourceType: string;
  importers: string[];
}

/**
 * Walk an Output's Value, collecting every logical id referenced through
 * Ref / Fn::GetAtt / Fn::Join / Fn::Select / Fn::Split / Fn::Sub / Fn::If.
 * AWS::* pseudo parameters (Ref: "AWS::Region" etc.) are skipped — they are
 * never a Resources/Parameters logical id.
 */
function collectReferencedLogicalIds(value: unknown): string[] {
  const ids: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const v of node) walk(v);
      return;
    }
    if (node === null || typeof node !== "object") return;
    for (const [key, val] of Object.entries(node as Record<string, unknown>)) {
      if (key === "Ref" && typeof val === "string") {
        if (!val.startsWith("AWS::")) ids.push(val);
      } else if (key === "Fn::GetAtt") {
        // Either ["LogicalId", "Attr"] or "LogicalId.Attr"
        if (Array.isArray(val) && typeof val[0] === "string") {
          ids.push(val[0]);
        } else if (typeof val === "string") {
          ids.push(val.split(".")[0]);
        }
      } else if (key === "Fn::Sub") {
        // Either a plain string with ${Logical} / ${Logical.Attr}, or
        // [string, { name: ref-like }] — handle both.
        const template = Array.isArray(val) ? val[0] : val;
        if (typeof template === "string") {
          const matches = template.matchAll(/\$\{([^}!]+)\}/g);
          for (const m of matches) {
            const token = m[1].split(".")[0];
            if (!token.startsWith("AWS::")) ids.push(token);
          }
        }
        if (Array.isArray(val) && val[1]) walk(val[1]);
      } else {
        walk(val);
      }
    }
  };
  walk(value);
  return ids;
}

function resolveResourceType(
  template: CfnTemplate,
  logicalId: string,
): string | undefined {
  const resource = template.Resources[logicalId];
  if (resource?.Type) return resource.Type;
  const param = template.Parameters?.[logicalId];
  if (param?.Type) return param.Type;
  return undefined;
}

/** True when `logicalId` names a template Parameter of the SSM dynamic-
 * reference type (`AWS::SSM::Parameter::Value<...>`) — re-exporting an
 * SSM-resolved value would silently reopen the class of bug the SSM
 * migration (finding 8b7ee8af) fixed by introducing a new export name. */
function isSsmParameterValueType(
  template: CfnTemplate,
  logicalId: string,
): boolean {
  const type = template.Parameters?.[logicalId]?.Type;
  return (
    typeof type === "string" && type.startsWith("AWS::SSM::Parameter::Value")
  );
}

/** All Fn::ImportValue import names appearing anywhere in a template. */
function collectImportValueNames(node: unknown): string[] {
  const names: string[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const v of value) walk(v);
      return;
    }
    if (value !== null && typeof value === "object") {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (k === "Fn::ImportValue" && typeof v === "string") names.push(v);
        else walk(v);
      }
    }
  };
  walk(node);
  return names;
}

/**
 * Scan every export in `templatesByStack` and report one Violation per
 * (output, denied-referenced-resource) pair. `importersOf(exportName)`
 * lets callers plug in the whole-app import scan; the in-memory bite test
 * below passes a scan over just the two stacks it builds.
 */
function findRecreatableExports(
  templatesByStack: Record<string, CfnTemplate>,
  importersOf: (exportName: string) => string[],
): Violation[] {
  const violations: Violation[] = [];

  for (const [stackName, template] of Object.entries(templatesByStack)) {
    const outputs = template.Outputs ?? {};
    for (const [outputName, output] of Object.entries(outputs)) {
      const exportName = output.Export?.Name;
      if (typeof exportName !== "string") continue; // not exported

      const referencedIds = collectReferencedLogicalIds(output.Value);
      for (const logicalId of referencedIds) {
        if (isSsmParameterValueType(template, logicalId)) {
          violations.push({
            stack: stackName,
            output: outputName,
            exportName,
            logicalId,
            resourceType: "AWS::SSM::Parameter::Value<*> (Parameter)",
            importers: importersOf(exportName),
          });
          continue;
        }
        const resourceType = resolveResourceType(template, logicalId);
        if (isDeniedType(resourceType)) {
          violations.push({
            stack: stackName,
            output: outputName,
            exportName,
            logicalId,
            resourceType: resourceType!,
            importers: importersOf(exportName),
          });
        }
      }
    }
  }

  return violations;
}

function formatViolation(v: Violation): string {
  const importers = v.importers.length > 0 ? v.importers.join(", ") : "none";
  return (
    `${v.stack}.Outputs.${v.output} exports "${v.exportName}" whose Value ` +
    `references ${v.logicalId} (${v.resourceType}) — recreatable identity; ` +
    `share via an SSM parameter (see finding 8b7ee8af / registry-ssm.ts) or ` +
    `drop the export. Imported by: ${importers}`
  );
}

// ---------------------------------------------------------------------------
// Allowlist — the 4 known current violations, tracked against CIT-207
// ---------------------------------------------------------------------------

interface AllowlistEntry {
  exportName: string;
  justification: string;
  followUpId: string;
}

const KNOWN_VIOLATIONS: AllowlistEntry[] = [
  // CIT-207 phase 2: the last entry here (the Cognito UserPoolClient id
  // auto-export) was removed once phase 1 was live everywhere and the
  // exportValue keep-alive was dropped from BackendStack. Empty by design —
  // keep the structure so future violations have a documented landing spot.
];

const ALLOWLISTED_EXPORT_NAMES = new Set(
  KNOWN_VIOLATIONS.map((e) => e.exportName),
);

// ---------------------------------------------------------------------------
// (B) Whole-app guard over pre-synthesized cdk.out templates
// ---------------------------------------------------------------------------

function loadTemplate(stackShortName: string): CfnTemplate | null {
  const templatePath = path.join(
    CDK_OUT,
    `citadel-${stackShortName}-${ENV}.template.json`,
  );
  if (!fs.existsSync(templatePath)) return null;
  return JSON.parse(fs.readFileSync(templatePath, "utf-8"));
}

const allTemplatesPresent = ALL_STACKS.every((s) => loadTemplate(s) !== null);

describe("cross-stack export guard: no recreatable resource identity shared via export (CIT-205)", () => {
  if (!allTemplatesPresent) {
    const missing = ALL_STACKS.filter((s) => loadTemplate(s) === null);
    guardCdkOutInCi(missing.join(", "), "npm run build && npx cdk synth --all");
    it.skip(`skipped: fresh templates missing for [${missing.join(", ")}] (run 'npm run build && npx cdk synth --all' first)`, () => {});
    return;
  }

  const templatesByStack: Record<string, CfnTemplate> = {};
  for (const s of ALL_STACKS) {
    templatesByStack[s] = loadTemplate(s)!;
  }

  // Whole-app Fn::ImportValue index, built once.
  const importersByExportName = new Map<string, string[]>();
  for (const [stackName, template] of Object.entries(templatesByStack)) {
    for (const name of collectImportValueNames(template)) {
      const list = importersByExportName.get(name) ?? [];
      if (!list.includes(stackName)) list.push(stackName);
      importersByExportName.set(name, list);
    }
  }
  const importersOf = (exportName: string): string[] =>
    importersByExportName.get(exportName) ?? [];

  test("every export of a recreatable resource identity is on the tracked allowlist, nothing new", () => {
    const violations = findRecreatableExports(templatesByStack, importersOf);
    const unexpected = violations.filter(
      (v) => !ALLOWLISTED_EXPORT_NAMES.has(v.exportName),
    );

    if (unexpected.length > 0) {
      const detail = unexpected.map(formatViolation).join("\n");
      throw new Error(
        `New export(s) of a recreatable resource identity found (not on ` +
          `the tracked CIT-207 allowlist):\n${detail}`,
      );
    }

    expect(unexpected).toEqual([]);
  });

  test("the tracked allowlist matches exactly the current known violations (shrink, never grow silently)", () => {
    const violations = findRecreatableExports(templatesByStack, importersOf);
    const foundExportNames = new Set(violations.map((v) => v.exportName));

    // Every allowlisted entry must still be a real, currently-present
    // violation — if one disappears, remove it from KNOWN_VIOLATIONS
    // instead of leaving stale dead weight in the allowlist.
    for (const entry of KNOWN_VIOLATIONS) {
      expect(foundExportNames.has(entry.exportName)).toBe(true);
    }
    expect(violations.length).toBe(KNOWN_VIOLATIONS.length);
  });

  test("every allowlist entry carries a non-empty justification and follow-up id", () => {
    for (const entry of KNOWN_VIOLATIONS) {
      expect(entry.justification.trim().length).toBeGreaterThan(0);
      expect(entry.followUpId.trim().length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// (A) In-memory bite test: a synthetic Custom::Registry export must be
// caught. Proves the predicate has teeth independent of cdk.out freshness.
// ---------------------------------------------------------------------------

describe("recreatable-export-guard predicate — bite test", () => {
  test("reports a synthetic Custom::Registry export imported by a sibling stack", () => {
    const app = new cdk.App();

    const producer = new Stack(app, "TestProducerStack");
    const registry = new CfnResource(producer, "FakeRegistry", {
      type: "Custom::Registry",
    });
    new CfnOutput(producer, "RegistryIdOutput", {
      value: registry.getAtt("RegistryId").toString(),
      exportName: "test-producer-RegistryId",
    });

    const consumer = new Stack(app, "TestConsumerStack");
    new CfnResource(consumer, "FakeConsumerResource", {
      type: "AWS::SNS::Topic",
    });
    new CfnOutput(consumer, "ImportsRegistryId", {
      value: cdk.Fn.importValue("test-producer-RegistryId"),
    });

    app.synth();

    const templatesByStack: Record<string, CfnTemplate> = {
      producer: producer._toCloudFormation() as unknown as CfnTemplate,
      consumer: consumer._toCloudFormation() as unknown as CfnTemplate,
    };

    const importersOf = (exportName: string): string[] => {
      const hits: string[] = [];
      for (const [stackName, template] of Object.entries(templatesByStack)) {
        if (collectImportValueNames(template).includes(exportName)) {
          hits.push(stackName);
        }
      }
      return hits;
    };

    const violations = findRecreatableExports(templatesByStack, importersOf);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      stack: "producer",
      exportName: "test-producer-RegistryId",
      logicalId: "FakeRegistry",
      resourceType: "Custom::Registry",
      importers: ["consumer"],
    });
  });

  test("does not report a plain DynamoDB table export (stable-by-name, allowed)", () => {
    const app = new cdk.App();
    const producer = new Stack(app, "TestProducerStack2");
    const table = new CfnResource(producer, "FakeTable", {
      type: "AWS::DynamoDB::Table",
      properties: {
        TableName: "fixture-table",
        KeySchema: [{ AttributeName: "id", KeyType: "HASH" }],
        AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }],
        BillingMode: "PAY_PER_REQUEST",
      },
    });
    new CfnOutput(producer, "TableNameOutput", {
      value: table.ref,
      exportName: "test-producer2-TableName",
    });
    app.synth();

    const templatesByStack: Record<string, CfnTemplate> = {
      producer: producer._toCloudFormation() as unknown as CfnTemplate,
    };
    const violations = findRecreatableExports(templatesByStack, () => []);

    expect(violations).toEqual([]);
  });
});
