/**
 * no-old-namespace-registry-ops.guard.test.ts — pins closed finding c6544456
 * / decision 06077146 (registry GA namespace migration, TS backend slice).
 *
 * AWS's Agent Registry moved from the preview `bedrock-agentcore` namespace
 * to the GA `agent-registry` namespace; access to the old namespace closes
 * per AWS's stated migration window. This stage migrated the TS REGISTRY-op
 * call sites (backend/src/services/registry-service.ts,
 * backend/src/lambda/registry-provisioner.ts) to
 * @aws-sdk/client-agent-registry-control / @aws-sdk/client-agent-registry.
 * @aws-sdk/client-bedrock-agentcore-control ITSELF remains installed and
 * imported elsewhere in backend/src, because runtime, gateway, identity and
 * credential-provider operations are NOT part of this migration and still
 * use the old client — only registry-record/registry commands moved.
 *
 * This guard enforces two things, scoped to what THIS stage actually
 * touched:
 *
 * 1. TS: no non-test file under backend/src imports a *RegistryRecord* or
 *    *Registry* command (Create/Get/Update/Delete/List/Submit) from
 *    @aws-sdk/client-bedrock-agentcore-control. Runtime/gateway/identity
 *    commands (e.g. InvokeAgentRuntimeCommand, CreateGatewayTargetCommand,
 *    GetWorkloadAccessTokenCommand, credential-provider commands) are
 *    explicitly allowlisted by name — they are NOT part of this migration
 *    and legitimately still come from the old client.
 *
 * 2. Python (arbiter/*.py): reports, rather than silently ignores, every
 *    `boto3.client('bedrock-agentcore-control')` call site that performs a
 *    registry op (create_registry_record / get_registry_record /
 *    list_registry_records / update_registry_record_status /
 *    submit_registry_record_for_approval / delete_registry_record /
 *    create_registry / get_registry / delete_registry /
 *    list_registries). Finding c6544456 explicitly scopes the Python
 *    migration (fabricator/index.py, fabricator/registry_recovery.py,
 *    catalog/registry_client.py, seedConfig/index.py) to a LATER stage of
 *    the same epic — this stage is TS-only. Failing the build on those
 *    known, tracked sites would be dishonest (it would look like new
 *    breakage rather than a scheduled follow-up), so they are captured in
 *    an explicit allowlist keyed to c6544456 with a TODO. Any Python
 *    registry-op site NOT in that allowlist fails the guard — so a NEW
 *    old-namespace call cannot sneak in unnoticed while the tracked ones
 *    await their own migration stage.
 */
import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";

const REPO_ROOT = path.resolve(__dirname, "../../..");
const TS_SCAN_DIR = path.join("backend", "src");
const PY_SCAN_DIR = path.join("arbiter");

// -- TS scan ---------------------------------------------------------------

/**
 * Command names legitimately imported from @aws-sdk/client-bedrock-agentcore-control
 * post-migration: runtime invocation, gateway target management, workload
 * identity, and credential-provider management. None of these are registry
 * ops, and none moved to the GA namespace SDKs.
 */
const ALLOWLISTED_OLD_NAMESPACE_IMPORTS = new Set([
  // Runtime
  "InvokeAgentRuntimeCommand",
  "BedrockAgentCoreClient",
  "BedrockAgentCoreControlClient",
  // Gateway
  "CreateGatewayCommand",
  "GetGatewayCommand",
  "DeleteGatewayCommand",
  "ListGatewaysCommand",
  "UpdateGatewayCommand",
  "CreateGatewayTargetCommand",
  "GetGatewayTargetCommand",
  "DeleteGatewayTargetCommand",
  "ListGatewayTargetsCommand",
  "UpdateGatewayTargetCommand",
  // Identity / workload identity
  "GetWorkloadAccessTokenCommand",
  "GetWorkloadAccessTokenForJWTCommand",
  "GetWorkloadAccessTokenForUserIdCommand",
  "CreateWorkloadIdentityCommand",
  "GetWorkloadIdentityCommand",
  "DeleteWorkloadIdentityCommand",
  "ListWorkloadIdentitiesCommand",
  // Credential provider management
  "CreateApiKeyCredentialProviderCommand",
  "CreateOauth2CredentialProviderCommand",
  "GetApiKeyCredentialProviderCommand",
  "GetOauth2CredentialProviderCommand",
  "DeleteApiKeyCredentialProviderCommand",
  "DeleteOauth2CredentialProviderCommand",
  "ListApiKeyCredentialProvidersCommand",
  "ListOauth2CredentialProvidersCommand",
  "UpdateApiKeyCredentialProviderCommand",
  "UpdateOauth2CredentialProviderCommand",
  // Shared enums/types safe to still import (not commands, but appear in
  // the same import statements as allowlisted commands).
  "DescriptorType",
  "RegistryRecordStatus", // type-only re-export some callers use for display; not a command
]);

/**
 * Command-name shape this guard treats as a REGISTRY op: anything whose
 * name contains "RegistryRecord" (create/get/update/delete/list/submit) or
 * is exactly one of the registry-lifecycle commands (CreateRegistry,
 * GetRegistry, DeleteRegistry, ListRegistries, UpdateRegistry).
 */
function isRegistryCommandName(name: string): boolean {
  if (name.includes("RegistryRecord")) return true;
  return /^(Create|Get|Delete|List|Update)Registr(y|ies)Command$/.test(name);
}

function listTsFiles(dir: string): string[] {
  const abs = path.join(REPO_ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  const out: string[] = [];
  const stack = [abs];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (
        entry.isFile() &&
        /\.tsx?$/.test(entry.name) &&
        !/\.test\.tsx?$/.test(entry.name) &&
        !full.includes(`${path.sep}__tests__${path.sep}`)
      ) {
        out.push(full);
      }
    }
  }
  return out;
}

function parseSourceFile(filePath: string, text?: string): ts.SourceFile {
  const content = text ?? fs.readFileSync(filePath, "utf-8");
  return ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.ESNext,
    /* setParentNodes */ true,
    filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

/**
 * Returns every disallowed registry-command import identifier found in an
 * import declaration whose module specifier is
 * '@aws-sdk/client-bedrock-agentcore-control'.
 */
function findOldNamespaceRegistryImports(sf: ts.SourceFile): string[] {
  const hits: string[] = [];

  function visit(node: ts.Node): void {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === "@aws-sdk/client-bedrock-agentcore-control"
    ) {
      const clause = node.importClause;
      const namedBindings = clause?.namedBindings;
      if (namedBindings && ts.isNamedImports(namedBindings)) {
        for (const spec of namedBindings.elements) {
          const importedName = (spec.propertyName ?? spec.name).text;
          if (
            isRegistryCommandName(importedName) &&
            !ALLOWLISTED_OLD_NAMESPACE_IMPORTS.has(importedName)
          ) {
            hits.push(importedName);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sf);
  return hits;
}

function scanTs(): Array<{ file: string; imports: string[] }> {
  const violations: Array<{ file: string; imports: string[] }> = [];
  for (const file of listTsFiles(TS_SCAN_DIR)) {
    const relPath = path.relative(REPO_ROOT, file);
    const sf = parseSourceFile(file);
    const hits = findOldNamespaceRegistryImports(sf);
    if (hits.length > 0) {
      violations.push({ file: relPath, imports: hits });
    }
  }
  return violations;
}

// -- Python scan -------------------------------------------------------------

const PY_REGISTRY_OP_METHODS = [
  "create_registry_record",
  "get_registry_record",
  "update_registry_record",
  "update_registry_record_status",
  "delete_registry_record",
  "list_registry_records",
  "submit_registry_record_for_approval",
  "create_registry",
  "get_registry",
  "delete_registry",
  "list_registries",
];

/**
 * Known, tracked pre-existing Python registry-op sites on the OLD namespace,
 * scheduled for a LATER stage of the c6544456 migration epic (this stage is
 * TS-only, per decision 06077146). Keyed by relative path so a fix removes
 * the entry (and the guard then requires the site to actually be gone,
 * since removing the allowlist entry while the call remains would fail the
 * "no other hits" assertion below). Detection is file-level: a file
 * matching both (a) `boto3.client('bedrock-agentcore-control')` AND (b) a
 * registry-op method call. `arbiter/fabricator/registry_recovery.py` also
 * performs registry ops but takes an externally-constructed client as a
 * parameter rather than instantiating its own — outside this detector's
 * reach; it will be caught transitively once fabricator/index.py's client
 * construction migrates.
 *
 * TODO(finding c6544456): migrate these to boto3 'agent-registry-control' /
 * 'agent-registry' clients + the same schema adapter used in
 * registry-service.ts, then delete this allowlist.
 */
const ALLOWLISTED_PY_OLD_NAMESPACE_FILES = new Set([
  path.join("arbiter", "fabricator", "index.py"),
  path.join("arbiter", "catalog", "registry_client.py"),
  path.join("arbiter", "seedConfig", "index.py"),
  // NOTE: arbiter/fabricator/registry_recovery.py performs registry ops too,
  // but receives an externally-constructed boto3 client as a parameter
  // rather than calling boto3.client('bedrock-agentcore-control') itself, so
  // it is outside this file-level detector's reach; its ops will be caught
  // transitively once fabricator/index.py's client construction migrates.
]);

function listPyFiles(dir: string): string[] {
  const abs = path.join(REPO_ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  const out: string[] = [];
  const stack = [abs];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "__pycache__") {
        continue;
      }
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (
        entry.isFile() &&
        entry.name.endsWith(".py") &&
        !entry.name.startsWith("test_") &&
        !full.includes(`${path.sep}__tests__${path.sep}`)
      ) {
        out.push(full);
      }
    }
  }
  return out;
}

/**
 * True when `content` both instantiates a boto3 client for the OLD
 * 'bedrock-agentcore-control' service name AND calls at least one registry
 * op method name found in PY_REGISTRY_OP_METHODS anywhere in the file.
 * File-level (not call-site-precise) — sufficient to flag/allowlist a file,
 * matching the granularity of the tracked migration TODOs.
 */
function usesOldNamespaceRegistryOps(content: string): boolean {
  const hasOldClient =
    /boto3\.client\(\s*['"]bedrock-agentcore-control['"]/.test(content);
  if (!hasOldClient) return false;
  return PY_REGISTRY_OP_METHODS.some((m) =>
    new RegExp(`\\.${m}\\s*\\(`).test(content),
  );
}

function scanPy(): string[] {
  const hits: string[] = [];
  for (const file of listPyFiles(PY_SCAN_DIR)) {
    const relPath = path.relative(REPO_ROOT, file);
    const content = fs.readFileSync(file, "utf-8");
    if (usesOldNamespaceRegistryOps(content)) {
      hits.push(relPath);
    }
  }
  return hits;
}

describe("no-old-namespace-registry-ops guard (finding c6544456 / decision 06077146)", () => {
  it("no non-test TS file under backend/src imports a Registry*/RegistryRecord* command from @aws-sdk/client-bedrock-agentcore-control", () => {
    const violations = scanTs();
    expect(violations).toEqual([]);
  });

  it("bites: importing CreateRegistryRecordCommand from the old namespace IS flagged", () => {
    const sf = parseSourceFile(
      "scratch.ts",
      [
        "import { CreateRegistryRecordCommand } from '@aws-sdk/client-bedrock-agentcore-control';",
        "export const x = CreateRegistryRecordCommand;",
      ].join("\n"),
    );
    expect(findOldNamespaceRegistryImports(sf)).toEqual([
      "CreateRegistryRecordCommand",
    ]);
  });

  it("bites: importing ListRegistriesCommand (registry-lifecycle, not just *Record*) from the old namespace IS flagged", () => {
    const sf = parseSourceFile(
      "scratch.ts",
      [
        "import { ListRegistriesCommand } from '@aws-sdk/client-bedrock-agentcore-control';",
        "export const x = ListRegistriesCommand;",
      ].join("\n"),
    );
    expect(findOldNamespaceRegistryImports(sf)).toEqual([
      "ListRegistriesCommand",
    ]);
  });

  it("does NOT flag an allowlisted runtime/gateway/identity/credential-provider import from the old namespace", () => {
    const sf = parseSourceFile(
      "scratch.ts",
      [
        "import {",
        "  InvokeAgentRuntimeCommand,",
        "  CreateGatewayTargetCommand,",
        "  GetWorkloadAccessTokenCommand,",
        "  CreateApiKeyCredentialProviderCommand,",
        "} from '@aws-sdk/client-bedrock-agentcore-control';",
        "export const x = [InvokeAgentRuntimeCommand, CreateGatewayTargetCommand, GetWorkloadAccessTokenCommand, CreateApiKeyCredentialProviderCommand];",
      ].join("\n"),
    );
    expect(findOldNamespaceRegistryImports(sf)).toEqual([]);
  });

  it("does NOT flag a Registry*/RegistryRecord* import from the NEW namespace packages", () => {
    const sf = parseSourceFile(
      "scratch.ts",
      [
        "import { CreateRegistryRecordCommand, ListRegistriesCommand } from '@aws-sdk/client-agent-registry-control';",
        "export const x = [CreateRegistryRecordCommand, ListRegistriesCommand];",
      ].join("\n"),
    );
    expect(findOldNamespaceRegistryImports(sf)).toEqual([]);
  });

  it("does NOT flag a comment that merely mentions an old-namespace registry command in prose", () => {
    const sf = parseSourceFile(
      "scratch.ts",
      [
        "/**",
        " * Do not import CreateRegistryRecordCommand from",
        " * '@aws-sdk/client-bedrock-agentcore-control' — see finding c6544456.",
        " */",
        "export function noop(): void {}",
      ].join("\n"),
    );
    expect(findOldNamespaceRegistryImports(sf)).toEqual([]);
  });

  it("registry-service.ts and registry-provisioner.ts (this stage's migrated files) no longer import any old-namespace registry command", () => {
    const migratedFiles = [
      path.join(REPO_ROOT, "backend", "src", "services", "registry-service.ts"),
      path.join(
        REPO_ROOT,
        "backend",
        "src",
        "lambda",
        "registry-provisioner.ts",
      ),
    ];
    for (const file of migratedFiles) {
      const sf = parseSourceFile(file);
      expect(findOldNamespaceRegistryImports(sf)).toEqual([]);
    }
  });

  it("reports every Python registry-op site still on the old namespace, and requires each to be an explicitly tracked, allowlisted TODO (finding c6544456) rather than silently passing or failing on undocumented drift", () => {
    const hits = scanPy();
    const untracked = hits.filter(
      (f) => !ALLOWLISTED_PY_OLD_NAMESPACE_FILES.has(f),
    );
    // Any NEW old-namespace registry-op site (not already tracked) fails
    // the build — this is the tripwire's actual enforcement.
    expect(untracked).toEqual([]);
    // Sanity: every allowlisted entry must still correspond to a real hit —
    // if a tracked file gets migrated, its entry must be removed from the
    // allowlist above (this assertion fails loudly if that upkeep is
    // skipped and the list silently drifts stale-but-harmless).
    for (const tracked of ALLOWLISTED_PY_OLD_NAMESPACE_FILES) {
      expect(hits).toContain(tracked);
    }
  });

  it("bites: a boto3 'bedrock-agentcore-control' client calling get_registry_record IS detected by the Python scanner", () => {
    const content = [
      "import boto3",
      "client = boto3.client('bedrock-agentcore-control')",
      "def f(registry_id, record_id):",
      "    return client.get_registry_record(registryId=registry_id, recordId=record_id)",
    ].join("\n");
    expect(usesOldNamespaceRegistryOps(content)).toBe(true);
  });

  it("does NOT flag a boto3 'bedrock-agentcore-control' client that calls only runtime/gateway ops (no registry method)", () => {
    const content = [
      "import boto3",
      "client = boto3.client('bedrock-agentcore-control')",
      "def f(gateway_id):",
      "    return client.get_gateway(gatewayIdentifier=gateway_id)",
    ].join("\n");
    expect(usesOldNamespaceRegistryOps(content)).toBe(false);
  });

  it("does NOT flag a client built on a different (e.g. new-namespace) boto3 service name", () => {
    const content = [
      "import boto3",
      "client = boto3.client('agent-registry-control')",
      "def f(registry_id, record_id):",
      "    return client.get_registry_record(registryId=registry_id, recordId=record_id)",
    ].join("\n");
    expect(usesOldNamespaceRegistryOps(content)).toBe(false);
  });
});
