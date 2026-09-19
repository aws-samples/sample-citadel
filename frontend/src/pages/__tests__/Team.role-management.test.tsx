/**
 * TDD cases for finding 3e942457: a role can be set once but never
 * changed/removed in the UI.
 *
 * Covers:
 *  - the Assign Role / Change Role control is available for ACTIVE users
 *    (not just Lobby users)
 *  - Remove Role in the active-user menu calls removeUserRole
 *  - the last-remaining-admin guard blocks both change and removal
 *  - self-demotion and self-role-removal require an explicit confirm
 *    dialog before the service call fires
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
let mockSelectValue = 'admin';

jest.mock('@/components/ui/select', () => ({
  Select: ({ children, onValueChange }: any) => (
    <div data-testid="role-org-select" onClick={() => onValueChange && onValueChange(mockSelectValue)}>{children}</div>
  ),
  SelectContent: ({ children }: any) => <div>{children}</div>,
  SelectItem: ({ children, value }: any) => <option value={value}>{children}</option>,
  SelectTrigger: ({ children }: any) => <button>{children}</button>,
  SelectValue: ({ placeholder }: any) => <span>{placeholder}</span>,
}));
jest.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children, open }: any) => (open ? <div data-testid="dialog">{children}</div> : null),
  DialogContent: ({ children }: any) => <div>{children}</div>,
  DialogDescription: ({ children }: any) => <p>{children}</p>,
  DialogHeader: ({ children }: any) => <div>{children}</div>,
  DialogTitle: ({ children }: any) => <h2>{children}</h2>,
}));
jest.mock('@/components/ui/alert-dialog', () => ({
  AlertDialog: ({ children, open }: any) => (open ? <div data-testid="alert-dialog">{children}</div> : null),
  AlertDialogContent: ({ children }: any) => <div>{children}</div>,
  AlertDialogHeader: ({ children }: any) => <div>{children}</div>,
  AlertDialogFooter: ({ children }: any) => <div>{children}</div>,
  AlertDialogTitle: ({ children }: any) => <h2>{children}</h2>,
  AlertDialogDescription: ({ children }: any) => <p>{children}</p>,
  AlertDialogAction: ({ children, onClick, disabled }: any) => (
    <button onClick={onClick} disabled={disabled}>{children}</button>
  ),
  AlertDialogCancel: ({ children, onClick, disabled }: any) => (
    <button onClick={onClick} disabled={disabled}>{children}</button>
  ),
}));
jest.mock('@/components/PageContainer', () => ({
  PageContainer: ({ children }: any) => <div>{children}</div>,
}));
jest.mock('sonner', () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}));

const twoAdminUsers = [
  {
    userId: 'u1',
    email: 'admin@example.com',
    name: 'Admin User',
    givenName: 'Admin',
    familyName: 'User',
    role: 'admin',
    organization: 'Default',
    status: 'CONFIRMED',
    createdAt: '2025-01-01',
    enabled: true,
  },
  {
    userId: 'u2',
    email: 'other-admin@example.com',
    name: 'Other Admin',
    givenName: 'Other',
    familyName: 'Admin',
    role: 'admin',
    organization: 'Default',
    status: 'CONFIRMED',
    createdAt: '2025-01-02',
    enabled: true,
  },
  {
    userId: 'u3',
    email: 'dev@example.com',
    name: 'Dev User',
    givenName: 'Dev',
    familyName: 'User',
    role: 'developer',
    organization: 'Default',
    status: 'CONFIRMED',
    createdAt: '2025-01-03',
    enabled: true,
  },
];

const singleAdminUsers = [
  {
    userId: 'u1',
    email: 'admin@example.com',
    name: 'Admin User',
    givenName: 'Admin',
    familyName: 'User',
    role: 'admin',
    organization: 'Default',
    status: 'CONFIRMED',
    createdAt: '2025-01-01',
    enabled: true,
  },
  {
    userId: 'u3',
    email: 'dev@example.com',
    name: 'Dev User',
    givenName: 'Dev',
    familyName: 'User',
    role: 'developer',
    organization: 'Default',
    status: 'CONFIRMED',
    createdAt: '2025-01-03',
    enabled: true,
  },
];

const mockOrgs = [
  { orgId: 'org-1', name: 'Default', description: 'Default organization', createdAt: '2025-01-01' },
  { orgId: 'org-2', name: 'Acme', description: 'Acme organization', createdAt: '2025-01-01' },
];

jest.mock('@/services/userManagementService', () => ({
  userManagementService: {
    listUsers: jest.fn(),
    listAvailableRoles: jest.fn().mockResolvedValue(['admin', 'developer', 'viewer']),
    listOrganizations: jest.fn().mockResolvedValue(mockOrgs),
    adminCreateUser: jest.fn().mockResolvedValue({ success: true, message: 'ok' }),
    assignUserRole: jest.fn().mockResolvedValue({ success: true }),
    removeUserRole: jest.fn().mockResolvedValue({ success: true }),
    createOrganization: jest.fn().mockResolvedValue({ name: 'NewOrg' }),
  },
}));

let mockCurrentUser: { userId: string; username: string; role: string } = {
  userId: 'u1',
  username: 'admin@example.com',
  role: 'admin',
};

jest.mock('@/contexts/OrganizationContext', () => ({
  useOrganization: () => ({
    selectedOrganization: 'Default',
    currentUser: mockCurrentUser,
    isAdmin: true,
  }),
}));

import { Team } from '../Team';

function expandUserMenu(userName: string) {
  const userNode = screen.getByText(userName);
  let el: HTMLElement | null = userNode;
  let expandButton: HTMLButtonElement | null = null;
  while (el && !expandButton) {
    expandButton = el.querySelector('button.ml-4');
    el = el.parentElement;
  }
  expect(expandButton).toBeTruthy();
  fireEvent.click(expandButton as HTMLButtonElement);
}

describe('Team page — active user role management (finding 3e942457)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCurrentUser = { userId: 'u1', username: 'admin@example.com', role: 'admin' };
    mockSelectValue = 'admin';
    const { userManagementService } = require('@/services/userManagementService');
    userManagementService.listUsers.mockResolvedValue(twoAdminUsers);
    userManagementService.listAvailableRoles.mockResolvedValue(['admin', 'developer', 'viewer']);
    userManagementService.listOrganizations.mockResolvedValue(mockOrgs);
    userManagementService.assignUserRole.mockResolvedValue({ success: true });
    userManagementService.removeUserRole.mockResolvedValue({ success: true });
  });

  test('Change Role control is visible for an active (non-lobby) user, not just lobby users', async () => {
    render(<Team />);

    await waitFor(() => {
      expect(screen.getByText('Dev User')).toBeInTheDocument();
    });

    expandUserMenu('Dev User');

    await waitFor(() => {
      expect(screen.getByText('Manage Role')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('Manage Role'));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /change role/i })).toBeInTheDocument();
    });
  });

  test('Remove Role action calls removeUserRole with the target user id and current role', async () => {
    const { userManagementService } = require('@/services/userManagementService');
    render(<Team />);

    await waitFor(() => {
      expect(screen.getByText('Dev User')).toBeInTheDocument();
    });

    expandUserMenu('Dev User');
    fireEvent.click(screen.getByText('Manage Role'));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /remove role/i })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /remove role/i }));

    await waitFor(() => {
      expect(screen.getByTestId('alert-dialog')).toBeInTheDocument();
    });

    const dialog = screen.getByTestId('alert-dialog');
    const confirmButton = Array.from(dialog.querySelectorAll('button')).find((b) =>
      /remove role/i.test(b.textContent || ''),
    )!;
    fireEvent.click(confirmButton);

    await waitFor(() => {
      expect(userManagementService.removeUserRole).toHaveBeenCalledWith('u3', 'developer');
    });
  });

  test('last remaining admin: Remove Role is disabled and Change Role away from admin is blocked', async () => {
    const { userManagementService } = require('@/services/userManagementService');
    userManagementService.listUsers.mockResolvedValue(singleAdminUsers);
    mockSelectValue = 'developer';

    render(<Team />);

    await waitFor(() => {
      expect(screen.getByText('Admin User')).toBeInTheDocument();
    });

    expandUserMenu('Admin User');
    fireEvent.click(screen.getByText('Manage Role'));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /remove role/i })).toBeInTheDocument();
    });

    // Guard message shown
    expect(screen.getByText(/last remaining admin/i)).toBeInTheDocument();

    // Remove Role button disabled
    expect(screen.getByRole('button', { name: /remove role/i })).toBeDisabled();

    // Change Role opens the modal
    fireEvent.click(screen.getByRole('button', { name: /change role/i }));

    await waitFor(() => {
      expect(screen.getByTestId('dialog')).toBeInTheDocument();
    });

    // Select "developer" in the Role dropdown (first role-org-select in the dialog)
    const dialogEl = screen.getByTestId('dialog');
    fireEvent.click(dialogEl.querySelectorAll('[data-testid="role-org-select"]')[0]);

    const submitInDialog = Array.from(dialogEl.querySelectorAll('button')).find((b) =>
      /change role/i.test(b.textContent || ''),
    )!;
    fireEvent.click(submitInDialog);

    // Refused: last remaining admin cannot be demoted away from admin.
    // No confirm dialog opens and assignUserRole is never called.
    expect(screen.queryByTestId('alert-dialog')).not.toBeInTheDocument();
    expect(userManagementService.assignUserRole).not.toHaveBeenCalled();
    expect(screen.getAllByText(/last remaining admin/i).length).toBeGreaterThan(0);
  });

  test('self-demotion (changing own role) requires an explicit confirm dialog before assignUserRole is called', async () => {
    const { userManagementService } = require('@/services/userManagementService');
    // Two admins so the last-admin guard does not also block this path —
    // isolates the self-demotion confirm behavior.
    userManagementService.listUsers.mockResolvedValue(twoAdminUsers);
    mockSelectValue = 'developer';

    render(<Team />);

    await waitFor(() => {
      expect(screen.getByText('Admin User')).toBeInTheDocument();
    });

    expandUserMenu('Admin User');
    fireEvent.click(screen.getByText('Manage Role'));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /change role/i })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /change role/i }));

    await waitFor(() => {
      expect(screen.getByTestId('dialog')).toBeInTheDocument();
    });

    // Select "developer" in the Role dropdown — a real change away from the
    // current 'admin' role, for the currently signed-in user.
    const dialogEl = screen.getByTestId('dialog');
    fireEvent.click(dialogEl.querySelectorAll('[data-testid="role-org-select"]')[0]);

    const submitInDialog = Array.from(dialogEl.querySelectorAll('button')).find((b) =>
      /change role/i.test(b.textContent || ''),
    )!;
    fireEvent.click(submitInDialog);

    // The confirm gate fires before the service call.
    await waitFor(() => {
      expect(screen.getByTestId('alert-dialog')).toBeInTheDocument();
    });
    expect(userManagementService.assignUserRole).not.toHaveBeenCalled();

    const confirmDialog = screen.getByTestId('alert-dialog');
    expect(confirmDialog.textContent).toMatch(/lose access/i);

    const confirmButton = Array.from(confirmDialog.querySelectorAll('button')).find((b) =>
      /change role/i.test(b.textContent || ''),
    )!;
    fireEvent.click(confirmButton);

    await waitFor(() => {
      expect(userManagementService.assignUserRole).toHaveBeenCalledWith({
        userId: 'u1',
        role: 'developer',
        organization: 'Default',
      });
    });
  });

  test('self-role-removal requires an explicit confirm dialog stating possible loss of access, before removeUserRole is called', async () => {
    const { userManagementService } = require('@/services/userManagementService');
    userManagementService.listUsers.mockResolvedValue(twoAdminUsers);

    render(<Team />);

    await waitFor(() => {
      expect(screen.getByText('Admin User')).toBeInTheDocument();
    });

    expandUserMenu('Admin User');
    fireEvent.click(screen.getByText('Manage Role'));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /remove role/i })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /remove role/i }));

    await waitFor(() => {
      expect(screen.getByTestId('alert-dialog')).toBeInTheDocument();
    });

    const dialog = screen.getByTestId('alert-dialog');
    expect(dialog.textContent).toMatch(/lose access/i);

    // Cancelling must not call removeUserRole
    const cancelButton = Array.from(dialog.querySelectorAll('button')).find((b) =>
      /cancel/i.test(b.textContent || ''),
    )!;
    fireEvent.click(cancelButton);

    expect(userManagementService.removeUserRole).not.toHaveBeenCalled();

    // Re-open and confirm
    fireEvent.click(screen.getByRole('button', { name: /remove role/i }));
    await waitFor(() => {
      expect(screen.getByTestId('alert-dialog')).toBeInTheDocument();
    });
    const dialog2 = screen.getByTestId('alert-dialog');
    const confirmButton = Array.from(dialog2.querySelectorAll('button')).find((b) =>
      /remove role/i.test(b.textContent || ''),
    )!;
    fireEvent.click(confirmButton);

    await waitFor(() => {
      expect(userManagementService.removeUserRole).toHaveBeenCalledWith('u1', 'admin');
    });
  });
});
