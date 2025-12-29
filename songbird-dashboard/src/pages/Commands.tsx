import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Terminal,
  Send,
  Clock,
  CheckCircle,
  XCircle,
  Loader2,
  AlertCircle,
  Bell,
  MapPin,
  Music,
  Trash2,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useAllCommands, useSendPing, useSendLocate, useSendPlayMelody, useDeleteCommand } from '@/hooks/useCommands';
import { useDevices } from '@/hooks/useDevices';
import { formatRelativeTime } from '@/utils/formatters';
import type { Command, CommandStatus, CommandType, Device } from '@/types';

const commandTypeLabels: Record<CommandType, string> = {
  ping: 'Ping',
  locate: 'Locate',
  play_melody: 'Play Melody',
  test_audio: 'Test Audio',
  set_volume: 'Set Volume',
};

const commandTypeIcons: Record<CommandType, React.ReactNode> = {
  ping: <Bell className="h-4 w-4" />,
  locate: <MapPin className="h-4 w-4" />,
  play_melody: <Music className="h-4 w-4" />,
  test_audio: <Music className="h-4 w-4" />,
  set_volume: <Music className="h-4 w-4" />,
};

function StatusBadge({ status }: { status: CommandStatus }) {
  switch (status) {
    case 'ok':
      return (
        <Badge variant="default" className="bg-green-500">
          <CheckCircle className="h-3 w-3 mr-1" />
          OK
        </Badge>
      );
    case 'error':
      return (
        <Badge variant="destructive">
          <XCircle className="h-3 w-3 mr-1" />
          Error
        </Badge>
      );
    case 'queued':
      return (
        <Badge variant="secondary">
          <Clock className="h-3 w-3 mr-1" />
          Queued
        </Badge>
      );
    case 'sent':
      return (
        <Badge variant="outline" className="border-blue-500 text-blue-500">
          <Loader2 className="h-3 w-3 mr-1 animate-spin" />
          Sent
        </Badge>
      );
    case 'ignored':
      return (
        <Badge variant="outline">
          <AlertCircle className="h-3 w-3 mr-1" />
          Ignored
        </Badge>
      );
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}

interface CommandRowProps {
  command: Command;
  deviceName?: string;
  onDeviceClick: (deviceUid: string) => void;
  onDelete: (commandId: string, deviceUid: string) => void;
  isDeleting: boolean;
}

function CommandRow({ command, deviceName, onDeviceClick, onDelete, isDeleting }: CommandRowProps) {
  return (
    <TableRow>
      <TableCell>
        <div className="flex items-center gap-2">
          {commandTypeIcons[command.cmd]}
          <span className="font-medium">{commandTypeLabels[command.cmd] || command.cmd}</span>
        </div>
      </TableCell>
      <TableCell>
        <button
          onClick={() => onDeviceClick(command.device_uid)}
          className="text-blue-500 hover:underline"
        >
          {deviceName || command.device_uid.substring(0, 12)}...
        </button>
      </TableCell>
      <TableCell>
        <StatusBadge status={command.status} />
      </TableCell>
      <TableCell className="text-muted-foreground">
        {command.ack_message || '-'}
      </TableCell>
      <TableCell className="text-muted-foreground">
        {formatRelativeTime(
          typeof command.created_at === 'number'
            ? new Date(command.created_at)
            : command.created_at
        )}
      </TableCell>
      <TableCell>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => onDelete(command.command_id, command.device_uid)}
          disabled={isDeleting}
          className="h-8 w-8 text-muted-foreground hover:text-destructive"
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </TableCell>
    </TableRow>
  );
}

const melodies = [
  { value: 'connected', label: 'Connected' },
  { value: 'power_on', label: 'Power On' },
  { value: 'alert', label: 'Alert' },
  { value: 'ping', label: 'Ping' },
];

export function Commands() {
  const navigate = useNavigate();
  const [selectedDevice, setSelectedDevice] = useState<string>('all');
  const [commandType, setCommandType] = useState<CommandType>('ping');
  const [selectedMelody, setSelectedMelody] = useState('connected');
  const [targetDevice, setTargetDevice] = useState<string>('');

  const { data: devicesData } = useDevices();
  const { data: commandsData, isLoading, error } = useAllCommands(
    selectedDevice === 'all' ? undefined : selectedDevice
  );

  const pingMutation = useSendPing();
  const locateMutation = useSendLocate();
  const melodyMutation = useSendPlayMelody();
  const deleteMutation = useDeleteCommand();

  const devices = devicesData?.devices || [];
  const commands = commandsData?.commands || [];

  // Create maps for device names and serial numbers
  const deviceNameMap = new Map<string, string>();
  const deviceSerialMap = new Map<string, string>();
  devices.forEach((d: Device) => {
    deviceNameMap.set(d.device_uid, d.name || d.serial_number || d.device_uid);
    if (d.serial_number) {
      deviceSerialMap.set(d.device_uid, d.serial_number);
    }
  });

  const handleDeleteCommand = (commandId: string, deviceUid: string) => {
    const serialNumber = deviceSerialMap.get(deviceUid);
    if (serialNumber) {
      deleteMutation.mutate({ commandId, serialNumber });
    }
  };

  const handleDeviceClick = (deviceUid: string) => {
    const serialNumber = deviceSerialMap.get(deviceUid);
    if (serialNumber) {
      navigate(`/devices/${serialNumber}`);
    }
  };

  const isSending = pingMutation.isPending || locateMutation.isPending || melodyMutation.isPending;

  const handleSendCommand = async () => {
    if (!targetDevice || targetDevice === 'all') {
      // Send to all devices
      for (const device of devices) {
        await sendToDevice(device.device_uid);
      }
    } else {
      await sendToDevice(targetDevice);
    }
  };

  const sendToDevice = async (deviceUid: string) => {
    const serialNumber = deviceSerialMap.get(deviceUid);
    if (!serialNumber) {
      console.error('No serial number found for device:', deviceUid);
      return;
    }
    switch (commandType) {
      case 'ping':
        await pingMutation.mutateAsync(serialNumber);
        break;
      case 'locate':
        await locateMutation.mutateAsync({ serialNumber, durationSec: 30 });
        break;
      case 'play_melody':
        await melodyMutation.mutateAsync({ serialNumber, melody: selectedMelody });
        break;
    }
  };

  // Stats
  const okCount = commands.filter((c) => c.status === 'ok').length;
  const pendingCount = commands.filter((c) => c.status === 'queued' || c.status === 'sent').length;
  const errorCount = commands.filter((c) => c.status === 'error').length;

  if (error) {
    return (
      <div className="text-center py-12">
        <Terminal className="h-12 w-12 text-red-500 mx-auto mb-4" />
        <h2 className="text-xl font-semibold mb-2">Error Loading Commands</h2>
        <p className="text-muted-foreground">
          {error instanceof Error ? error.message : 'Failed to load commands'}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Commands</h1>
        <p className="text-muted-foreground">
          Send commands and view command history across all devices
        </p>
      </div>

      {/* Stats Cards */}
      <div className="grid gap-4 grid-cols-2 md:grid-cols-4">
        <Card>
          <CardContent className="pt-6">
            <div className="text-center">
              <div className="text-3xl font-bold">{commands.length}</div>
              <div className="text-sm text-muted-foreground">Total Commands</div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-center">
              <div className="text-3xl font-bold text-green-500">{okCount}</div>
              <div className="text-sm text-muted-foreground">Successful</div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-center">
              <div className="text-3xl font-bold text-yellow-500">{pendingCount}</div>
              <div className="text-sm text-muted-foreground">Pending</div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-center">
              <div className="text-3xl font-bold text-red-500">{errorCount}</div>
              <div className="text-sm text-muted-foreground">Failed</div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Send Command Panel */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Send className="h-5 w-5" />
            Send Command
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-4 items-end">
            <div className="space-y-2">
              <label className="text-sm font-medium">Target Device</label>
              <Select value={targetDevice} onValueChange={setTargetDevice}>
                <SelectTrigger className="w-[200px]">
                  <SelectValue placeholder="Select device" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Devices ({devices.length})</SelectItem>
                  {devices.map((device: Device) => (
                    <SelectItem key={device.device_uid} value={device.device_uid}>
                      {device.name || device.serial_number || device.device_uid.substring(0, 12)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">Command</label>
              <Select value={commandType} onValueChange={(v) => setCommandType(v as CommandType)}>
                <SelectTrigger className="w-[160px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ping">Ping</SelectItem>
                  <SelectItem value="locate">Locate</SelectItem>
                  <SelectItem value="play_melody">Play Melody</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {commandType === 'play_melody' && (
              <div className="space-y-2">
                <label className="text-sm font-medium">Melody</label>
                <Select value={selectedMelody} onValueChange={setSelectedMelody}>
                  <SelectTrigger className="w-[140px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {melodies.map((m) => (
                      <SelectItem key={m.value} value={m.value}>
                        {m.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <Button
              onClick={handleSendCommand}
              disabled={!targetDevice || isSending}
            >
              {isSending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Sending...
                </>
              ) : (
                <>
                  <Send className="h-4 w-4 mr-2" />
                  Send Command
                </>
              )}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Filters and Command History */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2">
              <Terminal className="h-5 w-5" />
              Command History
            </CardTitle>
            <Select value={selectedDevice} onValueChange={setSelectedDevice}>
              <SelectTrigger className="w-[200px]">
                <SelectValue placeholder="Filter by device" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Devices</SelectItem>
                {devices.map((device: Device) => (
                  <SelectItem key={device.device_uid} value={device.device_uid}>
                    {device.name || device.serial_number || device.device_uid.substring(0, 12)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-4">
              {[1, 2, 3, 4, 5].map((i) => (
                <div key={i} className="animate-pulse flex items-center gap-4">
                  <div className="h-4 bg-muted rounded w-24" />
                  <div className="h-4 bg-muted rounded w-32" />
                  <div className="h-4 bg-muted rounded w-16" />
                  <div className="h-4 bg-muted rounded w-20" />
                  <div className="h-4 bg-muted rounded w-24" />
                </div>
              ))}
            </div>
          ) : commands.length === 0 ? (
            <div className="text-center py-12">
              <Terminal className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
              <h3 className="text-lg font-semibold mb-2">No Commands Yet</h3>
              <p className="text-muted-foreground">
                Send a command to a device to see it appear here.
              </p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Command</TableHead>
                  <TableHead>Device</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Message</TableHead>
                  <TableHead>Time</TableHead>
                  <TableHead className="w-12"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {commands.map((command) => (
                  <CommandRow
                    key={command.command_id}
                    command={command}
                    deviceName={deviceNameMap.get(command.device_uid)}
                    onDeviceClick={handleDeviceClick}
                    onDelete={handleDeleteCommand}
                    isDeleting={deleteMutation.isPending}
                  />
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
