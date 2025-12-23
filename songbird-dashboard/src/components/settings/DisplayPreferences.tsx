/**
 * Display Preferences Component
 *
 * Allows users to configure their display preferences.
 */

import { useState, useEffect } from 'react';
import { Thermometer, Clock, Map, Timer, Ruler } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useUserProfile, useUpdatePreferences } from '@/hooks/useUserProfile';
import type { DisplayPreferences as DisplayPreferencesType } from '@/types';

export function DisplayPreferences() {
  const { data: profile, isLoading } = useUserProfile();
  const updatePreferences = useUpdatePreferences();

  const [localPrefs, setLocalPrefs] = useState<DisplayPreferencesType>({
    temp_unit: 'celsius',
    time_format: '24h',
    default_time_range: '24',
    map_style: 'street',
    distance_unit: 'km',
  });
  const [hasChanges, setHasChanges] = useState(false);

  useEffect(() => {
    if (profile?.preferences) {
      setLocalPrefs(profile.preferences);
      setHasChanges(false);
    }
  }, [profile]);

  const updateLocalPref = <K extends keyof DisplayPreferencesType>(
    key: K,
    value: DisplayPreferencesType[K]
  ) => {
    setLocalPrefs(prev => ({ ...prev, [key]: value }));
    setHasChanges(true);
  };

  const handleSave = () => {
    updatePreferences.mutate(localPrefs);
    setHasChanges(false);
  };

  if (isLoading) {
    return (
      <Card>
        <CardContent className="py-8">
          <div className="text-center text-muted-foreground">Loading preferences...</div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Display Preferences</CardTitle>
        <CardDescription>
          Customize how data is displayed throughout the dashboard
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Temperature Unit */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Thermometer className="h-5 w-5 text-orange-500" />
            <div>
              <Label>Temperature Unit</Label>
              <p className="text-sm text-muted-foreground">
                Display temperatures in Celsius or Fahrenheit
              </p>
            </div>
          </div>
          <Select
            value={localPrefs.temp_unit}
            onValueChange={(v) => updateLocalPref('temp_unit', v as DisplayPreferencesType['temp_unit'])}
          >
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="celsius">Celsius (°C)</SelectItem>
              <SelectItem value="fahrenheit">Fahrenheit (°F)</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Time Format */}
        <div className="flex items-center justify-between border-t pt-6">
          <div className="flex items-center gap-3">
            <Clock className="h-5 w-5 text-blue-500" />
            <div>
              <Label>Time Format</Label>
              <p className="text-sm text-muted-foreground">
                12-hour or 24-hour time display
              </p>
            </div>
          </div>
          <Select
            value={localPrefs.time_format}
            onValueChange={(v) => updateLocalPref('time_format', v as DisplayPreferencesType['time_format'])}
          >
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="12h">12-hour</SelectItem>
              <SelectItem value="24h">24-hour</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Default Time Range */}
        <div className="flex items-center justify-between border-t pt-6">
          <div className="flex items-center gap-3">
            <Timer className="h-5 w-5 text-purple-500" />
            <div>
              <Label>Default Chart Time Range</Label>
              <p className="text-sm text-muted-foreground">
                Default time range for telemetry charts
              </p>
            </div>
          </div>
          <Select
            value={localPrefs.default_time_range}
            onValueChange={(v) => updateLocalPref('default_time_range', v as DisplayPreferencesType['default_time_range'])}
          >
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="1">1 hour</SelectItem>
              <SelectItem value="4">4 hours</SelectItem>
              <SelectItem value="8">8 hours</SelectItem>
              <SelectItem value="12">12 hours</SelectItem>
              <SelectItem value="24">24 hours</SelectItem>
              <SelectItem value="48">48 hours</SelectItem>
              <SelectItem value="168">7 days</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Map Style */}
        <div className="flex items-center justify-between border-t pt-6">
          <div className="flex items-center gap-3">
            <Map className="h-5 w-5 text-green-500" />
            <div>
              <Label>Default Map Style</Label>
              <p className="text-sm text-muted-foreground">
                Street view or satellite imagery
              </p>
            </div>
          </div>
          <Select
            value={localPrefs.map_style}
            onValueChange={(v) => updateLocalPref('map_style', v as DisplayPreferencesType['map_style'])}
          >
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="street">Street</SelectItem>
              <SelectItem value="satellite">Satellite</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Distance Unit */}
        <div className="flex items-center justify-between border-t pt-6">
          <div className="flex items-center gap-3">
            <Ruler className="h-5 w-5 text-indigo-500" />
            <div>
              <Label>Distance Unit</Label>
              <p className="text-sm text-muted-foreground">
                Display distances in kilometers or miles
              </p>
            </div>
          </div>
          <Select
            value={localPrefs.distance_unit}
            onValueChange={(v) => updateLocalPref('distance_unit', v as DisplayPreferencesType['distance_unit'])}
          >
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="km">Kilometers (km)</SelectItem>
              <SelectItem value="mi">Miles (mi)</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Save Button */}
        <div className="border-t pt-6">
          <Button
            onClick={handleSave}
            disabled={!hasChanges || updatePreferences.isPending}
            className="w-full sm:w-auto"
          >
            {updatePreferences.isPending ? 'Saving...' : 'Save Preferences'}
          </Button>
          {updatePreferences.isSuccess && !hasChanges && (
            <span className="ml-3 text-sm text-green-600">Preferences saved!</span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
