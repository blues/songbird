import { DeviceCard } from './DeviceCard';
import type { Device } from '@/types';

interface DeviceListProps {
  devices: Device[];
  loading?: boolean;
  alertsByDevice?: Record<string, number>;
}

export function DeviceList({ devices, loading, alertsByDevice = {} }: DeviceListProps) {
  if (loading) {
    return (
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {[...Array(6)].map((_, i) => (
          <div
            key={i}
            className="h-48 rounded-lg border bg-muted animate-pulse"
          />
        ))}
      </div>
    );
  }

  if (devices.length === 0) {
    return (
      <div className="text-center py-12">
        <p className="text-muted-foreground">No devices found</p>
      </div>
    );
  }

  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
      {devices.map((device) => (
        <DeviceCard
          key={device.device_uid}
          device={device}
          alertCount={alertsByDevice[device.device_uid] || 0}
        />
      ))}
    </div>
  );
}
