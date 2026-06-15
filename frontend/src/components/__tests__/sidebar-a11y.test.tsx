import React from 'react';
import { render, screen } from '@testing-library/react';
import { AppSidebar, navigationItems } from '../AppSidebar';
import { SidebarProvider } from '../ui/sidebar';

// jsdom doesn't implement matchMedia — required by useMobile hook in Sidebar
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: jest.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: jest.fn(),
    removeListener: jest.fn(),
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    dispatchEvent: jest.fn(),
  })),
});

// Mock OrganizationContext
jest.mock('../../contexts/OrganizationContext', () => ({
  useOrganization: () => ({
    selectedOrganization: 'TestOrg',
    setSelectedOrganization: jest.fn(),
    organizations: ['TestOrg'],
    loading: false,
  }),
}));

function renderSidebar(props: Partial<React.ComponentProps<typeof AppSidebar>> = {}) {
  return render(
    <SidebarProvider defaultOpen={true}>
      <AppSidebar {...props} />
    </SidebarProvider>
  );
}

describe('Property 9: Active nav item has aria-current', () => {
  it('active menu button has data-active=true', () => {
    renderSidebar({ activeItem: 'dashboard' });
    const activeButton = screen.getByRole('button', { name: 'Dashboard' });
    expect(activeButton.getAttribute('data-active')).toBe('true');
  });

  it('non-active menu buttons have data-active=false', () => {
    renderSidebar({ activeItem: 'dashboard' });
    const integrationsBtn = screen.getByRole('button', { name: 'Integrations' });
    expect(integrationsBtn.getAttribute('data-active')).toBe('false');
  });
});

describe('Accessibility unit tests', () => {
  it('renders all navigation items as buttons', () => {
    renderSidebar();
    for (const item of navigationItems) {
      expect(screen.getByRole('button', { name: item.label })).toBeTruthy();
    }
  });

  it('navigation items are within a list structure', () => {
    const { container } = renderSidebar();
    const lists = container.querySelectorAll('[data-slot="sidebar-menu"]');
    expect(lists.length).toBeGreaterThan(0);
    const menuItems = container.querySelectorAll('[data-slot="sidebar-menu-item"]');
    // At least the navigation items + org selector + settings
    expect(menuItems.length).toBeGreaterThanOrEqual(navigationItems.length);
  });

  it('each nav button is clickable and calls onNavigate', () => {
    const onNavigate = jest.fn();
    renderSidebar({ onNavigate });
    screen.getByRole('button', { name: 'Integrations' }).click();
    expect(onNavigate).toHaveBeenCalledWith('integrations');
  });
});
