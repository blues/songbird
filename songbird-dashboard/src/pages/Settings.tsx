/**
 * Settings Page
 *
 * Provides user preferences and admin settings management.
 */

import { useState } from 'react';
import { Settings as SettingsIcon, User, Users, Building2, Cloud, HardDrive, FlaskConical } from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useIsAdmin } from '@/hooks/useAuth';
import { DisplayPreferences } from '@/components/settings/DisplayPreferences';
import { FleetDefaults } from '@/components/settings/FleetDefaults';
import { NotehubConnection } from '@/components/settings/NotehubConnection';
import { UserManagement } from '@/components/settings/UserManagement';
import { FirmwareManagement } from '@/components/settings/FirmwareManagement';
import { FeatureFlags } from '@/components/settings/FeatureFlags';

export function Settings() {
  const { isAdmin, isLoading } = useIsAdmin();
  const [activeTab, setActiveTab] = useState('preferences');

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-muted-foreground">Loading...</div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <SettingsIcon className="h-8 w-8" />
        <div>
          <h1 className="text-3xl font-bold">Settings</h1>
          <p className="text-muted-foreground">
            Manage your preferences and {isAdmin ? 'system settings' : 'account'}
          </p>
        </div>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-6">
        {/* Mobile: vertical stacked tabs */}
        <TabsList className="sm:hidden flex flex-col h-auto w-full">
          <TabsTrigger value="preferences" className="gap-2 w-full justify-start">
            <User className="h-4 w-4" />
            Display Preferences
          </TabsTrigger>
          {isAdmin && (
            <TabsTrigger value="fleet-defaults" className="gap-2 w-full justify-start">
              <Building2 className="h-4 w-4" />
              Fleet Defaults
            </TabsTrigger>
          )}
          {isAdmin && (
            <TabsTrigger value="firmware" className="gap-2 w-full justify-start">
              <HardDrive className="h-4 w-4" />
              Firmware
            </TabsTrigger>
          )}
          <TabsTrigger value="notehub" className="gap-2 w-full justify-start">
            <Cloud className="h-4 w-4" />
            Notehub Connection
          </TabsTrigger>
          {isAdmin && (
            <TabsTrigger value="users" className="gap-2 w-full justify-start">
              <Users className="h-4 w-4" />
              User Management
            </TabsTrigger>
          )}
          {isAdmin && (
            <TabsTrigger value="feature-flags" className="gap-2 w-full justify-start">
              <FlaskConical className="h-4 w-4" />
              Feature Flags
            </TabsTrigger>
          )}
        </TabsList>

        {/* Desktop: horizontal tabs (original style) */}
        <TabsList className="hidden sm:inline-flex">
          <TabsTrigger value="preferences" className="gap-2">
            <User className="h-4 w-4" />
            Display Preferences
          </TabsTrigger>
          {isAdmin && (
            <TabsTrigger value="fleet-defaults" className="gap-2">
              <Building2 className="h-4 w-4" />
              Fleet Defaults
            </TabsTrigger>
          )}
          {isAdmin && (
            <TabsTrigger value="firmware" className="gap-2">
              <HardDrive className="h-4 w-4" />
              Firmware
            </TabsTrigger>
          )}
          <TabsTrigger value="notehub" className="gap-2">
            <Cloud className="h-4 w-4" />
            Notehub Connection
          </TabsTrigger>
          {isAdmin && (
            <TabsTrigger value="users" className="gap-2">
              <Users className="h-4 w-4" />
              User Management
            </TabsTrigger>
          )}
          {isAdmin && (
            <TabsTrigger value="feature-flags" className="gap-2">
              <FlaskConical className="h-4 w-4" />
              Feature Flags
            </TabsTrigger>
          )}
        </TabsList>

        <TabsContent value="preferences">
          <DisplayPreferences />
        </TabsContent>

        {isAdmin && (
          <TabsContent value="fleet-defaults">
            <FleetDefaults />
          </TabsContent>
        )}

        {isAdmin && (
          <TabsContent value="firmware">
            <FirmwareManagement />
          </TabsContent>
        )}

        <TabsContent value="notehub">
          <NotehubConnection />
        </TabsContent>

        {isAdmin && (
          <TabsContent value="users">
            <UserManagement />
          </TabsContent>
        )}

        {isAdmin && (
          <TabsContent value="feature-flags">
            <FeatureFlags />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
