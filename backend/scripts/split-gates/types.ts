/**
 * Shared types for the backend-stack-split safety gates.
 *
 * These gates verify that splitting `citadel-backend-<env>` into satellite
 * stacks (a later stage, not this one) never silently breaks the backend
 * template. THIS STAGE moves zero resources — it only builds and proves the
 * gate machinery against the current, unmoved synth so the move stages have
 * a trustworthy baseline + CI check to run against.
 *
 * Binding decision 30e6d067: 7 rails total.
 *   1. removals-only diff (this module: rail1-removals-only.ts)
 *   2. stateful logical-ID pin (rail2-stateful-pin.test.ts)
 *   3. resolver parity (rail3-resolver-parity.ts)
 *   4. doc-claims stack-count check (wired into the runner, pre-existing convention)
 *   5. cdk-nag (wired into the runner via `npm run nag`, pre-existing convention)
 *   6. IAM privilege-equivalence for moved resolver-Lambda roles (rail6-iam-equivalence.ts)
 *   7. resolver behavioral equivalence (mapping template + datasource config) (rail7-resolver-equivalence.ts)
 */

/** A single CloudFormation resource as it appears in a synthesized template. */
export interface CfnResource {
  Type: string;
  Properties?: Record<string, unknown>;
  DeletionPolicy?: string;
  UpdateReplacePolicy?: string;
  DependsOn?: string | string[];
  Metadata?: Record<string, unknown>;
}

/** Minimal shape of a synthesized CloudFormation template we care about. */
export interface CfnTemplate {
  Resources: Record<string, CfnResource>;
  Outputs?: Record<string, CfnOutput>;
}

export interface CfnOutput {
  Value?: unknown;
  Export?: { Name?: unknown };
}

/** Types treated as stateful — never expected to be removed by a split. */
export const STATEFUL_TYPES: readonly string[] = [
  "AWS::DynamoDB::Table",
  "AWS::Cognito::UserPool",
  "AWS::Cognito::UserPoolClient",
  "AWS::Cognito::UserPoolGroup",
  "AWS::AppSync::GraphQLApi",
  "AWS::AppSync::GraphQLSchema",
  "AWS::Events::EventBus",
  "AWS::S3::Bucket",
  "AWS::SecretsManager::Secret",
  "AWS::CloudFormation::CustomResource",
];

/** Key properties compared byte-identically per stateful type (rail 1 + 2). */
export const STATEFUL_KEY_PROPS: Record<string, readonly string[]> = {
  "AWS::DynamoDB::Table": [
    "TableName",
    "KeySchema",
    "AttributeDefinitions",
    "GlobalSecondaryIndexes",
    "StreamSpecification",
  ],
  "AWS::Cognito::UserPool": ["UserPoolName", "Schema"],
  "AWS::Cognito::UserPoolClient": ["ClientName"],
  "AWS::Cognito::UserPoolGroup": ["GroupName"],
  "AWS::AppSync::GraphQLApi": ["Name"],
  "AWS::AppSync::GraphQLSchema": [],
  "AWS::Events::EventBus": ["Name"],
  "AWS::S3::Bucket": ["BucketName"],
  "AWS::SecretsManager::Secret": ["Name"],
  "AWS::CloudFormation::CustomResource": [],
};

export interface StackBaseline {
  /** Stack name as passed to `Template.fromStack` / cdk.out file, e.g. "citadel-backend-dev". */
  stackName: string;
  /** ISO timestamp the baseline was captured. */
  capturedAt: string;
  /** logicalId -> { type, deletionPolicy, updateReplacePolicy } for every resource. */
  resources: Record<
    string,
    {
      type: string;
      deletionPolicy?: string;
      updateReplacePolicy?: string;
      /** Only populated for stateful types; full Properties object. */
      properties?: Record<string, unknown>;
    }
  >;
  /** typeName.fieldName -> resolver metadata, only for AWS::AppSync::Resolver resources. */
  resolvers: Record<
    string,
    {
      logicalId: string;
      typeName: string;
      fieldName: string;
      dataSourceName: string;
      requestMappingTemplateHash: string | null;
      responseMappingTemplateHash: string | null;
      requestMappingTemplateBytes: number;
      responseMappingTemplateBytes: number;
    }
  >;
  /** DataSource logical ID -> normalized config. */
  dataSources: Record<
    string,
    {
      logicalId: string;
      name: string;
      type: string | null;
      lambdaFunctionArnRef: string | null;
    }
  >;
  /** Lambda function logical ID -> normalized IAM policy statements for its execution role(s). */
  lambdaRolePolicies: Record<string, NormalizedPolicyStatement[]>;
  /** Outputs carrying Export.Name, keyed by output logical name. */
  exports: Record<string, { exportName: unknown; value: unknown }>;
}

export interface NormalizedPolicyStatement {
  effect: string;
  actions: string[];
  resources: string[];
  conditionKeys: string[];
}

export interface RailViolation {
  rail: string;
  message: string;
  logicalId?: string;
}

export interface RailResult {
  rail: string;
  name: string;
  passed: boolean;
  violations: RailViolation[];
}
