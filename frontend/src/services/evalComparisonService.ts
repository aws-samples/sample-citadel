/**
 * Eval baseline comparison + regression service (CIT-105 UI).
 *
 * Source of truth: backend/src/schema/schema.graphql (5 queries + 3
 * mutations under "Eval baseline comparison + regression (CIT-105)") and
 * the pure algorithm types in
 * backend/src/lambda/utils/eval-comparison.ts. Field names and shapes
 * mirror the schema verbatim — drift between this file and the schema is
 * a bug.
 *
 * This service never reimplements the comparison algorithm; it only
 * reads/writes the I/O-layer wire shapes produced by
 * eval-comparison-resolver.ts.
 */

import serverService from './server';

// -- Shared enums / literal unions (mirrors schema.graphql verbatim) --

export type EvalComparisonDirection =
  | 'improved'
  | 'regressed'
  | 'unchanged'
  | 'unstable'
  | 'incomparable'
  | 'insufficient_sample';

export type EvalComparisonVerdictStatus =
  | 'PASS'
  | 'REGRESSED'
  | 'UNSTABLE'
  | 'INCOMPARABLE'
  | 'NOTHING_TO_COMPARE';

export type EvalComparisonPerCaseClass =
  | 'improved'
  | 'regressed'
  | 'unchanged'
  | 'unstable'
  | 'incomparable'
  | 'new'
  | 'dropped';

export interface EvalComparisonCaseCounts {
  improved: number;
  regressed: number;
  unstable: number;
  unchanged: number;
  incomparable: number;
  new: number;
  dropped: number;
}

export interface EvalComparisonDimension {
  dimension: string;
  direction: EvalComparisonDirection;
  materialRegression: boolean;
  unstable: boolean;
  baselineStat: number | null;
  candidateStat: number | null;
  delta: number | null;
  caseCounts: EvalComparisonCaseCounts;
}

export interface EvalComparisonThresholds {
  passRateDropThreshold: number;
  meanScoreDropThreshold: number;
  latencyP95IncreaseMsThreshold: number;
  costIncreaseThreshold: number;
  minSampleCount: number;
  scoreStabilityBand: number;
}

export interface EvalComparisonVerdict {
  comparisonId: string;
  orgId: string;
  suiteId: string;
  suiteVersion: number;
  agentTargetId: string;
  baselineEvalRunId: string;
  baselineAgentTargetVersion: string;
  candidateEvalRunIds: string[];
  candidateAgentTargetVersion: string;
  repeatCount: number;
  scorerVersions: string[];
  thresholds: EvalComparisonThresholds;
  dimensions: EvalComparisonDimension[];
  anyMaterialRegression: boolean;
  materiallyRegressedDimensions: string[];
  unstableDimensions: string[];
  verdictStatus: EvalComparisonVerdictStatus;
  /** AWSJSON — string-encoded Map<dimension, EvalComparisonPerCaseRow[]>
   * when stored inline. Null/undefined when offloaded and hydration
   * failed, or before hydration. */
  caseDetail?: string | null;
  caseDetailRef?: string | null;
  createdAt: string;
  createdBy: string;
}

export interface EvalComparisonPerCaseRow {
  caseId: string;
  classification: EvalComparisonPerCaseClass;
  baselineValue: number | null;
  candidateValue: number | null;
}

export interface EvalBaseline {
  orgId: string;
  agentTargetId: string;
  suiteId: string;
  baselineEvalRunId: string;
  baselineSuiteVersion: number;
  baselineAgentTargetVersion: string;
  previousBaselineEvalRunId?: string | null;
  reason?: string | null;
  designatedAt: string;
  designatedBy: string;
  version: number;
}

export interface DesignateEvalBaselineInput {
  orgId: string;
  agentTargetId: string;
  suiteId: string;
  baselineEvalRunId: string;
  reason?: string;
}

export interface ComputeEvalComparisonInput {
  orgId: string;
  suiteId: string;
  candidateEvalRunIds: string[];
  baselineEvalRunId?: string;
  thresholdOverride?: Record<string, unknown>;
  idempotencyKey: string;
}

export interface EvalComparisonThresholdConfig {
  orgId: string;
  suiteId: string;
  thresholds: Record<string, unknown>;
  updatedAt?: string | null;
  updatedBy?: string | null;
  version: number;
}

export interface SetEvalComparisonThresholdConfigInput {
  thresholds: Record<string, unknown>;
}

// -- Queries --

const getEvalBaselineQuery = `
  query GetEvalBaseline($orgId: ID!, $agentTargetId: ID!, $suiteId: ID!) {
    getEvalBaseline(orgId: $orgId, agentTargetId: $agentTargetId, suiteId: $suiteId) {
      orgId
      agentTargetId
      suiteId
      baselineEvalRunId
      baselineSuiteVersion
      baselineAgentTargetVersion
      previousBaselineEvalRunId
      reason
      designatedAt
      designatedBy
      version
    }
  }
`;

async function getEvalBaseline(
  orgId: string,
  agentTargetId: string,
  suiteId: string,
): Promise<EvalBaseline | null> {
  const response = await serverService.query<{ getEvalBaseline: EvalBaseline | null }>(
    getEvalBaselineQuery,
    { orgId, agentTargetId, suiteId },
  );
  return response.getEvalBaseline;
}

const listEvalBaselinesQuery = `
  query ListEvalBaselines($orgId: ID!) {
    listEvalBaselines(orgId: $orgId) {
      orgId
      agentTargetId
      suiteId
      baselineEvalRunId
      baselineSuiteVersion
      baselineAgentTargetVersion
      previousBaselineEvalRunId
      reason
      designatedAt
      designatedBy
      version
    }
  }
`;

async function listEvalBaselines(orgId: string): Promise<EvalBaseline[]> {
  const response = await serverService.query<{ listEvalBaselines: EvalBaseline[] }>(
    listEvalBaselinesQuery,
    { orgId },
  );
  return response.listEvalBaselines;
}

const evalComparisonVerdictFields = `
  comparisonId
  orgId
  suiteId
  suiteVersion
  agentTargetId
  baselineEvalRunId
  baselineAgentTargetVersion
  candidateEvalRunIds
  candidateAgentTargetVersion
  repeatCount
  scorerVersions
  thresholds {
    passRateDropThreshold
    meanScoreDropThreshold
    latencyP95IncreaseMsThreshold
    costIncreaseThreshold
    minSampleCount
    scoreStabilityBand
  }
  dimensions {
    dimension
    direction
    materialRegression
    unstable
    baselineStat
    candidateStat
    delta
    caseCounts {
      improved
      regressed
      unstable
      unchanged
      incomparable
      new
      dropped
    }
  }
  anyMaterialRegression
  materiallyRegressedDimensions
  unstableDimensions
  verdictStatus
  caseDetail
  caseDetailRef
  createdAt
  createdBy
`;

const getEvalComparisonQuery = `
  query GetEvalComparison($comparisonId: ID!) {
    getEvalComparison(comparisonId: $comparisonId) {
      ${evalComparisonVerdictFields}
    }
  }
`;

async function getEvalComparison(comparisonId: string): Promise<EvalComparisonVerdict | null> {
  const response = await serverService.query<{ getEvalComparison: EvalComparisonVerdict | null }>(
    getEvalComparisonQuery,
    { comparisonId },
  );
  return response.getEvalComparison;
}

const listEvalComparisonsQuery = `
  query ListEvalComparisons($orgId: ID!, $suiteId: ID) {
    listEvalComparisons(orgId: $orgId, suiteId: $suiteId) {
      ${evalComparisonVerdictFields}
    }
  }
`;

async function listEvalComparisons(
  orgId: string,
  suiteId?: string,
): Promise<EvalComparisonVerdict[]> {
  const response = await serverService.query<{ listEvalComparisons: EvalComparisonVerdict[] }>(
    listEvalComparisonsQuery,
    { orgId, suiteId },
  );
  return response.listEvalComparisons;
}

const getEvalComparisonThresholdConfigQuery = `
  query GetEvalComparisonThresholdConfig($orgId: ID!, $suiteId: ID!) {
    getEvalComparisonThresholdConfig(orgId: $orgId, suiteId: $suiteId) {
      orgId
      suiteId
      thresholds
      updatedAt
      updatedBy
      version
    }
  }
`;

async function getEvalComparisonThresholdConfig(
  orgId: string,
  suiteId: string,
): Promise<EvalComparisonThresholdConfig | null> {
  const response = await serverService.query<{
    getEvalComparisonThresholdConfig: EvalComparisonThresholdConfig | null;
  }>(getEvalComparisonThresholdConfigQuery, { orgId, suiteId });
  return response.getEvalComparisonThresholdConfig;
}

// -- Mutations --

const designateEvalBaselineMutation = `
  mutation DesignateEvalBaseline($input: DesignateEvalBaselineInput!) {
    designateEvalBaseline(input: $input) {
      orgId
      agentTargetId
      suiteId
      baselineEvalRunId
      baselineSuiteVersion
      baselineAgentTargetVersion
      previousBaselineEvalRunId
      reason
      designatedAt
      designatedBy
      version
    }
  }
`;

async function designateEvalBaseline(
  input: DesignateEvalBaselineInput,
): Promise<EvalBaseline> {
  const response = await serverService.mutate<{ designateEvalBaseline: EvalBaseline }>(
    designateEvalBaselineMutation,
    { input },
  );
  return response.designateEvalBaseline;
}

const computeEvalComparisonMutation = `
  mutation ComputeEvalComparison($input: ComputeEvalComparisonInput!) {
    computeEvalComparison(input: $input) {
      ${evalComparisonVerdictFields}
    }
  }
`;

async function computeEvalComparison(
  input: ComputeEvalComparisonInput,
): Promise<EvalComparisonVerdict> {
  const response = await serverService.mutate<{ computeEvalComparison: EvalComparisonVerdict }>(
    computeEvalComparisonMutation,
    { input },
  );
  return response.computeEvalComparison;
}

const setEvalComparisonThresholdConfigMutation = `
  mutation SetEvalComparisonThresholdConfig($orgId: ID!, $suiteId: ID!, $input: SetEvalComparisonThresholdConfigInput!) {
    setEvalComparisonThresholdConfig(orgId: $orgId, suiteId: $suiteId, input: $input) {
      orgId
      suiteId
      thresholds
      updatedAt
      updatedBy
      version
    }
  }
`;

async function setEvalComparisonThresholdConfig(
  orgId: string,
  suiteId: string,
  input: SetEvalComparisonThresholdConfigInput,
): Promise<EvalComparisonThresholdConfig> {
  const response = await serverService.mutate<{
    setEvalComparisonThresholdConfig: EvalComparisonThresholdConfig;
  }>(setEvalComparisonThresholdConfigMutation, { orgId, suiteId, input });
  return response.setEvalComparisonThresholdConfig;
}

export const evalComparisonService = {
  getEvalBaseline,
  listEvalBaselines,
  getEvalComparison,
  listEvalComparisons,
  getEvalComparisonThresholdConfig,
  designateEvalBaseline,
  computeEvalComparison,
  setEvalComparisonThresholdConfig,
};

export default evalComparisonService;
