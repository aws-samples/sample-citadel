/**
 * Pure baseline-builder: turns a loaded CfnTemplate into a StackBaseline
 * (see types.ts). Kept separate from the CLI entrypoint (split-baseline.ts)
 * so it can be unit-tested without invoking `cdk synth`.
 */
import { CfnTemplate, StackBaseline } from "./types";
import {
  hashMappingTemplate,
  isStatefulType,
  normalizePolicyStatements,
} from "./template-utils";

/**
 * Map of Lambda Function logical ID -> the logical ID of the IAM::Role it
 * uses, resolved via the function's `Role` property (Fn::GetAtt reference).
 */
function resolveFunctionRoleLogicalId(
  template: CfnTemplate,
  fnLogicalId: string,
): string | null {
  const fn = template.Resources[fnLogicalId];
  const role = fn?.Properties?.Role;
  if (
    role !== null &&
    typeof role === "object" &&
    "Fn::GetAtt" in (role as Record<string, unknown>)
  ) {
    const getAtt = (role as Record<string, unknown>)["Fn::GetAtt"];
    if (Array.isArray(getAtt) && typeof getAtt[0] === "string") {
      return getAtt[0];
    }
  }
  return null;
}

/** Collect every IAM::Policy attached (via Roles[]) to a given role logical ID, plus inline PolicyDocument on the role itself. */
function collectPolicyStatementsForRole(
  template: CfnTemplate,
  roleLogicalId: string,
) {
  const statements = [];
  const role = template.Resources[roleLogicalId];
  const inlinePolicies = role?.Properties?.Policies;
  if (Array.isArray(inlinePolicies)) {
    for (const p of inlinePolicies) {
      if (p && typeof p === "object" && "PolicyDocument" in p) {
        statements.push(
          ...normalizePolicyStatements(
            (p as Record<string, unknown>).PolicyDocument,
          ),
        );
      }
    }
  }
  for (const [, res] of Object.entries(template.Resources)) {
    if (res.Type !== "AWS::IAM::Policy") continue;
    const roles = res.Properties?.Roles;
    const refsThisRole =
      Array.isArray(roles) &&
      roles.some(
        (r) =>
          r !== null &&
          typeof r === "object" &&
          "Ref" in (r as Record<string, unknown>) &&
          (r as Record<string, unknown>)["Ref"] === roleLogicalId,
      );
    if (refsThisRole) {
      statements.push(
        ...normalizePolicyStatements(res.Properties?.PolicyDocument),
      );
    }
  }
  return statements;
}

export function buildBaseline(
  stackName: string,
  template: CfnTemplate,
  capturedAt: string = new Date().toISOString(),
): StackBaseline {
  const baseline: StackBaseline = {
    stackName,
    capturedAt,
    resources: {},
    resolvers: {},
    dataSources: {},
    lambdaRolePolicies: {},
    exports: {},
  };

  for (const [logicalId, res] of Object.entries(template.Resources)) {
    baseline.resources[logicalId] = {
      type: res.Type,
      deletionPolicy: res.DeletionPolicy,
      updateReplacePolicy: res.UpdateReplacePolicy,
      properties: isStatefulType(res.Type) ? (res.Properties ?? {}) : undefined,
    };

    if (res.Type === "AWS::AppSync::Resolver") {
      const props = res.Properties ?? {};
      const typeName = String(props.TypeName ?? "");
      const fieldName = String(props.FieldName ?? "");
      const req = hashMappingTemplate(props.RequestMappingTemplate);
      const resp = hashMappingTemplate(props.ResponseMappingTemplate);
      baseline.resolvers[`${typeName}.${fieldName}`] = {
        logicalId,
        typeName,
        fieldName,
        dataSourceName: String(props.DataSourceName ?? ""),
        requestMappingTemplateHash: req.hash,
        responseMappingTemplateHash: resp.hash,
        requestMappingTemplateBytes: req.bytes,
        responseMappingTemplateBytes: resp.bytes,
      };
    }

    if (res.Type === "AWS::AppSync::DataSource") {
      const props = res.Properties ?? {};
      const lambdaArn = props.LambdaConfig;
      let lambdaRef: string | null = null;
      if (
        lambdaArn !== null &&
        typeof lambdaArn === "object" &&
        "LambdaFunctionArn" in (lambdaArn as Record<string, unknown>)
      ) {
        const arnField = (lambdaArn as Record<string, unknown>)[
          "LambdaFunctionArn"
        ];
        if (
          arnField !== null &&
          typeof arnField === "object" &&
          "Fn::GetAtt" in (arnField as Record<string, unknown>)
        ) {
          const getAtt = (arnField as Record<string, unknown>)["Fn::GetAtt"];
          if (Array.isArray(getAtt) && typeof getAtt[0] === "string") {
            lambdaRef = getAtt[0];
          }
        }
      }
      baseline.dataSources[logicalId] = {
        logicalId,
        name: String(props.Name ?? ""),
        type: typeof props.Type === "string" ? props.Type : null,
        lambdaFunctionArnRef: lambdaRef,
      };
    }

    if (res.Type === "AWS::Lambda::Function") {
      const roleLogicalId = resolveFunctionRoleLogicalId(template, logicalId);
      if (roleLogicalId) {
        baseline.lambdaRolePolicies[logicalId] = collectPolicyStatementsForRole(
          template,
          roleLogicalId,
        );
      } else {
        baseline.lambdaRolePolicies[logicalId] = [];
      }
    }
  }

  for (const [outputName, output] of Object.entries(template.Outputs ?? {})) {
    if (output.Export && output.Export.Name !== undefined) {
      baseline.exports[outputName] = {
        exportName: output.Export.Name,
        value: output.Value,
      };
    }
  }

  return baseline;
}
