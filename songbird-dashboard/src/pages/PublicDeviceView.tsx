/**
 * Public Device View
 *
 * Read-only device view accessible without authentication.
 * Shows device info, current readings, location, and telemetry chart.
 * If user is authenticated, redirects to full device detail view.
 */

import { useState, useEffect } from 'react';
import { useParams, Link, Navigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { fetchAuthSession } from 'aws-amplify/auth';
import {
  Thermometer,
  Droplets,
  Gauge,
  Battery,
  BatteryFull,
  BatteryCharging,
  MapPin,
  Satellite,
  Radio,
  Clock,
  LogIn,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DeviceStatus } from '@/components/devices/DeviceStatus';
import { LocationTrail } from '@/components/maps/LocationTrail';
import { TelemetryChart } from '@/components/charts/TelemetryChart';
import { GaugeCard } from '@/components/charts/GaugeCard';
import { getPublicDevice } from '@/api/devices';
import {
  formatBattery,
  formatMode,
  formatRelativeTime,
  truncateDeviceUid,
} from '@/utils/formatters';
import type { LocationSource } from '@/types';

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
    case 'triangulated':
      return { label: 'Triangulated', icon: Radio, color: 'text-orange-600', bgColor: 'bg-orange-100' };
    default:
      return { label: 'Unknown', icon: MapPin, color: 'text-gray-600', bgColor: 'bg-gray-100' };
  }
}

interface PublicDeviceViewProps {
  mapboxToken: string;
}

export function PublicDeviceView({ mapboxToken }: PublicDeviceViewProps) {
  const { serialNumber } = useParams<{ serialNumber: string }>();
  const [authChecked, setAuthChecked] = useState(false);
  const [isAuthenticated, setIsAuthenticated] = useState(false);

  // Check if user is authenticated
  useEffect(() => {
    async function checkAuth() {
      try {
        const session = await fetchAuthSession();
        const hasToken = !!session.tokens?.idToken;
        setIsAuthenticated(hasToken);
      } catch {
        setIsAuthenticated(false);
      } finally {
        setAuthChecked(true);
      }
    }
    checkAuth();
  }, []);

  const { data: device, isLoading, error } = useQuery({
    queryKey: ['public-device', serialNumber],
    queryFn: () => getPublicDevice(serialNumber!),
    enabled: !!serialNumber,
    refetchInterval: 30_000, // Refresh every 30 seconds
  });

  // Transform recent_telemetry for chart
  const chartData = device?.recent_telemetry?.map(t => ({
    time: t.timestamp,
    temperature: t.temperature,
    humidity: t.humidity,
    pressure: t.pressure,
    voltage: t.voltage,
  })) || [];

  // Sparkline data from recent telemetry
  const sparklineTemp = chartData.slice(0, 20).map(t => t.temperature || 0);
  const sparklineHumidity = chartData.slice(0, 20).map(t => t.humidity || 0);

  // Redirect authenticated users to full device detail view
  if (authChecked && isAuthenticated && serialNumber) {
    return <Navigate to={`/devices/${serialNumber}`} replace />;
  }

  // Show loading while checking auth or loading device
  if (!authChecked || isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-center">
          <img
            src="/songbird-logo.svg"
            alt="Songbird"
            className="h-16 w-16 mx-auto mb-4 animate-pulse"
          />
          <p className="text-muted-foreground">Loading device...</p>
        </div>
      </div>
    );
  }

  if (error || !device) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-red-500 mb-2">Device Not Found</h1>
          <p className="text-muted-foreground mb-4">
            The device you're looking for doesn't exist or is unavailable.
          </p>
          <Link to="/">
            <Button>
              <LogIn className="h-4 w-4 mr-2" />
              Sign In to Dashboard
            </Button>
          </Link>
        </div>
      </div>
    );
  }

  const battery = formatBattery(device.voltage);
  const sourceInfo = device.location_source ? getLocationSourceInfo(device.location_source) : null;
  const SourceIcon = sourceInfo?.icon || MapPin;

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b bg-card">
        <div className="container mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <img src="/songbird-logo.svg" alt="Songbird" className="h-8 w-8" />
              <div>
                <h1 className="text-lg font-semibold">Songbird</h1>
                <p className="text-xs text-muted-foreground">Public Device View</p>
              </div>
            </div>
            {!isAuthenticated && (
              <Link to="/">
                <Button variant="outline" size="sm">
                  <LogIn className="h-4 w-4 mr-2" />
                  Sign In
                </Button>
              </Link>
            )}
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="container mx-auto px-4 py-6">
        <div className="space-y-6 max-w-6xl mx-auto">
          {/* Device Header */}
          <div className="space-y-2">
            <div className="flex items-center gap-2 flex-wrap">
              {device.usb_powered ? (
                <BatteryCharging className="h-5 w-5 text-blue-500" />
              ) : (
                <BatteryFull className="h-5 w-5 text-green-500" />
              )}
              <h2 className="text-2xl font-bold">
                {device.name || device.serial_number || truncateDeviceUid(device.device_uid)}
              </h2>
              <DeviceStatus status={device.status} />
            </div>
            <div className="text-sm text-muted-foreground flex flex-wrap items-center gap-2">
              <Badge variant="secondary">{formatMode(device.mode)}</Badge>
              {device.last_seen && (
                <>
                  <span>•</span>
                  <span className="flex items-center gap-1">
                    <Clock className="h-3 w-3" />
                    Last seen: {formatRelativeTime(device.last_seen)}
                  </span>
                </>
              )}
            </div>
          </div>

          {/* Current Readings */}
          <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
            <GaugeCard
              title="Temperature"
              value={device.temperature?.toFixed(1) || '--'}
              unit="°C"
              icon={<Thermometer className="h-4 w-4 text-orange-500" />}
              sparklineData={sparklineTemp}
              status={device.temperature && device.temperature > 35 ? 'warning' : 'normal'}
            />
            <GaugeCard
              title="Humidity"
              value={device.humidity?.toFixed(1) || '--'}
              unit="%"
              icon={<Droplets className="h-4 w-4 text-blue-500" />}
              sparklineData={sparklineHumidity}
            />
            <GaugeCard
              title="Pressure"
              value={device.pressure?.toFixed(0) || '--'}
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

          {/* Location */}
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle className="flex items-center gap-2">
                <MapPin className="h-5 w-5" />
                Location
              </CardTitle>
              {sourceInfo && (
                <Badge variant="outline" className={`gap-1 ${sourceInfo.bgColor} border-0`}>
                  <SourceIcon className={`h-3 w-3 ${sourceInfo.color}`} />
                  <span className={sourceInfo.color}>{sourceInfo.label}</span>
                </Badge>
              )}
            </CardHeader>
            <CardContent className="p-0">
              <LocationTrail
                locations={[]}
                currentLocation={
                  device.latitude && device.longitude
                    ? { lat: device.latitude, lon: device.longitude }
                    : undefined
                }
                mapboxToken={mapboxToken}
                className="h-[300px] rounded-b-lg overflow-hidden"
              />
            </CardContent>
          </Card>

          {/* Telemetry Chart */}
          {chartData.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Thermometer className="h-5 w-5" />
                  24-Hour Telemetry
                </CardTitle>
              </CardHeader>
              <CardContent>
                <TelemetryChart
                  data={chartData}
                  showTemperature
                  showHumidity
                  showPressure
                  height={300}
                  tempUnit="C"
                />
              </CardContent>
            </Card>
          )}

          {/* Device Info */}
          <Card>
            <CardHeader>
              <CardTitle>Device Information</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid grid-cols-2 gap-4 text-sm">
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
                  <dd>
                    {device.notecard_version || '--'}
                    {device.notecard_sku && (
                      <span className="text-muted-foreground ml-1">({device.notecard_sku})</span>
                    )}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Battery</dt>
                  <dd>
                    {battery.voltage} ({battery.percentage}%)
                  </dd>
                </div>
              </dl>
            </CardContent>
          </Card>
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t bg-card mt-8">
        <div className="container mx-auto px-4 py-4 text-center text-sm text-muted-foreground">
          Powered by Blues Inc. •{' '}
          <a
            href="https://blues.io"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-foreground"
          >
            Learn more
          </a>
        </div>
      </footer>
    </div>
  );
}
