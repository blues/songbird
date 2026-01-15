/**
 * Fleet Defaults Component
 *
 * Admin-only component for configuring default settings per fleet.
 */

import { useState, useEffect } from 'react';
import { Building2, Satellite, Settings, Thermometer, Timer, Volume2, Zap } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useNotehubFleets, useFleetDefaults, useUpdateFleetDefaults } from '@/hooks/useSettings';
import { usePreferences } from '@/contexts/PreferencesContext';
import type { FleetDefaults as FleetDefaultsType, OperatingMode, MotionSensitivity } from '@/types';

// Temperature conversion helpers
const celsiusToFahrenheit = (c: number) => Math.round((c * 9) / 5 + 32);
const fahrenheitToCelsius = (f: number) => Math.round(((f - 32) * 5) / 9);

export function FleetDefaults() {
  const { data: fleets, isLoading: fleetsLoading } = useNotehubFleets();
  const [selectedFleet, setSelectedFleet] = useState<string>('');
  const { data: fleetConfig, isLoading: configLoading } = useFleetDefaults(selectedFleet);
  const updateDefaults = useUpdateFleetDefaults();
  const { preferences } = usePreferences();

  // Temperature unit preference
  const useFahrenheit = preferences.temp_unit === 'fahrenheit';
  const tempUnit = useFahrenheit ? '°F' : '°C';

  // Convert display temperature based on preference
  const displayTemp = (celsius: number) => useFahrenheit ? celsiusToFahrenheit(celsius) : celsius;

  // Slider ranges based on unit
  const tempHighMin = useFahrenheit ? 14 : -10;   // -10°C = 14°F
  const tempHighMax = useFahrenheit ? 140 : 60;   // 60°C = 140°F
  const tempLowMin = useFahrenheit ? -40 : -40;   // -40°C = -40°F
  const tempLowMax = useFahrenheit ? 86 : 30;     // 30°C = 86°F

  const [localConfig, setLocalConfig] = useState<Partial<FleetDefaultsType>>({});
  const [hasChanges, setHasChanges] = useState(false);

  // Select first fleet by default
  useEffect(() => {
    if (fleets && fleets.length > 0 && !selectedFleet) {
      setSelectedFleet(fleets[0].uid);
    }
  }, [fleets, selectedFleet]);

  // Load config when fleet changes
  useEffect(() => {
    if (fleetConfig?.config) {
      setLocalConfig(fleetConfig.config);
      setHasChanges(false);
    }
  }, [fleetConfig]);

  const updateLocalConfig = <K extends keyof FleetDefaultsType>(
    key: K,
    value: FleetDefaultsType[K]
  ) => {
    setLocalConfig(prev => ({ ...prev, [key]: value }));
    setHasChanges(true);
  };

  const handleSave = () => {
    if (!selectedFleet) return;
    updateDefaults.mutate({
      fleetUid: selectedFleet,
      config: localConfig,
    });
    setHasChanges(false);
  };

  if (fleetsLoading) {
    return (
      <Card>
        <CardContent className="py-8">
          <div className="text-center text-muted-foreground">Loading fleets...</div>
        </CardContent>
      </Card>
    );
  }

  if (!fleets || fleets.length === 0) {
    return (
      <Card>
        <CardContent className="py-8">
          <div className="text-center text-muted-foreground">
            No fleets found. Create a fleet in Notehub first.
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {/* Fleet Selector */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Building2 className="h-5 w-5" />
            Select Fleet
          </CardTitle>
          <CardDescription>
            Configure default settings for devices in each fleet
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Select value={selectedFleet} onValueChange={setSelectedFleet}>
            <SelectTrigger className="w-full md:w-80">
              <SelectValue placeholder="Select a fleet" />
            </SelectTrigger>
            <SelectContent>
              {fleets.map(fleet => (
                <SelectItem key={fleet.uid} value={fleet.uid}>
                  {fleet.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      {/* Fleet Configuration */}
      {selectedFleet && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Settings className="h-5 w-5" />
              Default Configuration
            </CardTitle>
            <CardDescription>
              These defaults will be applied to new devices added to this fleet
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {configLoading ? (
              <div className="text-center text-muted-foreground py-4">Loading configuration...</div>
            ) : (
              <>
                {/* Operating Mode */}
                <div className="flex items-center justify-between">
                  <div>
                    <Label>Default Operating Mode</Label>
                    <p className="text-sm text-muted-foreground">
                      Initial mode for new devices
                    </p>
                  </div>
                  <Select
                    value={localConfig.mode || 'demo'}
                    onValueChange={(v) => updateLocalConfig('mode', v as OperatingMode)}
                  >
                    <SelectTrigger className="w-40">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="demo">Demo</SelectItem>
                      <SelectItem value="transit">Transit</SelectItem>
                      <SelectItem value="storage">Storage</SelectItem>
                      <SelectItem value="sleep">Sleep</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {/* Intervals Section */}
                <div className="border-t pt-6 space-y-4">
                  <h4 className="text-sm font-medium flex items-center gap-2">
                    <Timer className="h-4 w-4" />
                    Default Intervals
                  </h4>

                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-2">
                      <div className="flex justify-between">
                        <Label>GPS Interval</Label>
                        <span className="text-sm text-muted-foreground">
                          {localConfig.gps_interval_min || 5} min
                        </span>
                      </div>
                      <Slider
                        value={[localConfig.gps_interval_min || 5]}
                        onValueChange={([v]) => updateLocalConfig('gps_interval_min', v)}
                        min={1}
                        max={60}
                        step={1}
                      />
                    </div>

                    <div className="space-y-2">
                      <div className="flex justify-between">
                        <Label>Sync Interval</Label>
                        <span className="text-sm text-muted-foreground">
                          {localConfig.sync_interval_min || 15} min
                        </span>
                      </div>
                      <Slider
                        value={[localConfig.sync_interval_min || 15]}
                        onValueChange={([v]) => updateLocalConfig('sync_interval_min', v)}
                        min={1}
                        max={60}
                        step={1}
                      />
                    </div>
                  </div>
                </div>

                {/* Alert Thresholds Section */}
                <div className="border-t pt-6 space-y-4">
                  <h4 className="text-sm font-medium flex items-center gap-2">
                    <Thermometer className="h-4 w-4" />
                    Default Alert Thresholds
                  </h4>

                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-2">
                      <div className="flex justify-between">
                        <Label>Temp High ({tempUnit})</Label>
                        <span className="text-sm text-muted-foreground">
                          {displayTemp(localConfig.temp_alert_high_c || 35)}{tempUnit}
                        </span>
                      </div>
                      <Slider
                        value={[displayTemp(localConfig.temp_alert_high_c || 35)]}
                        onValueChange={([v]) => {
                          const celsius = useFahrenheit ? fahrenheitToCelsius(v) : v;
                          updateLocalConfig('temp_alert_high_c', celsius);
                        }}
                        min={tempHighMin}
                        max={tempHighMax}
                        step={1}
                      />
                    </div>

                    <div className="space-y-2">
                      <div className="flex justify-between">
                        <Label>Temp Low ({tempUnit})</Label>
                        <span className="text-sm text-muted-foreground">
                          {displayTemp(localConfig.temp_alert_low_c || 5)}{tempUnit}
                        </span>
                      </div>
                      <Slider
                        value={[displayTemp(localConfig.temp_alert_low_c || 5)]}
                        onValueChange={([v]) => {
                          const celsius = useFahrenheit ? fahrenheitToCelsius(v) : v;
                          updateLocalConfig('temp_alert_low_c', celsius);
                        }}
                        min={tempLowMin}
                        max={tempLowMax}
                        step={1}
                      />
                    </div>

                    <div className="space-y-2">
                      <div className="flex justify-between">
                        <Label>Humidity High (%)</Label>
                        <span className="text-sm text-muted-foreground">
                          {localConfig.humidity_alert_high || 80}%
                        </span>
                      </div>
                      <Slider
                        value={[localConfig.humidity_alert_high || 80]}
                        onValueChange={([v]) => updateLocalConfig('humidity_alert_high', v)}
                        min={50}
                        max={100}
                        step={1}
                      />
                    </div>

                    <div className="space-y-2">
                      <div className="flex justify-between">
                        <Label>Humidity Low (%)</Label>
                        <span className="text-sm text-muted-foreground">
                          {localConfig.humidity_alert_low || 20}%
                        </span>
                      </div>
                      <Slider
                        value={[localConfig.humidity_alert_low || 20]}
                        onValueChange={([v]) => updateLocalConfig('humidity_alert_low', v)}
                        min={0}
                        max={50}
                        step={1}
                      />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <div className="flex justify-between">
                      <Label>Voltage Low (V)</Label>
                      <span className="text-sm text-muted-foreground">
                        {(localConfig.voltage_alert_low || 3.5).toFixed(1)}V
                      </span>
                    </div>
                    <Slider
                      value={[localConfig.voltage_alert_low || 3.5]}
                      onValueChange={([v]) => updateLocalConfig('voltage_alert_low', v)}
                      min={3.0}
                      max={4.0}
                      step={0.1}
                    />
                  </div>
                </div>

                {/* Features Section */}
                <div className="border-t pt-6 space-y-4">
                  <h4 className="text-sm font-medium flex items-center gap-2">
                    <Zap className="h-4 w-4" />
                    Default Features
                  </h4>

                  <div className="space-y-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <Label>Motion Sensitivity</Label>
                        <p className="text-sm text-muted-foreground">Default motion detection level</p>
                      </div>
                      <Select
                        value={localConfig.motion_sensitivity || 'medium'}
                        onValueChange={(v) => updateLocalConfig('motion_sensitivity', v as MotionSensitivity)}
                      >
                        <SelectTrigger className="w-32">
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
                      <div className="flex items-center gap-3">
                        <Volume2 className="h-5 w-5 text-purple-500" />
                        <div>
                          <Label>Audio Enabled</Label>
                          <p className="text-sm text-muted-foreground">Enable speaker by default</p>
                        </div>
                      </div>
                      <Switch
                        checked={localConfig.audio_enabled !== false}
                        onCheckedChange={(v) => updateLocalConfig('audio_enabled', v)}
                      />
                    </div>

                    <div className="flex items-center justify-between">
                      <div>
                        <Label>LED Enabled</Label>
                        <p className="text-sm text-muted-foreground">Enable LED indicators by default</p>
                      </div>
                      <Switch
                        checked={localConfig.led_enabled !== false}
                        onCheckedChange={(v) => updateLocalConfig('led_enabled', v)}
                      />
                    </div>
                  </div>
                </div>

                {/* GPS Power Management Section */}
                <div className="border-t pt-6 space-y-4">
                  <h4 className="text-sm font-medium flex items-center gap-2">
                    <Satellite className="h-4 w-4" />
                    GPS Power Management (Transit Mode)
                  </h4>
                  <p className="text-sm text-muted-foreground">
                    When enabled, GPS is disabled after no signal is acquired within the timeout period
                  </p>

                  <div className="flex items-center justify-between">
                    <div>
                      <Label>GPS Power Management</Label>
                      <p className="text-sm text-muted-foreground">
                        Disable GPS when no signal to save power
                      </p>
                    </div>
                    <Switch
                      checked={localConfig.gps_power_save_enabled !== false}
                      onCheckedChange={(v) => updateLocalConfig('gps_power_save_enabled', v)}
                    />
                  </div>

                  <div className="space-y-2">
                    <div className="flex justify-between">
                      <Label>Signal Timeout</Label>
                      <span className="text-sm text-muted-foreground">
                        {localConfig.gps_signal_timeout_min || 15} min
                      </span>
                    </div>
                    <Slider
                      value={[localConfig.gps_signal_timeout_min || 15]}
                      onValueChange={([v]) => updateLocalConfig('gps_signal_timeout_min', v)}
                      min={10}
                      max={30}
                      step={5}
                      disabled={localConfig.gps_power_save_enabled === false}
                    />
                    <p className="text-xs text-muted-foreground">
                      Time to wait for GPS signal before disabling GPS
                    </p>
                  </div>

                  <div className="space-y-2">
                    <div className="flex justify-between">
                      <Label>Retry Interval</Label>
                      <span className="text-sm text-muted-foreground">
                        {localConfig.gps_retry_interval_min || 30} min
                      </span>
                    </div>
                    <Slider
                      value={[localConfig.gps_retry_interval_min || 30]}
                      onValueChange={([v]) => updateLocalConfig('gps_retry_interval_min', v)}
                      min={5}
                      max={120}
                      step={5}
                      disabled={localConfig.gps_power_save_enabled === false}
                    />
                    <p className="text-xs text-muted-foreground">
                      Time between attempts to re-enable GPS after disabling
                    </p>
                  </div>
                </div>

                {/* Save Button */}
                <div className="border-t pt-6">
                  <Button
                    onClick={handleSave}
                    disabled={!hasChanges || updateDefaults.isPending}
                    className="w-full sm:w-auto"
                  >
                    {updateDefaults.isPending ? 'Saving...' : 'Save Fleet Defaults'}
                  </Button>
                  {updateDefaults.isSuccess && !hasChanges && (
                    <span className="ml-3 text-sm text-green-600">
                      Defaults saved and synced to Notehub!
                    </span>
                  )}
                  {fleetConfig?.updated_at && (
                    <p className="mt-2 text-sm text-muted-foreground">
                      Last updated: {new Date(fleetConfig.updated_at).toLocaleString()}
                      {fleetConfig.updated_by && ` by ${fleetConfig.updated_by}`}
                    </p>
                  )}
                  <p className="mt-1 text-xs text-muted-foreground">
                    Fleet defaults are saved as environment variables in Notehub and will apply to all devices in the fleet on their next sync.
                  </p>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
