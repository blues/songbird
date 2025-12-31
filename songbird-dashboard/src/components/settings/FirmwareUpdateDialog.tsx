/**
 * Firmware Update Dialog
 *
 * Dialog for selecting firmware update target and initiating deployment.
 */

import { useState, useEffect } from 'react';
import { HardDrive, AlertTriangle } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useNotehubFleets } from '@/hooks/useSettings';
import { useDevices } from '@/hooks/useDevices';
import { useQueueFirmwareUpdate } from '@/hooks/useFirmware';
import type { HostFirmware, FirmwareUpdateTarget } from '@/types';

interface FirmwareUpdateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  firmware: HostFirmware | null;
}

export function FirmwareUpdateDialog({
  open,
  onOpenChange,
  firmware,
}: FirmwareUpdateDialogProps) {
  const [target, setTarget] = useState<FirmwareUpdateTarget>('all');
  const [selectedFleet, setSelectedFleet] = useState<string>('');
  const [selectedDevice, setSelectedDevice] = useState<string>('');

  const { data: fleets, isLoading: loadingFleets } = useNotehubFleets();
  const { data: devicesData, isLoading: loadingDevices } = useDevices();
  const queueUpdate = useQueueFirmwareUpdate();

  const devices = devicesData?.devices || [];

  // Reset selections when dialog opens
  useEffect(() => {
    if (open) {
      setTarget('all');
      setSelectedFleet('');
      setSelectedDevice('');
    }
  }, [open]);

  const handleSubmit = async () => {
    if (!firmware) return;

    try {
      await queueUpdate.mutateAsync({
        filename: firmware.filename,
        fleetUID: target === 'fleet' ? selectedFleet : undefined,
        deviceUID: target === 'device' ? selectedDevice : undefined,
      });
      onOpenChange(false);
    } catch (error) {
      console.error('Failed to queue firmware update:', error);
    }
  };

  const getTargetCount = () => {
    if (target === 'all') return devices.length;
    if (target === 'fleet' && selectedFleet) {
      return devices.filter(d => d.fleet_uid === selectedFleet).length;
    }
    if (target === 'device') return 1;
    return 0;
  };

  const canSubmit = () => {
    if (!firmware) return false;
    if (target === 'fleet' && !selectedFleet) return false;
    if (target === 'device' && !selectedDevice) return false;
    return true;
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[450px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <HardDrive className="h-5 w-5" />
            Deploy Firmware
          </DialogTitle>
          <DialogDescription>
            Deploy <span className="font-mono font-medium">{firmware?.filename}</span> to devices.
          </DialogDescription>
        </DialogHeader>

        <div className="py-4 space-y-4">
          {/* Target Selection */}
          <div className="space-y-2">
            <Label>Deploy to</Label>
            <Select
              value={target}
              onValueChange={(value) => {
                setTarget(value as FirmwareUpdateTarget);
                setSelectedFleet('');
                setSelectedDevice('');
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Devices</SelectItem>
                <SelectItem value="fleet">Specific Fleet</SelectItem>
                <SelectItem value="device">Single Device</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Fleet Selection */}
          {target === 'fleet' && (
            <div className="space-y-2">
              <Label>Select Fleet</Label>
              <Select
                value={selectedFleet}
                onValueChange={setSelectedFleet}
                disabled={loadingFleets}
              >
                <SelectTrigger>
                  <SelectValue placeholder={loadingFleets ? 'Loading...' : 'Select a fleet'} />
                </SelectTrigger>
                <SelectContent>
                  {fleets?.map((fleet) => (
                    <SelectItem key={fleet.uid} value={fleet.uid}>
                      {fleet.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {/* Device Selection */}
          {target === 'device' && (
            <div className="space-y-2">
              <Label>Select Device</Label>
              <Select
                value={selectedDevice}
                onValueChange={setSelectedDevice}
                disabled={loadingDevices}
              >
                <SelectTrigger>
                  <SelectValue placeholder={loadingDevices ? 'Loading...' : 'Select a device'} />
                </SelectTrigger>
                <SelectContent>
                  {devices.map((device) => (
                    <SelectItem key={device.device_uid} value={device.device_uid}>
                      {device.name || device.serial_number}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {/* Warning */}
          {canSubmit() && (
            <div className="flex gap-3 p-3 rounded-lg bg-yellow-50 border border-yellow-200">
              <AlertTriangle className="h-5 w-5 text-yellow-600 flex-shrink-0 mt-0.5" />
              <p className="text-sm text-yellow-800">
                This will queue firmware updates for{' '}
                <span className="font-semibold">{getTargetCount()} device{getTargetCount() !== 1 ? 's' : ''}</span>.
                Devices will download and install the update on their next sync.
              </p>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={!canSubmit() || queueUpdate.isPending}
          >
            {queueUpdate.isPending ? 'Deploying...' : 'Deploy Firmware'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
