import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, Settings, Thermometer, Droplets, Gauge, Battery } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { DeviceStatus } from '@/components/devices/DeviceStatus';
import { LocationTrail } from '@/components/maps/LocationTrail';
import { TelemetryChart } from '@/components/charts/TelemetryChart';
import { GaugeCard } from '@/components/charts/GaugeCard';
import { CommandPanel } from '@/components/commands/CommandPanel';
import { ConfigPanel } from '@/components/config/ConfigPanel';
import { useDevice } from '@/hooks/useDevices';
import { useTelemetry, useLocationHistory } from '@/hooks/useTelemetry';
import { useCommands } from '@/hooks/useCommands';
import {
  formatTemperature,
  formatHumidity,
  formatPressure,
  formatBattery,
  formatMode,
  formatRelativeTime,
  truncateDeviceUid,
} from '@/utils/formatters';

interface DeviceDetailProps {
  mapboxToken: string;
}

export function DeviceDetail({ mapboxToken }: DeviceDetailProps) {
  const { deviceUid } = useParams<{ deviceUid: string }>();
  const [showConfig, setShowConfig] = useState(false);
  const [timeRange, setTimeRange] = useState(24);

  const { data: device, isLoading: deviceLoading } = useDevice(deviceUid!);
  const { data: telemetryData, isLoading: telemetryLoading } = useTelemetry(
    deviceUid!,
    timeRange
  );
  const { data: locationData } = useLocationHistory(deviceUid!, timeRange);
  const { data: commandsData } = useCommands(deviceUid!);

  const telemetry = telemetryData?.telemetry || [];
  const locations = locationData?.locations || [];
  const lastCommand = commandsData?.commands?.[0];

  // Get latest values and sparkline data
  const latestTelemetry = telemetry[0];
  const sparklineTemp = telemetry.slice(0, 20).map((t) => t.temperature || 0);
  const sparklineHumidity = telemetry.slice(0, 20).map((t) => t.humidity || 0);

  const battery = formatBattery(device?.voltage);

  if (deviceLoading || !device) {
    return (
      <div className="flex items-center justify-center h-96">
        <div className="text-muted-foreground">Loading device...</div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Link to="/">
              <Button variant="ghost" size="icon">
                <ArrowLeft className="h-4 w-4" />
              </Button>
            </Link>
            <h1 className="text-2xl font-bold">
              {device.name || device.serial_number || truncateDeviceUid(device.device_uid)}
            </h1>
            <DeviceStatus status={device.status} />
          </div>
          <p className="text-muted-foreground">
            {device.fleet_name && `Fleet: ${device.fleet_name} • `}
            {device.assigned_to && `Assigned: ${device.assigned_to} • `}
            <Badge variant="secondary">{formatMode(device.mode)}</Badge>
            {device.last_seen && ` • Last seen: ${formatRelativeTime(device.last_seen)}`}
          </p>
        </div>

        <Button
          variant="outline"
          onClick={() => setShowConfig(!showConfig)}
        >
          <Settings className="h-4 w-4 mr-2" />
          Config
        </Button>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Main Content */}
        <div className={showConfig ? 'lg:col-span-2' : 'lg:col-span-3'}>
          {/* Location Map */}
          <Card className="mb-6">
            <CardHeader>
              <CardTitle>Location Trail ({timeRange}h)</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <LocationTrail
                locations={locations}
                mapboxToken={mapboxToken}
                className="h-[300px] rounded-b-lg overflow-hidden"
              />
            </CardContent>
          </Card>

          {/* Current Readings */}
          <div className="grid gap-4 md:grid-cols-4 mb-6">
            <GaugeCard
              title="Temperature"
              value={latestTelemetry?.temperature?.toFixed(1) || '--'}
              unit="°C"
              icon={<Thermometer className="h-4 w-4 text-orange-500" />}
              sparklineData={sparklineTemp}
              status={
                latestTelemetry?.temperature && latestTelemetry.temperature > 35
                  ? 'warning'
                  : 'normal'
              }
            />
            <GaugeCard
              title="Humidity"
              value={latestTelemetry?.humidity?.toFixed(1) || '--'}
              unit="%"
              icon={<Droplets className="h-4 w-4 text-blue-500" />}
              sparklineData={sparklineHumidity}
            />
            <GaugeCard
              title="Pressure"
              value={latestTelemetry?.pressure?.toFixed(0) || '--'}
              unit="hPa"
              icon={<Gauge className="h-4 w-4 text-purple-500" />}
            />
            <GaugeCard
              title="Battery"
              value={battery.percentage}
              unit="%"
              icon={
                <Battery
                  className={`h-4 w-4 ${
                    battery.level === 'critical'
                      ? 'text-red-500'
                      : battery.level === 'low'
                      ? 'text-yellow-500'
                      : 'text-green-500'
                  }`}
                />
              }
              status={
                battery.level === 'critical'
                  ? 'critical'
                  : battery.level === 'low'
                  ? 'warning'
                  : 'normal'
              }
            />
          </div>

          {/* Historical Charts */}
          <Card className="mb-6">
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle>Historical Data</CardTitle>
              <Tabs value={String(timeRange)} onValueChange={(v) => setTimeRange(Number(v))}>
                <TabsList>
                  <TabsTrigger value="24">24h</TabsTrigger>
                  <TabsTrigger value="168">7d</TabsTrigger>
                  <TabsTrigger value="720">30d</TabsTrigger>
                </TabsList>
              </Tabs>
            </CardHeader>
            <CardContent>
              {telemetryLoading ? (
                <div className="h-[300px] flex items-center justify-center">
                  <span className="text-muted-foreground">Loading chart...</span>
                </div>
              ) : telemetry.length > 0 ? (
                <TelemetryChart
                  data={telemetry}
                  showTemperature
                  showHumidity
                  height={300}
                />
              ) : (
                <div className="h-[300px] flex items-center justify-center">
                  <span className="text-muted-foreground">No data available</span>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Command Panel */}
          <CommandPanel
            deviceUid={device.device_uid}
            audioEnabled={device.audio_enabled !== false}
            lastCommand={lastCommand}
          />

          {/* Device Info */}
          <Card className="mt-6">
            <CardHeader>
              <CardTitle>Device Information</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <dt className="text-muted-foreground">Device UID</dt>
                  <dd className="font-mono">{device.device_uid}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Serial Number</dt>
                  <dd>{device.serial_number || '--'}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Firmware</dt>
                  <dd>{device.firmware_version || '--'}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Notecard</dt>
                  <dd>{device.notecard_version || '--'}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Battery</dt>
                  <dd>{battery.voltage} ({battery.percentage}%)</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Audio</dt>
                  <dd>
                    {device.audio_enabled !== false ? 'Enabled' : 'Disabled'}
                    {device.audio_enabled && device.audio_volume && ` (${device.audio_volume}%)`}
                  </dd>
                </div>
              </dl>
            </CardContent>
          </Card>
        </div>

        {/* Config Panel */}
        {showConfig && (
          <div className="lg:col-span-1">
            <ConfigPanel
              deviceUid={device.device_uid}
              onClose={() => setShowConfig(false)}
            />
          </div>
        )}
      </div>
    </div>
  );
}
