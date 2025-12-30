/**
 * Dialog for merging two devices (Admin only)
 */

import { useState } from 'react';
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
import { Label } from '@/components/ui/label';
import { AlertTriangle, Merge } from 'lucide-react';
import { useMergeDevices } from '@/hooks/useDevices';
import { formatRelativeTime } from '@/utils/formatters';
import type { Device } from '@/types';

interface MergeDevicesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  devices: Device[];
  preselectedSource?: string;
}

export function MergeDevicesDialog({
  open,
  onOpenChange,
  devices,
  preselectedSource,
}: MergeDevicesDialogProps) {
  const [sourceSerial, setSourceSerial] = useState<string>(preselectedSource || '');
  const [targetSerial, setTargetSerial] = useState<string>('');
  const [confirmStep, setConfirmStep] = useState(false);
  const mergeMutation = useMergeDevices();

  const handleClose = () => {
    setSourceSerial(preselectedSource || '');
    setTargetSerial('');
    setConfirmStep(false);
    onOpenChange(false);
  };

  const handleMerge = async () => {
    if (!sourceSerial || !targetSerial) return;

    try {
      await mergeMutation.mutateAsync({
        sourceSerialNumber: sourceSerial,
        targetSerialNumber: targetSerial,
      });
      handleClose();
    } catch (error) {
      console.error('Failed to merge devices:', error);
    }
  };

  const sourceDevice = devices.find(d => d.serial_number === sourceSerial);
  const targetDevice = devices.find(d => d.serial_number === targetSerial);

  // Filter out selected devices from opposite dropdown
  const availableTargets = devices.filter(d => d.serial_number !== sourceSerial);
  const availableSources = devices.filter(d => d.serial_number !== targetSerial);

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Merge className="h-5 w-5" />
            Merge Devices
          </DialogTitle>
          <DialogDescription>
            Merge two devices into one. The source device will be deleted and its
            history will be merged into the target device.
          </DialogDescription>
        </DialogHeader>

        {!confirmStep ? (
          <>
            <div className="grid gap-4 py-4">
              <div className="grid gap-2">
                <Label htmlFor="source">Source Device (will be deleted)</Label>
                <Select value={sourceSerial} onValueChange={setSourceSerial}>
                  <SelectTrigger id="source" className="h-14">
                    <SelectValue placeholder="Select source device" />
                  </SelectTrigger>
                  <SelectContent>
                    {availableSources.map((device) => (
                      <SelectItem
                        key={device.serial_number}
                        value={device.serial_number || device.device_uid}
                        className="py-2"
                      >
                        <div className="flex flex-col">
                          <span>{device.name || device.serial_number || device.device_uid}</span>
                          <span className="text-xs text-muted-foreground">
                            Last seen: {device.last_seen ? formatRelativeTime(device.last_seen) : 'Never'}
                          </span>
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {sourceDevice && (
                  <p className="text-xs text-muted-foreground">
                    UID: {sourceDevice.device_uid}
                  </p>
                )}
              </div>

              <div className="grid gap-2">
                <Label htmlFor="target">Target Device (will keep history)</Label>
                <Select value={targetSerial} onValueChange={setTargetSerial}>
                  <SelectTrigger id="target" className="h-14">
                    <SelectValue placeholder="Select target device" />
                  </SelectTrigger>
                  <SelectContent>
                    {availableTargets.map((device) => (
                      <SelectItem
                        key={device.serial_number}
                        value={device.serial_number || device.device_uid}
                        className="py-2"
                      >
                        <div className="flex flex-col">
                          <span>{device.name || device.serial_number || device.device_uid}</span>
                          <span className="text-xs text-muted-foreground">
                            Last seen: {device.last_seen ? formatRelativeTime(device.last_seen) : 'Never'}
                          </span>
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {targetDevice && (
                  <p className="text-xs text-muted-foreground">
                    UID: {targetDevice.device_uid}
                  </p>
                )}
              </div>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={handleClose}>
                Cancel
              </Button>
              <Button
                onClick={() => setConfirmStep(true)}
                disabled={!sourceSerial || !targetSerial}
              >
                Continue
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <div className="py-4">
              <div className="flex items-start gap-3 p-4 bg-destructive/10 border border-destructive/20 rounded-lg">
                <AlertTriangle className="h-5 w-5 text-destructive mt-0.5" />
                <div className="space-y-2">
                  <p className="font-medium text-destructive">
                    This action cannot be undone
                  </p>
                  <p className="text-sm text-muted-foreground">
                    The following device will be <strong>permanently deleted</strong>:
                  </p>
                  <div className="text-sm font-mono bg-muted p-2 rounded">
                    {sourceDevice?.name || sourceSerial}
                    <br />
                    <span className="text-muted-foreground">
                      Serial: {sourceSerial}
                    </span>
                    <br />
                    <span className="text-muted-foreground">
                      UID: {sourceDevice?.device_uid}
                    </span>
                    <br />
                    <span className="text-muted-foreground">
                      Last seen: {sourceDevice?.last_seen ? formatRelativeTime(sourceDevice.last_seen) : 'Never'}
                    </span>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Its data will be merged into:
                  </p>
                  <div className="text-sm font-mono bg-muted p-2 rounded">
                    {targetDevice?.name || targetSerial}
                    <br />
                    <span className="text-muted-foreground">
                      Serial: {targetSerial}
                    </span>
                    <br />
                    <span className="text-muted-foreground">
                      UID: {targetDevice?.device_uid}
                    </span>
                    <br />
                    <span className="text-muted-foreground">
                      Last seen: {targetDevice?.last_seen ? formatRelativeTime(targetDevice.last_seen) : 'Never'}
                    </span>
                  </div>
                </div>
              </div>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => setConfirmStep(false)}>
                Back
              </Button>
              <Button
                variant="destructive"
                onClick={handleMerge}
                disabled={mergeMutation.isPending}
              >
                {mergeMutation.isPending ? 'Merging...' : 'Confirm Merge'}
              </Button>
            </DialogFooter>

            {mergeMutation.isError && (
              <p className="text-sm text-destructive mt-2">
                Failed to merge devices: {(mergeMutation.error as Error).message}
              </p>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
