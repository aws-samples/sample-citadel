Object.defineProperty(window, 'matchMedia', { writable: true, value: jest.fn().mockImplementation((q: string) => ({ matches: false, media: q, onchange: null, addListener: jest.fn(), removeListener: jest.fn(), addEventListener: jest.fn(), removeEventListener: jest.fn(), dispatchEvent: jest.fn() })) });

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import { MemoryRouter } from 'react-router-dom';
import { AppSidebar } from '../AppSidebar';
import { AppHeader } from '../AppHeader';
import { SidebarProvider } from '../ui/sidebar';
import { TooltipProvider } from '../ui/tooltip';

jest.mock('../../contexts/OrganizationContext', () => ({
  useOrganization: () => ({
    selectedOrganization: 'All Organizations',
    setSelectedOrganization: jest.fn(),
    organizations: ['All Organizations', 'Acme', 'Beta'],
    loading: false,
    currentUser: { role: 'admin' },
    isAdmin: true,
  }),
}));

describe('Dropdown triggers integration', () => {
  it('AppSidebar org dropdown opens and shows menu items', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <TooltipProvider>
          <SidebarProvider defaultOpen={true}>
            <AppSidebar />
          </SidebarProvider>
        </TooltipProvider>
      </MemoryRouter>,
    );

    const trigger = screen.getByRole('button', { name: /All Organizations/i });
    await user.click(trigger);

    expect(screen.getByText('Acme')).toBeInTheDocument();
    expect(screen.getByText('Beta')).toBeInTheDocument();
  });

  it('AppHeader user dropdown opens and shows Logout', async () => {
    const user = userEvent.setup();
    const onLogout = jest.fn();
    render(
      <MemoryRouter>
        <TooltipProvider>
          <SidebarProvider defaultOpen={true}>
            <AppHeader currentUser={{ role: 'admin', name: 'Test' }} onLogout={onLogout} />
          </SidebarProvider>
        </TooltipProvider>
      </MemoryRouter>,
    );

    // The user icon button
    const trigger = screen.getByRole('button', { name: '' });
    await user.click(trigger);

    expect(screen.getByText('Logout')).toBeInTheDocument();
  });
});
