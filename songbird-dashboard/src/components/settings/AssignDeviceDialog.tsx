/**
 * Assign Device Dialog
 *
 * Dialog for assigning a device to a user. Each user can only have one device.
 */

import { useState, useEffect } from 'react';
import { Cpu, X } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useUpdateUserDevice, useUnassignedDevices } from '@/hooks/useUsers';

interface AssignDeviceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userId: string;
  userName: string;
  currentDeviceUid?: string;
  currentDeviceLabel?: string;
}

export function AssignDeviceDialog({
  open,
  onOpenChange,
  userId,
  userName,
  currentDeviceUid,
  currentDeviceLabel,
}: AssignDeviceDialogProps) {
  const [selectedDevice, setSelectedDevice] = useState<string>('');
  const { data: unassignedDevices, isLoading: loadingDevices } = useUnassignedDevices();
  const updateDevice = useUpdateUserDevice();

  // Reset selection when dialog opens
  useEffect(() => {
    if (open) {
      setSelectedDevice(currentDeviceUid || '');
    }
  }, [open, currentDeviceUid]);

  const handleSubmit = async () => {
    try {
      await updateDevice.mutateAsync({
        userId,
        deviceUid: selectedDevice || null,
      });
      onOpenChange(false);
    } catch (error) {
      console.error('Failed to assign device:', error);
    }
  };

  const handleRemove = async () => {
    try {
      await updateDevice.mutateAsync({
        userId,
        deviceUid: null,
      });
      onOpenChange(false);
    } catch (error) {
      console.error('Failed to remove device:', error);
    }
  };

  // Combine current device with unassigned devices for the dropdown
  const availableDevices = [
    ...(currentDeviceUid ? [{ device_uid: currentDeviceUid, serial_number: currentDeviceLabel || currentDeviceUid }] : []),
    ...(unassignedDevices || []),
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Cpu className="h-5 w-5" />
            Assign Device
          </DialogTitle>
          <DialogDescription>
            Assign a device to {userName}. Each user can only have one device assigned.
          </DialogDescription>
        </DialogHeader>

        <div className="py-4">
          {currentDeviceUid && (
            <div className="mb-4 p-3 bg-muted rounded-lg">
              <div className="text-sm text-muted-foreground mb-1">Currently assigned:</div>
              <div className="flex items-center justify-between">
                <div className="font-medium">{currentDeviceLabel || currentDeviceUid}</div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleRemove}
                  disabled={updateDevice.isPending}
                >
                  <X className="h-4 w-4 mr-1" />
                  Remove
                </Button>
              </div>
            </div>
          )}

          <div className="space-y-2">
            <label className="text-sm font-medium">
              {currentDeviceUid ? 'Change to:' : 'Select device:'}
            </label>
            <Select
              value={selectedDevice}
              onValueChange={setSelectedDevice}
              disabled={loadingDevices}
            >
              <SelectTrigger>
                <SelectValue placeholder={loadingDevices ? 'Loading devices...' : 'Select a device'} />
              </SelectTrigger>
              <SelectContent>
                {availableDevices.map((device) => (
                  <SelectItem key={device.device_uid} value={device.device_uid}>
                    {device.name || device.serial_number}
                  </SelectItem>
                ))}
                {availableDevices.length === 0 && !loadingDevices && (
                  <div className="p-2 text-sm text-muted-foreground text-center">
                    No devices available
                  </div>
                )}
              </SelectContent>
            </Select>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={!selectedDevice || selectedDevice === currentDeviceUid || updateDevice.isPending}
          >
            {updateDevice.isPending ? 'Saving...' : 'Assign Device'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
