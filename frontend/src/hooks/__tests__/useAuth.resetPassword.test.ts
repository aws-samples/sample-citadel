/**
 * useAuth.resetPassword Tests
 * Tests for the resetPassword method on the useAuth hook
 *
 * Validates: Requirements 6.1, 6.3, 6.4, 6.7
 */

// Mock serverService before imports
jest.mock('../../services', () => ({
  serverService: {
    getCurrentUser: jest.fn().mockRejectedValue(new Error('Not authenticated')),
    signIn: jest.fn(),
    signUp: jest.fn(),
    confirmSignUp: jest.fn(),
    resendConfirmationCode: jest.fn(),
    signOut: jest.fn(),
    resetPassword: jest.fn(),
    confirmResetPassword: jest.fn(),
  },
}));

import { renderHook, act } from '@testing-library/react';
import { useAuth } from '../useAuth';
import { serverService } from '../../services';

describe('useAuth.resetPassword', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should expose resetPassword as a function', async () => {
    const { result } = renderHook(() => useAuth());

    await act(async () => {
      await Promise.resolve();
    });

    expect(typeof result.current.resetPassword).toBe('function');
  });

  it('should delegate to serverService.resetPassword with the username', async () => {
    const mockResult = {
      isPasswordReset: false,
      nextStep: {
        resetPasswordStep: 'CONFIRM_RESET_PASSWORD_WITH_CODE',
        codeDeliveryDetails: { deliveryMedium: 'EMAIL', destination: 'u***@example.com' },
      },
    };
    (serverService.resetPassword as jest.Mock).mockResolvedValue(mockResult);

    const { result } = renderHook(() => useAuth());

    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      const res = await result.current.resetPassword('user@example.com');
      expect(res).toEqual(mockResult);
    });

    expect(serverService.resetPassword).toHaveBeenCalledWith('user@example.com');
  });

  it('should clear error before making the request', async () => {
    // First, cause an error so error state is set
    (serverService.resetPassword as jest.Mock).mockRejectedValueOnce(new Error('first error'));

    const { result } = renderHook(() => useAuth());

    await act(async () => {
      await Promise.resolve();
    });

    // Trigger first call to set error
    await act(async () => {
      try {
        await result.current.resetPassword('user@example.com');
      } catch {
        // expected
      }
    });

    expect(result.current.error).toBe('first error');

    // Now set up a successful call
    (serverService.resetPassword as jest.Mock).mockResolvedValueOnce({ isPasswordReset: false, nextStep: {} });

    await act(async () => {
      await result.current.resetPassword('user@example.com');
    });

    // Error should be cleared
    expect(result.current.error).toBeNull();
  });

  it('should set error and re-throw on failure', async () => {
    (serverService.resetPassword as jest.Mock).mockRejectedValue(new Error('UserNotFoundException'));

    const { result } = renderHook(() => useAuth());

    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      await expect(result.current.resetPassword('bad@example.com')).rejects.toThrow('UserNotFoundException');
    });

    expect(result.current.error).toBe('UserNotFoundException');
  });

  it('should use default error message when error has no message', async () => {
    (serverService.resetPassword as jest.Mock).mockRejectedValue(new Error(''));

    const { result } = renderHook(() => useAuth());

    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      await expect(result.current.resetPassword('user@example.com')).rejects.toThrow('Failed to send reset code');
    });

    expect(result.current.error).toBe('Failed to send reset code');
  });
});

/**
 * useAuth.confirmResetPassword Tests
 * Tests for the confirmResetPassword method on the useAuth hook
 *
 * Validates: Requirements 6.2, 6.5, 6.6, 6.7
 */
describe('useAuth.confirmResetPassword', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should expose confirmResetPassword as a function', async () => {
    const { result } = renderHook(() => useAuth());

    await act(async () => {
      await Promise.resolve();
    });

    expect(typeof result.current.confirmResetPassword).toBe('function');
  });

  it('should delegate to serverService.confirmResetPassword with correct params', async () => {
    (serverService.confirmResetPassword as jest.Mock).mockResolvedValue(undefined);

    const { result } = renderHook(() => useAuth());

    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      const res = await result.current.confirmResetPassword('user@example.com', '123456', 'NewPass123!');
      expect(res).toBe(true);
    });

    expect(serverService.confirmResetPassword).toHaveBeenCalledWith('user@example.com', '123456', 'NewPass123!');
  });

  it('should clear error before making the request', async () => {
    // First, cause an error so error state is set
    (serverService.confirmResetPassword as jest.Mock).mockRejectedValueOnce(new Error('first error'));

    const { result } = renderHook(() => useAuth());

    await act(async () => {
      await Promise.resolve();
    });

    // Trigger first call to set error
    await act(async () => {
      try {
        await result.current.confirmResetPassword('user@example.com', '123456', 'NewPass123!');
      } catch {
        // expected
      }
    });

    expect(result.current.error).toBe('first error');

    // Now set up a successful call
    (serverService.confirmResetPassword as jest.Mock).mockResolvedValueOnce(undefined);

    await act(async () => {
      await result.current.confirmResetPassword('user@example.com', '123456', 'NewPass123!');
    });

    // Error should be cleared
    expect(result.current.error).toBeNull();
  });

  it('should set error and re-throw on failure', async () => {
    (serverService.confirmResetPassword as jest.Mock).mockRejectedValue(new Error('CodeMismatchException'));

    const { result } = renderHook(() => useAuth());

    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      await expect(
        result.current.confirmResetPassword('user@example.com', 'wrong', 'NewPass123!')
      ).rejects.toThrow('CodeMismatchException');
    });

    expect(result.current.error).toBe('CodeMismatchException');
  });

  it('should use default error message when error has no message', async () => {
    (serverService.confirmResetPassword as jest.Mock).mockRejectedValue(new Error(''));

    const { result } = renderHook(() => useAuth());

    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      await expect(
        result.current.confirmResetPassword('user@example.com', '123456', 'NewPass123!')
      ).rejects.toThrow('Failed to reset password');
    });

    expect(result.current.error).toBe('Failed to reset password');
  });
});

/**
 * Property-Based Tests: useAuth error lifecycle
 *
 * Property 4: useAuth error lifecycle
 * For any non-empty error message string, mock serverService to throw,
 * verify hook sets error state to that message and re-throws with the same message.
 *
 * Validates: Requirements 6.3, 6.4, 6.5, 6.6
 */
import * as fc from 'fast-check';

describe('Property 4: useAuth error lifecycle', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('resetPassword sets error to thrown message and re-throws with same message for any non-empty string', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string().filter((s) => s.length > 0),
        async (errorMessage) => {
          (serverService.resetPassword as jest.Mock).mockRejectedValue(new Error(errorMessage));

          const { result } = renderHook(() => useAuth());

          // Wait for initial auth check to settle
          await act(async () => {
            await Promise.resolve();
          });

          let thrownError: Error | undefined;
          await act(async () => {
            try {
              await result.current.resetPassword('test@example.com');
            } catch (e) {
              thrownError = e as Error;
            }
          });

          // Hook should set error state to the error message
          expect(result.current.error).toBe(errorMessage);
          // Hook should re-throw with the same message
          expect(thrownError).toBeDefined();
          expect(thrownError!.message).toBe(errorMessage);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('confirmResetPassword sets error to thrown message and re-throws with same message for any non-empty string', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string().filter((s) => s.length > 0),
        async (errorMessage) => {
          (serverService.confirmResetPassword as jest.Mock).mockRejectedValue(new Error(errorMessage));

          const { result } = renderHook(() => useAuth());

          // Wait for initial auth check to settle
          await act(async () => {
            await Promise.resolve();
          });

          let thrownError: Error | undefined;
          await act(async () => {
            try {
              await result.current.confirmResetPassword('test@example.com', '123456', 'Password123');
            } catch (e) {
              thrownError = e as Error;
            }
          });

          // Hook should set error state to the error message
          expect(result.current.error).toBe(errorMessage);
          // Hook should re-throw with the same message
          expect(thrownError).toBeDefined();
          expect(thrownError!.message).toBe(errorMessage);
        }
      ),
      { numRuns: 100 }
    );
  });
});
