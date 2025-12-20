/**
 * Edit Groups Dialog
 *
 * Dialog for editing user group assignments.
 */

import { useState, useEffect } from 'react';
import { Shield } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { useUpdateUserGroups } from '@/hooks/useUsers';
import type { UserGroup } from '@/types';

interface EditGroupsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userId: string;
  userName: string;
  currentGroups: UserGroup[];
}

const GROUPS: { value: UserGroup; label: string; description: string }[] = [
  { value: 'Admin', label: 'Admin', description: 'Full access to all features' },
  { value: 'Sales', label: 'Sales', description: 'Sales team member' },
  { value: 'FieldEngineering', label: 'Field Engineering', description: 'Field operations access' },
  { value: 'Viewer', label: 'Viewer', description: 'Read-only access' },
];

export function EditGroupsDialog({
  open,
  onOpenChange,
  userId,
  userName,
  currentGroups,
}: EditGroupsDialogProps) {
  const [selectedGroups, setSelectedGroups] = useState<UserGroup[]>([]);
  const updateGroups = useUpdateUserGroups();

  // Reset selection when dialog opens
  useEffect(() => {
    if (open) {
      setSelectedGroups([...currentGroups]);
    }
  }, [open, currentGroups]);

  const handleToggleGroup = (group: UserGroup) => {
    setSelectedGroups((prev) =>
      prev.includes(group)
        ? prev.filter((g) => g !== group)
        : [...prev, group]
    );
  };

  const handleSubmit = async () => {
    try {
      await updateGroups.mutateAsync({
        userId,
        groups: selectedGroups,
      });
      onOpenChange(false);
    } catch (error) {
      console.error('Failed to update groups:', error);
    }
  };

  const hasChanges =
    selectedGroups.length !== currentGroups.length ||
    selectedGroups.some((g) => !currentGroups.includes(g));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Shield className="h-5 w-5" />
            Edit Groups
          </DialogTitle>
          <DialogDescription>
            Manage group memberships for {userName}.
          </DialogDescription>
        </DialogHeader>

        <div className="py-4 space-y-4">
          {GROUPS.map((group) => (
            <div key={group.value} className="flex items-center justify-between">
              <div className="grid gap-1">
                <Label
                  htmlFor={`group-${group.value}`}
                  className="cursor-pointer font-medium"
                >
                  {group.label}
                </Label>
                <p className="text-sm text-muted-foreground">
                  {group.description}
                </p>
              </div>
              <Switch
                id={`group-${group.value}`}
                checked={selectedGroups.includes(group.value)}
                onCheckedChange={() => handleToggleGroup(group.value)}
              />
            </div>
          ))}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={!hasChanges || updateGroups.isPending}
          >
            {updateGroups.isPending ? 'Saving...' : 'Save Changes'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
