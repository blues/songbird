import { useState, useMemo } from 'react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { DeviceCard } from './DeviceCard';
import type { Device } from '@/types';

type SortField = 'last_seen' | 'serial_number' | 'owner' | 'name' | 'status' | 'battery' | 'temperature';
type SortDirection = 'asc' | 'desc';
type SortOption = `${SortField}:${SortDirection}`;

interface DeviceListProps {
  devices: Device[];
  loading?: boolean;
  alertsByDevice?: Record<string, number>;
}

export function DeviceList({ devices, loading, alertsByDevice = {} }: DeviceListProps) {
  const [sortOption, setSortOption] = useState<SortOption>('last_seen:desc');

  const sortedDevices = useMemo(() => {
    const [field, direction] = sortOption.split(':') as [SortField, SortDirection];
    return [...devices].sort((a, b) => {
      let comparison = 0;
      switch (field) {
        case 'name':
          comparison = (a.name || a.serial_number || a.device_uid).localeCompare(
            b.name || b.serial_number || b.device_uid
          );
          break;
        case 'serial_number':
          comparison = (a.serial_number || a.device_uid).localeCompare(
            b.serial_number || b.device_uid
          );
          break;
        case 'owner':
          comparison = (a.assigned_to_name || a.assigned_to || '').localeCompare(
            b.assigned_to_name || b.assigned_to || ''
          );
          break;
        case 'status':
          comparison = (a.status || '').localeCompare(b.status || '');
          break;
        case 'temperature':
          comparison = (a.temperature || 0) - (b.temperature || 0);
          break;
        case 'battery':
          comparison = (a.voltage || 0) - (b.voltage || 0);
          break;
        case 'last_seen':
          comparison =
            new Date(a.last_seen || 0).getTime() - new Date(b.last_seen || 0).getTime();
          break;
      }
      return direction === 'asc' ? comparison : -comparison;
    });
  }, [devices, sortOption]);

  if (loading) {
    return (
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {[...Array(6)].map((_, i) => (
          <div key={i} className="h-48 rounded-lg border bg-muted animate-pulse" />
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
    <div className="space-y-4">
      <div className="flex justify-end">
        <Select value={sortOption} onValueChange={(v) => setSortOption(v as SortOption)}>
          <SelectTrigger className="w-[200px]">
            <SelectValue placeholder="Sort by" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="last_seen:desc">Last Activity (newest)</SelectItem>
            <SelectItem value="last_seen:asc">Last Activity (oldest)</SelectItem>
            <SelectItem value="serial_number:asc">Serial Number A–Z</SelectItem>
            <SelectItem value="serial_number:desc">Serial Number Z–A</SelectItem>
            <SelectItem value="owner:asc">Owner A–Z</SelectItem>
            <SelectItem value="owner:desc">Owner Z–A</SelectItem>
            <SelectItem value="name:asc">Device Name A–Z</SelectItem>
            <SelectItem value="name:desc">Device Name Z–A</SelectItem>
            <SelectItem value="status:asc">Status A–Z</SelectItem>
            <SelectItem value="battery:desc">Battery High–Low</SelectItem>
            <SelectItem value="battery:asc">Battery Low–High</SelectItem>
            <SelectItem value="temperature:desc">Temp High–Low</SelectItem>
            <SelectItem value="temperature:asc">Temp Low–High</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {sortedDevices.map((device) => (
          <DeviceCard
            key={device.device_uid}
            device={device}
            alertCount={alertsByDevice[device.device_uid] || 0}
          />
        ))}
      </div>
    </div>
  );
}
