import { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { userManagementService, User, Organization } from '../services/userManagementService';

interface OrganizationContextType {
  selectedOrganization: string | null;
  setSelectedOrganization: (org: string | null) => void;
  organizations: string[];
  currentUser: User | null;
  isAdmin: boolean;
  loading: boolean;
}

const OrganizationContext = createContext<OrganizationContextType | undefined>(undefined);

export function OrganizationProvider({ children }: { children: ReactNode }) {
  const [selectedOrganization, setSelectedOrganization] = useState<string | null>(null);
  const [organizations, setOrganizations] = useState<string[]>([]);
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadUserAndOrganizations();
  }, []);

  const loadUserAndOrganizations = async () => {
    try {
      setLoading(true);
      
      console.log('OrganizationContext: Loading user profile...');
      
      // Get current user profile
      const userProfile = await userManagementService.getCurrentUserProfile();
      
      console.log('OrganizationContext: User profile:', userProfile);
      
      if (!userProfile) {
        console.warn('No user profile returned from getCurrentUserProfile');
        setCurrentUser(null);
        setOrganizations([]);
        setSelectedOrganization(null);
        return;
      }

      setCurrentUser(userProfile);

      const isUserAdmin = userProfile.role === 'admin';
      console.log('OrganizationContext: Is admin?', isUserAdmin);

      if (isUserAdmin) {
        // Admin: Get all organizations from the organization table
        console.log('OrganizationContext: Loading organizations for admin...');
        const allOrgs = await userManagementService.listOrganizations();
        console.log('OrganizationContext: Loaded organizations:', allOrgs);
        
        const orgNames = allOrgs.map(org => org.name).sort();
        
        // Add "All Organizations" option for admins
        const orgsWithAll = ['All Organizations', ...orgNames];
        setOrganizations(orgsWithAll);
        // Default to "All Organizations"
        setSelectedOrganization('All Organizations');
        console.log('OrganizationContext: Set organizations:', orgsWithAll);
      } else {
        // Non-admin: Only show their organization
        if (userProfile.organization) {
          setOrganizations([userProfile.organization]);
          setSelectedOrganization(userProfile.organization);
          console.log('OrganizationContext: Set user org:', userProfile.organization);
        } else {
          setOrganizations([]);
          setSelectedOrganization(null);
          console.log('OrganizationContext: User has no organization');
        }
      }
    } catch (error) {
      console.error('OrganizationContext: Failed to load user and organizations:', error);
      setCurrentUser(null);
      setOrganizations([]);
      setSelectedOrganization(null);
    } finally {
      setLoading(false);
    }
  };

  const isAdmin = currentUser?.role === 'admin';

  return (
    <OrganizationContext.Provider
      value={{
        selectedOrganization,
        setSelectedOrganization,
        organizations,
        currentUser,
        isAdmin,
        loading,
      }}
    >
      {children}
    </OrganizationContext.Provider>
  );
}

export function useOrganization() {
  const context = useContext(OrganizationContext);
  if (context === undefined) {
    throw new Error('useOrganization must be used within an OrganizationProvider');
  }
  return context;
}
