/**
 * Device hooks using TanStack Query
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getDevices, getDevice, updateDevice, mergeDevices } from '@/api/devices';
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
export function useDevice(serialNumber: string) {
  return useQuery({
    queryKey: ['device', serialNumber],
    queryFn: () => getDevice(serialNumber),
    refetchInterval: 30_000, // Poll every 30 seconds
    staleTime: 15_000,
    enabled: !!serialNumber,
  });
}

/**
 * Hook to update a device
 */
export function useUpdateDevice() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      serialNumber,
      updates,
    }: {
      serialNumber: string;
      updates: Partial<Pick<Device, 'name' | 'assigned_to' | 'fleet_uid'>>;
    }) => updateDevice(serialNumber, updates),
    onSuccess: (_, { serialNumber }) => {
      queryClient.invalidateQueries({ queryKey: ['device', serialNumber] });
      queryClient.invalidateQueries({ queryKey: ['devices'] });
    },
  });
}

/**
 * Hook to merge two devices (Admin only)
 */
export function useMergeDevices() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      sourceSerialNumber,
      targetSerialNumber,
    }: {
      sourceSerialNumber: string;
      targetSerialNumber: string;
    }) => mergeDevices(sourceSerialNumber, targetSerialNumber),
    onSuccess: () => {
      // Invalidate all device queries to refresh the list
      queryClient.invalidateQueries({ queryKey: ['devices'] });
      queryClient.invalidateQueries({ queryKey: ['device'] });
    },
  });
}
