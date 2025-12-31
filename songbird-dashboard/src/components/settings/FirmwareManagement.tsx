/**
 * Firmware Management Component
 *
 * Admin-only component for managing host firmware updates.
 */

import { useState } from 'react';
import {
  HardDrive,
  RefreshCw,
  Upload,
  XCircle,
  CheckCircle,
  Clock,
  Loader2,
  AlertCircle,
  Package,
} from 'lucide-react';
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
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useHostFirmware, useDfuStatus, useCancelFirmwareUpdate } from '@/hooks/useFirmware';
import { FirmwareUpdateDialog } from './FirmwareUpdateDialog';
import { formatRelativeTime } from '@/utils/formatters';
import type { HostFirmware, DeviceDfuStatus } from '@/types';

function normalizeStatus(status: unknown): string {
  if (typeof status === 'string') return status.toLowerCase();
  if (status != null) return String(status).toLowerCase();
  return '';
}

function getStatusBadge(status?: unknown) {
  const normalized = normalizeStatus(status);
  switch (normalized) {
    case 'completed':
    case 'done':
      return <Badge className="bg-green-100 text-green-800">Completed</Badge>;
    case 'in_progress':
    case 'downloading':
      return <Badge className="bg-blue-100 text-blue-800">In Progress</Badge>;
    case 'pending':
    case 'queued':
      return <Badge className="bg-yellow-100 text-yellow-800">Pending</Badge>;
    case 'failed':
    case 'error':
      return <Badge variant="destructive">Failed</Badge>;
    case 'cancelled':
      return <Badge variant="secondary">Cancelled</Badge>;
    default:
      return <Badge variant="secondary">{normalized || 'Unknown'}</Badge>;
  }
}

function getStatusIcon(status?: unknown) {
  const normalized = normalizeStatus(status);
  switch (normalized) {
    case 'completed':
    case 'done':
      return <CheckCircle className="h-4 w-4 text-green-500" />;
    case 'in_progress':
    case 'downloading':
      return <Loader2 className="h-4 w-4 text-blue-500 animate-spin" />;
    case 'pending':
    case 'queued':
      return <Clock className="h-4 w-4 text-yellow-500" />;
    case 'failed':
    case 'error':
      return <XCircle className="h-4 w-4 text-red-500" />;
    default:
      return <AlertCircle className="h-4 w-4 text-gray-500" />;
  }
}

function safeFormatRelativeTime(dateStr?: string): string {
  if (!dateStr) return '-';
  try {
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) return '-';
    return formatRelativeTime(dateStr);
  } catch {
    return '-';
  }
}

function extractVersion(version: unknown): string {
  if (!version) return '-';
  if (typeof version === 'string') return version;
  if (typeof version === 'object' && version !== null) {
    // Notehub returns version as object with {version, organization, ...}
    const versionObj = version as Record<string, unknown>;
    if (typeof versionObj.version === 'string') return versionObj.version;
  }
  return '-';
}

function isStatusCancellable(status?: unknown): boolean {
  const normalized = normalizeStatus(status);
  return normalized === 'pending' || normalized === 'queued' ||
         normalized === 'in_progress' || normalized === 'downloading';
}

export function FirmwareManagement() {
  const [selectedFirmware, setSelectedFirmware] = useState<HostFirmware | null>(null);
  const [updateDialogOpen, setUpdateDialogOpen] = useState(false);
  const [cancelDialogOpen, setCancelDialogOpen] = useState(false);
  const [deviceToCancel, setDeviceToCancel] = useState<{ uid: string; name: string } | null>(null);

  const {
    data: firmware,
    isLoading: loadingFirmware,
    error: firmwareError,
    refetch: refetchFirmware,
    isFetching: fetchingFirmware,
  } = useHostFirmware();

  const {
    data: dfuStatus,
    isLoading: loadingStatus,
    refetch: refetchStatus,
    isFetching: fetchingStatus,
  } = useDfuStatus();

  const cancelUpdate = useCancelFirmwareUpdate();

  const handleDeploy = (fw: HostFirmware) => {
    setSelectedFirmware(fw);
    setUpdateDialogOpen(true);
  };

  const handleCancelUpdate = async () => {
    try {
      await cancelUpdate.mutateAsync({});
      setCancelDialogOpen(false);
    } catch (error) {
      console.error('Failed to cancel update:', error);
    }
  };

  const handleCancelDeviceUpdate = async () => {
    if (!deviceToCancel) return;
    try {
      await cancelUpdate.mutateAsync({ deviceUID: deviceToCancel.uid });
      setDeviceToCancel(null);
    } catch (error) {
      console.error('Failed to cancel device update:', error);
    }
  };

  // Count devices in each status
  const statusCounts = (dfuStatus?.devices || []).reduce(
    (acc, device) => {
      const status = normalizeStatus(device.status);
      if (status === 'completed' || status === 'done') {
        acc.completed++;
      } else if (status === 'in_progress' || status === 'downloading') {
        acc.inProgress++;
      } else if (status === 'pending' || status === 'queued') {
        acc.pending++;
      } else if (status === 'failed' || status === 'error') {
        acc.failed++;
      }
      return acc;
    },
    { pending: 0, inProgress: 0, completed: 0, failed: 0 }
  );

  const hasActiveUpdates = statusCounts.pending > 0 || statusCounts.inProgress > 0;

  if (loadingFirmware && loadingStatus) {
    return (
      <Card>
        <CardContent className="py-8">
          <div className="flex items-center justify-center gap-2 text-muted-foreground">
            <RefreshCw className="h-4 w-4 animate-spin" />
            Loading firmware information...
          </div>
        </CardContent>
      </Card>
    );
  }

  if (firmwareError) {
    return (
      <Card>
        <CardContent className="py-8">
          <div className="text-center">
            <XCircle className="h-12 w-12 text-red-500 mx-auto mb-4" />
            <h3 className="font-semibold">Unable to load firmware</h3>
            <p className="text-sm text-muted-foreground mt-1">
              {firmwareError instanceof Error ? firmwareError.message : 'Failed to load firmware list'}
            </p>
            <Button onClick={() => refetchFirmware()} variant="outline" className="mt-4">
              <RefreshCw className="h-4 w-4 mr-2" />
              Retry
            </Button>
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
              <HardDrive className="h-6 w-6 text-purple-500" />
              <div>
                <CardTitle>Host Firmware Management</CardTitle>
                <CardDescription>
                  Deploy host firmware updates to devices
                </CardDescription>
              </div>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                refetchFirmware();
                refetchStatus();
              }}
              disabled={fetchingFirmware || fetchingStatus}
            >
              <RefreshCw className={`h-4 w-4 ${fetchingFirmware || fetchingStatus ? 'animate-spin' : ''}`} />
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="flex items-center gap-3 p-4 rounded-lg bg-muted/50">
              <Package className="h-5 w-5 text-purple-500" />
              <div>
                <div className="text-sm font-medium">Available</div>
                <div className="text-2xl font-bold">{firmware?.length || 0}</div>
              </div>
            </div>
            <div className="flex items-center gap-3 p-4 rounded-lg bg-muted/50">
              <Clock className="h-5 w-5 text-yellow-500" />
              <div>
                <div className="text-sm font-medium">Pending</div>
                <div className="text-2xl font-bold">{statusCounts.pending}</div>
              </div>
            </div>
            <div className="flex items-center gap-3 p-4 rounded-lg bg-muted/50">
              <Loader2 className={`h-5 w-5 text-blue-500 ${statusCounts.inProgress > 0 ? 'animate-spin' : ''}`} />
              <div>
                <div className="text-sm font-medium">In Progress</div>
                <div className="text-2xl font-bold">{statusCounts.inProgress}</div>
              </div>
            </div>
            <div className="flex items-center gap-3 p-4 rounded-lg bg-muted/50">
              <CheckCircle className="h-5 w-5 text-green-500" />
              <div>
                <div className="text-sm font-medium">Completed</div>
                <div className="text-2xl font-bold">{statusCounts.completed}</div>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Available Firmware */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <Package className="h-5 w-5" />
            Available Firmware
          </CardTitle>
          <CardDescription>
            Host firmware versions available for deployment
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!firmware || firmware.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <Package className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <p>No host firmware available</p>
              <p className="text-sm mt-1">
                Upload firmware to Notehub to make it available for deployment
              </p>
            </div>
          ) : (
            <div className="border rounded-lg">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Filename</TableHead>
                    <TableHead>Uploaded</TableHead>
                    <TableHead className="text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {[...firmware]
                    .sort((a, b) => {
                      // Sort by created date, newest first
                      const dateA = a.created ? new Date(a.created).getTime() : 0;
                      const dateB = b.created ? new Date(b.created).getTime() : 0;
                      return dateB - dateA;
                    })
                    .map((fw) => (
                      <TableRow key={fw.filename}>
                        <TableCell className="font-mono text-sm">{fw.filename}</TableCell>
                        <TableCell>{safeFormatRelativeTime(fw.created)}</TableCell>
                        <TableCell className="text-right">
                          <Button
                            size="sm"
                            onClick={() => handleDeploy(fw)}
                          >
                            <Upload className="h-4 w-4 mr-1" />
                            Deploy
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Active Updates */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-lg flex items-center gap-2">
                {hasActiveUpdates ? (
                  <Loader2 className="h-5 w-5 animate-spin text-blue-500" />
                ) : (
                  <CheckCircle className="h-5 w-5 text-green-500" />
                )}
                Update Status
              </CardTitle>
              <CardDescription>
                Current firmware update progress across devices
              </CardDescription>
            </div>
            {hasActiveUpdates && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setCancelDialogOpen(true)}
              >
                <XCircle className="h-4 w-4 mr-1" />
                Cancel Updates
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {!dfuStatus?.devices || dfuStatus.devices.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <CheckCircle className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <p>No active firmware updates</p>
              <p className="text-sm mt-1">
                Deploy firmware to devices using the table above
              </p>
            </div>
          ) : (
            <div className="border rounded-lg">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Device</TableHead>
                    <TableHead>Current Version</TableHead>
                    <TableHead>Target Version</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Last Update</TableHead>
                    <TableHead className="text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {dfuStatus.devices.map((device: DeviceDfuStatus) => {
                    const latestUpdate = device.updates?.[device.updates.length - 1];
                    const deviceName = device.serial_number || device.device_uid;
                    const canCancel = isStatusCancellable(device.status);
                    return (
                      <TableRow key={device.device_uid}>
                        <TableCell className="font-medium">
                          {deviceName}
                        </TableCell>
                        <TableCell className="font-mono text-sm">
                          {extractVersion(device.current_version)}
                        </TableCell>
                        <TableCell className="font-mono text-sm">
                          {extractVersion(device.requested_version)}
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            {getStatusIcon(device.status)}
                            {getStatusBadge(device.status)}
                          </div>
                        </TableCell>
                        <TableCell className="text-muted-foreground text-sm">
                          {latestUpdate ? safeFormatRelativeTime(latestUpdate.when) : '-'}
                        </TableCell>
                        <TableCell className="text-right">
                          {canCancel && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setDeviceToCancel({ uid: device.device_uid, name: deviceName })}
                            >
                              <XCircle className="h-4 w-4" />
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Firmware Update Dialog */}
      <FirmwareUpdateDialog
        open={updateDialogOpen}
        onOpenChange={setUpdateDialogOpen}
        firmware={selectedFirmware}
      />

      {/* Cancel All Confirmation Dialog */}
      <AlertDialog open={cancelDialogOpen} onOpenChange={setCancelDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel All Firmware Updates?</AlertDialogTitle>
            <AlertDialogDescription>
              This will cancel all pending and in-progress firmware updates.
              Devices that have already started downloading may complete their update.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep Updates</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleCancelUpdate}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {cancelUpdate.isPending ? 'Cancelling...' : 'Cancel Updates'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Cancel Device Update Confirmation Dialog */}
      <AlertDialog open={!!deviceToCancel} onOpenChange={(open) => !open && setDeviceToCancel(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel Firmware Update?</AlertDialogTitle>
            <AlertDialogDescription>
              This will cancel the pending firmware update for{' '}
              <span className="font-semibold">{deviceToCancel?.name}</span>.
              If the device has already started downloading, it may complete its update.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep Update</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleCancelDeviceUpdate}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {cancelUpdate.isPending ? 'Cancelling...' : 'Cancel Update'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
