import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, Settings, Thermometer, Droplets, Gauge, Battery, BatteryFull, BatteryCharging, Zap, AlertTriangle, Check, Clock, Activity, MapPin, Satellite, Radio, Lock, Route, Navigation } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { DeviceStatus } from '@/components/devices/DeviceStatus';
import { LocationTrail } from '@/components/maps/LocationTrail';
import { TelemetryChart } from '@/components/charts/TelemetryChart';
import { PowerChart } from '@/components/charts/PowerChart';
import { GaugeCard } from '@/components/charts/GaugeCard';
import { CommandPanel } from '@/components/commands/CommandPanel';
import { ConfigPanel } from '@/components/config/ConfigPanel';
import { JourneyMap, JourneySelector, LocationHistoryTable } from '@/components/journeys';
import { useDevice } from '@/hooks/useDevices';
import { useTelemetry, useLocationHistory, usePowerHistory, useHealthHistory } from '@/hooks/useTelemetry';
import { useJourneys, useJourneyDetail, useLocationHistoryFull, useLatestJourney } from '@/hooks/useJourneys';
import { useCommands } from '@/hooks/useCommands';
import { useDeviceAlerts, useAcknowledgeAlert } from '@/hooks/useAlerts';
import { usePreferences } from '@/contexts/PreferencesContext';
import {
  formatBattery,
  formatMode,
  formatRelativeTime,
  truncateDeviceUid,
  convertTemperature,
  getTemperatureUnit,
} from '@/utils/formatters';
import type { Alert, HealthPoint, LocationSource } from '@/types';

const alertTypeLabels: Record<string, string> = {
  temp_high: 'High Temperature',
  temp_low: 'Low Temperature',
  humidity_high: 'High Humidity',
  humidity_low: 'Low Humidity',
  pressure_change: 'Pressure Change',
  low_battery: 'Low Battery',
  motion: 'Motion Detected',
};

const healthMethodLabels: Record<string, string> = {
  dfu: 'Firmware Update',
  boot: 'Device Boot',
  reboot: 'Device Reboot',
  reset: 'Device Reset',
  usb: 'USB Connected',
  battery: 'Battery Status',
  sync: 'Sync Event',
  connected: 'Connected',
  disconnected: 'Disconnected',
};

// Location source display configuration
function getLocationSourceInfo(source?: LocationSource | string) {
  switch (source) {
    case 'gps':
      return { label: 'GPS', icon: Satellite, color: 'text-green-600', bgColor: 'bg-green-100' };
    case 'cell':
    case 'tower':
      return { label: 'Cell Tower', icon: Radio, color: 'text-blue-600', bgColor: 'bg-blue-100' };
    case 'wifi':
      return { label: 'Wi-Fi', icon: Radio, color: 'text-purple-600', bgColor: 'bg-purple-100' };
    case 'triangulation':
    case 'triangulated': // Handle raw Notehub value
      return { label: 'Triangulated', icon: Radio, color: 'text-orange-600', bgColor: 'bg-orange-100' };
    default:
      return { label: 'Unknown', icon: MapPin, color: 'text-gray-600', bgColor: 'bg-gray-100' };
  }
}

interface DeviceDetailProps {
  mapboxToken: string;
}

export function DeviceDetail({ mapboxToken }: DeviceDetailProps) {
  const { deviceUid } = useParams<{ deviceUid: string }>();
  const { preferences } = usePreferences();
  const tempUnit = preferences.temp_unit === 'fahrenheit' ? 'F' : 'C';

  const [showConfig, setShowConfig] = useState(false);
  const [timeRange, setTimeRange] = useState<number | null>(null);
  const [chartTab, setChartTab] = useState('telemetry');
  const [locationTab, setLocationTab] = useState('current');
  const [selectedJourneyId, setSelectedJourneyId] = useState<number | null>(null);

  // Set default time range from preferences once loaded
  useEffect(() => {
    if (timeRange === null && preferences.default_time_range) {
      setTimeRange(Number(preferences.default_time_range));
    }
  }, [preferences.default_time_range, timeRange]);

  // Use 24h as fallback until preferences are loaded
  const effectiveTimeRange = timeRange ?? 24;

  const { data: device, isLoading: deviceLoading } = useDevice(deviceUid!);
  const { data: telemetryData, isLoading: telemetryLoading } = useTelemetry(
    deviceUid!,
    effectiveTimeRange
  );
  const { data: locationData } = useLocationHistory(deviceUid!, effectiveTimeRange);
  const { data: powerData, isLoading: powerLoading } = usePowerHistory(deviceUid!, effectiveTimeRange);
  const { data: healthData, isLoading: healthLoading } = useHealthHistory(deviceUid!, Math.max(effectiveTimeRange, 168)); // At least 7 days for health
  const { data: commandsData } = useCommands(deviceUid!);
  const { data: alertsData } = useDeviceAlerts(deviceUid!);
  const acknowledgeMutation = useAcknowledgeAlert();

  // Journey and location history hooks
  const { data: journeysData, isLoading: journeysLoading } = useJourneys(deviceUid!);
  const { data: journeyDetailData, isLoading: journeyDetailLoading } = useJourneyDetail(deviceUid!, selectedJourneyId);
  const { data: locationHistoryData, isLoading: locationHistoryLoading } = useLocationHistoryFull(deviceUid!, effectiveTimeRange);
  const { data: latestJourney } = useLatestJourney(deviceUid!);

  const telemetry = telemetryData?.telemetry || [];
  const alerts = alertsData?.alerts || [];
  const activeAlerts = alerts.filter((a: Alert) => a.acknowledged === 'false' || a.acknowledged === false);
  const locations = locationData?.locations || [];
  const power = powerData?.power || [];
  const health = healthData?.health || [];
  const lastCommand = commandsData?.commands?.[0];

  // Journey data
  const journeys = journeysData?.journeys || [];
  const journeyPoints = journeyDetailData?.points || [];
  const locationHistory = locationHistoryData?.locations || [];

  // Get latest values and sparkline data
  const latestTelemetry = telemetry[0];
  const sparklineTemp = telemetry.slice(0, 20).map((t) => convertTemperature(t.temperature, tempUnit) || 0);
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
            <h1 className="text-2xl font-bold flex items-center gap-2">
              {device.usb_powered ? (
                <span title="USB Powered"><BatteryCharging className="h-5 w-5 text-blue-500" /></span>
              ) : (
                <span title="Battery Powered"><BatteryFull className="h-5 w-5 text-green-500" /></span>
              )}
              {device.name || device.serial_number || truncateDeviceUid(device.device_uid)}
            </h1>
            <DeviceStatus status={device.status} />
            {activeAlerts.length > 0 && (
              <Badge variant="destructive" className="gap-1">
                <AlertTriangle className="h-3 w-3" />
                {activeAlerts.length} Alert{activeAlerts.length !== 1 ? 's' : ''}
              </Badge>
            )}
          </div>
          <p className="text-muted-foreground">
            {device.fleet_name && `Fleet: ${device.fleet_name} • `}
            {(device.assigned_to_name || device.assigned_to) && `Assigned: ${device.assigned_to_name || device.assigned_to} • `}
            <Badge
              variant={device.transit_locked || device.demo_locked ? "default" : "secondary"}
              className={
                device.transit_locked
                  ? "gap-1 bg-amber-500 hover:bg-amber-600"
                  : device.demo_locked
                  ? "gap-1 bg-green-500 hover:bg-green-600"
                  : ""
              }
            >
              {(device.transit_locked || device.demo_locked) && <Lock className="h-3 w-3" />}
              {formatMode(device.mode)}
            </Badge>
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
          {/* Location / Journeys Section */}
          <Card className="mb-6">
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle className="flex items-center gap-2">
                <MapPin className="h-5 w-5" />
                Location
              </CardTitle>
              <div className="flex items-center gap-2">
                <Tabs value={locationTab} onValueChange={setLocationTab}>
                  <TabsList>
                    <TabsTrigger value="current">
                      <MapPin className="h-3 w-3 mr-1" />
                      Current
                    </TabsTrigger>
                    <TabsTrigger value="history">
                      <Clock className="h-3 w-3 mr-1" />
                      History
                    </TabsTrigger>
                    <TabsTrigger value="journeys">
                      <Route className="h-3 w-3 mr-1" />
                      Journeys
                    </TabsTrigger>
                  </TabsList>
                </Tabs>
                {locationTab === 'current' && device.location_source && (
                  (() => {
                    const sourceInfo = getLocationSourceInfo(device.location_source);
                    const SourceIcon = sourceInfo.icon;
                    return (
                      <Badge variant="outline" className={`gap-1 ${sourceInfo.bgColor} border-0`}>
                        <SourceIcon className={`h-3 w-3 ${sourceInfo.color}`} />
                        <span className={sourceInfo.color}>{sourceInfo.label}</span>
                      </Badge>
                    );
                  })()
                )}
              </div>
            </CardHeader>
            <CardContent className={locationTab === 'current' ? 'p-0' : ''}>
              {locationTab === 'current' && (
                <>
                  {latestJourney ? (
                    <LocationTrail
                      locations={locations.filter(l => (l as any).journey_id === latestJourney.journey_id).map(l => ({
                        time: l.time,
                        lat: l.lat,
                        lon: l.lon,
                        source: l.source,
                      }))}
                      currentLocation={device.latitude && device.longitude ? { lat: device.latitude, lon: device.longitude } : undefined}
                      mapboxToken={mapboxToken}
                      className="h-[300px] rounded-b-lg overflow-hidden"
                    />
                  ) : (
                    <LocationTrail
                      locations={[]}
                      currentLocation={device.latitude && device.longitude ? { lat: device.latitude, lon: device.longitude } : undefined}
                      mapboxToken={mapboxToken}
                      className="h-[300px] rounded-b-lg overflow-hidden"
                    />
                  )}
                </>
              )}
              {locationTab === 'history' && (
                <LocationHistoryTable
                  locations={locationHistory}
                  isLoading={locationHistoryLoading}
                />
              )}
              {locationTab === 'journeys' && (
                <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
                  <div className="lg:col-span-1">
                    <h4 className="text-sm font-medium mb-3">Select a Journey</h4>
                    <JourneySelector
                      journeys={journeys}
                      selectedJourneyId={selectedJourneyId}
                      onSelect={setSelectedJourneyId}
                      isLoading={journeysLoading}
                    />
                  </div>
                  <div className="lg:col-span-3">
                    <h4 className="text-sm font-medium mb-3">Journey Playback</h4>
                    {selectedJourneyId ? (
                      journeyDetailLoading ? (
                        <div className="h-[400px] flex items-center justify-center border rounded-lg">
                          <span className="text-muted-foreground">Loading journey...</span>
                        </div>
                      ) : (
                        <JourneyMap
                          points={journeyPoints}
                          mapboxToken={mapboxToken}
                          className="h-[500px] border rounded-lg overflow-hidden"
                        />
                      )
                    ) : (
                      <div className="h-[400px] flex items-center justify-center border rounded-lg text-muted-foreground">
                        <div className="text-center">
                          <Navigation className="h-8 w-8 mx-auto mb-2" />
                          <p>Select a journey to view playback</p>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Current Readings */}
          <div className="grid gap-4 md:grid-cols-4 mb-6">
            <GaugeCard
              title="Temperature"
              value={convertTemperature(latestTelemetry?.temperature, tempUnit)?.toFixed(1) || '--'}
              unit={getTemperatureUnit(tempUnit)}
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
              <div className="flex gap-4">
                <Tabs value={chartTab} onValueChange={setChartTab}>
                  <TabsList>
                    <TabsTrigger value="telemetry">
                      <Thermometer className="h-3 w-3 mr-1" />
                      Telemetry
                    </TabsTrigger>
                    <TabsTrigger value="power">
                      <Zap className="h-3 w-3 mr-1" />
                      Power
                    </TabsTrigger>
                    <TabsTrigger value="health">
                      <Activity className="h-3 w-3 mr-1" />
                      Health
                    </TabsTrigger>
                  </TabsList>
                </Tabs>
                <Tabs value={String(effectiveTimeRange)} onValueChange={(v) => setTimeRange(Number(v))}>
                  <TabsList>
                    <TabsTrigger value="1">1h</TabsTrigger>
                    <TabsTrigger value="4">4h</TabsTrigger>
                    <TabsTrigger value="8">8h</TabsTrigger>
                    <TabsTrigger value="12">12h</TabsTrigger>
                    <TabsTrigger value="24">24h</TabsTrigger>
                    <TabsTrigger value="48">48h</TabsTrigger>
                    <TabsTrigger value="168">7d</TabsTrigger>
                  </TabsList>
                </Tabs>
              </div>
            </CardHeader>
            <CardContent>
              {chartTab === 'telemetry' && (
                <>
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
                      tempUnit={tempUnit}
                    />
                  ) : (
                    <div className="h-[300px] flex items-center justify-center">
                      <span className="text-muted-foreground">No telemetry data available</span>
                    </div>
                  )}
                </>
              )}
              {chartTab === 'power' && (
                <>
                  {powerLoading ? (
                    <div className="h-[300px] flex items-center justify-center">
                      <span className="text-muted-foreground">Loading chart...</span>
                    </div>
                  ) : power.length > 0 ? (
                    <PowerChart data={power} height={350} />
                  ) : (
                    <div className="h-[300px] flex items-center justify-center">
                      <span className="text-muted-foreground">No power data available (Mojo required)</span>
                    </div>
                  )}
                </>
              )}
              {chartTab === 'health' && (
                <>
                  {healthLoading ? (
                    <div className="h-[300px] flex items-center justify-center">
                      <span className="text-muted-foreground">Loading health events...</span>
                    </div>
                  ) : health.length > 0 ? (
                    <div className="space-y-3 max-h-[300px] overflow-y-auto">
                      {health.map((event: HealthPoint, index: number) => (
                        <div
                          key={`${event.time}-${index}`}
                          className="flex items-start gap-3 p-3 rounded-lg border bg-muted/30"
                        >
                          <Activity className="h-4 w-4 mt-0.5 text-blue-500 flex-shrink-0" />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <Badge variant="secondary" className="text-xs">
                                {healthMethodLabels[event.method || ''] || event.method || 'Unknown'}
                              </Badge>
                              {event.voltage_mode && (
                                <Badge variant="outline" className="text-xs">
                                  {event.voltage_mode}
                                </Badge>
                              )}
                            </div>
                            {event.text && (
                              <p className="text-sm mt-1 break-words text-muted-foreground">
                                {event.text}
                              </p>
                            )}
                            <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                              <span className="flex items-center gap-1">
                                <Clock className="h-3 w-3" />
                                {formatRelativeTime(new Date(event.time))}
                              </span>
                              {event.voltage !== undefined && (
                                <span>{event.voltage.toFixed(2)}V</span>
                              )}
                              {event.milliamp_hours !== undefined && (
                                <span>{event.milliamp_hours.toFixed(3)} mAh</span>
                              )}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="h-[300px] flex items-center justify-center">
                      <span className="text-muted-foreground">No health events recorded</span>
                    </div>
                  )}
                </>
              )}
            </CardContent>
          </Card>

          {/* Command Panel */}
          <CommandPanel
            deviceUid={device.device_uid}
            audioEnabled={device.audio_enabled !== false}
            lastCommand={lastCommand}
          />

          {/* Alerts Section */}
          <Card className="mt-6">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <AlertTriangle className="h-5 w-5" />
                Alerts
                {activeAlerts.length > 0 && (
                  <Badge variant="destructive">{activeAlerts.length} Active</Badge>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {alerts.length === 0 ? (
                <div className="text-center py-6 text-muted-foreground">
                  <Check className="h-8 w-8 mx-auto mb-2 text-green-500" />
                  <p>No alerts for this device</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {alerts.slice(0, 10).map((alert: Alert) => {
                    const isAcknowledged = alert.acknowledged === 'true' || alert.acknowledged === true;
                    return (
                      <div
                        key={alert.alert_id}
                        className={`flex items-center justify-between p-3 rounded-lg border ${
                          isAcknowledged ? 'bg-muted/50 opacity-60' : 'bg-destructive/5 border-destructive/20'
                        }`}
                      >
                        <div className="flex items-center gap-3">
                          <AlertTriangle
                            className={`h-4 w-4 ${isAcknowledged ? 'text-muted-foreground' : 'text-destructive'}`}
                          />
                          <div>
                            <p className="font-medium text-sm">
                              {alertTypeLabels[alert.type] || alert.type}
                            </p>
                            <div className="flex items-center gap-2 text-xs text-muted-foreground">
                              <Clock className="h-3 w-3" />
                              {formatRelativeTime(new Date(alert.created_at))}
                              {alert.value !== undefined && (
                                <span>• Value: {alert.value.toFixed(1)}</span>
                              )}
                            </div>
                          </div>
                        </div>
                        {!isAcknowledged && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => acknowledgeMutation.mutate({ alertId: alert.alert_id })}
                            disabled={acknowledgeMutation.isPending}
                          >
                            <Check className="h-3 w-3 mr-1" />
                            Ack
                          </Button>
                        )}
                        {isAcknowledged && (
                          <Badge variant="secondary" className="text-xs">
                            <Check className="h-3 w-3 mr-1" />
                            Acknowledged
                          </Badge>
                        )}
                      </div>
                    );
                  })}
                  {alerts.length > 10 && (
                    <p className="text-center text-sm text-muted-foreground">
                      Showing 10 of {alerts.length} alerts
                    </p>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

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
                  <dd>
                    {device.serial_number || '--'}
                    {device.assigned_to_name && (
                      <span className="text-muted-foreground ml-1">({device.assigned_to_name})</span>
                    )}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Firmware</dt>
                  <dd>{device.firmware_version || '--'}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Notecard</dt>
                  <dd>
                    {device.notecard_version || '--'}
                    {device.notecard_sku && <span className="text-muted-foreground ml-1">({device.notecard_sku})</span>}
                  </dd>
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
              assignedTo={device.assigned_to}
              onClose={() => setShowConfig(false)}
            />
          </div>
        )}
      </div>
    </div>
  );
}
