import { useState } from 'react';
import { Bell, MapPin, Music, Volume2 } from 'lucide-react';
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
import { useSendPing, useSendLocate, useSendPlayMelody } from '@/hooks/useCommands';
import { formatRelativeTime } from '@/utils/formatters';
import type { Command } from '@/types';

interface CommandPanelProps {
  deviceUid: string;
  audioEnabled: boolean;
  lastCommand?: Command;
}

const melodies = [
  { value: 'connected', label: 'Connected' },
  { value: 'power_on', label: 'Power On' },
  { value: 'alert', label: 'Alert' },
  { value: 'low_battery', label: 'Low Battery' },
  { value: 'ping', label: 'Ping' },
];

export function CommandPanel({
  deviceUid,
  audioEnabled,
  lastCommand,
}: CommandPanelProps) {
  const [selectedMelody, setSelectedMelody] = useState('connected');
  const [locateDuration, setLocateDuration] = useState(30);

  const pingMutation = useSendPing();
  const locateMutation = useSendLocate();
  const melodyMutation = useSendPlayMelody();

  const isLoading =
    pingMutation.isPending ||
    locateMutation.isPending ||
    melodyMutation.isPending;

  const handlePing = () => {
    pingMutation.mutate(deviceUid);
  };

  const handleLocate = () => {
    locateMutation.mutate({ deviceUid, durationSec: locateDuration });
  };

  const handlePlayMelody = () => {
    melodyMutation.mutate({ deviceUid, melody: selectedMelody });
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
        <div className="grid grid-cols-2 gap-3">
          <Button
            onClick={handlePing}
            disabled={!audioEnabled || isLoading}
            variant="outline"
            className="h-auto py-4 flex-col gap-2"
          >
            <Bell className="h-5 w-5" />
            <span>Ping</span>
          </Button>

          <Button
            onClick={handleLocate}
            disabled={!audioEnabled || isLoading}
            variant="outline"
            className="h-auto py-4 flex-col gap-2"
          >
            <MapPin className="h-5 w-5" />
            <span>Locate</span>
          </Button>
        </div>

        {/* Locate Duration */}
        <div className="space-y-2">
          <label className="text-sm text-muted-foreground">
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
          <label className="text-sm text-muted-foreground">Play Melody</label>
          <div className="flex gap-2">
            <Select
              value={selectedMelody}
              onValueChange={setSelectedMelody}
              disabled={!audioEnabled}
            >
              <SelectTrigger className="flex-1">
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
            >
              <Music className="h-4 w-4" />
            </Button>
          </div>
        </div>

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
              {lastCommand.status === 'acknowledged' ? (
                <span className="text-green-500">✓ Acknowledged</span>
              ) : lastCommand.status === 'queued' ? (
                <span className="text-yellow-500">⏳ Queued</span>
              ) : (
                <span className="text-red-500">✗ Error</span>
              )}
              {' • '}
              {formatRelativeTime(lastCommand.created_at)}
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
