import { useState } from 'react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Banner } from './ui/banner';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { Alert, AlertTitle, AlertDescription } from './ui/alert';
import { serverService } from '../services';
import { validatePassword } from '../utils/validatePassword';

interface AuthScreenProps {
  onLogin: (user: any) => void;
}

type AuthMode = 'signin' | 'newpassword' | 'forgotpassword' | 'resetcode';

export function AuthScreen({ onLogin }: AuthScreenProps) {
  const [mode, setMode] = useState<AuthMode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [successMessage, setSuccessMessage] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmNewPassword, setConfirmNewPassword] = useState('');
  const [resetCode, setResetCode] = useState('');

  const switchMode = (newMode: AuthMode, options?: { successMessage?: string }) => {
    setMode(newMode);
    setError('');
    setSuccessMessage(options?.successMessage ?? '');
    if (newMode === 'signin') {
      setPassword('');
      setNewPassword('');
      setConfirmNewPassword('');
      setResetCode('');
    }
  };

  const handleSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const result = await serverService.signIn({
        username: email,
        password,
      });

      // Check if user needs to set a new password
      if (result.nextStep?.signInStep === 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED') {
        setMode('newpassword');
        setSuccessMessage('You must set a new password before continuing.');
        setPassword(''); // Clear the temporary password
        setLoading(false);
        return;
      }

      if (result.isSignedIn) {
        const user = await serverService.getCurrentUser();
        onLogin(user);
      }
    } catch (err: any) {
      console.error('Sign in error:', err);
      setError(err.message || 'Failed to sign in. Please check your credentials.');
    } finally {
      setLoading(false);
    }
  };

  const handleNewPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSuccessMessage('');

    const validationError = validatePassword(newPassword, confirmNewPassword);
    if (validationError) {
      setError(validationError);
      return;
    }

    setLoading(true);

    try {
      const result = await serverService.confirmSignIn({ challengeResponse: newPassword });

      if (result.isSignedIn) {
        const user = await serverService.getCurrentUser();
        onLogin(user);
      }
    } catch (err: any) {
      console.error('New password error:', err);
      setError(err.message || 'Failed to set new password. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleForgotPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      await serverService.resetPassword(email);
      switchMode('resetcode', { successMessage: 'A verification code has been sent to your email.' });
    } catch (err: any) {
      setError(err.message || 'Failed to send reset code. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleResetCode = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSuccessMessage('');

    const validationError = validatePassword(newPassword, confirmNewPassword);
    if (validationError) {
      setError(validationError);
      return;
    }

    setLoading(true);

    try {
      await serverService.confirmResetPassword(email, resetCode, newPassword);
      switchMode('signin', { successMessage: 'Password reset successful. Please sign in with your new password.' });
    } catch (err: any) {
      setError(err.message || 'Failed to reset password. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit =
    mode === 'signin'
      ? handleSignIn
      : mode === 'forgotpassword'
        ? handleForgotPassword
        : mode === 'resetcode'
          ? handleResetCode
          : handleNewPassword;

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="w-full max-w-md flex flex-col gap-6">
        <Banner description='' variant='compact' />

        <Card>
          <CardHeader>
            <CardTitle>
              {mode === 'signin' && 'Sign in'}
              {mode === 'newpassword' && 'Set New Password'}
              {mode === 'forgotpassword' && 'Reset Password'}
              {mode === 'resetcode' && 'Enter Verification Code'}
            </CardTitle>
            <CardDescription>
              {mode === 'signin' && 'Enter your credentials to access your projects'}
              {mode === 'newpassword' && 'Your temporary password has expired. Please set a new password.'}
              {mode === 'forgotpassword' && "Enter your email address and we'll send you a verification code"}
              {mode === 'resetcode' && 'Enter the code sent to your email and set a new password'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="flex flex-col gap-4">
              {error && (
                <Alert variant="destructive">
                  <AlertTitle>Error</AlertTitle>
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}

              {successMessage && (
                <Alert>
                  <AlertTitle>Success</AlertTitle>
                  <AlertDescription>{successMessage}</AlertDescription>
                </Alert>
              )}

              {mode === 'newpassword' ? (
                <>
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="email">Email</Label>
                    <Input
                      id="email"
                      type="email"
                      value={email}
                      disabled
                      className="bg-muted"
                    />
                  </div>

                  <div className="flex flex-col gap-2">
                    <Label htmlFor="newPassword">New Password</Label>
                    <Input
                      id="newPassword"
                      type="password"
                      placeholder="Enter new password"
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      disabled={loading}
                      required
                    />
                    <p className="text-xs text-muted-foreground">
                      Must be at least 8 characters long
                    </p>
                  </div>

                  <div className="flex flex-col gap-2">
                    <Label htmlFor="confirmNewPassword">Confirm New Password</Label>
                    <Input
                      id="confirmNewPassword"
                      type="password"
                      placeholder="Re-enter new password"
                      value={confirmNewPassword}
                      onChange={(e) => setConfirmNewPassword(e.target.value)}
                      disabled={loading}
                      required
                    />
                  </div>
                </>
              ) : mode === 'signin' ? (
                <>
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="email">Email</Label>
                    <Input
                      id="email"
                      type="email"
                      placeholder="partner@example.com"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      disabled={loading}
                      required
                    />
                  </div>

                  <div className="flex flex-col gap-2">
                    <Label htmlFor="password">Password</Label>
                    <Input
                      id="password"
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      disabled={loading}
                      required
                    />
                  </div>

                  <div className="text-right">
                    <button
                      type="button"
                      onClick={() => switchMode('forgotpassword')}
                      className="text-sm text-primary hover:underline"
                    >
                      Forgot password?
                    </button>
                  </div>
                </>
              ) : mode === 'forgotpassword' ? (
                <>
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="email">Email</Label>
                    <Input
                      id="email"
                      type="email"
                      placeholder="partner@example.com"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      disabled={loading}
                      required
                    />
                  </div>
                </>
              ) : mode === 'resetcode' ? (
                <>
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="email">Email</Label>
                    <Input
                      id="email"
                      type="email"
                      value={email}
                      disabled
                      className="bg-muted"
                    />
                  </div>

                  <div className="flex flex-col gap-2">
                    <Label htmlFor="resetCode">Verification Code</Label>
                    <Input
                      id="resetCode"
                      type="text"
                      placeholder="Enter verification code"
                      value={resetCode}
                      onChange={(e) => setResetCode(e.target.value)}
                      disabled={loading}
                      required
                    />
                  </div>

                  <div className="flex flex-col gap-2">
                    <Label htmlFor="newPassword">New Password</Label>
                    <Input
                      id="newPassword"
                      type="password"
                      placeholder="Enter new password"
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      disabled={loading}
                      required
                    />
                    <p className="text-xs text-muted-foreground">
                      Must be at least 8 characters long
                    </p>
                  </div>

                  <div className="flex flex-col gap-2">
                    <Label htmlFor="confirmNewPassword">Confirm New Password</Label>
                    <Input
                      id="confirmNewPassword"
                      type="password"
                      placeholder="Re-enter new password"
                      value={confirmNewPassword}
                      onChange={(e) => setConfirmNewPassword(e.target.value)}
                      disabled={loading}
                      required
                    />
                  </div>
                </>
              ) : null}

              {(mode === 'signin' || mode === 'newpassword' || mode === 'forgotpassword' || mode === 'resetcode') && (
                <Button 
                  type="submit" 
                  className="w-full rounded-md font-medium inline-flex items-center transition-colors duration-200 bg-white text-black border-none cursor-pointer text-sm h-[38px] hover:bg-muted"
                  disabled={loading}
                >
                  {loading
                    ? 'Please wait...'
                    : mode === 'signin'
                      ? 'Sign in'
                      : mode === 'forgotpassword'
                        ? 'Send Reset Code'
                        : mode === 'resetcode'
                          ? 'Reset Password'
                          : 'Set New Password'}
                </Button>
              )}

              {(mode === 'newpassword' || mode === 'forgotpassword' || mode === 'resetcode') && (
                <div className="text-center">
                  <button
                    type="button"
                    onClick={() => switchMode('signin')}
                    className="text-sm text-primary hover:underline"
                    disabled={loading}
                  >
                    Back to sign in
                  </button>
                </div>
              )}
            </form>
          </CardContent>
        </Card>

        <p className="text-center text-sm text-muted-foreground">
          Powered by AWS
        </p>
      </div>
    </div>
  );
}
