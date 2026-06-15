/**
 * Authentication hook for managing user state
 */

import { useState, useEffect } from 'react';
import { serverService } from '../services';

interface AuthUser {
  userId: string;
  username: string;
}

export function useAuth() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    checkAuthStatus();
  }, []);

  const checkAuthStatus = async () => {
    try {
      const currentUser = await serverService.getCurrentUser();
      if (currentUser) {
        setUser(currentUser);
      }
    } catch (err) {
      console.log('User not authenticated');
    } finally {
      setLoading(false);
    }
  };

  const signIn = async (username: string, password: string) => {
    setError(null);
    setLoading(true);

    try {
      const result = await serverService.signIn({ username, password });
      
      if (result.isSignedIn) {
        const currentUser = await serverService.getCurrentUser();
        setUser(currentUser);
        return currentUser;
      }
    } catch (err: any) {
      const errorMessage = err.message || 'Failed to sign in';
      setError(errorMessage);
      throw new Error(errorMessage);
    } finally {
      setLoading(false);
    }
  };

  const signUp = async (
    username: string,
    password: string,
    email: string,
    attributes?: Record<string, string>
  ) => {
    setError(null);
    setLoading(true);

    try {
      const result = await serverService.signUp({ username, password, email, attributes });
      return result;
    } catch (err: any) {
      const errorMessage = err.message || 'Failed to sign up';
      setError(errorMessage);
      throw new Error(errorMessage);
    } finally {
      setLoading(false);
    }
  };

  const confirmSignUp = async (username: string, code: string) => {
    setError(null);
    setLoading(true);

    try {
      await serverService.confirmSignUp(username, code);
      return true;
    } catch (err: any) {
      const errorMessage = err.message || 'Failed to confirm sign up';
      setError(errorMessage);
      throw new Error(errorMessage);
    } finally {
      setLoading(false);
    }
  };

  const resendConfirmationCode = async (username: string) => {
    setError(null);

    try {
      await serverService.resendConfirmationCode(username);
      return true;
    } catch (err: any) {
      const errorMessage = err.message || 'Failed to resend code';
      setError(errorMessage);
      throw new Error(errorMessage);
    }
  };

  const resetPassword = async (username: string) => {
    setError(null);
    try {
      const result = await serverService.resetPassword(username);
      return result;
    } catch (err: any) {
      const errorMessage = err.message || 'Failed to send reset code';
      setError(errorMessage);
      throw new Error(errorMessage);
    }
  };

  const confirmResetPassword = async (
    username: string,
    confirmationCode: string,
    newPassword: string
  ) => {
    setError(null);
    try {
      await serverService.confirmResetPassword(username, confirmationCode, newPassword);
      return true;
    } catch (err: any) {
      const errorMessage = err.message || 'Failed to reset password';
      setError(errorMessage);
      throw new Error(errorMessage);
    }
  };

  const signOut = async () => {
    setError(null);
    
    try {
      await serverService.signOut();
      setUser(null);
    } catch (err: any) {
      const errorMessage = err.message || 'Failed to sign out';
      setError(errorMessage);
      throw new Error(errorMessage);
    }
  };

  return {
    user,
    loading,
    error,
    signIn,
    signUp,
    confirmSignUp,
    resendConfirmationCode,
    resetPassword,
    confirmResetPassword,
    signOut,
    isAuthenticated: !!user,
  };
}
