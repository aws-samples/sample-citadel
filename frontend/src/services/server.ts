/**
 * AppSync Server Service
 * Handles integration with AWS AppSync and Cognito using AWS Amplify
 */

import { Amplify } from "aws-amplify";
import { generateClient } from "aws-amplify/api";
import {
  signIn,
  signOut,
  signUp,
  confirmSignUp,
  confirmSignIn,
  resendSignUpCode,
  getCurrentUser,
  fetchAuthSession,
  resetPassword,
  confirmResetPassword,
} from "aws-amplify/auth";
import type { ResetPasswordOutput } from "aws-amplify/auth";

interface AmplifyConfig {
  region: string;
  userPoolId: string;
  userPoolClientId: string;
  identityPoolId?: string;
  appsyncEndpoint: string;
  appsyncRegion: string;
  appsyncAuthenticationType:
    | "API_KEY"
    | "AMAZON_COGNITO_USER_POOLS"
    | "AWS_IAM";
  appsyncApiKey?: string;
  environment?: string;
  eventBusUrl?: string;
}

interface SignUpParams {
  username: string;
  password: string;
  email: string;
  attributes?: Record<string, string>;
}

interface SignInParams {
  username: string;
  password: string;
}

class ServerService {
  private client: any;
  private config: AmplifyConfig | null = null;

  constructor() {
    this.client = generateClient();
  }

  /**
   * Get the current configuration
   */
  getConfig(): AmplifyConfig | null {
    return this.config;
  }

  /**
   * Configure Amplify with AppSync and Cognito settings
   */
  configure(config: AmplifyConfig): void {
    this.config = config;
    let authMode: "apiKey" | "userPool" | "iam" = "userPool";

    if (config.appsyncAuthenticationType === "API_KEY") {
      authMode = "apiKey";
    } else if (config.appsyncAuthenticationType === "AWS_IAM") {
      authMode = "iam";
    }

    const cognitoConfig: any = {
      userPoolId: config.userPoolId,
      userPoolClientId: config.userPoolClientId,
      loginWith: {
        email: true,
      },
    };

    if (config.identityPoolId) {
      cognitoConfig.identityPoolId = config.identityPoolId;
    }

    const graphqlConfig: any = {
      endpoint: config.appsyncEndpoint,
      region: config.appsyncRegion,
      defaultAuthMode: authMode,
    };

    if (config.appsyncApiKey) {
      graphqlConfig.apiKey = config.appsyncApiKey;
    }

    Amplify.configure({
      Auth: {
        Cognito: cognitoConfig,
      },
      API: {
        GraphQL: graphqlConfig,
      },
    });

  }

  /**
   * Execute a GraphQL query
   */
  async query<T = any>(query: string, variables?: any): Promise<T> {
    try {
      const response = (await this.client.graphql({
        query,
        variables,
      } as any)) as any;

      const errors = response?.errors;
      if (errors?.length) {
        throw new Error(
          errors.map((e: any) => e.message).join(", ")
        );
      }

      return response.data as T;
    } catch (error: any) {
      console.error("GraphQL query failed:", error);
      if (error?.errors?.length) {
        throw new Error(error.errors.map((e: any) => e.message).join(", "));
      }
      throw error;
    }
  }

  /**
   * Execute a GraphQL mutation
   */
  async mutate<T = any>(mutation: string, variables?: any): Promise<T> {
    try {
      const response = (await this.client.graphql({
        query: mutation,
        variables,
      } as any)) as any;

      // Amplify v6 can return errors in multiple ways
      const errors = response?.errors;
      if (errors?.length) {
        throw new Error(
          errors.map((e: any) => e.message).join(", ")
        );
      }

      return response.data as T;
    } catch (error: any) {
      console.error("GraphQL mutation failed:", error);
      // Extract meaningful error message from Amplify error objects
      if (error?.errors?.length) {
        throw new Error(error.errors.map((e: any) => e.message).join(", "));
      }
      throw error;
    }
  }

  /**
   * Subscribe to GraphQL subscriptions
   */
  subscribe(subscription: string, variables: any, callback: (data: any) => void) {
    const sub = this.client.graphql({
      query: subscription,
      variables,
    } as any).subscribe({
      next: ({ data }: any) => callback(data),
      error: (error: any) => console.error('Subscription error:', error)
    });
    return () => sub.unsubscribe();
  }

  // Authentication methods

  /**
   * Sign up a new user
   */
  async signUp(params: SignUpParams) {
    try {
      const { username, password, email, attributes = {} } = params;
      const result = await signUp({
        username,
        password,
        options: {
          userAttributes: {
            email,
            ...attributes,
          },
        },
      });
      return result;
    } catch (error) {
      console.error("Sign up failed:", error);
      throw error;
    }
  }

  /**
   * Confirm sign up with verification code
   */
  async confirmSignUp(username: string, code: string) {
    try {
      const result = await confirmSignUp({
        username,
        confirmationCode: code,
      });
      return result;
    } catch (error) {
      console.error("Confirm sign up failed:", error);
      throw error;
    }
  }

  /**
   * Resend confirmation code
   */
  async resendConfirmationCode(username: string) {
    try {
      await resendSignUpCode({ username });
    } catch (error) {
      console.error("Resend confirmation code failed:", error);
      throw error;
    }
  }

  /**
   * Sign in a user
   */
  async signIn(params: SignInParams) {
    try {
      const { username, password } = params;
      const result = await signIn({ username, password });
      return result;
    } catch (error) {
      console.error("Sign in failed:", error);
      throw error;
    }
  }

  /**
   * Confirm sign in with new password (for NEW_PASSWORD_REQUIRED challenge)
   */
  async confirmSignIn(params: { challengeResponse: string }) {
    try {
      const result = await confirmSignIn({ challengeResponse: params.challengeResponse });
      return result;
    } catch (error) {
      console.error("Confirm sign in failed:", error);
      throw error;
    }
  }

  /**
   * Sign out the current user
   */
  async signOut() {
    try {
      await signOut();
    } catch (error) {
      console.error("Sign out failed:", error);
      throw error;
    }
  }

  /**
   * Get the current authenticated user
   */
  async getCurrentUser() {
    try {
      const user = await getCurrentUser();
      return user;
    } catch (error) {
      console.error("Get current user failed:", error);
      return null;
    }
  }

  /**
   * Get the current auth session (tokens, credentials)
   */
  async getAuthSession() {
    try {
      const session = await fetchAuthSession();
      return session;
    } catch (error) {
      console.error("Get auth session failed:", error);
      throw error;
    }
  }

  /**
   * Reset password — sends verification code to user's email
   */
  async resetPassword(username: string): Promise<ResetPasswordOutput> {
    try {
      const result = await resetPassword({ username });
      return result;
    } catch (error) {
      console.error('Reset password failed:', error);
      throw error;
    }
  }

  /**
   * Confirm reset password — validates code and sets new password
   */
  async confirmResetPassword(
    username: string,
    confirmationCode: string,
    newPassword: string
  ): Promise<void> {
    try {
      await confirmResetPassword({ username, confirmationCode, newPassword });
    } catch (error) {
      console.error('Confirm reset password failed:', error);
      throw error;
    }
  }

  /**
   * Check if user is authenticated
   */
  async isAuthenticated(): Promise<boolean> {
    try {
      await getCurrentUser();
      return true;
    } catch {
      return false;
    }
  }

}

// Create singleton instance
const serverService = new ServerService();

export default serverService;
export { ServerService };
export type { AmplifyConfig, SignUpParams, SignInParams, ResetPasswordOutput };
