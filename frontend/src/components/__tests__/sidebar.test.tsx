import React from 'react';
import { render } from '@testing-library/react';
import { AppSidebar } from '../AppSidebar';
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
    organizations: ['TestOrg', 'OtherOrg'],
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

describe('Property 14: Sidebar collapse/expand round-trip', () => {
  it('renders in expanded state when defaultOpen=true', () => {
    const { container } = renderSidebar();
    const sidebar = container.querySelector('[data-slot="sidebar"]');
    expect(sidebar).toBeTruthy();
    expect(sidebar!.getAttribute('data-state')).toBe('expanded');
  });

  it('renders in collapsed state when defaultOpen=false', () => {
    const { container } = render(
      <SidebarProvider defaultOpen={false}>
        <AppSidebar />
      </SidebarProvider>
    );
    const sidebar = container.querySelector('[data-slot="sidebar"]');
    expect(sidebar).toBeTruthy();
    expect(sidebar!.getAttribute('data-state')).toBe('collapsed');
  });

  it('sidebar-wrapper is present in both states', () => {
    const { container } = renderSidebar();
    const wrapper = container.querySelector('[data-slot="sidebar-wrapper"]');
    expect(wrapper).toBeTruthy();
  });
});
