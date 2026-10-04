/**
 * tagPolicyService — typed wrappers for the tag-policy GraphQL operations.
 *
 * Backend schema:
 *   getTagPolicy(orgId: ID!): TagPolicy
 *   updateTagPolicy(input: UpdateTagPolicyInput!): TagPolicy!
 *
 * TagPolicy: { requiredKeys: [TagPolicyRule!]!, version: Int!, updatedBy: String!, updatedAt: AWSDateTime! }
 * TagPolicyRule: { key: String!, allowedValues: [String!] }
 * UpdateTagPolicyInput: { orgId: ID!, requiredKeys: [TagPolicyRuleInput!]!, expectedVersion: Int }
 */

import serverService from './server';

export interface TagPolicyRule {
  key: string;
  allowedValues?: string[] | null;
}

export interface TagPolicy {
  requiredKeys: TagPolicyRule[];
  version: number;
  updatedBy: string;
  updatedAt: string;
}

export interface UpdateTagPolicyInput {
  orgId: string;
  requiredKeys: TagPolicyRule[];
  expectedVersion?: number;
}

const getTagPolicyQuery = `
  query GetTagPolicy($orgId: ID!) {
    getTagPolicy(orgId: $orgId) {
      requiredKeys {
        key
        allowedValues
      }
      version
      updatedBy
      updatedAt
    }
  }
`;

const updateTagPolicyMutation = `
  mutation UpdateTagPolicy($input: UpdateTagPolicyInput!) {
    updateTagPolicy(input: $input) {
      requiredKeys {
        key
        allowedValues
      }
      version
      updatedBy
      updatedAt
    }
  }
`;

export const tagPolicyService = {
  /**
   * Fetch the tag policy for an organisation.  Returns `null` when no policy
   * has been configured yet (the backend returns null for the query).
   */
  async getTagPolicy(orgId: string): Promise<TagPolicy | null> {
    try {
      const response = await serverService.query<{ getTagPolicy: TagPolicy | null }>(
        getTagPolicyQuery,
        { orgId },
      );
      return response.getTagPolicy ?? null;
    } catch (error) {
      console.error('Error fetching tag policy:', error);
      throw error;
    }
  },

  /**
   * Create or update the tag policy for an organisation.
   */
  async updateTagPolicy(input: UpdateTagPolicyInput): Promise<TagPolicy> {
    try {
      const response = await serverService.mutate<{ updateTagPolicy: TagPolicy }>(
        updateTagPolicyMutation,
        { input },
      );
      return response.updateTagPolicy;
    } catch (error) {
      console.error('Error updating tag policy:', error);
      throw error;
    }
  },
};
