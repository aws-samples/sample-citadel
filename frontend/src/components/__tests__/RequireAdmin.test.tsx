import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { RequireAdmin } from '../RequireAdmin';

// Shared mock reference so each test file can override
let mockIsAdmin = true;

jest.mock('../../contexts/OrganizationContext', () => ({
  useOrganization: () => ({
    selectedOrganization: 'TestOrg',
    setSelectedOrganization: jest.fn(),
    organizations: ['TestOrg'],
    currentUser: { userId: 'u1', role: mockIsAdmin ? 'admin' : 'developer', organization: 'TestOrg' },
    isAdmin: mockIsAdmin,
    loading: false,
  }),
  OrganizationProvider: ({ children }: any) => <>{children}</>,
}));

function renderWithRouter(isAdmin: boolean) {
  mockIsAdmin = isAdmin;
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
});
