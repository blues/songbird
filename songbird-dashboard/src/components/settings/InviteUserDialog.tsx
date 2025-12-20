/**
 * Invite User Dialog Component
 *
 * Dialog for inviting new users with email, name, group, and optional device assignment.
 * Each user can only have one device assigned.
 */

import { useState } from 'react';
import { UserPlus } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useInviteUser, useUnassignedDevices } from '@/hooks/useUsers';
import type { UserGroup } from '@/types';

interface InviteUserDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const GROUPS: { value: UserGroup; label: string; description: string }[] = [
  { value: 'Admin', label: 'Admin', description: 'Full access to all features' },
  { value: 'Sales', label: 'Sales', description: 'Sales team member' },
  { value: 'FieldEngineering', label: 'Field Engineering', description: 'Field operations access' },
  { value: 'Viewer', label: 'Viewer', description: 'Read-only access' },
];

export function InviteUserDialog({ open, onOpenChange }: InviteUserDialogProps) {
  const inviteUser = useInviteUser();
  const { data: unassignedDevices, isLoading: loadingDevices } = useUnassignedDevices();

  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [group, setGroup] = useState<UserGroup>('Viewer');
  const [selectedDevice, setSelectedDevice] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!email || !name || !group) {
      setError('Please fill in all required fields');
      return;
    }

    try {
      await inviteUser.mutateAsync({
        email,
        name,
        group,
        device_uids: selectedDevice ? [selectedDevice] : undefined,
      });
      // Reset form and close dialog on success
      setEmail('');
      setName('');
      setGroup('Viewer');
      setSelectedDevice('');
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to invite user');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserPlus className="h-5 w-5" />
            Invite New User
          </DialogTitle>
          <DialogDescription>
            Send an invitation email to add a new user to the platform.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Email */}
          <div className="space-y-2">
            <Label htmlFor="email">Email *</Label>
            <Input
              id="email"
              type="email"
              placeholder="user@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>

          {/* Name */}
          <div className="space-y-2">
            <Label htmlFor="name">Full Name *</Label>
            <Input
              id="name"
              type="text"
              placeholder="John Doe"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </div>

          {/* Group */}
          <div className="space-y-2">
            <Label htmlFor="group">Role *</Label>
            <Select value={group} onValueChange={(v) => setGroup(v as UserGroup)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {GROUPS.map(g => (
                  <SelectItem key={g.value} value={g.value}>
                    <div className="flex flex-col">
                      <span>{g.label}</span>
                      <span className="text-xs text-muted-foreground">{g.description}</span>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Device Assignment */}
          <div className="space-y-2">
            <Label>Assign Device (optional)</Label>
            <p className="text-sm text-muted-foreground">
              Each user can only have one device assigned
            </p>
            <Select
              value={selectedDevice || 'none'}
              onValueChange={(v) => setSelectedDevice(v === 'none' ? '' : v)}
              disabled={loadingDevices}
            >
              <SelectTrigger>
                <SelectValue placeholder={loadingDevices ? 'Loading devices...' : 'Select a device...'} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">None</SelectItem>
                {(unassignedDevices || []).map(device => (
                  <SelectItem key={device.device_uid} value={device.device_uid}>
                    {device.name || device.serial_number}
                  </SelectItem>
                ))}
                {unassignedDevices?.length === 0 && (
                  <div className="p-2 text-sm text-muted-foreground text-center">
                    No unassigned devices available
                  </div>
                )}
              </SelectContent>
            </Select>
          </div>

          {/* Error */}
          {error && (
            <div className="text-sm text-destructive">{error}</div>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={inviteUser.isPending}>
              {inviteUser.isPending ? 'Sending...' : 'Send Invitation'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
