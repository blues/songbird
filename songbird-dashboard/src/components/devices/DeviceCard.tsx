import { Link } from 'react-router-dom';
import { Thermometer, Droplets, Gauge, Battery, MapPin, AlertTriangle, Satellite, Radio } from 'lucide-react';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { DeviceStatus } from './DeviceStatus';
import {
  formatTemperature,
  formatHumidity,
  formatBattery,
  formatMode,
  formatRelativeTime,
} from '@/utils/formatters';
import { usePreferences } from '@/contexts/PreferencesContext';
import type { Device, LocationSource } from '@/types';

// Location source display configuration
function getLocationSourceInfo(source?: LocationSource | string) {
  switch (source) {
    case 'gps':
      return { label: 'GPS', icon: Satellite, color: 'text-green-600' };
    case 'cell':
    case 'tower':
      return { label: 'Cell', icon: Radio, color: 'text-blue-600' };
    case 'wifi':
      return { label: 'Wi-Fi', icon: Radio, color: 'text-purple-600' };
    case 'triangulation':
    case 'triangulated':
      return { label: 'Tri', icon: Radio, color: 'text-orange-600' };
    default:
      return null;
  }
}

interface DeviceCardProps {
  device: Device;
  alertCount?: number;
}

export function DeviceCard({ device, alertCount = 0 }: DeviceCardProps) {
  const { preferences } = usePreferences();
  const tempUnit = preferences.temp_unit === 'fahrenheit' ? 'F' : 'C';
  const battery = formatBattery(device.voltage);

  return (
    <Link to={`/devices/${device.device_uid}`}>
      <Card className="hover:shadow-md transition-shadow cursor-pointer">
        <CardHeader className="pb-2">
          <div className="flex items-start justify-between">
            <div>
              <h3 className="font-semibold">
                {device.name || device.serial_number || device.device_uid}
              </h3>
              {(device.assigned_to_name || device.assigned_to) && (
                <p className="text-sm text-muted-foreground">{device.assigned_to_name || device.assigned_to}</p>
              )}
            </div>
            <div className="flex items-center gap-2">
              {alertCount > 0 && (
                <Badge variant="destructive" className="gap-1">
                  <AlertTriangle className="h-3 w-3" />
                  {alertCount}
                </Badge>
              )}
              <Badge variant="secondary">{formatMode(device.mode)}</Badge>
              <DeviceStatus status={device.status} showLabel={false} />
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-4">
            {/* Temperature */}
            <div className="flex items-center gap-2">
              <Thermometer className="h-4 w-4 text-orange-500" />
              <span className="text-sm font-medium">
                {formatTemperature(device.temperature, tempUnit)}
              </span>
            </div>

            {/* Humidity */}
            <div className="flex items-center gap-2">
              <Droplets className="h-4 w-4 text-blue-500" />
              <span className="text-sm font-medium">
                {formatHumidity(device.humidity)}
              </span>
            </div>

            {/* Pressure */}
            <div className="flex items-center gap-2">
              <Gauge className="h-4 w-4 text-purple-500" />
              <span className="text-sm font-medium">
                {device.pressure ? `${device.pressure.toFixed(0)} hPa` : '--'}
              </span>
            </div>

            {/* Battery */}
            <div className="flex items-center gap-2">
              <Battery
                className={`h-4 w-4 ${
                  battery.level === 'critical'
                    ? 'text-red-500'
                    : battery.level === 'low'
                    ? 'text-yellow-500'
                    : 'text-green-500'
                }`}
              />
              <span className="text-sm font-medium">{battery.percentage}%</span>
            </div>
          </div>

          {/* Location & Last seen */}
          <div className="mt-4 pt-4 border-t flex items-center justify-between text-sm text-muted-foreground">
            <div className="flex items-center gap-1.5">
              <MapPin className="h-3 w-3" />
              {device.latitude && device.longitude ? (
                <>
                  <span>
                    {device.latitude.toFixed(3)}, {device.longitude.toFixed(3)}
                  </span>
                  {(() => {
                    const sourceInfo = getLocationSourceInfo(device.location_source);
                    if (!sourceInfo) return null;
                    const SourceIcon = sourceInfo.icon;
                    return (
                      <span className={`flex items-center gap-0.5 ${sourceInfo.color}`}>
                        <SourceIcon className="h-3 w-3" />
                        <span className="text-xs">{sourceInfo.label}</span>
                      </span>
                    );
                  })()}
                </>
              ) : (
                <span>No location</span>
              )}
            </div>
            {device.last_seen && (
              <span>{formatRelativeTime(device.last_seen)}</span>
            )}
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}
