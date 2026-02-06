import { Link } from 'react-router-dom';
import { Thermometer, Droplets, Gauge, BatteryFull, BatteryMedium, BatteryLow, BatteryCharging, MapPin, AlertTriangle, Satellite, Radio, Lock, ArrowRight } from 'lucide-react';
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
    <Link to={`/devices/${device.serial_number}`}>
      <Card className="hover:shadow-md transition-shadow cursor-pointer">
        <CardHeader className="pb-2">
          <div className="flex items-start justify-between">
            <div>
              <h3 className="font-semibold flex items-center gap-1.5">
                {device.usb_powered ? (
                  <span title="USB Powered"><BatteryCharging className="h-4 w-4 text-blue-500" /></span>
                ) : (
                  <span title="Battery Powered"><BatteryFull className="h-4 w-4 text-green-500" /></span>
                )}
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
              {device.pending_mode && device.pending_mode !== device.mode && (
                <Badge variant="outline" className="gap-1 border-blue-300 bg-blue-50 text-blue-700 animate-pulse">
                  <ArrowRight className="h-3 w-3" />
                  {formatMode(device.pending_mode)}
                </Badge>
              )}
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
              {battery.percentage >= 75 ? (
                <BatteryFull className="h-4 w-4 text-green-500" />
              ) : battery.percentage >= 25 ? (
                <BatteryMedium className="h-4 w-4 text-orange-500" />
              ) : (
                <BatteryLow className="h-4 w-4 text-red-500" />
              )}
              <span className="text-sm font-medium">{battery.percentage}%</span>
            </div>
          </div>

          {/* Location & Last seen */}
          <div className="mt-4 pt-4 border-t flex items-start justify-between gap-2 text-sm text-muted-foreground">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <MapPin className="h-3 w-3 flex-shrink-0" />
                {device.latitude && device.longitude ? (
                  <span className="truncate">
                    {device.location_name || `${device.latitude.toFixed(3)}, ${device.longitude.toFixed(3)}`}
                  </span>
                ) : (
                  <span>No location</span>
                )}
              </div>
              {device.latitude && device.longitude && (() => {
                const sourceInfo = getLocationSourceInfo(device.location_source);
                if (!sourceInfo) return null;
                const SourceIcon = sourceInfo.icon;
                return (
                  <div className={`flex items-center gap-1 mt-0.5 ml-[18px] ${sourceInfo.color}`}>
                    <SourceIcon className="h-3 w-3" />
                    <span className="text-xs">{sourceInfo.label}</span>
                  </div>
                );
              })()}
            </div>
            {device.last_seen && (
              <span className="flex-shrink-0">{formatRelativeTime(device.last_seen)}</span>
            )}
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}
