import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { RequireAdmin } from '../RequireAdmin';

// Shared mock state so individual tests can override
let mockIsAdmin = true;
let mockLoading = false;

jest.mock('../../contexts/OrganizationContext', () => ({
  useOrganization: () => ({
    selectedOrganization: 'TestOrg',
    setSelectedOrganization: jest.fn(),
    organizations: ['TestOrg'],
    currentUser: mockLoading
      ? null
      : { userId: 'u1', role: mockIsAdmin ? 'admin' : 'developer', organization: 'TestOrg' },
    isAdmin: mockIsAdmin,
    loading: mockLoading,
  }),
  OrganizationProvider: ({ children }: any) => <>{children}</>,
}));

function renderWithRouter(isAdmin: boolean, loading = false) {
  mockIsAdmin = isAdmin;
  mockLoading = loading;
  return render(
    <MemoryRouter initialEntries={['/admin-page']}>
      <Routes>
        <Route
          path="/admin-page"
          element={
            <RequireAdmin>
              <div data-testid="admin-content">Secret admin stuff</div>
            </RequireAdmin>
          }
        />
        <Route path="/" element={<div data-testid="home">Home</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('RequireAdmin', () => {
  it('renders children when user is admin', () => {
    renderWithRouter(true);
    expect(screen.getByTestId('admin-content')).toBeInTheDocument();
  });

  it('redirects to / when user is not admin', () => {
    renderWithRouter(false);
    expect(screen.queryByTestId('admin-content')).not.toBeInTheDocument();
    expect(screen.getByTestId('home')).toBeInTheDocument();
  });

  it('shows loading indicator while profile is loading and does not redirect', () => {
    renderWithRouter(false, true);
    expect(screen.getByTestId('admin-loading')).toBeInTheDocument();
    expect(screen.queryByTestId('admin-content')).not.toBeInTheDocument();
    expect(screen.queryByTestId('home')).not.toBeInTheDocument();
  });
});
