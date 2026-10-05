/**
 * OrganizationContext Tests — canApproveExecutions
 */

import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('../../services/userManagementService', () => ({
  userManagementService: {
    getCurrentUserProfile: jest.fn(),
    listOrganizations: jest.fn().mockResolvedValue([]),
  },
}));

import { OrganizationProvider, useOrganization } from '../OrganizationContext';
import { userManagementService } from '../../services/userManagementService';

function TestConsumer() {
  const { canApproveExecutions, isAdmin, loading } = useOrganization();
  if (loading) return <div>loading</div>;
  return (
    <div>
      <span data-testid="can-approve">{String(canApproveExecutions)}</span>
      <span data-testid="is-admin">{String(isAdmin)}</span>
    </div>
  );
}

describe('OrganizationContext — canApproveExecutions', () => {
  beforeEach(() => jest.clearAllMocks());

  it('is true for admin users', async () => {
    (userManagementService.getCurrentUserProfile as jest.Mock).mockResolvedValue({
      userId: 'u1', email: 'a@b.com', name: 'Admin', givenName: 'A', familyName: 'B',
      role: 'admin', organization: 'org-1', status: 'active', enabled: true, createdAt: '2024-01-01',
    });

    render(
      <OrganizationProvider><TestConsumer /></OrganizationProvider>
    );

    await waitFor(() => expect(screen.getByTestId('can-approve')).toHaveTextContent('true'));
  });

  it('is true for architect users', async () => {
    (userManagementService.getCurrentUserProfile as jest.Mock).mockResolvedValue({
      userId: 'u2', email: 'arch@b.com', name: 'Arch', givenName: 'A', familyName: 'B',
      role: 'architect', organization: 'org-1', status: 'active', enabled: true, createdAt: '2024-01-01',
    });

    render(
      <OrganizationProvider><TestConsumer /></OrganizationProvider>
    );

    await waitFor(() => expect(screen.getByTestId('can-approve')).toHaveTextContent('true'));
    expect(screen.getByTestId('is-admin')).toHaveTextContent('false');
  });

  it('is false for member users', async () => {
    (userManagementService.getCurrentUserProfile as jest.Mock).mockResolvedValue({
      userId: 'u3', email: 'mem@b.com', name: 'Member', givenName: 'M', familyName: 'B',
      role: 'member', organization: 'org-1', status: 'active', enabled: true, createdAt: '2024-01-01',
    });

    render(
      <OrganizationProvider><TestConsumer /></OrganizationProvider>
    );

    await waitFor(() => expect(screen.getByTestId('can-approve')).toHaveTextContent('false'));
  });

  it('is false while loading', () => {
    (userManagementService.getCurrentUserProfile as jest.Mock).mockReturnValue(new Promise(() => {}));

    render(
      <OrganizationProvider><TestConsumer /></OrganizationProvider>
    );

    expect(screen.getByText('loading')).toBeInTheDocument();
  });
});
