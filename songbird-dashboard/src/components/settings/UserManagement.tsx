/**
 * User Management Component
 *
 * Admin-only component for managing users and device assignments.
 */

import { useState } from 'react';
import { Users, UserPlus, Mail, Shield, Cpu, RefreshCw, Pencil } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useUsers } from '@/hooks/useUsers';
import { useDevices } from '@/hooks/useDevices';
import { InviteUserDialog } from './InviteUserDialog';
import { AssignDeviceDialog } from './AssignDeviceDialog';
import { EditGroupsDialog } from './EditGroupsDialog';
import { formatRelativeTime } from '@/utils/formatters';
import type { UserGroup, UserInfo } from '@/types';

const groupColors: Record<UserGroup, string> = {
  Admin: 'bg-red-100 text-red-800',
  Sales: 'bg-blue-100 text-blue-800',
  FieldEngineering: 'bg-green-100 text-green-800',
  Viewer: 'bg-gray-100 text-gray-800',
};

const statusColors: Record<string, string> = {
  CONFIRMED: 'bg-green-100 text-green-800',
  FORCE_CHANGE_PASSWORD: 'bg-yellow-100 text-yellow-800',
  UNCONFIRMED: 'bg-gray-100 text-gray-800',
};

export function UserManagement() {
  const { data: users, isLoading, refetch, isFetching } = useUsers(true);
  const { data: devicesData } = useDevices();
  const [inviteDialogOpen, setInviteDialogOpen] = useState(false);
  const [assignDeviceUser, setAssignDeviceUser] = useState<UserInfo | null>(null);
  const [editGroupsUser, setEditGroupsUser] = useState<UserInfo | null>(null);

  // Create a map of device_uid -> serial_number for quick lookup
  const deviceSerialMap = new Map(
    (devicesData?.devices || []).map(d => [d.device_uid, d.serial_number])
  );

  if (isLoading) {
    return (
      <Card>
        <CardContent className="py-8">
          <div className="flex items-center justify-center gap-2 text-muted-foreground">
            <RefreshCw className="h-4 w-4 animate-spin" />
            Loading users...
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Users className="h-6 w-6 text-blue-500" />
              <div>
                <CardTitle>User Management</CardTitle>
                <CardDescription>
                  Manage users, roles, and device assignments
                </CardDescription>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => refetch()}
                disabled={isFetching}
              >
                <RefreshCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
              </Button>
              <Button onClick={() => setInviteDialogOpen(true)}>
                <UserPlus className="h-4 w-4 mr-2" />
                Invite User
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="flex items-center gap-3 p-4 rounded-lg bg-muted/50">
              <Users className="h-5 w-5 text-blue-500" />
              <div>
                <div className="text-sm font-medium">Total Users</div>
                <div className="text-2xl font-bold">{users?.length || 0}</div>
              </div>
            </div>
            <div className="flex items-center gap-3 p-4 rounded-lg bg-muted/50">
              <Shield className="h-5 w-5 text-red-500" />
              <div>
                <div className="text-sm font-medium">Admins</div>
                <div className="text-2xl font-bold">
                  {users?.filter(u => u.groups.includes('Admin')).length || 0}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-3 p-4 rounded-lg bg-muted/50">
              <Mail className="h-5 w-5 text-yellow-500" />
              <div>
                <div className="text-sm font-medium">Pending</div>
                <div className="text-2xl font-bold">
                  {users?.filter(u => u.status === 'FORCE_CHANGE_PASSWORD').length || 0}
                </div>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Users Table */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">All Users</CardTitle>
        </CardHeader>
        <CardContent>
          {!users || users.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <Users className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <p>No users found</p>
              <p className="text-sm mt-1">Invite users to get started</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>User</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Groups</TableHead>
                  <TableHead>Device</TableHead>
                  <TableHead>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {users.map(user => (
                  <TableRow key={user.username}>
                    <TableCell>
                      <div>
                        <div className="font-medium">{user.name || user.email}</div>
                        <div className="text-sm text-muted-foreground">{user.email}</div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge className={statusColors[user.status] || 'bg-gray-100'}>
                        {user.status === 'FORCE_CHANGE_PASSWORD' ? 'Pending' : user.status}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-auto py-1 px-2 -ml-2"
                        onClick={() => setEditGroupsUser(user)}
                      >
                        <div className="flex flex-wrap items-center gap-1">
                          {user.groups.map(group => (
                            <Badge key={group} className={groupColors[group]}>
                              {group}
                            </Badge>
                          ))}
                          {user.groups.length === 0 && (
                            <span className="text-sm text-muted-foreground">No groups</span>
                          )}
                          <Pencil className="h-3 w-3 text-muted-foreground ml-1" />
                        </div>
                      </Button>
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-auto py-1 px-2 -ml-2"
                        onClick={() => setAssignDeviceUser(user)}
                      >
                        {user.assigned_devices && user.assigned_devices.length > 0 ? (
                          <div className="flex items-center gap-1">
                            <Cpu className="h-4 w-4 text-muted-foreground" />
                            <span className="text-xs">{deviceSerialMap.get(user.assigned_devices[0]) || user.assigned_devices[0].slice(-8)}</span>
                            <Pencil className="h-3 w-3 text-muted-foreground ml-1" />
                          </div>
                        ) : (
                          <div className="flex items-center gap-1 text-muted-foreground">
                            <span className="text-sm">Assign</span>
                            <Pencil className="h-3 w-3" />
                          </div>
                        )}
                      </Button>
                    </TableCell>
                    <TableCell>
                      <span className="text-sm text-muted-foreground">
                        {user.created_at ? formatRelativeTime(user.created_at) : '--'}
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Invite User Dialog */}
      <InviteUserDialog
        open={inviteDialogOpen}
        onOpenChange={setInviteDialogOpen}
      />

      {/* Assign Device Dialog */}
      {assignDeviceUser && (
        <AssignDeviceDialog
          open={!!assignDeviceUser}
          onOpenChange={(open) => !open && setAssignDeviceUser(null)}
          userId={assignDeviceUser.username}
          userName={assignDeviceUser.name || assignDeviceUser.email}
          currentDeviceUid={assignDeviceUser.assigned_devices?.[0]}
          currentDeviceLabel={assignDeviceUser.assigned_devices?.[0] ? deviceSerialMap.get(assignDeviceUser.assigned_devices[0]) : undefined}
        />
      )}

      {/* Edit Groups Dialog */}
      {editGroupsUser && (
        <EditGroupsDialog
          open={!!editGroupsUser}
          onOpenChange={(open) => !open && setEditGroupsUser(null)}
          userId={editGroupsUser.username}
          userName={editGroupsUser.name || editGroupsUser.email}
          currentGroups={editGroupsUser.groups}
        />
      )}
    </div>
  );
}
