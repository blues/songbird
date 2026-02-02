import { useState } from 'react';
import { Bell, MapPin, Music, Volume2, Unlock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { useSendPing, useSendLocate, useSendPlayMelody, useSendUnlock } from '@/hooks/useCommands';
import { useCanUnlockDevice } from '@/hooks/useAuth';
import { formatRelativeTime } from '@/utils/formatters';
import type { Command } from '@/types';
import type { UnlockType } from '@/api/commands';

interface CommandPanelProps {
  serialNumber: string;
  audioEnabled: boolean;
  lastCommand?: Command;
  transitLocked?: boolean;
  demoLocked?: boolean;
  assignedTo?: string;
}

const melodies = [
  { value: 'connected', label: 'Connected' },
  { value: 'power_on', label: 'Power On' },
  { value: 'alert', label: 'Alert' },
  { value: 'low_battery', label: 'Low Battery' },
  { value: 'ping', label: 'Ping' },
];

export function CommandPanel({
  serialNumber,
  audioEnabled,
  lastCommand,
  transitLocked,
  demoLocked,
  assignedTo,
}: CommandPanelProps) {
  const [selectedMelody, setSelectedMelody] = useState('connected');
  const [locateDuration, setLocateDuration] = useState(30);
  const [unlockType, setUnlockType] = useState<UnlockType>('all');

  const pingMutation = useSendPing();
  const locateMutation = useSendLocate();
  const melodyMutation = useSendPlayMelody();
  const unlockMutation = useSendUnlock();
  const { canUnlock } = useCanUnlockDevice(assignedTo);

  const isLocked = transitLocked || demoLocked;

  const isLoading =
    pingMutation.isPending ||
    locateMutation.isPending ||
    melodyMutation.isPending ||
    unlockMutation.isPending;

  const handlePing = () => {
    pingMutation.mutate(serialNumber);
  };

  const handleLocate = () => {
    locateMutation.mutate({ serialNumber, durationSec: locateDuration });
  };

  const handlePlayMelody = () => {
    melodyMutation.mutate({ serialNumber, melody: selectedMelody });
  };

  const handleUnlock = () => {
    unlockMutation.mutate({ serialNumber, lockType: unlockType });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <span>📡</span>
          Command & Control
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Quick Commands */}
        <div className="grid grid-cols-2 gap-2 sm:gap-3">
          <Button
            onClick={handlePing}
            disabled={!audioEnabled || isLoading}
            variant="outline"
            className="h-auto py-3 sm:py-4 flex-col gap-1 sm:gap-2 px-2"
          >
            <Bell className="h-4 w-4 sm:h-5 sm:w-5" />
            <span className="text-xs sm:text-sm">Ping</span>
          </Button>

          <Button
            onClick={handleLocate}
            disabled={!audioEnabled || isLoading}
            variant="outline"
            className="h-auto py-3 sm:py-4 flex-col gap-1 sm:gap-2 px-2"
          >
            <MapPin className="h-4 w-4 sm:h-5 sm:w-5" />
            <span className="text-xs sm:text-sm">Locate</span>
          </Button>
        </div>

        {/* Locate Duration */}
        <div className="space-y-2">
          <label className="text-xs sm:text-sm text-muted-foreground">
            Locate Duration: {locateDuration}s
          </label>
          <Slider
            value={[locateDuration]}
            onValueChange={([value]) => setLocateDuration(value)}
            min={10}
            max={120}
            step={10}
            disabled={!audioEnabled}
          />
        </div>

        {/* Melody Selector */}
        <div className="space-y-2">
          <label className="text-xs sm:text-sm text-muted-foreground">Play Melody</label>
          <div className="flex gap-2">
            <Select
              value={selectedMelody}
              onValueChange={setSelectedMelody}
              disabled={!audioEnabled}
            >
              <SelectTrigger className="flex-1 min-w-0">
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
            <Button
              onClick={handlePlayMelody}
              disabled={!audioEnabled || isLoading}
              size="icon"
              className="flex-shrink-0"
            >
              <Music className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* Lock Override - Only visible when device is locked AND user has permission */}
        {isLocked && canUnlock && (
          <div className="space-y-2 pt-4 border-t">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">Device Lock Override</p>
                <p className="text-xs text-muted-foreground">
                  Currently locked:{' '}
                  {transitLocked && demoLocked
                    ? 'Transit & Demo'
                    : transitLocked
                    ? 'Transit'
                    : 'Demo'}
                </p>
              </div>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={isLoading}
                    className="text-orange-600 border-orange-600 hover:bg-orange-50"
                  >
                    <Unlock className="h-4 w-4 mr-2" />
                    Override Lock
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Override Device Lock</AlertDialogTitle>
                    <AlertDialogDescription>
                      This will remotely unlock the device, allowing mode changes.
                      The device will play a confirmation sound when unlocked.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <div className="py-4">
                    <label className="text-sm font-medium">Lock type to clear:</label>
                    <Select
                      value={unlockType}
                      onValueChange={(v) => setUnlockType(v as UnlockType)}
                    >
                      <SelectTrigger className="mt-2">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">Both locks</SelectItem>
                        <SelectItem value="transit">Transit lock only</SelectItem>
                        <SelectItem value="demo">Demo lock only</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={handleUnlock}
                      className="bg-orange-600 hover:bg-orange-700"
                    >
                      Confirm Unlock
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </div>
        )}

        {/* Audio Status */}
        {!audioEnabled && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground bg-muted p-3 rounded-md">
            <Volume2 className="h-4 w-4" />
            <span>Audio is disabled on this device</span>
          </div>
        )}

        {/* Last Command */}
        {lastCommand && (
          <div className="pt-4 border-t">
            <p className="text-sm text-muted-foreground">
              Last command:{' '}
              <span className="font-medium">{lastCommand.cmd}</span>
              {' • '}
              {lastCommand.status === 'ok' ? (
                <span className="text-green-500">✓ OK</span>
              ) : lastCommand.status === 'queued' ? (
                <span className="text-yellow-500">⏳ Queued</span>
              ) : lastCommand.status === 'ignored' ? (
                <span className="text-gray-500">⊘ Ignored</span>
              ) : lastCommand.status === 'error' ? (
                <span className="text-red-500">✗ Error</span>
              ) : (
                <span className="text-yellow-500">⏳ {lastCommand.status}</span>
              )}
              {' • '}
              {formatRelativeTime(
                typeof lastCommand.created_at === 'number'
                  ? new Date(lastCommand.created_at)
                  : lastCommand.created_at
              )}
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
