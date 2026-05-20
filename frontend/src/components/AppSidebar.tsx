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
} from 'lucide-react';
import { useOrganization } from '../contexts/OrganizationContext';
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

export const navigationItems = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'intake-requests', label: 'Intake Requests', icon: Inbox },
  { id: 'agentic-studio', label: 'Agentic Studio', icon: Wand2 },
  { id: 'agent-apps', label: 'Agent Apps', icon: AppWindow },
  { id: 'agent-catalog', label: 'Agent Catalog', icon: Bot },
  { id: 'tools', label: 'Agent Tools', icon: Wrench },
  { id: 'integrations', label: 'Integrations', icon: Plug },
  { id: 'data-stores', label: 'Data Stores', icon: Database },
  { id: 'team', label: 'Team', icon: Users },
];

export function AppSidebar({ activeItem = 'dashboard', onNavigate }: AppSidebarProps) {
  const { selectedOrganization, setSelectedOrganization, organizations, loading } = useOrganization();

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
              {navigationItems.map((item) => {
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
                    </SidebarMenuButton>
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
