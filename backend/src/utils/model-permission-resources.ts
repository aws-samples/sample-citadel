/**
 * Model Permission Resources
 *
 * Computes IAM resource ARNs for Bedrock model invocation policies from
 * a foundation model ID and the model catalog's regionProfiles map.
 *
 * Single source of truth shared between the credential vender Lambda
 * and the stamp-agent-permissions script.
 */

export interface ModelPermissionResources {
  /** Foundation-model ARN(s) for the current region. */
  foundationModelArns: string[];
  /** Cross-region inference-profile ARN(s) for every region the profile routes to. */
  inferenceProfileArns: string[];
  /** Combined: foundationModelArns + inferenceProfileArns — ready to use as IAM resources. */
  allResourceArns: string[];
}

/**
 * Compute IAM resource ARNs for a single Bedrock model.
 *
 * @param modelId       Foundation model ID (e.g. "anthropic.claude-sonnet-4-20250514-v1:0")
 * @param regionProfiles Map of region-prefix -> inference-profile ID from the model catalog
 *                       (e.g. { us: "us.anthropic.claude-sonnet-4-20250514-v1:0", eu: "eu.…" })
 * @param accountId     AWS account ID
 * @param region        Current AWS region (e.g. "us-west-2")
 */
export function computeModelResources(
  modelId: string,
  regionProfiles: Record<string, string>,
  accountId: string,
  region: string,
): ModelPermissionResources {
  // 1. Foundation-model ARN — always present
  const foundationModelArns = [
    `arn:aws:bedrock:${region}::foundation-model/${modelId}`,
  ];

  // 2. Inference-profile ARNs — one per region prefix in the catalog.
  //    The ARN uses the CURRENT region (not a wildcard) because the IAM
  //    resource ARN for a cross-region inference profile is:
  //      arn:aws:bedrock:{region}:{accountId}:inference-profile/{profileId}
  //    where {region} is the region the caller invokes from, and the
  //    service routes internally to the underlying regions.
  const inferenceProfileArns: string[] = [];
  for (const profileId of Object.values(regionProfiles)) {
    if (profileId) {
      inferenceProfileArns.push(
        `arn:aws:bedrock:${region}:${accountId}:inference-profile/${profileId}`,
      );
    }
  }

  return {
    foundationModelArns,
    inferenceProfileArns,
    allResourceArns: [...foundationModelArns, ...inferenceProfileArns],
  };
}
