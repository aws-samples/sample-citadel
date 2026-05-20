import { useState, useEffect } from 'react';
import { Users, UserPlus, Shield, Building2, Mail, Calendar, MoreVertical, Eye, EyeOff, Send, Trash2, Plus } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Accordion, AccordionItem, AccordionTrigger, AccordionContent } from '../components/ui/accordion';
import { userManagementService, User, Organization } from '../services/userManagementService';
import { useOrganization } from '../contexts/OrganizationContext';
import { PageContainer } from '../components/PageContainer';

export function Team() {
  const { selectedOrganization: currentOrg, currentUser, isAdmin } = useOrganization();
  const [users, setUsers] = useState<User[]>([]);
  const [selectedUser, setSelectedUser] = useState<User | null>(null);
  const [selectedRole, setSelectedRole] = useState('');
  const [selectedOrganization, setSelectedOrganization] = useState('');
  const [availableRoles, setAvailableRoles] = useState<string[]>([]);
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [assigning, setAssigning] = useState(false);
  const [expandedUserId, setExpandedUserId] = useState<string | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [verifyPassword, setVerifyPassword] = useState('');
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showVerifyPassword, setShowVerifyPassword] = useState(false);
  const [passwordChanging, setPasswordChanging] = useState(false);
  const [passwordResetMessage, setPasswordResetMessage] = useState<string | null>(null);
  const [showAddUserModal, setShowAddUserModal] = useState(false);
  const [newUserEmail, setNewUserEmail] = useState('');
  const [newUserFirstName, setNewUserFirstName] = useState('');
  const [newUserLastName, setNewUserLastName] = useState('');
  const [creatingUser, setCreatingUser] = useState(false);
  const [newUserRole, setNewUserRole] = useState('');
  const [newUserOrganization, setNewUserOrganization] = useState('');
  const [invitationMessage, setInvitationMessage] = useState<string | null>(null);
  const [showAddOrgModal, setShowAddOrgModal] = useState(false);
  const [newOrgName, setNewOrgName] = useState('');
  const [newOrgDescription, setNewOrgDescription] = useState('');
  const [creatingOrg, setCreatingOrg] = useState(false);
  const [showManageOrgsModal, setShowManageOrgsModal] = useState(false);
  const [newOrganizationValue, setNewOrganizationValue] = useState('');
  const [changingOrg, setChangingOrg] = useState(false);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      setLoading(true);
      setError(null);
      
      console.log('Starting to load data...');
      
      // Load all data in parallel
      const [allUsers, roles, orgs] = await Promise.all([
        userManagementService.listUsers(),
        userManagementService.listAvailableRoles(),
        userManagementService.listOrganizations(),
      ]);
      
      console.log('Loaded users:', allUsers);
      console.log('Loaded roles from Cognito:', roles);
      console.log('Loaded organizations from DynamoDB:', orgs);
      
      setUsers(allUsers);
      setAvailableRoles(roles);
      setOrganizations(orgs);
    } catch (err: any) {
      console.error('Failed to load data:', err);
      console.error('Error details:', err);
      setError(err.message || 'Failed to load data');
    } finally {
      setLoading(false);
    }
  };

  const handleAssignRole = async () => {
    if (!selectedUser || !selectedRole) {
      setError('Please select both a role and organization');
      return;
    }

    try {
      setAssigning(true);
      setError(null);

      await userManagementService.assignUserRole({
        userId: selectedUser.userId,
        role: selectedRole,
        organization: selectedOrganization || undefined,
      });

      // Reload data to get updated users
      await loadData();

      // Close modal and reset
      setSelectedUser(null);
      setSelectedRole('');
      setSelectedOrganization('');
    } catch (err: any) {
      console.error('Failed to assign role:', err);
      setError(err.message || 'Failed to assign role');
    } finally {
      setAssigning(false);
    }
  };

  const handleChangePassword = async () => {
    if (!newPassword || !verifyPassword) {
      setError('Please fill in all password fields');
      return;
    }

    if (newPassword !== verifyPassword) {
      setError('New passwords do not match');
      return;
    }

    if (newPassword.length < 8) {
      setError('Password must be at least 8 characters long');
      return;
    }

    try {
      setPasswordChanging(true);
      setError(null);

      const response = await userManagementService.changePassword(newPassword);

      if (response.success) {
        setNewPassword('');
        setVerifyPassword('');
        setExpandedUserId(null);
        setError(null);
        alert('Password changed successfully');
      } else {
        setError(response.message || 'Failed to change password');
      }
    } catch (err: any) {
      console.error('Failed to change password:', err);
      setError(err.message || 'Failed to change password');
    } finally {
      setPasswordChanging(false);
    }
  };

  const handleResetPassword = async (userId: string) => {
    if (!confirm(`Are you sure you want to reset the password for this user? They will receive a temporary password.`)) {
      return;
    }

    try {
      setPasswordChanging(true);
      setError(null);
      setPasswordResetMessage(null);

      const response = await userManagementService.adminResetUserPassword(userId);

      if (response.success) {
        setPasswordResetMessage(response.message || 'Password reset successfully');
        setTimeout(() => setPasswordResetMessage(null), 10000); // Clear after 10 seconds
      } else {
        setError(response.message || 'Failed to reset password');
      }
    } catch (err: any) {
      console.error('Failed to reset password:', err);
      setError(err.message || 'Failed to reset password');
    } finally {
      setPasswordChanging(false);
    }
  };

  const handleAddUser = async () => {
    if (!newUserEmail || !newUserFirstName || !newUserLastName) {
      setError('Please fill in all fields');
      return;
    }

    // Basic email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(newUserEmail)) {
      setError('Please enter a valid email address');
      return;
    }

    try {
      setCreatingUser(true);
      setError(null);

      const response = await userManagementService.adminCreateUser({
        email: newUserEmail,
        givenName: newUserFirstName,
        familyName: newUserLastName,
      });

      console.log('Create user response:', response);

      if (response && response.success) {
        const savedEmail = newUserEmail;
        const savedRole = newUserRole;
        const savedOrg = newUserOrganization;
        setNewUserEmail('');
        setNewUserFirstName('');
        setNewUserLastName('');
        setNewUserRole('');
        setNewUserOrganization('');
        setShowAddUserModal(false);

        if (savedRole) {
          const refreshed = await userManagementService.listUsers();
          const newUser = refreshed.find(u => u.email.toLowerCase() === savedEmail.toLowerCase());
          if (newUser) {
            await userManagementService.assignUserRole({
              userId: newUser.userId,
              role: savedRole,
              organization: savedOrg || undefined,
            });
          }
        }

        await loadData();
        setError(null);
      } else {
        setError(response?.message || 'Failed to create user');
      }
    } catch (err: any) {
      console.error('Failed to create user:', err);
      console.error('Error details:', err.errors);
      
      // Extract error message from GraphQL errors if available
      let errorMessage = 'Failed to create user';
      if (err.errors && err.errors.length > 0) {
        errorMessage = err.errors[0].message;
      } else if (err.message) {
        errorMessage = err.message;
      }
      
      setError(errorMessage);
    } finally {
      setCreatingUser(false);
    }
  };

  const handleResendInvitation = async (userId: string) => {
    try {
      setError(null);
      setInvitationMessage(null);

      const response = await userManagementService.adminResendInvitation(userId);

      if (response.success) {
        setInvitationMessage(response.message || 'Invitation resent successfully');
        setTimeout(() => setInvitationMessage(null), 10000); // Clear after 10 seconds
      } else {
        setError(response.message || 'Failed to resend invitation');
      }
    } catch (err: any) {
      console.error('Failed to resend invitation:', err);
      setError(err.message || 'Failed to resend invitation');
    }
  };

  const handleAddOrganization = async () => {
    if (!newOrgName) {
      setError('Please enter an organization name');
      return;
    }

    try {
      setCreatingOrg(true);
      setError(null);

      await userManagementService.createOrganization({
        name: newOrgName,
        description: newOrgDescription || undefined,
      });

      setNewOrgName('');
      setNewOrgDescription('');
      setShowAddOrgModal(false);
      await loadData(); // Reload organizations
      setError(null);
    } catch (err: any) {
      console.error('Failed to create organization:', err);
      setError(err.message || 'Failed to create organization');
    } finally {
      setCreatingOrg(false);
    }
  };

  const handleDeleteOrganization = async (orgId: string, orgName: string) => {
    if (!confirm(`Are you sure you want to delete the organization "${orgName}"? This action cannot be undone.`)) {
      return;
    }

    try {
      setError(null);

      const response = await userManagementService.deleteOrganization(orgId);

      if (response.success) {
        await loadData(); // Reload organizations
        setError(null);
      } else {
        setError(response.message || 'Failed to delete organization');
      }
    } catch (err: any) {
      console.error('Failed to delete organization:', err);
      setError(err.message || 'Failed to delete organization');
    }
  };

  const handleChangeOrganization = async (user: User) => {
    if (!newOrganizationValue || newOrganizationValue === user.organization || !user.role) return;

    try {
      setChangingOrg(true);
      setError(null);

      await userManagementService.assignUserRole({
        userId: user.userId,
        role: user.role!,
        organization: newOrganizationValue,
      });

      await loadData();
      setNewOrganizationValue('');
      setExpandedUserId(null);
    } catch (err: any) {
      setError(err.message || 'Failed to change organization');
    } finally {
      setChangingOrg(false);
    }
  };

  const shouldShowUserActions = (user: User) => {
    if (!currentUser) return false;
    
    // Show if user is the current user (for password change)
    if (user.userId === currentUser.userId) return true;
    
    // Show if current user is admin and it's not their own account
    if (isAdmin && user.userId !== currentUser.userId) return true;
    
    return false;
  };

  // Filter users based on role and organization
  const filteredUsers = (() => {
    if (isAdmin) {
      // Admins see all users
      return users;
    } else {
      // Non-admins only see users in their organization (and users with no org)
      const userOrg = currentUser?.organization;
      return users.filter(u => 
        u.role && // Only show users with roles (no lobby access)
        (u.organization === userOrg || !u.organization)
      );
    }
  })();

  // Users without roles are in the lobby (only visible to admins)
  const lobbyUsers = isAdmin ? filteredUsers.filter(u => !u.role) : [];
  const activeUsers = filteredUsers.filter(u => u.role);

  // Further filter by selected organization if one is chosen (and not "All Organizations")
  const shouldFilterByOrg = currentOrg && currentOrg !== 'All Organizations';
  
  const displayedLobbyUsers = shouldFilterByOrg
    ? lobbyUsers.filter(u => !u.organization || u.organization === currentOrg)
    : lobbyUsers;
  
  const displayedActiveUsers = shouldFilterByOrg
    ? activeUsers.filter(u => u.organization === currentOrg)
    : activeUsers;

  // console.log('Debug - currentOrg:', currentOrg);
  // console.log('Debug - shouldFilterByOrg:', shouldFilterByOrg);
  // console.log('Debug - users:', users.length);
  // console.log('Debug - filteredUsers:', filteredUsers.length);
  // console.log('Debug - lobbyUsers:', lobbyUsers.length);
  // console.log('Debug - activeUsers:', activeUsers.length);
  // console.log('Debug - displayedLobbyUsers:', displayedLobbyUsers.length);
  // console.log('Debug - displayedActiveUsers:', displayedActiveUsers.length);

  const formatDate = (date: string) => {
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    }).format(new Date(date));
  };

  const getRoleBadgeColor = (role?: string) => {
    switch (role) {
      case 'admin':
        return 'bg-destructive/20 text-destructive border-destructive/50';
      case 'developer':
        return 'bg-primary/20 text-primary border-primary/50';
      case 'viewer':
        return 'bg-muted/20 text-muted-foreground border-border';
      default:
        return 'bg-chart-4/20 text-chart-4 border-chart-4/50';
    }
  };

  return (
    <PageContainer className="flex-1 bg-card">
      <div className="mb-6">
        <h1 className="text-foreground text-2xl font-semibold mb-2">Team Management</h1>
        <p className="text-muted-foreground text-sm">
          Manage team members, roles, and organization assignments
          {currentOrg && currentOrg !== 'All Organizations' && (
            <span className="ml-2 text-primary">• Filtered by {currentOrg}</span>
          )}
        </p>
      </div>

      {/* Error Message */}
      {error && (
        <div className="bg-destructive/10 border border-destructive/50 rounded-lg p-4 mb-6">
          <p className="text-destructive">{error}</p>
        </div>
      )}

      {/* Invitation Message */}
      {invitationMessage && (
        <div className="bg-chart-2/10 border border-chart-2/50 rounded-lg p-4 mb-6">
          <p className="text-chart-2 font-mono text-sm break-all">{invitationMessage}</p>
        </div>
      )}

      {/* Loading State */}
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <div className="text-center">
            <div className="animate-spin rounded-full size-12 border-b-2 border-primary mx-auto mb-4"></div>
            <p className="text-muted-foreground">Loading users...</p>
          </div>
        </div>
      ) : (
        <>
          {/* Stats Cards */}
          <div className="flex gap-4 mb-6">
        <Card className="flex-1 bg-accent border-border">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-muted-foreground text-sm">Total Users</p>
                <p className="text-foreground text-2xl font-bold">{filteredUsers.length}</p>
              </div>
              <div className="size-12 rounded-lg bg-primary/20 flex items-center justify-center">
                <Users className="size-6 text-primary" />
              </div>
            </div>
          </CardContent>
        </Card>

        {isAdmin && (
          <Card className="flex-1 bg-accent border-border">
            <CardContent className="pt-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-muted-foreground text-sm">Pending Assignment</p>
                  <p className="text-foreground text-2xl font-bold">{displayedLobbyUsers.length}</p>
                </div>
                <div className="size-12 rounded-lg bg-chart-4/20 flex items-center justify-center">
                  <UserPlus className="size-6 text-chart-4" />
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        <Card className="flex-1 bg-accent border-border">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-muted-foreground text-sm">Active Members</p>
                <p className="text-foreground text-2xl font-bold">{displayedActiveUsers.length}</p>
              </div>
              <div className="size-12 rounded-lg bg-chart-2/20 flex items-center justify-center">
                <Shield className="size-6 text-chart-2" />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="flex-1 bg-accent border-border">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-muted-foreground text-sm">Your Role</p>
                <p className="text-foreground text-2xl font-bold capitalize">{currentUser?.role || 'N/A'}</p>
              </div>
              <div className="size-12 rounded-lg bg-chart-5/20 flex items-center justify-center">
                <Shield className="size-6 text-chart-5" />
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Two Column Layout - Lobby and Active Users */}
      <div className="flex gap-6">
        {/* Lobby Section - Only visible to admins */}
        {isAdmin && displayedLobbyUsers.length > 0 && (
          <div className="flex-1">
            <Card className="bg-accent border-border">
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle className="text-foreground flex items-center gap-2">
                      <UserPlus className="size-5 text-chart-4" />
                      Lobby - Pending Assignment
                    </CardTitle>
                    <CardDescription className="text-muted-foreground">
                      New users waiting to be assigned a role and organization
                    </CardDescription>
                  </div>
                  <div className="flex items-center gap-3">
                    <Badge className="bg-chart-4/20 text-chart-4 border-chart-4/50">
                      {displayedLobbyUsers.length} pending
                    </Badge>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <div className="flex flex-col gap-3">
                  {displayedLobbyUsers.map((user) => {
                    const isUnverified = user.status === 'FORCE_CHANGE_PASSWORD';
                    return (
                      <div
                        key={user.userId}
                        className="flex items-center justify-between p-4 bg-card border border-border rounded-lg hover:border-chart-4/50 transition-colors"
                      >
                        <div className="flex items-center gap-4">
                          <div className="size-10 rounded-full bg-chart-4/20 flex items-center justify-center">
                            <Users className="size-5 text-chart-4" />
                          </div>
                          <div>
                            <div className="flex items-center gap-2">
                              <p className="text-foreground font-medium">{user.name}</p>
                              {isUnverified && (
                                <Badge className="bg-chart-4/20 text-chart-4 border-chart-4/50 text-xs">
                                  Invited
                                </Badge>
                              )}
                            </div>
                            <div className="flex items-center gap-3 text-sm text-muted-foreground">
                              <span className="flex items-center gap-1">
                                <Mail className="size-3" />
                                {user.email}
                              </span>
                              <span className="flex items-center gap-1">
                                <Calendar className="size-3" />
                                Joined {formatDate(user.createdAt)}
                              </span>
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          {isUnverified ? (
                            <Button
                              variant="outline" className="gap-1 text-xs py-1 px-2 h-7"
                              onClick={() => handleResendInvitation(user.userId)}
                            >
                              <Send className="size-4 mr-2" />
                              Resend Invitation
                            </Button>
                          ) : (
                            <Button
                              variant="outline" className="gap-1 text-xs py-1 px-2 h-7"
                              onClick={() => setSelectedUser(user)}
                            >
                              Assign Role
                            </Button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {/* Active Users Section */}
        <div className="flex-1">
          <Card className="bg-accent border-border">
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-foreground">Active Team Members</CardTitle>
                  <CardDescription className="text-muted-foreground">
                    Users with assigned roles and organizations
                  </CardDescription>
                </div>
                <div className="flex items-center gap-3">
                    {isAdmin && (
                      <Button
                        variant="outline" className="gap-1 text-xs py-1 px-2 h-7"
                        onClick={() => setShowManageOrgsModal(true)}
                      >
                        <Building2 className="size-4 mr-2" />
                        Manage Organizations
                      </Button>
                    )}
                    <Button
                      variant="outline" className="gap-1 text-xs py-1 px-2 h-7"
                      onClick={() => setShowAddUserModal(true)}
                    >
                      <UserPlus className="size-4 mr-2" />
                      Add User
                    </Button>
                  </div>
              </div>
            </CardHeader>
            <CardContent>
              <div className="flex flex-col gap-3">
                {displayedActiveUsers.length > 0 ? (
                  displayedActiveUsers.map((user) => (
                  <div
                    key={user.userId}
                    className="bg-card border border-border rounded-lg hover:border-primary transition-colors"
                  >
                    <div className="flex items-center justify-between p-4">
                      <div className="flex items-center gap-4 flex-1">
                        <div className="size-10 rounded-full bg-primary/20 flex items-center justify-center">
                          <Users className="size-5 text-primary" />
                        </div>
                        <div className="flex-1">
                          <p className="text-foreground font-medium">{user.name}</p>
                          <div className="flex items-center gap-3 text-sm text-muted-foreground">
                            <span className="flex items-center gap-1">
                              <Mail className="size-3" />
                              {user.email}
                            </span>
                            <span className="flex items-center gap-1">
                              <Calendar className="size-3" />
                              {formatDate(user.createdAt)}
                            </span>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <Badge className={getRoleBadgeColor(user.role)}>
                            <Shield className="size-3 mr-1" />
                            {user.role}
                          </Badge>
                          {user.organization && (
                            <Badge className="bg-chart-5/20 text-chart-5 border-chart-5/50">
                              <Building2 className="size-3 mr-1" />
                              {user.organization}
                            </Badge>
                          )}
                        </div>
                      </div>
                      {shouldShowUserActions(user) && (
                        <button 
                          className="text-muted-foreground hover:text-foreground transition-colors ml-4"
                          onClick={() => setExpandedUserId(expandedUserId === user.userId ? null : user.userId)}
                        >
                          <MoreVertical className="size-5" />
                        </button>
                      )}
                    </div>
                    
                    {shouldShowUserActions(user) && expandedUserId === user.userId && (
                      <div className="border-t border-border p-4">
                        <Accordion type="single" collapsible className="w-full">
                          {user.userId === currentUser?.userId ? (
                            <>
                            <AccordionItem value="change-password" className="border-border">
                              <AccordionTrigger className="text-foreground hover:text-primary">
                                Change Password
                              </AccordionTrigger>
                              <AccordionContent>
                                <div className="flex flex-col gap-4 pt-2">
                                  <div>
                                    <label className="text-foreground text-sm font-medium mb-2 block">
                                      New Password
                                    </label>
                                    <div className="relative">
                                      <input
                                        type={showNewPassword ? 'text' : 'password'}
                                        className="w-full px-3 py-2 bg-accent border border-border rounded text-foreground pr-10"
                                        value={newPassword}
                                        onChange={(e) => setNewPassword(e.target.value)}
                                        placeholder="Enter new password"
                                      />
                                      <button
                                        type="button"
                                        className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                                        onClick={() => setShowNewPassword(!showNewPassword)}
                                      >
                                        {showNewPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                                      </button>
                                    </div>
                                  </div>
                                  <div>
                                    <label className="text-foreground text-sm font-medium mb-2 block">
                                      Verify New Password
                                    </label>
                                    <div className="relative">
                                      <input
                                        type={showVerifyPassword ? 'text' : 'password'}
                                        className="w-full px-3 py-2 bg-accent border border-border rounded text-foreground pr-10"
                                        value={verifyPassword}
                                        onChange={(e) => setVerifyPassword(e.target.value)}
                                        placeholder="Re-enter new password"
                                      />
                                      <button
                                        type="button"
                                        className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                                        onClick={() => setShowVerifyPassword(!showVerifyPassword)}
                                      >
                                        {showVerifyPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                                      </button>
                                    </div>
                                  </div>
                                  <Button
                                    className="w-full bg-primary text-primary-foreground hover:bg-primary/90"
                                    onClick={() => handleChangePassword()}
                                    disabled={passwordChanging}
                                  >
                                    {passwordChanging ? 'Changing...' : 'Change Password'}
                                  </Button>
                                </div>
                              </AccordionContent>
                            </AccordionItem>
                            {isAdmin && (
                              <AccordionItem value="change-organization" className="border-border">
                                <AccordionTrigger className="text-foreground hover:text-primary">
                                  Change Organization
                                </AccordionTrigger>
                                <AccordionContent>
                                  <div className="flex flex-col gap-4 pt-2">
                                    <p className="text-muted-foreground text-sm">
                                      Current: {user.organization || 'None'}
                                    </p>
                                    <select
                                      className="w-full px-3 py-2 bg-card border border-border rounded text-foreground"
                                      value={newOrganizationValue}
                                      onChange={(e) => setNewOrganizationValue(e.target.value)}
                                    >
                                      <option value="">Select a new organization...</option>
                                      {organizations.filter(o => o.name !== user.organization).map(org => (
                                        <option key={org.orgId} value={org.name}>{org.name}</option>
                                      ))}
                                    </select>
                                    <Button
                                      className="w-full bg-primary text-primary-foreground hover:bg-primary/90"
                                      onClick={() => handleChangeOrganization(user)}
                                      disabled={changingOrg || !newOrganizationValue}
                                    >
                                      {changingOrg ? 'Changing...' : 'Change Organization'}
                                    </Button>
                                  </div>
                                </AccordionContent>
                              </AccordionItem>
                            )}
                            </>
                          ) : isAdmin && user.userId !== currentUser?.userId ? (
                            <>
                            <AccordionItem value="reset-password" className="border-border">
                              <AccordionTrigger className="text-foreground hover:text-primary">
                                Reset User Password
                              </AccordionTrigger>
                              <AccordionContent>
                                <div className="flex flex-col gap-4 pt-2">
                                  <p className="text-muted-foreground text-sm">
                                    This will generate a temporary password for the user. They will be required to change it on their next login.
                                  </p>
                                  {passwordResetMessage && (
                                    <div className="bg-chart-2/10 border border-chart-2/50 rounded-lg p-3">
                                      <p className="text-chart-2 text-sm font-mono break-all">{passwordResetMessage}</p>
                                    </div>
                                  )}
                                  <Button
                                    className="w-full bg-destructive text-foreground hover:bg-destructive"
                                    onClick={() => handleResetPassword(user.userId)}
                                    disabled={passwordChanging}
                                  >
                                    {passwordChanging ? 'Resetting...' : 'Reset Password'}
                                  </Button>
                                </div>
                              </AccordionContent>
                            </AccordionItem>
                            <AccordionItem value="change-organization" className="border-border">
                              <AccordionTrigger className="text-foreground hover:text-primary">
                                Change Organization
                              </AccordionTrigger>
                              <AccordionContent>
                                <div className="flex flex-col gap-4 pt-2">
                                  <p className="text-muted-foreground text-sm">
                                    Current: {user.organization || 'None'}
                                  </p>
                                  <select
                                    className="w-full px-3 py-2 bg-card border border-border rounded text-foreground"
                                    value={newOrganizationValue}
                                    onChange={(e) => setNewOrganizationValue(e.target.value)}
                                  >
                                    <option value="">Select a new organization...</option>
                                    {organizations.filter(o => o.name !== user.organization).map(org => (
                                      <option key={org.orgId} value={org.name}>{org.name}</option>
                                    ))}
                                  </select>
                                  <Button
                                    className="w-full bg-primary text-primary-foreground hover:bg-primary/90"
                                    onClick={() => handleChangeOrganization(user)}
                                    disabled={changingOrg || !newOrganizationValue}
                                  >
                                    {changingOrg ? 'Changing...' : 'Change Organization'}
                                  </Button>
                                </div>
                              </AccordionContent>
                            </AccordionItem>
                            </>
                          ) : null}
                        </Accordion>
                      </div>
                    )}
                  </div>
                  ))
                ) : (
                  <div className="text-center py-8">
                    <Users className="size-12 text-muted-foreground mx-auto mb-3" />
                    <p className="text-muted-foreground">No team members found</p>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
        </>
      )}

      {/* Add User Modal */}
      {showAddUserModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <Card className="bg-accent border-border w-full max-w-md mx-4">
            <CardHeader>
              <CardTitle className="text-foreground">Add New User</CardTitle>
              <CardDescription className="text-muted-foreground">
                Create a new user account. They will receive an email with a temporary password.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div>
                <Label htmlFor="newUserEmail" className="text-foreground text-sm font-medium mb-2 block">
                  Email Address
                </Label>
                <Input
                  id="newUserEmail"
                  type="email"
                  placeholder="user@example.com"
                  value={newUserEmail}
                  onChange={(e) => setNewUserEmail(e.target.value)}
                  className="bg-card border-border text-foreground"
                  disabled={creatingUser}
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="newUserFirstName" className="text-foreground text-sm font-medium mb-2 block">
                    First Name
                  </Label>
                  <Input
                    id="newUserFirstName"
                    type="text"
                    placeholder="John"
                    value={newUserFirstName}
                    onChange={(e) => setNewUserFirstName(e.target.value)}
                    className="bg-card border-border text-foreground"
                    disabled={creatingUser}
                  />
                </div>
                <div>
                  <Label htmlFor="newUserLastName" className="text-foreground text-sm font-medium mb-2 block">
                    Last Name
                  </Label>
                  <Input
                    id="newUserLastName"
                    type="text"
                    placeholder="Doe"
                    value={newUserLastName}
                    onChange={(e) => setNewUserLastName(e.target.value)}
                    className="bg-card border-border text-foreground"
                    disabled={creatingUser}
                  />
                </div>
              </div>
              <div>
                <Label className="text-foreground text-sm font-medium mb-2 block">
                  Role (Optional)
                </Label>
                <select
                  className="w-full px-3 py-2 bg-card border border-border rounded text-foreground"
                  value={newUserRole}
                  onChange={(e) => setNewUserRole(e.target.value)}
                  disabled={creatingUser}
                >
                  <option value="">Select a role (optional)...</option>
                  {availableRoles.map((role) => (
                    <option key={role} value={role}>
                      {role.split('_').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ')}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <Label className="text-foreground text-sm font-medium mb-2 block">
                  Organization (Optional)
                </Label>
                <select
                  className="w-full px-3 py-2 bg-card border border-border rounded text-foreground"
                  value={newUserOrganization}
                  onChange={(e) => setNewUserOrganization(e.target.value)}
                  disabled={creatingUser}
                >
                  <option value="">Select an organization (optional)...</option>
                  {organizations.map((org) => (
                    <option key={org.orgId} value={org.name}>
                      {org.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex gap-2 pt-4">
                <Button
                  className="flex-1 bg-primary text-primary-foreground hover:bg-primary/90"
                  onClick={handleAddUser}
                  disabled={creatingUser}
                >
                  {creatingUser ? 'Creating...' : 'Create User'}
                </Button>
                <Button
                  variant="outline"
                  className="flex-1 border-border text-foreground hover:bg-accent"
                  onClick={() => {
                    setShowAddUserModal(false);
                    setNewUserEmail('');
                    setNewUserFirstName('');
                    setNewUserLastName('');
                    setNewUserRole('');
                    setNewUserOrganization('');
                    setError(null);
                  }}
                  disabled={creatingUser}
                >
                  Cancel
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Assignment Modal */}
      {selectedUser && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <Card className="bg-accent border-border w-full max-w-md mx-4">
            <CardHeader>
              <CardTitle className="text-foreground">Assign Role & Organization</CardTitle>
              <CardDescription className="text-muted-foreground">
                Assign {selectedUser.name} to a role and organization
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div>
                <label className="text-foreground text-sm font-medium mb-2 block">Role</label>
                <select 
                  className="w-full px-3 py-2 bg-card border border-border rounded text-foreground"
                  value={selectedRole}
                  onChange={(e) => setSelectedRole(e.target.value)}
                >
                  <option value="">Select a role...</option>
                  {availableRoles.map((role) => (
                    <option key={role} value={role}>
                      {role.split('_').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ')}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-foreground text-sm font-medium mb-2 block">Organization</label>
                <select 
                  className="w-full px-3 py-2 bg-card border border-border rounded text-foreground"
                  value={selectedOrganization}
                  onChange={(e) => setSelectedOrganization(e.target.value)}
                >
                  <option value="">Select an organization...</option>
                  {organizations.map((org) => (
                    <option key={org.orgId} value={org.name}>
                      {org.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex gap-2 pt-4">
                <Button
                  className="flex-1 bg-primary text-primary-foreground hover:bg-primary/90"
                  onClick={handleAssignRole}
                  disabled={assigning || !selectedRole}
                >
                  {assigning ? 'Assigning...' : 'Assign'}
                </Button>
                <Button
                  variant="outline"
                  className="flex-1 border-border text-foreground hover:bg-accent"
                  onClick={() => setSelectedUser(null)}
                >
                  Cancel
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Manage Organizations Modal */}
      {showManageOrgsModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <Card className="bg-accent border-border w-full max-w-2xl mx-4 max-h-[80vh] overflow-hidden flex flex-col">
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-foreground">Manage Organizations</CardTitle>
                  <CardDescription className="text-muted-foreground">
                    Add or remove organizations
                  </CardDescription>
                </div>
                <Button
                  size="sm"
                  className="bg-primary text-primary-foreground hover:bg-primary/90"
                  onClick={() => setShowAddOrgModal(true)}
                >
                  <Plus className="size-4 mr-2" />
                  Add Organization
                </Button>
              </div>
            </CardHeader>
            <CardContent className="overflow-y-auto flex-1">
              <div className="flex flex-col gap-3">
                {organizations.length > 0 ? (
                  organizations.map((org) => (
                    <div
                      key={org.orgId}
                      className="flex items-center justify-between p-4 bg-card border border-border rounded-lg"
                    >
                      <div className="flex items-center gap-4 flex-1">
                        <div className="size-10 rounded-full bg-chart-5/20 flex items-center justify-center">
                          <Building2 className="size-5 text-chart-5" />
                        </div>
                        <div className="flex-1">
                          <p className="text-foreground font-medium">{org.name}</p>
                          {org.description && (
                            <p className="text-muted-foreground text-sm">{org.description}</p>
                          )}
                          {org.createdAt && (
                            <p className="text-muted-foreground text-xs mt-1">
                              Created {formatDate(org.createdAt)}
                            </p>
                          )}
                        </div>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        className="border-destructive/50 text-destructive hover:bg-destructive/10"
                        onClick={() => handleDeleteOrganization(org.orgId, org.name)}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  ))
                ) : (
                  <div className="text-center py-8">
                    <Building2 className="size-12 text-muted-foreground mx-auto mb-3" />
                    <p className="text-muted-foreground">No organizations found</p>
                  </div>
                )}
              </div>
            </CardContent>
            <div className="border-t border-border p-4">
              <Button
                variant="outline"
                className="w-full border-border text-foreground hover:bg-accent"
                onClick={() => setShowManageOrgsModal(false)}
              >
                Close
              </Button>
            </div>
          </Card>
        </div>
      )}

      {/* Add Organization Modal */}
      {showAddOrgModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-60">
          <Card className="bg-accent border-border w-full max-w-md mx-4">
            <CardHeader>
              <CardTitle className="text-foreground">Add Organization</CardTitle>
              <CardDescription className="text-muted-foreground">
                Create a new organization
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div>
                <Label htmlFor="newOrgName" className="text-foreground text-sm font-medium mb-2 block">
                  Organization Name
                </Label>
                <Input
                  id="newOrgName"
                  type="text"
                  placeholder="e.g., Engineering, Sales, Marketing"
                  value={newOrgName}
                  onChange={(e) => setNewOrgName(e.target.value)}
                  className="bg-card border-border text-foreground"
                  disabled={creatingOrg}
                />
              </div>
              <div>
                <Label htmlFor="newOrgDescription" className="text-foreground text-sm font-medium mb-2 block">
                  Description (Optional)
                </Label>
                <Input
                  id="newOrgDescription"
                  type="text"
                  placeholder="Brief description of the organization"
                  value={newOrgDescription}
                  onChange={(e) => setNewOrgDescription(e.target.value)}
                  className="bg-card border-border text-foreground"
                  disabled={creatingOrg}
                />
              </div>
              <div className="flex gap-2 pt-4">
                <Button
                  className="flex-1 bg-primary text-primary-foreground hover:bg-primary/90"
                  onClick={handleAddOrganization}
                  disabled={creatingOrg}
                >
                  {creatingOrg ? 'Creating...' : 'Create Organization'}
                </Button>
                <Button
                  variant="outline"
                  className="flex-1 border-border text-foreground hover:bg-accent"
                  onClick={() => {
                    setShowAddOrgModal(false);
                    setNewOrgName('');
                    setNewOrgDescription('');
                    setError(null);
                  }}
                  disabled={creatingOrg}
                >
                  Cancel
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </PageContainer>
  );
}
