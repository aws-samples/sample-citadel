import { ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { AppSidebar } from './AppSidebar';
import { AppHeader } from './AppHeader';
import { SidebarProvider, SidebarInset } from './ui/sidebar';
import { pathToNavId, navIdToPath } from '../routes';

interface AppLayoutProps {
  children: ReactNode;
  currentUser?: any;
  onLogout?: () => void;
}

export function AppLayout({
  children,
  currentUser,
  onLogout,
}: AppLayoutProps) {
  const location = useLocation();
  const navigate = useNavigate();

  const activeItem = pathToNavId(location.pathname);

  const handleNavigate = (navId: string) => {
    navigate(navIdToPath(navId));
  };

  return (
    <SidebarProvider>
      {/* Skip to main content link for keyboard/screen reader users */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:p-4 focus:bg-card focus:text-foreground focus:rounded-md focus:top-2 focus:left-2"
      >
        Skip to main content
      </a>

      <AppSidebar
        activeItem={activeItem}
        onNavigate={handleNavigate}
      />

      <SidebarInset>
        <AppHeader currentUser={currentUser} onLogout={onLogout} />
        <main id="main-content" className="flex-1 bg-background min-w-0 overflow-y-auto overflow-x-hidden">{children}</main>
      </SidebarInset>
    </SidebarProvider>
  );
}
