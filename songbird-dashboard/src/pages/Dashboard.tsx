import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { StatsCards } from '@/components/devices/StatsCards';
import { DeviceList } from '@/components/devices/DeviceList';
import { FleetMap } from '@/components/maps/FleetMap';
import { useDevices } from '@/hooks/useDevices';
import { useActiveAlerts } from '@/hooks/useAlerts';
import { useActivity } from '@/hooks/useActivity';
import { formatRelativeTime } from '@/utils/formatters';
import type { DashboardStats } from '@/types';

interface DashboardProps {
  mapboxToken: string;
  selectedFleet?: string;
}

export function Dashboard({ mapboxToken, selectedFleet }: DashboardProps) {
  const navigate = useNavigate();
  const { data: devicesData, isLoading } = useDevices(
    selectedFleet === 'all' ? undefined : selectedFleet
  );
  const { data: alertsData } = useActiveAlerts();
  const { data: activityData, isLoading: activityLoading } = useActivity(24, 20);

  const devices = devicesData?.devices || [];
  const activeAlerts = alertsData?.alerts || [];
  const activeAlertCount = alertsData?.active_count || 0;
  const recentActivity = activityData?.activities || [];

  // Build a map of device_uid -> alert count for device cards
  const alertsByDevice = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const alert of activeAlerts) {
      counts[alert.device_uid] = (counts[alert.device_uid] || 0) + 1;
    }
    return counts;
  }, [activeAlerts]);

  // Calculate stats
  const stats: DashboardStats = useMemo(() => {
    const onlineCount = devices.filter((d) => d.status === 'online').length;
    const lowBatteryCount = devices.filter(
      (d) => d.voltage && d.voltage < 3.4
    ).length;

    return {
      total_devices: devices.length,
      online_devices: onlineCount,
      offline_devices: devices.length - onlineCount,
      active_alerts: activeAlertCount,
      low_battery_count: lowBatteryCount,
    };
  }, [devices, activeAlertCount]);

  const handleDeviceSelect = (deviceUid: string) => {
    navigate(`/devices/${deviceUid}`);
  };

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold">Fleet Dashboard</h1>

      {/* Stats Cards */}
      <StatsCards stats={stats} />

      {/* Map and Activity */}
      <div className="grid gap-6 lg:grid-cols-3">
        {/* Map */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Fleet Map</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <FleetMap
              devices={devices}
              mapboxToken={mapboxToken}
              onDeviceSelect={handleDeviceSelect}
              className="h-[400px] rounded-b-lg overflow-hidden"
            />
          </CardContent>
        </Card>

        {/* Recent Activity */}
        <Card>
          <CardHeader>
            <CardTitle>Recent Activity</CardTitle>
          </CardHeader>
          <CardContent>
            {activityLoading ? (
              <p className="text-sm text-muted-foreground text-center py-4">
                Loading activity...
              </p>
            ) : recentActivity.length > 0 ? (
              <div className="space-y-3 max-h-[350px] overflow-y-auto overflow-x-hidden">
                {recentActivity.map((item) => (
                  <div
                    key={item.id}
                    className="flex items-start gap-3 cursor-pointer hover:bg-muted p-2 rounded-md -mx-2"
                    onClick={() => handleDeviceSelect(item.device_uid)}
                  >
                    <div className="text-lg">
                      {item.type === 'alert' && '⚠️'}
                      {item.type === 'health' && '💓'}
                      {item.type === 'command' && '📡'}
                      {item.type === 'journey' && '🗺️'}
                      {item.type === 'mode_change' && '🔄'}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">
                        {item.device_name || item.device_uid}
                      </p>
                      <p className="text-xs text-muted-foreground truncate">
                        {item.message}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {formatRelativeTime(item.timestamp)}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground text-center py-4">
                No recent activity
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Device List */}
      <div>
        <h2 className="text-xl font-semibold mb-4">All Devices</h2>
        <DeviceList devices={devices} loading={isLoading} alertsByDevice={alertsByDevice} />
      </div>
    </div>
  );
}
