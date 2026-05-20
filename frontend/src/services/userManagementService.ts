import serverService from './server';

const LIST_USERS = `
  query ListUsers {
    listUsers {
      userId
      email
      name
      givenName
      familyName
      role
      organization
      status
      createdAt
      enabled
    }
  }
`;

const GET_USER = `
  query GetUser($userId: String!) {
    getUser(userId: $userId) {
      userId
      email
      name
      givenName
      familyName
      role
      organization
      status
      createdAt
      enabled
    }
  }
`;

const ASSIGN_USER_ROLE = `
  mutation AssignUserRole($input: AssignUserRoleInput!) {
    assignUserRole(input: $input) {
      success
      message
    }
  }
`;

const REMOVE_USER_ROLE = `
  mutation RemoveUserRole($userId: String!, $role: String!) {
    removeUserRole(userId: $userId, role: $role) {
      success
      message
    }
  }
`;

const GET_CURRENT_USER_PROFILE = `
  query GetCurrentUserProfile {
    getCurrentUserProfile {
      userId
      email
      name
      givenName
      familyName
      role
      organization
      status
      createdAt
      enabled
    }
  }
`;

const LIST_AVAILABLE_ROLES = `
  query ListAvailableRoles {
    listAvailableRoles
  }
`;

const LIST_ORGANIZATIONS = `
  query ListOrganizations {
    listOrganizations {
      orgId
      name
      description
      createdAt
    }
  }
`;

const CHANGE_PASSWORD = `
  mutation ChangePassword($input: ChangePasswordInput!) {
    changePassword(input: $input) {
      success
      message
    }
  }
`;

const ADMIN_RESET_USER_PASSWORD = `
  mutation AdminResetUserPassword($userId: String!) {
    adminResetUserPassword(userId: $userId) {
      success
      message
    }
  }
`;

const ADMIN_CREATE_USER = `
  mutation AdminCreateUser($input: AdminCreateUserInput!) {
    adminCreateUser(input: $input) {
      success
      message
    }
  }
`;

const ADMIN_RESEND_INVITATION = `
  mutation AdminResendInvitation($userId: String!) {
    adminResendInvitation(userId: $userId) {
      success
      message
    }
  }
`;

const CREATE_ORGANIZATION = `
  mutation CreateOrganization($input: CreateOrganizationInput!) {
    createOrganization(input: $input) {
      orgId
      name
      description
      createdAt
    }
  }
`;

const DELETE_ORGANIZATION = `
  mutation DeleteOrganization($orgId: String!) {
    deleteOrganization(orgId: $orgId) {
      success
      message
    }
  }
`;

export interface User {
  userId: string;
  email: string;
  name: string;
  givenName: string;
  familyName: string;
  role?: string;
  organization?: string;
  status: string;
  createdAt: string;
  enabled: boolean;
}

export interface AssignUserRoleInput {
  userId: string;
  role: string;
  organization?: string;
}

export interface UserManagementResponse {
  success: boolean;
  message?: string;
}

export interface Organization {
  orgId: string;
  name: string;
  description?: string;
  createdAt?: string;
}

export interface AdminCreateUserInput {
  email: string;
  givenName: string;
  familyName: string;
}

export interface CreateOrganizationInput {
  name: string;
  description?: string;
}

export const userManagementService = {
  async listUsers(): Promise<User[]> {
    try {
      const response = await serverService.query<{ listUsers: User[] }>(
        LIST_USERS
      );

      return response.listUsers;
    } catch (error) {
      console.error('Error listing users:', error);
      throw error;
    }
  },

  async getUser(userId: string): Promise<User> {
    try {
      const response = await serverService.query<{ getUser: User }>(
        GET_USER,
        { userId }
      );

      return response.getUser;
    } catch (error) {
      console.error('Error getting user:', error);
      throw error;
    }
  },

  async assignUserRole(input: AssignUserRoleInput): Promise<UserManagementResponse> {
    try {
      const response = await serverService.mutate<{ assignUserRole: UserManagementResponse }>(
        ASSIGN_USER_ROLE,
        { input }
      );

      return response.assignUserRole;
    } catch (error) {
      console.error('Error assigning user role:', error);
      throw error;
    }
  },

  async removeUserRole(userId: string, role: string): Promise<UserManagementResponse> {
    try {
      const response = await serverService.mutate<{ removeUserRole: UserManagementResponse }>(
        REMOVE_USER_ROLE,
        { userId, role }
      );

      return response.removeUserRole;
    } catch (error) {
      console.error('Error removing user role:', error);
      throw error;
    }
  },

  async getCurrentUserProfile(): Promise<User> {
    try {
      const response = await serverService.query<{ getCurrentUserProfile: User }>(
        GET_CURRENT_USER_PROFILE
      );

      return response.getCurrentUserProfile;
    } catch (error) {
      console.error('Error getting current user profile:', error);
      throw error;
    }
  },

  async listAvailableRoles(): Promise<string[]> {
    try {
      const response = await serverService.query<{ listAvailableRoles: string[] }>(
        LIST_AVAILABLE_ROLES
      );

      return response.listAvailableRoles;
    } catch (error) {
      console.error('Error listing available roles:', error);
      throw error;
    }
  },

  async listOrganizations(): Promise<Organization[]> {
    try {
      const response = await serverService.query<{ listOrganizations: Organization[] }>(
        LIST_ORGANIZATIONS
      );

      return response.listOrganizations;
    } catch (error) {
      console.error('Error listing organizations:', error);
      throw error;
    }
  },

  async changePassword(newPassword: string): Promise<UserManagementResponse> {
    try {
      const response = await serverService.mutate<{ changePassword: UserManagementResponse }>(
        CHANGE_PASSWORD,
        {
          input: {
            newPassword,
          },
        }
      );

      return response.changePassword;
    } catch (error: any) {
      console.error('Error changing password:', error);
      return {
        success: false,
        message: error.message || 'Failed to change password',
      };
    }
  },

  async adminResetUserPassword(userId: string): Promise<UserManagementResponse> {
    try {
      const response = await serverService.mutate<{ adminResetUserPassword: UserManagementResponse }>(
        ADMIN_RESET_USER_PASSWORD,
        { userId }
      );

      console.log('Reset password response:', response);
      
      if (!response.adminResetUserPassword) {
        console.error('Invalid response structure:', response);
        throw new Error('Invalid response from server');
      }

      return response.adminResetUserPassword;
    } catch (error: any) {
      console.error('Error resetting user password:', error);
      console.error('Error details:', error.errors);
      throw error;
    }
  },

  async adminCreateUser(input: AdminCreateUserInput): Promise<UserManagementResponse> {
    try {
      const response = await serverService.mutate<{ adminCreateUser: UserManagementResponse }>(
        ADMIN_CREATE_USER,
        { input }
      );

      console.log('GraphQL response for adminCreateUser:', response);

      if (!response.adminCreateUser) {
        console.error('Invalid response structure:', response);
        return {
          success: false,
          message: 'Invalid response from server',
        };
      }

      return response.adminCreateUser;
    } catch (error: any) {
      console.error('Error creating user:', error);
      console.error('Error details:', error.errors);
      
      // Return a structured error response instead of throwing
      return {
        success: false,
        message: error.errors?.[0]?.message || error.message || 'Failed to create user',
      };
    }
  },

  async adminResendInvitation(userId: string): Promise<UserManagementResponse> {
    try {
      const response = await serverService.mutate<{ adminResendInvitation: UserManagementResponse }>(
        ADMIN_RESEND_INVITATION,
        { userId }
      );

      return response.adminResendInvitation;
    } catch (error: any) {
      console.error('Error resending invitation:', error);
      throw error;
    }
  },

  async createOrganization(input: CreateOrganizationInput): Promise<Organization> {
    try {
      const response = await serverService.mutate<{ createOrganization: Organization }>(
        CREATE_ORGANIZATION,
        { input }
      );

      return response.createOrganization;
    } catch (error: any) {
      console.error('Error creating organization:', error);
      throw error;
    }
  },

  async deleteOrganization(orgId: string): Promise<UserManagementResponse> {
    try {
      const response = await serverService.mutate<{ deleteOrganization: UserManagementResponse }>(
        DELETE_ORGANIZATION,
        { orgId }
      );

      return response.deleteOrganization;
    } catch (error: any) {
      console.error('Error deleting organization:', error);
      throw error;
    }
  },
};
