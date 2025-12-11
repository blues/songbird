/**
 * Device hooks using TanStack Query
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getDevices, getDevice, updateDevice } from '@/api/devices';
import type { Device } from '@/types';

/**
 * Hook to fetch all devices
 */
export function useDevices(fleetUid?: string) {
  return useQuery({
    queryKey: ['devices', fleetUid],
    queryFn: () => getDevices(fleetUid),
    refetchInterval: 60_000, // Poll every minute
    staleTime: 30_000,
  });
}

/**
 * Hook to fetch a single device
 */
export function useDevice(deviceUid: string) {
  return useQuery({
    queryKey: ['device', deviceUid],
    queryFn: () => getDevice(deviceUid),
    refetchInterval: 30_000, // Poll every 30 seconds
    staleTime: 15_000,
    enabled: !!deviceUid,
  });
}

/**
 * Hook to update a device
 */
export function useUpdateDevice() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      deviceUid,
      updates,
    }: {
      deviceUid: string;
      updates: Partial<Pick<Device, 'name' | 'assigned_to' | 'fleet_uid'>>;
    }) => updateDevice(deviceUid, updates),
    onSuccess: (_, { deviceUid }) => {
      queryClient.invalidateQueries({ queryKey: ['device', deviceUid] });
      queryClient.invalidateQueries({ queryKey: ['devices'] });
    },
  });
}
