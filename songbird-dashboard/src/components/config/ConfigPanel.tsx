import { useState, useEffect } from 'react';
import { Lock, Satellite } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Slider } from '@/components/ui/slider';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useDeviceConfig, useUpdateDeviceConfig } from '@/hooks/useConfig';
import { useIsAdmin } from '@/hooks/useAuth';
import { useUserProfile } from '@/hooks/useUserProfile';
import { usePreferences } from '@/contexts/PreferencesContext';
import type { DeviceConfig, OperatingMode, MotionSensitivity } from '@/types';

// Temperature conversion helpers
const celsiusToFahrenheit = (c: number) => Math.round((c * 9) / 5 + 32);
const fahrenheitToCelsius = (f: number) => Math.round(((f - 32) * 5) / 9);

interface ConfigPanelProps {
  serialNumber: string;
  assignedTo?: string; // Email of the user the device is assigned to
  onClose?: () => void;
}

export function ConfigPanel({ serialNumber, assignedTo, onClose }: ConfigPanelProps) {
  const { data: configData, isLoading } = useDeviceConfig(serialNumber);
  const updateConfig = useUpdateDeviceConfig();
  const { isAdmin } = useIsAdmin();
  const { data: userProfile } = useUserProfile();
  const { preferences } = usePreferences();

  // Check if user can edit: Admin OR device is assigned to them
  const canEdit = isAdmin || (userProfile?.email && assignedTo === userProfile.email);

  // Temperature unit preference
  const useFahrenheit = preferences.temp_unit === 'fahrenheit';
  const tempUnit = useFahrenheit ? '°F' : '°C';

  // Convert display temperature based on preference
  const displayTemp = (celsius: number) => useFahrenheit ? celsiusToFahrenheit(celsius) : celsius;

  // Slider ranges based on unit
  const tempHighMin = useFahrenheit ? 68 : 20;   // 20°C = 68°F
  const tempHighMax = useFahrenheit ? 140 : 60;  // 60°C = 140°F
  const tempLowMin = useFahrenheit ? -4 : -20;   // -20°C = -4°F
  const tempLowMax = useFahrenheit ? 68 : 20;    // 20°C = 68°F

  const [localConfig, setLocalConfig] = useState<Partial<DeviceConfig>>({});
  const [hasChanges, setHasChanges] = useState(false);

  // Initialize local config when data loads
  useEffect(() => {
    if (configData?.config) {
      setLocalConfig(configData.config);
      setHasChanges(false);
    }
  }, [configData]);

  const updateLocalConfig = <K extends keyof DeviceConfig>(
    key: K,
    value: DeviceConfig[K]
  ) => {
    setLocalConfig((prev) => ({ ...prev, [key]: value }));
    setHasChanges(true);
  };

  const handleApply = () => {
    updateConfig.mutate(
      { serialNumber, config: localConfig },
      {
        onSuccess: () => {
          setHasChanges(false);
        },
      }
    );
  };

  if (isLoading) {
    return (
      <Card>
        <CardContent className="py-8">
          <div className="text-center text-muted-foreground">
            Loading configuration...
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2">
          <span>⚙️</span>
          Device Configuration
        </CardTitle>
        {onClose && (
          <Button variant="ghost" size="sm" onClick={onClose}>
            ✕
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Read-only notice */}
        {!canEdit && (
          <div className="flex items-center gap-2 p-3 bg-muted rounded-lg text-sm text-muted-foreground">
            <Lock className="h-4 w-4" />
            <span>You can view this configuration but only the device owner or an admin can make changes.</span>
          </div>
        )}

        {/* Operating Mode */}
        <div className="space-y-2">
          <label className="text-sm font-medium">Operating Mode</label>
          <Select
            value={localConfig.mode || 'demo'}
            onValueChange={(value) =>
              updateLocalConfig('mode', value as OperatingMode)
            }
            disabled={!canEdit}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="demo">Demo (triangulation only, instant sync)</SelectItem>
              <SelectItem value="transit">Transit (GPS tracking enabled, 15 min sync)</SelectItem>
              <SelectItem value="storage">Storage (triangulation only, 60 min sync)</SelectItem>
              <SelectItem value="sleep">Sleep (motion wake only)</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Custom Intervals */}
        <div className="space-y-4 border-t pt-4">
          <h4 className="text-sm font-medium">Custom Intervals</h4>

          <div className="space-y-2">
            <div className="flex justify-between text-sm">
              <span>GPS Interval</span>
              <span>{localConfig.gps_interval_min || 5} min</span>
            </div>
            <Slider
              value={[localConfig.gps_interval_min || 5]}
              onValueChange={([value]) =>
                updateLocalConfig('gps_interval_min', value)
              }
              min={1}
              max={60}
              step={1}
              disabled={!canEdit}
            />
          </div>

          <div className="space-y-2">
            <div className="flex justify-between text-sm">
              <span>Sync Interval</span>
              <span>{localConfig.sync_interval_min || 15} min</span>
            </div>
            <Slider
              value={[localConfig.sync_interval_min || 15]}
              onValueChange={([value]) =>
                updateLocalConfig('sync_interval_min', value)
              }
              min={1}
              max={60}
              step={1}
              disabled={!canEdit}
            />
          </div>
        </div>

        {/* Alert Thresholds */}
        <div className="space-y-4 border-t pt-4">
          <h4 className="text-sm font-medium">Alert Thresholds</h4>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="text-sm text-muted-foreground">Temp High ({tempUnit})</label>
              <Slider
                value={[displayTemp(localConfig.temp_alert_high_c || 35)]}
                onValueChange={([value]) => {
                  // Convert back to Celsius for storage
                  const celsius = useFahrenheit ? fahrenheitToCelsius(value) : value;
                  updateLocalConfig('temp_alert_high_c', celsius);
                }}
                min={tempHighMin}
                max={tempHighMax}
                step={1}
                disabled={!canEdit}
              />
              <span className="text-xs">{displayTemp(localConfig.temp_alert_high_c || 35)}{tempUnit}</span>
            </div>

            <div className="space-y-2">
              <label className="text-sm text-muted-foreground">Temp Low ({tempUnit})</label>
              <Slider
                value={[displayTemp(localConfig.temp_alert_low_c || 0)]}
                onValueChange={([value]) => {
                  // Convert back to Celsius for storage
                  const celsius = useFahrenheit ? fahrenheitToCelsius(value) : value;
                  updateLocalConfig('temp_alert_low_c', celsius);
                }}
                min={tempLowMin}
                max={tempLowMax}
                step={1}
                disabled={!canEdit}
              />
              <span className="text-xs">{displayTemp(localConfig.temp_alert_low_c || 0)}{tempUnit}</span>
            </div>

            <div className="space-y-2">
              <label className="text-sm text-muted-foreground">Humidity High (%)</label>
              <Slider
                value={[localConfig.humidity_alert_high || 80]}
                onValueChange={([value]) =>
                  updateLocalConfig('humidity_alert_high', value)
                }
                min={50}
                max={100}
                step={5}
                disabled={!canEdit}
              />
              <span className="text-xs">{localConfig.humidity_alert_high || 80}%</span>
            </div>

            <div className="space-y-2">
              <label className="text-sm text-muted-foreground">Humidity Low (%)</label>
              <Slider
                value={[localConfig.humidity_alert_low || 20]}
                onValueChange={([value]) =>
                  updateLocalConfig('humidity_alert_low', value)
                }
                min={0}
                max={50}
                step={5}
                disabled={!canEdit}
              />
              <span className="text-xs">{localConfig.humidity_alert_low || 20}%</span>
            </div>
          </div>
        </div>

        {/* Audio Settings */}
        <div className="space-y-4 border-t pt-4">
          <h4 className="text-sm font-medium">Audio Settings</h4>

          <div className="flex items-center justify-between">
            <label className="text-sm">Audio Enabled</label>
            <Switch
              checked={localConfig.audio_enabled !== false}
              onCheckedChange={(checked) =>
                updateLocalConfig('audio_enabled', checked)
              }
              disabled={!canEdit}
            />
          </div>

          <div className="space-y-2">
            <div className="flex justify-between text-sm">
              <span>Volume</span>
              <span>{localConfig.audio_volume || 50}%</span>
            </div>
            <Slider
              value={[localConfig.audio_volume || 50]}
              onValueChange={([value]) =>
                updateLocalConfig('audio_volume', value)
              }
              min={0}
              max={100}
              step={10}
              disabled={!canEdit || localConfig.audio_enabled === false}
            />
          </div>

          <div className="flex items-center justify-between">
            <label className="text-sm">Alerts Only</label>
            <Switch
              checked={localConfig.audio_alerts_only === true}
              onCheckedChange={(checked) =>
                updateLocalConfig('audio_alerts_only', checked)
              }
              disabled={!canEdit || localConfig.audio_enabled === false}
            />
          </div>
        </div>

        {/* Motion Settings */}
        <div className="space-y-4 border-t pt-4">
          <h4 className="text-sm font-medium">Motion Settings</h4>

          <div className="space-y-2">
            <label className="text-sm text-muted-foreground">Sensitivity</label>
            <Select
              value={localConfig.motion_sensitivity || 'medium'}
              onValueChange={(value) =>
                updateLocalConfig('motion_sensitivity', value as MotionSensitivity)
              }
              disabled={!canEdit}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="low">Low</SelectItem>
                <SelectItem value="medium">Medium</SelectItem>
                <SelectItem value="high">High</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center justify-between">
            <label className="text-sm">Motion Wake Enabled</label>
            <Switch
              checked={localConfig.motion_wake_enabled !== false}
              onCheckedChange={(checked) =>
                updateLocalConfig('motion_wake_enabled', checked)
              }
              disabled={!canEdit}
            />
          </div>
        </div>

        {/* Other Settings */}
        <div className="space-y-4 border-t pt-4">
          <h4 className="text-sm font-medium">Other Settings</h4>

          <div className="flex items-center justify-between">
            <label className="text-sm">LED Enabled</label>
            <Switch
              checked={localConfig.led_enabled !== false}
              onCheckedChange={(checked) =>
                updateLocalConfig('led_enabled', checked)
              }
              disabled={!canEdit}
            />
          </div>

          <div className="flex items-center justify-between">
            <label className="text-sm">Debug Mode</label>
            <Switch
              checked={localConfig.debug_mode === true}
              onCheckedChange={(checked) =>
                updateLocalConfig('debug_mode', checked)
              }
              disabled={!canEdit}
            />
          </div>
        </div>

        {/* GPS Power Management */}
        <div className="space-y-4 border-t pt-4">
          <h4 className="text-sm font-medium flex items-center gap-2">
            <Satellite className="h-4 w-4" />
            GPS Power Management (Transit Mode)
          </h4>
          <p className="text-xs text-muted-foreground">
            When enabled, GPS is disabled after no signal is acquired within the timeout period
          </p>

          <div className="flex items-center justify-between">
            <label className="text-sm">GPS Power Management</label>
            <Switch
              checked={localConfig.gps_power_save_enabled !== false}
              onCheckedChange={(checked) =>
                updateLocalConfig('gps_power_save_enabled', checked)
              }
              disabled={!canEdit}
            />
          </div>

          <div className="space-y-2">
            <div className="flex justify-between text-sm">
              <span>Signal Timeout</span>
              <span>{localConfig.gps_signal_timeout_min || 15} min</span>
            </div>
            <Slider
              value={[localConfig.gps_signal_timeout_min || 15]}
              onValueChange={([value]) =>
                updateLocalConfig('gps_signal_timeout_min', value)
              }
              min={10}
              max={30}
              step={5}
              disabled={!canEdit || localConfig.gps_power_save_enabled === false}
            />
            <span className="text-xs text-muted-foreground">
              Time to wait for GPS signal before disabling GPS
            </span>
          </div>

          <div className="space-y-2">
            <div className="flex justify-between text-sm">
              <span>Retry Interval</span>
              <span>{localConfig.gps_retry_interval_min || 30} min</span>
            </div>
            <Slider
              value={[localConfig.gps_retry_interval_min || 30]}
              onValueChange={([value]) =>
                updateLocalConfig('gps_retry_interval_min', value)
              }
              min={5}
              max={120}
              step={5}
              disabled={!canEdit || localConfig.gps_power_save_enabled === false}
            />
            <span className="text-xs text-muted-foreground">
              Time between attempts to re-enable GPS after disabling
            </span>
          </div>
        </div>

        {/* Apply Button */}
        {canEdit && (
          <div className="border-t pt-4">
            <Button
              onClick={handleApply}
              disabled={!hasChanges || updateConfig.isPending}
              className="w-full"
            >
              {updateConfig.isPending ? 'Applying...' : 'Apply Changes'}
            </Button>
            {hasChanges && (
              <p className="text-xs text-muted-foreground text-center mt-2">
                Changes will take effect on next device sync
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
