import { Navigate } from 'react-router-dom';
import { useOrganization } from '../contexts/OrganizationContext';

interface RequireAdminProps {
  children: React.ReactNode;
}

/**
 * Route guard that renders children only when the current user is an admin.
 * Non-admins are redirected to the dashboard.
 */
export function RequireAdmin({ children }: RequireAdminProps) {
  const { isAdmin } = useOrganization();

  if (!isAdmin) {
    return <Navigate to="/" replace />;
  }

  return <>{children}</>;
}
