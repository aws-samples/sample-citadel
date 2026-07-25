/**
 * Rail 7 — resolver behavioral equivalence.
 *
 * For every moved resolver (per the move manifest), the satellite's
 * RequestMappingTemplate / ResponseMappingTemplate hashes and DataSource
 * config (type + lambda function ref) must equal the baseline's. This is
 * the rail the adversarial reviewer flagged as the blocking gap: rail 3
 * only checks that the field exists in exactly one stack, not that its VTL
 * or DataSource wiring reproduces backend's behavior.
 *
 * In this no-move stage the manifest is empty and the rail passes
 * trivially (nothing to compare).
 */
import { StackBaseline } from "../types";
import { RailResult, RailViolation } from "../types";

export interface MovedResolverMapping {
  /** "TypeName.fieldName" key as it appears in the baseline. */
  fieldKey: string;
  /** Stack the resolver now lives in. */
  satelliteStackName: string;
}

export interface SatelliteResolverSnapshot {
  requestMappingTemplateHash: string | null;
  responseMappingTemplateHash: string | null;
  dataSourceType: string | null;
  dataSourceLambdaFunctionArnRef: string | null;
}

export function runResolverEquivalence(
  baseline: StackBaseline,
  /** fieldKey -> satellite resolver snapshot, built by the caller from the satellite template + its DataSource. */
  satelliteResolvers: Record<string, SatelliteResolverSnapshot>,
  manifest: MovedResolverMapping[],
): RailResult {
  const violations: RailViolation[] = [];

  for (const { fieldKey, satelliteStackName } of manifest) {
    const baselineResolver = baseline.resolvers[fieldKey];
    if (!baselineResolver) {
      violations.push({
        rail: "rail7",
        logicalId: fieldKey,
        message: `No baseline resolver found for "${fieldKey}" — cannot verify behavioral equivalence.`,
      });
      continue;
    }
    const baselineDataSource = Object.values(baseline.dataSources).find(
      (ds) => ds.name === baselineResolver.dataSourceName,
    );

    const satelliteSnapshot = satelliteResolvers[fieldKey];
    if (!satelliteSnapshot) {
      violations.push({
        rail: "rail7",
        logicalId: fieldKey,
        message: `Resolver "${fieldKey}" is declared as moved to ${satelliteStackName} but no satellite snapshot was provided.`,
      });
      continue;
    }

    if (
      satelliteSnapshot.requestMappingTemplateHash !==
      baselineResolver.requestMappingTemplateHash
    ) {
      violations.push({
        rail: "rail7",
        logicalId: fieldKey,
        message: `RequestMappingTemplate hash mismatch for "${fieldKey}" moved to ${satelliteStackName}.`,
      });
    }
    if (
      satelliteSnapshot.responseMappingTemplateHash !==
      baselineResolver.responseMappingTemplateHash
    ) {
      violations.push({
        rail: "rail7",
        logicalId: fieldKey,
        message: `ResponseMappingTemplate hash mismatch for "${fieldKey}" moved to ${satelliteStackName}.`,
      });
    }
    if (
      baselineDataSource &&
      satelliteSnapshot.dataSourceType !== baselineDataSource.type
    ) {
      violations.push({
        rail: "rail7",
        logicalId: fieldKey,
        message: `DataSource type mismatch for "${fieldKey}" moved to ${satelliteStackName}: baseline=${baselineDataSource.type}, satellite=${satelliteSnapshot.dataSourceType}.`,
      });
    }
  }

  return {
    rail: "rail7",
    name: "resolver behavioral equivalence",
    passed: violations.length === 0,
    violations,
  };
}
