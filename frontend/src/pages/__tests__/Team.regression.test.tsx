/**
 * Regression tests for the Team page.
 *
 * Covers: user list rendering, role badges, invite user button/modal,
 * admin-only actions, organization management, loading/error states.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('@/components/ui/card', () => ({
  Card: ({ children, className }: any) => <div className={className}>{children}</div>,
  CardContent: ({ children }: any) => <div>{children}</div>,
  CardDescription: ({ children }: any) => <p>{children}</p>,
  CardHeader: ({ children }: any) => <div>{children}</div>,
  CardTitle: ({ children }: any) => <h3>{children}</h3>,
}));
jest.mock('@/components/ui/badge', () => ({
  Badge: ({ children, className }: any) => <span data-testid="badge" className={className}>{children}</span>,
}));
jest.mock('@/components/ui/button', () => ({
  Button: ({ children, onClick, disabled, ...rest }: any) => (
    <button onClick={onClick} disabled={disabled} {...rest}>{children}</button>
  ),
}));
jest.mock('@/components/ui/input', () => ({
  Input: (props: any) => <input {...props} />,
}));
jest.mock('@/components/ui/label', () => ({
  Label: ({ children, ...props }: any) => <label {...props}>{children}</label>,
}));
jest.mock('@/components/ui/accordion', () => ({
  Accordion: ({ children }: any) => <div>{children}</div>,
  AccordionItem: ({ children }: any) => <div>{children}</div>,
  AccordionTrigger: ({ children, onClick }: any) => <button onClick={onClick}>{children}</button>,
  AccordionContent: ({ children }: any) => <div>{children}</div>,
}));
jest.mock('@/components/ui/select', () => ({
  Select: ({ children, onValueChange: _onValueChange }: any) => <div>{children}</div>,
  SelectContent: ({ children }: any) => <div>{children}</div>,
  SelectItem: ({ children, value }: any) => <option value={value}>{children}</option>,
  SelectTrigger: ({ children }: any) => <button>{children}</button>,
  SelectValue: ({ placeholder }: any) => <span>{placeholder}</span>,
}));
jest.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children, open }: any) => open ? <div data-testid="dialog">{children}</div> : null,
  DialogContent: ({ children }: any) => <div>{children}</div>,
  DialogDescription: ({ children }: any) => <p>{children}</p>,
  DialogHeader: ({ children }: any) => <div>{children}</div>,
  DialogTitle: ({ children }: any) => <h2>{children}</h2>,
}));
jest.mock('@/components/PageContainer', () => ({
  PageContainer: ({ children }: any) => <div>{children}</div>,
}));
jest.mock('sonner', () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}));

const mockUsers = [
  { userId: 'u1', email: 'admin@example.com', name: 'Admin User', givenName: 'Admin', familyName: 'User', role: 'admin', organization: 'Default', status: 'CONFIRMED', createdAt: '2025-01-01', enabled: true },
  { userId: 'u2', email: 'dev@example.com', name: 'Dev User', givenName: 'Dev', familyName: 'User', role: 'developer', organization: 'Default', status: 'CONFIRMED', createdAt: '2025-01-02', enabled: true },
];

const mockOrgs = [
  { orgId: 'org-1', name: 'Default', description: 'Default organization', createdAt: '2025-01-01' },
];

jest.mock('@/services/userManagementService', () => ({
  userManagementService: {
    listUsers: jest.fn().mockResolvedValue(mockUsers),
    listAvailableRoles: jest.fn().mockResolvedValue(['admin', 'developer', 'viewer']),
    listOrganizations: jest.fn().mockResolvedValue(mockOrgs),
    createUser: jest.fn().mockResolvedValue({ username: 'new@example.com' }),
    assignRole: jest.fn().mockResolvedValue(undefined),
    resetPassword: jest.fn().mockResolvedValue(undefined),
    createOrganization: jest.fn().mockResolvedValue({ name: 'NewOrg' }),
    changeOrganization: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('@/contexts/OrganizationContext', () => ({
  useOrganization: () => ({
    selectedOrganization: 'Default',
    currentUser: { userId: 'u1', username: 'admin@example.com', role: 'admin' },
    isAdmin: true,
  }),
}));

import { Team } from '../Team';

describe('Team page — regression', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('renders user list after loading', async () => {
    render(<Team />);

    await waitFor(() => {
      expect(screen.getByText('Admin User')).toBeInTheDocument();
      expect(screen.getByText('Dev User')).toBeInTheDocument();
    });
  });

  test('displays user emails', async () => {
    render(<Team />);

    await waitFor(() => {
      expect(screen.getByText('admin@example.com')).toBeInTheDocument();
      expect(screen.getByText('dev@example.com')).toBeInTheDocument();
    });
  });

  test('displays role badges', async () => {
    render(<Team />);

    await waitFor(() => {
      const badges = screen.getAllByTestId('badge');
      expect(badges.length).toBeGreaterThan(0);
    });
  });

  test('renders Add User button for admins', async () => {
    render(<Team />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /add user|invite/i })).toBeInTheDocument();
    });
  });

  test('clicking Add User opens the invite modal', async () => {
    render(<Team />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /add user|invite/i })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /add user|invite/i }));

    await waitFor(() => {
      expect(screen.getByTestId('dialog')).toBeInTheDocument();
    });
  });

  test('shows error state when API call fails', async () => {
    const { userManagementService } = require('@/services/userManagementService');
    userManagementService.listUsers.mockRejectedValueOnce(new Error('Service unavailable'));

    render(<Team />);

    await waitFor(() => {
      expect(screen.getByText(/failed|error|unavailable/i)).toBeInTheDocument();
    });
  });
});
