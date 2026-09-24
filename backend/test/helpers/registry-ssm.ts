/**
 * Shared assertions for the SSM-shared registry id/arn seam (finding
 * 8b7ee8af): consumer stacks resolve the registry id/arn from the SSM
 * parameters `/citadel/<env>/registry/{id,arn}` (published by BackendStack)
 * instead of importing the backend's CloudFormation exports.
 *
 * In a synthesized consumer template, `ssm.StringParameter.
 * valueForStringParameter` renders as a CFN Parameter of type
 * `AWS::SSM::Parameter::Value<String>` whose Default is the parameter name;
 * every use site becomes `{ Ref: <paramLogicalId> }`.
 */
import { REGISTRY_GENERATION } from "../../lib/registry-generation";

export interface CfnResourceLike {
  Type?: string;
  Properties?: {
    Environment?: { Variables?: Record<string, unknown> };
    EnvironmentVariables?: Record<string, unknown>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export type TemplateJson = {
  Parameters?: Record<string, { Type?: string; Default?: unknown }>;
  Resources: Record<string, CfnResourceLike>;
};

/** Minimal structural view of an IAM policy statement in a template. */
export interface CfnStatementLike {
  Effect?: string;
  Action?: string | string[];
  Resource?: unknown;
  [key: string]: unknown;
}

/** Minimal structural view of an AWS::IAM::Policy resource. */
export interface CfnPolicyResourceLike {
  Type?: string;
  Properties?: {
    Roles?: Array<{ Ref?: string }>;
    PolicyDocument?: { Statement?: CfnStatementLike[] };
    [key: string]: unknown;
  };
}

/**
 * Locate the SSM dynamic-parameter logical IDs for the registry id and arn
 * in a consumer template (by their Default parameter names).
 */
export function registrySsmParamLogicalIds(
  template: TemplateJson,
  environment = "test",
): { idParam: string; arnParam: string } {
  const params = template.Parameters ?? {};
  const findByDefault = (name: string): string => {
    const entry = Object.entries(params).find(
      ([, p]) =>
        p.Type === "AWS::SSM::Parameter::Value<String>" && p.Default === name,
    );
    if (!entry)
      throw new Error(
        `No AWS::SSM::Parameter::Value<String> template parameter with Default "${name}" found — the stack no longer resolves the registry value from SSM`,
      );
    return entry[0];
  };
  return {
    idParam: findByDefault(`/citadel/${environment}/registry/id`),
    arnParam: findByDefault(`/citadel/${environment}/registry/arn`),
  };
}

/** All Fn::ImportValue import names appearing anywhere in the template. */
export function collectImportValueNames(node: unknown): string[] {
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
 * Consumer templates must NOT import the backend's registry exports
 * (`<backend-stack>-RegistryArn` / `-RegistryId`, or the CDK auto-export
 * form `ExportsOutput...AgentCoreRegistryRegistry{Arn,Id}...`) — the values
 * are SSM-resolved instead.
 */
export function expectNoRegistryExportImports(template: TemplateJson): void {
  const registryImports = collectImportValueNames(template).filter((name) =>
    /RegistryArn|RegistryId/.test(name),
  );
  expect(registryImports).toEqual([]);
}

/**
 * Every function-like resource (Lambda function or AgentCore runtime) that
 * carries a REGISTRY_ID env var must also carry REGISTRY_GENERATION pinned
 * to the current generation constant, so bumping the generation redeploys
 * every registry consumer.
 */
export function expectRegistryGenerationBesideRegistryId(
  template: TemplateJson,
): void {
  const carriers: Array<[string, Record<string, unknown>]> = [];
  for (const [logicalId, resource] of Object.entries(template.Resources)) {
    if (
      resource.Type !== "AWS::Lambda::Function" &&
      resource.Type !== "AWS::BedrockAgentCore::Runtime"
    )
      continue;
    const env: Record<string, unknown> =
      resource.Properties?.Environment?.Variables ??
      resource.Properties?.EnvironmentVariables ??
      {};
    if ("REGISTRY_ID" in env) carriers.push([logicalId, env]);
  }
  expect(carriers.length).toBeGreaterThanOrEqual(1);
  for (const [logicalId, env] of carriers) {
    if (env.REGISTRY_GENERATION !== REGISTRY_GENERATION)
      throw new Error(
        `${logicalId} has REGISTRY_ID but REGISTRY_GENERATION is ${JSON.stringify(
          env.REGISTRY_GENERATION,
        )} (expected "${REGISTRY_GENERATION}")`,
      );
    expect(env.REGISTRY_GENERATION).toBe(REGISTRY_GENERATION);
  }
}
