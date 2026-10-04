import { Navigate } from 'react-router-dom';
import { useOrganization } from '../contexts/OrganizationContext';

interface RequireAdminProps {
  children: React.ReactNode;
}

/**
 * Route guard that renders children only when the current user is an admin.
 * While the organisation profile is still loading the guard shows a loading
 * indicator instead of redirecting — this prevents a flash-redirect on cold
 * start when {@link useOrganization} has not resolved yet.
 */
export function RequireAdmin({ children }: RequireAdminProps) {
  const { isAdmin, loading } = useOrganization();

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full" data-testid="admin-loading">
        <span>Loading…</span>
      </div>
    );
  }

  if (!isAdmin) {
    return <Navigate to="/" replace />;
  }

  return <>{children}</>;
}
