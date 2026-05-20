/**
 * ServerService.resetPassword & confirmResetPassword Tests
 * Tests for the resetPassword and confirmResetPassword methods on ServerService
 *
 * Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7
 */

import { resetPassword as amplifyResetPassword, confirmResetPassword as amplifyConfirmResetPassword } from 'aws-amplify/auth';

jest.mock('aws-amplify/auth', () => ({
  resetPassword: jest.fn(),
  confirmResetPassword: jest.fn(),
  signIn: jest.fn(),
  signOut: jest.fn(),
  signUp: jest.fn(),
  confirmSignUp: jest.fn(),
  confirmSignIn: jest.fn(),
  resendSignUpCode: jest.fn(),
  getCurrentUser: jest.fn(),
  fetchAuthSession: jest.fn(),
}));

jest.mock('aws-amplify/api', () => ({
  generateClient: jest.fn(() => ({})),
}));

jest.mock('aws-amplify', () => ({
  Amplify: { configure: jest.fn() },
}));

import serverService from '../server';

describe('ServerService.resetPassword', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should exist as a method on serverService', () => {
    expect(typeof serverService.resetPassword).toBe('function');
  });

  it('should delegate to Amplify resetPassword with the correct username', async () => {
    const mockResult = {
      isPasswordReset: false,
      nextStep: {
        resetPasswordStep: 'CONFIRM_RESET_PASSWORD_WITH_CODE',
        codeDeliveryDetails: {
          deliveryMedium: 'EMAIL',
          destination: 'u***@example.com',
        },
      },
    };
    (amplifyResetPassword as jest.Mock).mockResolvedValue(mockResult);

    await serverService.resetPassword('user@example.com');

    expect(amplifyResetPassword).toHaveBeenCalledWith({ username: 'user@example.com' });
  });

  it('should return the Amplify result', async () => {
    const mockResult = {
      isPasswordReset: false,
      nextStep: {
        resetPasswordStep: 'CONFIRM_RESET_PASSWORD_WITH_CODE',
        codeDeliveryDetails: {
          deliveryMedium: 'EMAIL',
          destination: 'u***@example.com',
        },
      },
    };
    (amplifyResetPassword as jest.Mock).mockResolvedValue(mockResult);

    const result = await serverService.resetPassword('user@example.com');

    expect(result).toEqual(mockResult);
  });

  it('should log and re-throw on error', async () => {
    const error = new Error('UserNotFoundException');
    (amplifyResetPassword as jest.Mock).mockRejectedValue(error);
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

    await expect(serverService.resetPassword('bad@example.com')).rejects.toThrow('UserNotFoundException');

    expect(consoleSpy).toHaveBeenCalledWith('Reset password failed:', error);
    consoleSpy.mockRestore();
  });
});

describe('ServerService.confirmResetPassword', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should exist as a method on serverService', () => {
    expect(typeof serverService.confirmResetPassword).toBe('function');
  });

  it('should delegate to Amplify confirmResetPassword with correct params', async () => {
    (amplifyConfirmResetPassword as jest.Mock).mockResolvedValue(undefined);

    await serverService.confirmResetPassword('user@example.com', '123456', 'NewPass123!');

    expect(amplifyConfirmResetPassword).toHaveBeenCalledWith({
      username: 'user@example.com',
      confirmationCode: '123456',
      newPassword: 'NewPass123!',
    });
  });

  it('should log and re-throw on error', async () => {
    const error = new Error('CodeMismatchException');
    (amplifyConfirmResetPassword as jest.Mock).mockRejectedValue(error);
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

    await expect(
      serverService.confirmResetPassword('user@example.com', 'wrong', 'NewPass123!')
    ).rejects.toThrow('CodeMismatchException');

    expect(consoleSpy).toHaveBeenCalledWith('Confirm reset password failed:', error);
    consoleSpy.mockRestore();
  });
});

// Feature: password-reset-flow, Property 1: ServerService error propagation
import * as fc from 'fast-check';

describe('Property 1: ServerService error propagation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  /**
   * **Validates: Requirements 1.4, 1.6, 1.7**
   *
   * For any error message string, when Amplify resetPassword throws with that message,
   * ServerService.resetPassword re-throws with the same message.
   */
  it('resetPassword re-throws any error message from Amplify', async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

    await fc.assert(
      fc.asyncProperty(fc.string(), async (errorMessage) => {
        jest.clearAllMocks();
        const error = new Error(errorMessage);
        (amplifyResetPassword as jest.Mock).mockRejectedValue(error);

        try {
          await serverService.resetPassword('any@user.com');
          // Should not reach here
          throw new Error('Expected resetPassword to throw');
        } catch (caught: any) {
          expect(caught.message).toBe(errorMessage);
        }
      }),
      { numRuns: 100 }
    );

    consoleSpy.mockRestore();
  });

  /**
   * **Validates: Requirements 1.4, 1.6, 1.7**
   *
   * For any error message string, when Amplify confirmResetPassword throws with that message,
   * ServerService.confirmResetPassword re-throws with the same message.
   */
  it('confirmResetPassword re-throws any error message from Amplify', async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

    await fc.assert(
      fc.asyncProperty(fc.string(), async (errorMessage) => {
        jest.clearAllMocks();
        const error = new Error(errorMessage);
        (amplifyConfirmResetPassword as jest.Mock).mockRejectedValue(error);

        try {
          await serverService.confirmResetPassword('any@user.com', '123456', 'Password1!');
          throw new Error('Expected confirmResetPassword to throw');
        } catch (caught: any) {
          expect(caught.message).toBe(errorMessage);
        }
      }),
      { numRuns: 100 }
    );

    consoleSpy.mockRestore();
  });
});
