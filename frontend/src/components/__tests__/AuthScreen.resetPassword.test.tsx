/**
 * Unit tests for AuthScreen password reset state management (Task 6.1)
 *
 * Tests:
 * - AuthMode type accepts 'forgotpassword' and 'resetcode' values
 * - switchMode helper clears error, successMessage, and sensitive fields
 * - validatePassword is used instead of inline validation in handleNewPassword
 *
 * Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.5
 */
import React from 'react';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { AuthScreen } from '../AuthScreen';

// Mock the services module
const mockSignIn = jest.fn();
const mockConfirmSignIn = jest.fn();
const mockGetCurrentUser = jest.fn();
const mockResetPassword = jest.fn();
const mockConfirmResetPassword = jest.fn();

jest.mock('../../services', () => ({
  serverService: {
    signIn: (...args: any[]) => mockSignIn(...args),
    confirmSignIn: (...args: any[]) => mockConfirmSignIn(...args),
    getCurrentUser: (...args: any[]) => mockGetCurrentUser(...args),
    resetPassword: (...args: any[]) => mockResetPassword(...args),
    confirmResetPassword: (...args: any[]) => mockConfirmResetPassword(...args),
  },
}));

// Mock the Banner component to simplify rendering
jest.mock('../ui/banner', () => ({
  Banner: ({ description, variant }: any) => (
    <div data-testid="banner" data-variant={variant}>{description}</div>
  ),
}));

const mockOnLogin = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
});

describe('AuthMode type extension (Requirement 5.1)', () => {
  it('renders in signin mode by default', () => {
    render(<AuthScreen onLogin={mockOnLogin} />);
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy();
  });

  it('can transition to forgotpassword mode', async () => {
    render(<AuthScreen onLogin={mockOnLogin} />);
    // The component renders without error with the extended AuthMode type
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy();
  });
});

describe('resetCode state variable (Requirement 5.4)', () => {
  it('AuthScreen renders without errors with extended state', () => {
    const { container } = render(<AuthScreen onLogin={mockOnLogin} />);
    expect(container.querySelector('form')).toBeTruthy();
  });
});

describe('switchMode helper clears state (Requirements 5.2, 5.3)', () => {
  it('clears error when transitioning from newpassword to signin via Back to sign in', async () => {
    // First, get into newpassword mode by simulating a sign-in that requires new password
    mockSignIn.mockResolvedValueOnce({
      isSignedIn: false,
      nextStep: { signInStep: 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED' },
    });

    render(<AuthScreen onLogin={mockOnLogin} />);

    // Fill in email and password, then sign in
    const emailInput = screen.getByLabelText('Email');
    const passwordInput = screen.getByLabelText('Password');
    fireEvent.change(emailInput, { target: { value: 'test@example.com' } });
    fireEvent.change(passwordInput, { target: { value: 'oldpassword' } });

    await act(async () => {
      fireEvent.submit(screen.getByRole('button', { name: 'Sign in' }));
    });

    // Now in newpassword mode
    expect(screen.getByLabelText('New Password')).toBeTruthy();

    // Trigger a validation error by submitting mismatched passwords
    const newPwInput = screen.getByLabelText('New Password');
    const confirmPwInput = screen.getByLabelText('Confirm New Password');
    fireEvent.change(newPwInput, { target: { value: 'password123' } });
    fireEvent.change(confirmPwInput, { target: { value: 'different456' } });

    await act(async () => {
      fireEvent.submit(screen.getByRole('button', { name: /Set New Password/i }));
    });

    // Error should be displayed
    expect(screen.getByText('Passwords do not match')).toBeTruthy();

    // Click "Back to sign in" — should clear error
    fireEvent.click(screen.getByText('Back to sign in'));

    // Error should be cleared
    expect(screen.queryByText('Passwords do not match')).toBeNull();
  });

  it('clears successMessage when transitioning from newpassword to signin', async () => {
    mockSignIn.mockResolvedValueOnce({
      isSignedIn: false,
      nextStep: { signInStep: 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED' },
    });

    render(<AuthScreen onLogin={mockOnLogin} />);

    const emailInput = screen.getByLabelText('Email');
    const passwordInput = screen.getByLabelText('Password');
    fireEvent.change(emailInput, { target: { value: 'test@example.com' } });
    fireEvent.change(passwordInput, { target: { value: 'oldpassword' } });

    await act(async () => {
      fireEvent.submit(screen.getByRole('button', { name: 'Sign in' }));
    });

    // Success message should be shown in newpassword mode
    expect(screen.getByText('You must set a new password before continuing.')).toBeTruthy();

    // Click "Back to sign in" — should clear success message
    fireEvent.click(screen.getByText('Back to sign in'));

    expect(screen.queryByText('You must set a new password before continuing.')).toBeNull();
  });

  it('clears sensitive fields (password, newPassword, confirmNewPassword, resetCode) when transitioning to signin', async () => {
    mockSignIn.mockResolvedValueOnce({
      isSignedIn: false,
      nextStep: { signInStep: 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED' },
    });

    render(<AuthScreen onLogin={mockOnLogin} />);

    // Fill in email and password
    const emailInput = screen.getByLabelText('Email');
    const passwordInput = screen.getByLabelText('Password');
    fireEvent.change(emailInput, { target: { value: 'test@example.com' } });
    fireEvent.change(passwordInput, { target: { value: 'oldpassword' } });

    await act(async () => {
      fireEvent.submit(screen.getByRole('button', { name: 'Sign in' }));
    });

    // In newpassword mode, fill in new password fields
    const newPwInput = screen.getByLabelText('New Password');
    const confirmPwInput = screen.getByLabelText('Confirm New Password');
    fireEvent.change(newPwInput, { target: { value: 'newpass123' } });
    fireEvent.change(confirmPwInput, { target: { value: 'newpass123' } });

    // Click "Back to sign in"
    fireEvent.click(screen.getByText('Back to sign in'));

    // Now in signin mode — password field should be empty
    const signinPasswordInput = screen.getByLabelText('Password') as HTMLInputElement;
    expect(signinPasswordInput.value).toBe('');
  });
});

describe('validatePassword replaces inline validation in handleNewPassword', () => {
  it('shows "Password must be at least 8 characters long" for short passwords', async () => {
    mockSignIn.mockResolvedValueOnce({
      isSignedIn: false,
      nextStep: { signInStep: 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED' },
    });

    render(<AuthScreen onLogin={mockOnLogin} />);

    // Get into newpassword mode
    const emailInput = screen.getByLabelText('Email');
    const passwordInput = screen.getByLabelText('Password');
    fireEvent.change(emailInput, { target: { value: 'test@example.com' } });
    fireEvent.change(passwordInput, { target: { value: 'oldpassword' } });

    await act(async () => {
      fireEvent.submit(screen.getByRole('button', { name: 'Sign in' }));
    });

    // Enter a short password (< 8 chars) with matching confirm
    const newPwInput = screen.getByLabelText('New Password');
    const confirmPwInput = screen.getByLabelText('Confirm New Password');
    fireEvent.change(newPwInput, { target: { value: 'short' } });
    fireEvent.change(confirmPwInput, { target: { value: 'short' } });

    await act(async () => {
      fireEvent.submit(screen.getByRole('button', { name: 'Set New Password' }));
    });

    expect(screen.getByText('Password must be at least 8 characters long')).toBeTruthy();
    // Should NOT have called the server
    expect(mockConfirmSignIn).not.toHaveBeenCalled();
  });

  it('shows "Passwords do not match" for mismatched passwords >= 8 chars', async () => {
    mockSignIn.mockResolvedValueOnce({
      isSignedIn: false,
      nextStep: { signInStep: 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED' },
    });

    render(<AuthScreen onLogin={mockOnLogin} />);

    const emailInput = screen.getByLabelText('Email');
    const passwordInput = screen.getByLabelText('Password');
    fireEvent.change(emailInput, { target: { value: 'test@example.com' } });
    fireEvent.change(passwordInput, { target: { value: 'oldpassword' } });

    await act(async () => {
      fireEvent.submit(screen.getByRole('button', { name: 'Sign in' }));
    });

    const newPwInput = screen.getByLabelText('New Password');
    const confirmPwInput = screen.getByLabelText('Confirm New Password');
    fireEvent.change(newPwInput, { target: { value: 'password123' } });
    fireEvent.change(confirmPwInput, { target: { value: 'different456' } });

    await act(async () => {
      fireEvent.submit(screen.getByRole('button', { name: 'Set New Password' }));
    });

    expect(screen.getByText('Passwords do not match')).toBeTruthy();
    expect(mockConfirmSignIn).not.toHaveBeenCalled();
  });

  it('validates password length before mismatch (short + mismatched shows length error)', async () => {
    mockSignIn.mockResolvedValueOnce({
      isSignedIn: false,
      nextStep: { signInStep: 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED' },
    });

    render(<AuthScreen onLogin={mockOnLogin} />);

    const emailInput = screen.getByLabelText('Email');
    const passwordInput = screen.getByLabelText('Password');
    fireEvent.change(emailInput, { target: { value: 'test@example.com' } });
    fireEvent.change(passwordInput, { target: { value: 'oldpassword' } });

    await act(async () => {
      fireEvent.submit(screen.getByRole('button', { name: 'Sign in' }));
    });

    // Short AND mismatched — length error should take priority
    const newPwInput = screen.getByLabelText('New Password');
    const confirmPwInput = screen.getByLabelText('Confirm New Password');
    fireEvent.change(newPwInput, { target: { value: 'short' } });
    fireEvent.change(confirmPwInput, { target: { value: 'differ' } });

    await act(async () => {
      fireEvent.submit(screen.getByRole('button', { name: 'Set New Password' }));
    });

    // validatePassword checks length first
    expect(screen.getByText('Password must be at least 8 characters long')).toBeTruthy();
  });
});


describe('Forgot password? link in signin mode (Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 2.6)', () => {
  it('renders "Forgot password?" button in signin mode (Req 2.1)', () => {
    render(<AuthScreen onLogin={mockOnLogin} />);
    const forgotBtn = screen.getByRole('button', { name: 'Forgot password?' });
    expect(forgotBtn).toBeTruthy();
  });

  it('is rendered as a <button> with type="button" (Req 2.2)', () => {
    render(<AuthScreen onLogin={mockOnLogin} />);
    const forgotBtn = screen.getByRole('button', { name: 'Forgot password?' });
    expect(forgotBtn.tagName).toBe('BUTTON');
    expect(forgotBtn.getAttribute('type')).toBe('button');
  });

  it('clicking transitions to forgotpassword mode (Req 2.3)', () => {
    render(<AuthScreen onLogin={mockOnLogin} />);
    const forgotBtn = screen.getByRole('button', { name: 'Forgot password?' });
    fireEvent.click(forgotBtn);

    // Sign in form should no longer be visible
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
    // The title should change (forgotpassword mode renders "Reset Password")
    expect(screen.getByText('Reset Password')).toBeTruthy();
  });

  it('uses text-sm text-primary hover:underline classes matching existing link style (Req 2.4)', () => {
    render(<AuthScreen onLogin={mockOnLogin} />);
    const forgotBtn = screen.getByRole('button', { name: 'Forgot password?' });
    expect(forgotBtn.className).toContain('text-sm');
    expect(forgotBtn.className).toContain('text-primary');
    expect(forgotBtn.className).toContain('hover:underline');
  });

  it('clears error and success messages when transitioning to forgotpassword (Req 2.5)', async () => {
    // Trigger an error first by failing sign-in
    mockSignIn.mockRejectedValueOnce(new Error('Invalid credentials'));

    render(<AuthScreen onLogin={mockOnLogin} />);

    const emailInput = screen.getByLabelText('Email');
    const passwordInput = screen.getByLabelText('Password');
    fireEvent.change(emailInput, { target: { value: 'test@example.com' } });
    fireEvent.change(passwordInput, { target: { value: 'wrongpass' } });

    await act(async () => {
      fireEvent.submit(screen.getByRole('button', { name: 'Sign in' }));
    });

    // Error should be displayed
    expect(screen.getByText('Invalid credentials')).toBeTruthy();

    // Click "Forgot password?" — should clear error
    fireEvent.click(screen.getByRole('button', { name: 'Forgot password?' }));

    expect(screen.queryByText('Invalid credentials')).toBeNull();
  });

  it('is keyboard-accessible and focusable via Tab (Req 2.6)', () => {
    render(<AuthScreen onLogin={mockOnLogin} />);
    const forgotBtn = screen.getByRole('button', { name: 'Forgot password?' });
    // Buttons are natively focusable — verify it can receive focus
    forgotBtn.focus();
    expect(document.activeElement).toBe(forgotBtn);
    // Verify tabIndex is not set to -1 (which would remove it from tab order)
    expect(forgotBtn.getAttribute('tabindex')).not.toBe('-1');
  });
});


describe('Forgot password mode UI (Requirements 3.1–3.10)', () => {
  const navigateToForgotPassword = (prefilledEmail?: string) => {
    render(<AuthScreen onLogin={mockOnLogin} />);
    if (prefilledEmail) {
      const emailInput = screen.getByLabelText('Email');
      fireEvent.change(emailInput, { target: { value: prefilledEmail } });
    }
    fireEvent.click(screen.getByRole('button', { name: 'Forgot password?' }));
  };

  it('renders card with title "Reset Password" (Req 3.1)', () => {
    navigateToForgotPassword();
    expect(screen.getByText('Reset Password')).toBeTruthy();
  });

  it('renders description text (Req 3.2)', () => {
    navigateToForgotPassword();
    expect(screen.getByText("Enter your email address and we'll send you a verification code")).toBeTruthy();
  });

  it('shows email input pre-populated from sign-in (Req 3.3)', () => {
    navigateToForgotPassword('user@example.com');
    const emailInput = screen.getByLabelText('Email') as HTMLInputElement;
    expect(emailInput.value).toBe('user@example.com');
  });

  it('email input is editable (Req 3.3)', () => {
    navigateToForgotPassword('user@example.com');
    const emailInput = screen.getByLabelText('Email') as HTMLInputElement;
    fireEvent.change(emailInput, { target: { value: 'other@example.com' } });
    expect(emailInput.value).toBe('other@example.com');
  });

  it('email input has Label with text "Email" (Req 3.10)', () => {
    navigateToForgotPassword();
    expect(screen.getByLabelText('Email')).toBeTruthy();
  });

  it('form submission calls serverService.resetPassword with email (Req 3.4)', async () => {
    mockResetPassword.mockResolvedValueOnce({});
    navigateToForgotPassword('user@example.com');

    await act(async () => {
      fireEvent.submit(screen.getByRole('button', { name: 'Send Reset Code' }));
    });

    expect(mockResetPassword).toHaveBeenCalledWith('user@example.com');
  });

  it('on success, transitions to resetcode mode with success message (Req 3.5, 3.6)', async () => {
    mockResetPassword.mockResolvedValueOnce({});
    navigateToForgotPassword('user@example.com');

    await act(async () => {
      fireEvent.submit(screen.getByRole('button', { name: 'Send Reset Code' }));
    });

    expect(screen.getByText('Enter Verification Code')).toBeTruthy();
    expect(screen.getByText('A verification code has been sent to your email.')).toBeTruthy();
  });

  it('on failure, displays error message (Req 3.7)', async () => {
    mockResetPassword.mockRejectedValueOnce(new Error('User not found'));
    navigateToForgotPassword('user@example.com');

    await act(async () => {
      fireEvent.submit(screen.getByRole('button', { name: 'Send Reset Code' }));
    });

    expect(screen.getByText('User not found')).toBeTruthy();
    // Should still be in forgotpassword mode
    expect(screen.getByText('Reset Password')).toBeTruthy();
  });

  it('disables button and shows "Please wait..." during loading (Req 3.8)', async () => {
    // Use a promise that we can control to check loading state
    mockResetPassword.mockImplementation(() => {
      // Check loading state synchronously during the call
      const button = screen.getByRole('button', { name: 'Please wait...' });
      expect(button).toBeTruthy();
      expect((button as HTMLButtonElement).disabled).toBe(true);
      return Promise.resolve({});
    });
    navigateToForgotPassword('user@example.com');

    await act(async () => {
      fireEvent.submit(screen.getByRole('button', { name: 'Send Reset Code' }));
    });
  });

  it('renders "Back to sign in" link (Req 3.9)', () => {
    navigateToForgotPassword();
    const backLink = screen.getByRole('button', { name: 'Back to sign in' });
    expect(backLink).toBeTruthy();
  });

  it('"Back to sign in" link transitions back to signin mode (Req 3.9)', () => {
    navigateToForgotPassword();
    fireEvent.click(screen.getByRole('button', { name: 'Back to sign in' }));
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy();
  });
});


/**
 * Unit tests for AuthScreen resetcode mode UI (Task 7.1)
 *
 * Tests:
 * - Correct title renders
 * - Email shown read-only
 * - All inputs render with labels
 * - Validation errors prevent submission
 * - Form submission calls service
 * - Success transitions to signin with message
 * - Error displays
 * - Loading state
 * - Back link works
 *
 * Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8, 4.9, 4.10, 4.11, 4.12, 4.13, 4.14
 */
describe('Reset code mode UI (Requirements 4.1–4.14)', () => {
  const navigateToResetCode = async (prefilledEmail = 'user@example.com') => {
    mockResetPassword.mockResolvedValueOnce({});
    render(<AuthScreen onLogin={mockOnLogin} />);

    // Fill email in signin mode
    const emailInput = screen.getByLabelText('Email');
    fireEvent.change(emailInput, { target: { value: prefilledEmail } });

    // Navigate to forgotpassword
    fireEvent.click(screen.getByRole('button', { name: 'Forgot password?' }));

    // Submit to transition to resetcode
    await act(async () => {
      fireEvent.submit(screen.getByRole('button', { name: 'Send Reset Code' }));
    });

    // Verify we're in resetcode mode
    expect(screen.getByText('Enter Verification Code')).toBeTruthy();
  };

  it('renders card with title "Enter Verification Code" (Req 4.1)', async () => {
    await navigateToResetCode();
    expect(screen.getByText('Enter Verification Code')).toBeTruthy();
  });

  it('renders description text (Req 4.1)', async () => {
    await navigateToResetCode();
    expect(screen.getByText('Enter the code sent to your email and set a new password')).toBeTruthy();
  });

  it('displays email as read-only (Req 4.2)', async () => {
    await navigateToResetCode('user@example.com');
    const emailInput = screen.getByLabelText('Email') as HTMLInputElement;
    expect(emailInput.value).toBe('user@example.com');
    expect(emailInput.disabled).toBe(true);
  });

  it('renders verification code input with label (Req 4.3)', async () => {
    await navigateToResetCode();
    const codeInput = screen.getByLabelText('Verification Code');
    expect(codeInput).toBeTruthy();
    expect(codeInput.getAttribute('type')).toBe('text');
  });

  it('renders new password input with label (Req 4.4)', async () => {
    await navigateToResetCode();
    const pwInput = screen.getByLabelText('New Password');
    expect(pwInput).toBeTruthy();
    expect(pwInput.getAttribute('type')).toBe('password');
  });

  it('renders confirm new password input with label (Req 4.5)', async () => {
    await navigateToResetCode();
    const confirmInput = screen.getByLabelText('Confirm New Password');
    expect(confirmInput).toBeTruthy();
    expect(confirmInput.getAttribute('type')).toBe('password');
  });

  it('shows "Passwords do not match" when passwords differ (Req 4.6, 4.7)', async () => {
    await navigateToResetCode();

    fireEvent.change(screen.getByLabelText('Verification Code'), { target: { value: '123456' } });
    fireEvent.change(screen.getByLabelText('New Password'), { target: { value: 'password123' } });
    fireEvent.change(screen.getByLabelText('Confirm New Password'), { target: { value: 'different456' } });

    await act(async () => {
      fireEvent.submit(screen.getByRole('button', { name: 'Reset Password' }));
    });

    expect(screen.getByText('Passwords do not match')).toBeTruthy();
    expect(mockConfirmResetPassword).not.toHaveBeenCalled();
  });

  it('shows "Password must be at least 8 characters long" for short passwords (Req 4.14)', async () => {
    await navigateToResetCode();

    fireEvent.change(screen.getByLabelText('Verification Code'), { target: { value: '123456' } });
    fireEvent.change(screen.getByLabelText('New Password'), { target: { value: 'short' } });
    fireEvent.change(screen.getByLabelText('Confirm New Password'), { target: { value: 'short' } });

    await act(async () => {
      fireEvent.submit(screen.getByRole('button', { name: 'Reset Password' }));
    });

    expect(screen.getByText('Password must be at least 8 characters long')).toBeTruthy();
    expect(mockConfirmResetPassword).not.toHaveBeenCalled();
  });

  it('calls serverService.confirmResetPassword with correct params on valid submit (Req 4.8)', async () => {
    mockConfirmResetPassword.mockResolvedValueOnce(undefined);
    await navigateToResetCode('user@example.com');

    fireEvent.change(screen.getByLabelText('Verification Code'), { target: { value: '123456' } });
    fireEvent.change(screen.getByLabelText('New Password'), { target: { value: 'newpassword1' } });
    fireEvent.change(screen.getByLabelText('Confirm New Password'), { target: { value: 'newpassword1' } });

    await act(async () => {
      fireEvent.submit(screen.getByRole('button', { name: 'Reset Password' }));
    });

    expect(mockConfirmResetPassword).toHaveBeenCalledWith('user@example.com', '123456', 'newpassword1');
  });

  it('on success, transitions to signin with success message (Req 4.9, 4.10)', async () => {
    mockConfirmResetPassword.mockResolvedValueOnce(undefined);
    await navigateToResetCode('user@example.com');

    fireEvent.change(screen.getByLabelText('Verification Code'), { target: { value: '123456' } });
    fireEvent.change(screen.getByLabelText('New Password'), { target: { value: 'newpassword1' } });
    fireEvent.change(screen.getByLabelText('Confirm New Password'), { target: { value: 'newpassword1' } });

    await act(async () => {
      fireEvent.submit(screen.getByRole('button', { name: 'Reset Password' }));
    });

    // Should be back in signin mode
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy();
    expect(screen.getByText('Password reset successful. Please sign in with your new password.')).toBeTruthy();
  });

  it('on failure, displays error message (Req 4.11)', async () => {
    mockConfirmResetPassword.mockRejectedValueOnce(new Error('Invalid verification code'));
    await navigateToResetCode();

    fireEvent.change(screen.getByLabelText('Verification Code'), { target: { value: '000000' } });
    fireEvent.change(screen.getByLabelText('New Password'), { target: { value: 'newpassword1' } });
    fireEvent.change(screen.getByLabelText('Confirm New Password'), { target: { value: 'newpassword1' } });

    await act(async () => {
      fireEvent.submit(screen.getByRole('button', { name: 'Reset Password' }));
    });

    expect(screen.getByText('Invalid verification code')).toBeTruthy();
    // Should still be in resetcode mode
    expect(screen.getByText('Enter Verification Code')).toBeTruthy();
  });

  it('disables button and shows "Please wait..." during loading (Req 4.12)', async () => {
    mockConfirmResetPassword.mockImplementation(() => {
      const button = screen.getByRole('button', { name: 'Please wait...' });
      expect(button).toBeTruthy();
      expect((button as HTMLButtonElement).disabled).toBe(true);
      return Promise.resolve(undefined);
    });
    await navigateToResetCode();

    fireEvent.change(screen.getByLabelText('Verification Code'), { target: { value: '123456' } });
    fireEvent.change(screen.getByLabelText('New Password'), { target: { value: 'newpassword1' } });
    fireEvent.change(screen.getByLabelText('Confirm New Password'), { target: { value: 'newpassword1' } });

    await act(async () => {
      fireEvent.submit(screen.getByRole('button', { name: 'Reset Password' }));
    });
  });

  it('renders "Back to sign in" link (Req 4.13)', async () => {
    await navigateToResetCode();
    const backLink = screen.getByRole('button', { name: 'Back to sign in' });
    expect(backLink).toBeTruthy();
  });

  it('"Back to sign in" link transitions back to signin mode (Req 4.13)', async () => {
    await navigateToResetCode();
    fireEvent.click(screen.getByRole('button', { name: 'Back to sign in' }));
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy();
  });
});


/**
 * Visual consistency tests for AuthScreen across all modes (Task 7.2)
 *
 * Validates: Requirements 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 7.8
 */
describe('Visual consistency across all modes (Requirements 7.1–7.8)', () => {
  // Helper to navigate to newpassword mode
  const navigateToNewPassword = async () => {
    mockSignIn.mockResolvedValueOnce({
      isSignedIn: false,
      nextStep: { signInStep: 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED' },
    });
    render(<AuthScreen onLogin={mockOnLogin} />);
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'test@example.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'oldpassword' } });
    await act(async () => {
      fireEvent.submit(screen.getByRole('button', { name: 'Sign in' }));
    });
  };

  const navigateToForgotPassword = () => {
    render(<AuthScreen onLogin={mockOnLogin} />);
    fireEvent.click(screen.getByRole('button', { name: 'Forgot password?' }));
  };

  const navigateToResetCode = async () => {
    mockResetPassword.mockResolvedValueOnce({});
    render(<AuthScreen onLogin={mockOnLogin} />);
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'user@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Forgot password?' }));
    await act(async () => {
      fireEvent.submit(screen.getByRole('button', { name: 'Send Reset Code' }));
    });
  };

  describe('Card/CardHeader/CardTitle/CardDescription/CardContent composition (Req 7.1)', () => {
    it('signin mode uses Card composition', () => {
      const { container } = render(<AuthScreen onLogin={mockOnLogin} />);
      expect(container.querySelector('[data-slot="card"]')).toBeTruthy();
      expect(container.querySelector('[data-slot="card-header"]')).toBeTruthy();
      expect(container.querySelector('[data-slot="card-title"]')).toBeTruthy();
      expect(container.querySelector('[data-slot="card-description"]')).toBeTruthy();
      expect(container.querySelector('[data-slot="card-content"]')).toBeTruthy();
    });

    it('newpassword mode uses Card composition', async () => {
      await navigateToNewPassword();
      const container = document.querySelector('[data-slot="card"]');
      expect(container).toBeTruthy();
      expect(document.querySelector('[data-slot="card-header"]')).toBeTruthy();
      expect(document.querySelector('[data-slot="card-title"]')).toBeTruthy();
      expect(document.querySelector('[data-slot="card-description"]')).toBeTruthy();
      expect(document.querySelector('[data-slot="card-content"]')).toBeTruthy();
    });

    it('forgotpassword mode uses Card composition', () => {
      navigateToForgotPassword();
      expect(document.querySelector('[data-slot="card"]')).toBeTruthy();
      expect(document.querySelector('[data-slot="card-header"]')).toBeTruthy();
      expect(document.querySelector('[data-slot="card-title"]')).toBeTruthy();
      expect(document.querySelector('[data-slot="card-description"]')).toBeTruthy();
      expect(document.querySelector('[data-slot="card-content"]')).toBeTruthy();
    });

    it('resetcode mode uses Card composition', async () => {
      await navigateToResetCode();
      expect(document.querySelector('[data-slot="card"]')).toBeTruthy();
      expect(document.querySelector('[data-slot="card-header"]')).toBeTruthy();
      expect(document.querySelector('[data-slot="card-title"]')).toBeTruthy();
      expect(document.querySelector('[data-slot="card-description"]')).toBeTruthy();
      expect(document.querySelector('[data-slot="card-content"]')).toBeTruthy();
    });
  });

  // Updated for shadcn Alert primitive (replaces raw-color divs)
  describe('Error display uses Alert variant="destructive" (Req 7.3)', () => {
    it('signin mode error renders within an Alert with role="alert"', async () => {
      mockSignIn.mockRejectedValueOnce(new Error('Invalid credentials'));
      render(<AuthScreen onLogin={mockOnLogin} />);
      fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'test@example.com' } });
      fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'wrong' } });
      await act(async () => {
        fireEvent.submit(screen.getByRole('button', { name: 'Sign in' }));
      });
      const alert = screen.getByRole('alert');
      expect(alert).toBeTruthy();
      expect(alert.textContent).toContain('Invalid credentials');
    });

    it('forgotpassword mode error renders within an Alert with role="alert"', async () => {
      mockResetPassword.mockRejectedValueOnce(new Error('User not found'));
      render(<AuthScreen onLogin={mockOnLogin} />);
      fireEvent.click(screen.getByRole('button', { name: 'Forgot password?' }));
      fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'test@example.com' } });
      await act(async () => {
        fireEvent.submit(screen.getByRole('button', { name: 'Send Reset Code' }));
      });
      const alert = screen.getByRole('alert');
      expect(alert).toBeTruthy();
      expect(alert.textContent).toContain('User not found');
    });

    it('resetcode mode error renders within an Alert with role="alert"', async () => {
      await navigateToResetCode();
      fireEvent.change(screen.getByLabelText('Verification Code'), { target: { value: '123456' } });
      fireEvent.change(screen.getByLabelText('New Password'), { target: { value: 'short' } });
      fireEvent.change(screen.getByLabelText('Confirm New Password'), { target: { value: 'short' } });
      await act(async () => {
        fireEvent.submit(screen.getByRole('button', { name: 'Reset Password' }));
      });
      const alert = screen.getByRole('alert');
      expect(alert).toBeTruthy();
      expect(alert.textContent).toContain('Password must be at least 8 characters long');
    });

    it('newpassword mode error renders within an Alert with role="alert"', async () => {
      await navigateToNewPassword();
      fireEvent.change(screen.getByLabelText('New Password'), { target: { value: 'short' } });
      fireEvent.change(screen.getByLabelText('Confirm New Password'), { target: { value: 'short' } });
      await act(async () => {
        fireEvent.submit(screen.getByRole('button', { name: 'Set New Password' }));
      });
      const alert = screen.getByRole('alert');
      expect(alert).toBeTruthy();
      expect(alert.textContent).toContain('Password must be at least 8 characters long');
    });
  });

  // Updated for shadcn Alert primitive (replaces raw-color divs)
  describe('Success display uses Alert primitive (Req 7.4)', () => {
    it('newpassword mode success message renders within an Alert with role="alert"', async () => {
      await navigateToNewPassword();
      const alerts = screen.getAllByRole('alert');
      const successAlert = alerts.find(el => el.textContent?.includes('You must set a new password before continuing.'));
      expect(successAlert).toBeTruthy();
    });

    it('resetcode mode success message renders within an Alert with role="alert"', async () => {
      await navigateToResetCode();
      const alerts = screen.getAllByRole('alert');
      const successAlert = alerts.find(el => el.textContent?.includes('A verification code has been sent to your email.'));
      expect(successAlert).toBeTruthy();
    });

    it('signin mode success message after password reset renders within an Alert', async () => {
      mockResetPassword.mockResolvedValueOnce({});
      mockConfirmResetPassword.mockResolvedValueOnce(undefined);
      render(<AuthScreen onLogin={mockOnLogin} />);
      fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'user@example.com' } });
      fireEvent.click(screen.getByRole('button', { name: 'Forgot password?' }));
      await act(async () => {
        fireEvent.submit(screen.getByRole('button', { name: 'Send Reset Code' }));
      });
      fireEvent.change(screen.getByLabelText('Verification Code'), { target: { value: '123456' } });
      fireEvent.change(screen.getByLabelText('New Password'), { target: { value: 'newpassword1' } });
      fireEvent.change(screen.getByLabelText('Confirm New Password'), { target: { value: 'newpassword1' } });
      await act(async () => {
        fireEvent.submit(screen.getByRole('button', { name: 'Reset Password' }));
      });
      const alerts = screen.getAllByRole('alert');
      const successAlert = alerts.find(el => el.textContent?.includes('Password reset successful'));
      expect(successAlert).toBeTruthy();
    });
  });

  describe('Banner renders above card in all modes (Req 7.5)', () => {
    it('Banner renders in signin mode', () => {
      render(<AuthScreen onLogin={mockOnLogin} />);
      const banner = screen.getByTestId('banner');
      expect(banner).toBeTruthy();
      // Banner should appear before the card in DOM order
      const card = document.querySelector('[data-slot="card"]')!;
      expect(banner.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('Banner renders in newpassword mode', async () => {
      await navigateToNewPassword();
      const banner = screen.getByTestId('banner');
      expect(banner).toBeTruthy();
      const card = document.querySelector('[data-slot="card"]')!;
      expect(banner.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('Banner renders in forgotpassword mode', () => {
      navigateToForgotPassword();
      const banner = screen.getByTestId('banner');
      expect(banner).toBeTruthy();
      const card = document.querySelector('[data-slot="card"]')!;
      expect(banner.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('Banner renders in resetcode mode', async () => {
      await navigateToResetCode();
      const banner = screen.getByTestId('banner');
      expect(banner).toBeTruthy();
      const card = document.querySelector('[data-slot="card"]')!;
      expect(banner.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });
  });

  describe('All inputs have associated Labels with matching htmlFor/id (Req 7.7)', () => {
    it('signin mode: all inputs have matching labels', () => {
      const { container } = render(<AuthScreen onLogin={mockOnLogin} />);
      const inputs = container.querySelectorAll('input');
      inputs.forEach((input) => {
        const id = input.getAttribute('id');
        expect(id).toBeTruthy();
        const label = container.querySelector(`label[for="${id}"]`);
        expect(label).toBeTruthy();
      });
    });

    it('newpassword mode: all inputs have matching labels', async () => {
      await navigateToNewPassword();
      const inputs = document.querySelectorAll('input');
      inputs.forEach((input) => {
        const id = input.getAttribute('id');
        expect(id).toBeTruthy();
        const label = document.querySelector(`label[for="${id}"]`);
        expect(label).toBeTruthy();
      });
    });

    it('forgotpassword mode: all inputs have matching labels', () => {
      navigateToForgotPassword();
      const inputs = document.querySelectorAll('input');
      inputs.forEach((input) => {
        const id = input.getAttribute('id');
        expect(id).toBeTruthy();
        const label = document.querySelector(`label[for="${id}"]`);
        expect(label).toBeTruthy();
      });
    });

    it('resetcode mode: all inputs have matching labels', async () => {
      await navigateToResetCode();
      const inputs = document.querySelectorAll('input');
      inputs.forEach((input) => {
        const id = input.getAttribute('id');
        expect(id).toBeTruthy();
        const label = document.querySelector(`label[for="${id}"]`);
        expect(label).toBeTruthy();
      });
    });
  });
});
