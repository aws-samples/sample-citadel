import { ReactNode } from 'react';

interface ProtectedRouteProps {
  currentUser: any;
  children: ReactNode;
  fallback: ReactNode;
}

export function ProtectedRoute({ currentUser, children, fallback }: ProtectedRouteProps) {
  if (!currentUser) {
    return <>{fallback}</>;
  }
  return <>{children}</>;
}
