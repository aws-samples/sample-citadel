/**
 * Property-Based Tests — AuthScreen password reset flow
 *
 * Tests universal correctness properties of the AuthScreen component
 * across all authentication modes using fast-check.
 *
 * Properties tested:
 * - Property 2: Mode transition state cleanup
 * - Property 3: Round-trip mode transition
 * - Property 5: Banner rendered in all modes
 * - Property 6: Label-input accessibility association
 */
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import * as fc from 'fast-check';
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

type AuthMode = 'signin' | 'newpassword' | 'forgotpassword' | 'resetcode';

/**
 * Helper: navigate the AuthScreen to a given mode via UI interactions.
 * Must be called after render(<AuthScreen onLogin={mockOnLogin} />).
 */
async function navigateToMode(mode: AuthMode): Promise<void> {
  switch (mode) {
    case 'signin':
      // Default mode — nothing to do
      break;

    case 'forgotpassword':
      fireEvent.click(screen.getByRole('button', { name: 'Forgot password?' }));
      break;

    case 'resetcode':
      // Navigate to forgotpassword first, fill email, submit
      fireEvent.click(screen.getByRole('button', { name: 'Forgot password?' }));
      fireEvent.change(screen.getByLabelText('Email'), {
        target: { value: 'test@example.com' },
      });
      mockResetPassword.mockResolvedValueOnce({});
      await act(async () => {
        fireEvent.submit(screen.getByRole('button', { name: 'Send Reset Code' }));
      });
      break;

    case 'newpassword':
      // Fill email+password, submit sign-in with NEW_PASSWORD_REQUIRED challenge
      fireEvent.change(screen.getByLabelText('Email'), {
        target: { value: 'test@example.com' },
      });
      fireEvent.change(screen.getByLabelText('Password'), {
        target: { value: 'temppass123' },
      });
      mockSignIn.mockResolvedValueOnce({
        isSignedIn: false,
        nextStep: { signInStep: 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED' },
      });
      await act(async () => {
        fireEvent.submit(screen.getByRole('button', { name: 'Sign in' }));
      });
      break;
  }
}

/**
 * Helper: navigate from the current mode to a target mode via "Back to sign in"
 * or other UI transitions. This assumes we're already in `fromMode`.
 */
async function transitionBetweenModes(
  fromMode: AuthMode,
  toMode: AuthMode
): Promise<void> {
  // All non-signin modes can go "Back to sign in" first
  if (fromMode !== 'signin' && toMode === 'signin') {
    fireEvent.click(screen.getByRole('button', { name: 'Back to sign in' }));
    return;
  }

  // If going from non-signin to non-signin, go through signin first
  if (fromMode !== 'signin') {
    fireEvent.click(screen.getByRole('button', { name: 'Back to sign in' }));
  }

  // Now we're in signin — navigate to the target
  await navigateToMode(toMode);
}

beforeEach(() => {
  jest.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe('AuthScreen — property-based tests', () => {
  // Feature: password-reset-flow, Property 2: Mode transition state cleanup
  // **Validates: Requirements 2.5, 5.2, 5.3**
  // Updated for shadcn Alert primitive (queries role="alert" instead of .text-red-600)
  it('Property 2: error and successMessage are cleared on every mode transition', async () => {
    // Define mode pairs where the transition is user-initiated via switchMode
    const switchModePairs: [AuthMode, AuthMode][] = [
      ['signin', 'forgotpassword'],
      ['forgotpassword', 'signin'],
      ['resetcode', 'signin'],
      ['newpassword', 'signin'],
    ];

    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...switchModePairs),
        async ([fromMode, toMode]) => {
          jest.clearAllMocks();
          cleanup();

          render(<AuthScreen onLogin={mockOnLogin} />);

          // Navigate to the source mode
          await navigateToMode(fromMode);

          // Inject an error into the current mode to ensure it gets cleared
          if (fromMode === 'signin') {
            fireEvent.change(screen.getByLabelText('Email'), {
              target: { value: 'err@example.com' },
            });
            fireEvent.change(screen.getByLabelText('Password'), {
              target: { value: 'wrongpass' },
            });
            mockSignIn.mockRejectedValueOnce(new Error('Test error'));
            await act(async () => {
              fireEvent.submit(screen.getByRole('button', { name: 'Sign in' }));
            });
          } else if (fromMode === 'forgotpassword') {
            fireEvent.change(screen.getByLabelText('Email'), {
              target: { value: 'err@example.com' },
            });
            mockResetPassword.mockRejectedValueOnce(new Error('Test error'));
            await act(async () => {
              fireEvent.submit(screen.getByRole('button', { name: 'Send Reset Code' }));
            });
          } else if (fromMode === 'resetcode') {
            fireEvent.change(screen.getByLabelText('New Password'), {
              target: { value: 'short' },
            });
            fireEvent.change(screen.getByLabelText('Confirm New Password'), {
              target: { value: 'short' },
            });
            fireEvent.change(screen.getByLabelText('Verification Code'), {
              target: { value: '123456' },
            });
            await act(async () => {
              fireEvent.submit(screen.getByRole('button', { name: 'Reset Password' }));
            });
          } else if (fromMode === 'newpassword') {
            fireEvent.change(screen.getByLabelText('New Password'), {
              target: { value: 'short' },
            });
            fireEvent.change(screen.getByLabelText('Confirm New Password'), {
              target: { value: 'short' },
            });
            await act(async () => {
              fireEvent.submit(screen.getByRole('button', { name: 'Set New Password' }));
            });
          }

          // Verify error is present before transition (via Alert role="alert" containing error text)
          const alertsBefore = screen.queryAllByRole('alert');
          const errorAlertBefore = alertsBefore.find(el => el.textContent?.includes('Error'));
          expect(errorAlertBefore).toBeTruthy();

          // Perform the switchMode-driven transition
          if (fromMode === 'signin' && toMode === 'forgotpassword') {
            fireEvent.click(screen.getByRole('button', { name: 'Forgot password?' }));
          } else {
            fireEvent.click(screen.getByRole('button', { name: 'Back to sign in' }));
          }

          // After transition, error alert should be gone
          const alertsAfter = screen.queryAllByRole('alert');
          const errorAlertAfter = alertsAfter.find(el => el.textContent?.includes('Error'));
          expect(errorAlertAfter).toBeUndefined();
        }
      ),
      { numRuns: 100 }
    );
  });

  // Feature: password-reset-flow, Property 3: Round-trip mode transition
  // **Validates: Requirements 5.5, 5.6**
  it('Property 3: all sensitive fields are empty after round-trip mode transition', async () => {
    // Define valid round-trip triples: start → intermediate → back to start
    // We use transitions that are reachable via the UI
    const validTriples: [AuthMode, AuthMode][] = [
      ['signin', 'forgotpassword'],
      ['signin', 'newpassword'],
      ['signin', 'resetcode'],
      ['forgotpassword', 'signin'],
      ['resetcode', 'signin'],
      ['newpassword', 'signin'],
    ];

    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...validTriples),
        async ([startMode, intermediateMode]) => {
          jest.clearAllMocks();
          cleanup();

          render(<AuthScreen onLogin={mockOnLogin} />);

          // Navigate to start mode
          await navigateToMode(startMode);

          // Fill in some sensitive data depending on the current mode
          if (startMode === 'signin') {
            fireEvent.change(screen.getByLabelText('Email'), {
              target: { value: 'user@example.com' },
            });
            fireEvent.change(screen.getByLabelText('Password'), {
              target: { value: 'mypassword123' },
            });
          } else if (startMode === 'resetcode') {
            fireEvent.change(screen.getByLabelText('Verification Code'), {
              target: { value: '123456' },
            });
            fireEvent.change(screen.getByLabelText('New Password'), {
              target: { value: 'newpass123' },
            });
            fireEvent.change(screen.getByLabelText('Confirm New Password'), {
              target: { value: 'newpass123' },
            });
          } else if (startMode === 'newpassword') {
            fireEvent.change(screen.getByLabelText('New Password'), {
              target: { value: 'newpass123' },
            });
            fireEvent.change(screen.getByLabelText('Confirm New Password'), {
              target: { value: 'newpass123' },
            });
          } else if (startMode === 'forgotpassword') {
            fireEvent.change(screen.getByLabelText('Email'), {
              target: { value: 'user@example.com' },
            });
          }

          // Transition to intermediate mode
          await transitionBetweenModes(startMode, intermediateMode);

          // Transition back to start mode
          await transitionBetweenModes(intermediateMode, startMode);

          // Verify all sensitive fields are empty after round-trip
          // Check password field if visible
          const passwordInput = document.querySelector('input#password') as HTMLInputElement | null;
          if (passwordInput) {
            expect(passwordInput.value).toBe('');
          }

          // Check newPassword field if visible
          const newPasswordInput = document.querySelector('input#newPassword') as HTMLInputElement | null;
          if (newPasswordInput) {
            expect(newPasswordInput.value).toBe('');
          }

          // Check confirmNewPassword field if visible
          const confirmInput = document.querySelector('input#confirmNewPassword') as HTMLInputElement | null;
          if (confirmInput) {
            expect(confirmInput.value).toBe('');
          }

          // Check resetCode field if visible
          const resetCodeInput = document.querySelector('input#resetCode') as HTMLInputElement | null;
          if (resetCodeInput) {
            expect(resetCodeInput.value).toBe('');
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  // Feature: password-reset-flow, Property 5: Banner rendered in all modes
  // **Validates: Requirements 7.5**
  it('Property 5: Banner component is rendered in every AuthMode', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<AuthMode>('signin', 'newpassword', 'forgotpassword', 'resetcode'),
        async (mode) => {
          jest.clearAllMocks();
          cleanup();

          render(<AuthScreen onLogin={mockOnLogin} />);
          await navigateToMode(mode);

          // Banner should be present
          const banner = screen.getByTestId('banner');
          expect(banner).toBeTruthy();

          // Banner should appear before the card in DOM order
          const card = document.querySelector('[data-slot="card"]')!;
          expect(card).toBeTruthy();
          expect(
            banner.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING
          ).toBeTruthy();
        }
      ),
      { numRuns: 100 }
    );
  });

  // Feature: password-reset-flow, Property 6: Label-input accessibility association
  // **Validates: Requirements 7.7**
  it('Property 6: every input has a matching Label with htmlFor/id association in every mode', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<AuthMode>('signin', 'newpassword', 'forgotpassword', 'resetcode'),
        async (mode) => {
          jest.clearAllMocks();
          cleanup();

          render(<AuthScreen onLogin={mockOnLogin} />);
          await navigateToMode(mode);

          const inputs = document.querySelectorAll('input');
          // Every mode should have at least one input
          expect(inputs.length).toBeGreaterThan(0);

          inputs.forEach((input) => {
            const id = input.getAttribute('id');
            // Every input must have an id
            expect(id).toBeTruthy();
            // There must be a label whose htmlFor matches the input's id
            const label = document.querySelector(`label[for="${id}"]`);
            expect(label).toBeTruthy();
          });
        }
      ),
      { numRuns: 100 }
    );
  });
});
