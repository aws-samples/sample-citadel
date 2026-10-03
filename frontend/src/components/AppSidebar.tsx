import { useState, useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import {
  LayoutDashboard,
  Inbox,
  Building2,
  Wand2,
  Plug,
  Wrench,
  Database,
  Users,
  Bot,
  AppWindow,
  ChevronDown,
  Shield,
  SlidersHorizontal,
  Waypoints,
  KeyRound,
  ClipboardCheck,
} from 'lucide-react';
import { useOrganization } from '../contexts/OrganizationContext';
import { Badge } from './ui/badge';
import { approvalsService } from '../services/approvalsService';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from './ui/sidebar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';

export interface AppSidebarProps {
  activeItem?: string;
  onNavigate?: (item: string) => void;
}

export interface NavigationItem {
  id: string;
  label: string;
  icon: React.ComponentType<any>;
  adminOnly?: boolean;
}

export const navigationItems: NavigationItem[] = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'intake-requests', label: 'Intake Requests', icon: Inbox },
  { id: 'agentic-studio', label: 'Agentic Studio', icon: Wand2 },
  { id: 'agent-apps', label: 'Agent Apps', icon: AppWindow },
  { id: 'agent-catalog', label: 'Agent Catalog', icon: Bot },
  { id: 'tools', label: 'Agent Tools', icon: Wrench },
  { id: 'model-config', label: 'Model Config', icon: SlidersHorizontal },
  { id: 'observability', label: 'Observability', icon: Waypoints },
  { id: 'governance', label: 'Governance', icon: Shield },
  { id: 'integrations', label: 'Integrations', icon: Plug },
  { id: 'data-stores', label: 'Data Stores', icon: Database },
  { id: 'team', label: 'Team', icon: Users },
  { id: 'approvals', label: 'Approvals', icon: ClipboardCheck, adminOnly: true },
];

export function AppSidebar({ activeItem = 'dashboard', onNavigate }: AppSidebarProps) {
  const { selectedOrganization, setSelectedOrganization, organizations, loading, isAdmin } = useOrganization();
  const location = useLocation();
  const [pendingCount, setPendingCount] = useState(0);

  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    approvalsService.listPendingApprovals({ limit: 50 }).then((data) => {
      if (!cancelled) setPendingCount(data.items.length);
    }).catch(() => {
      /* best-effort badge */
    });
    return () => { cancelled = true; };
  }, [isAdmin, location.pathname]);

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton
                  size="lg"
                  className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
                  disabled={loading}
                >
                  <div className="flex items-center gap-2">
                    <div className="size-7 bg-sidebar-accent rounded flex items-center justify-center shrink-0">
                      <Building2 className="size-4" />
                    </div>
                    <div className="flex flex-col items-start">
                      <span className="text-xs font-medium truncate">
                        {loading ? 'Loading...' : selectedOrganization || 'No Org'}
                      </span>
                    </div>
                  </div>
                  {!loading && organizations.length > 1 && (
                    <ChevronDown className="ml-auto size-3" />
                  )}
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent className="w-[--radix-dropdown-menu-trigger-width]" align="start">
                <DropdownMenuRadioGroup value={selectedOrganization || ''} onValueChange={setSelectedOrganization}>
                  {organizations.map((org) => (
                    <DropdownMenuRadioItem key={org} value={org}>
                      {org}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {navigationItems
                .filter((item) => !item.adminOnly || isAdmin)
                .map((item) => {
                const Icon = item.icon;
                return (
                  <SidebarMenuItem key={item.id}>
                    <SidebarMenuButton
                      isActive={activeItem === item.id}
                      tooltip={item.label}
                      onClick={() => onNavigate?.(item.id)}
                    >
                      <Icon />
                      <span>{item.label}</span>
                      {item.id === 'approvals' && pendingCount > 0 && (
                        <Badge variant="destructive" className="ml-auto text-[10px] px-1.5 py-0">
                          {pendingCount}
                        </Badge>
                      )}
                    </SidebarMenuButton>
                    {item.id === 'observability' && isAdmin && (
                      <SidebarMenuSub>
                        <SidebarMenuSubItem>
                          <SidebarMenuSubButton onClick={() => onNavigate?.('observability')}>
                            <KeyRound className="size-3" />
                            <span>Raw trace ID (admin)</span>
                          </SidebarMenuSubButton>
                        </SidebarMenuSubItem>
                      </SidebarMenuSub>
                    )}
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton tooltip="Settings">
              <Wrench />
              <span>Settings</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
