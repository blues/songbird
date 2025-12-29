/**
 * Config hooks using TanStack Query
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getDeviceConfig, updateDeviceConfig, updateFleetConfig } from '@/api/config';
import type { DeviceConfig } from '@/types';

/**
 * Hook to fetch device configuration
 */
export function useDeviceConfig(serialNumber: string) {
  return useQuery({
    queryKey: ['config', serialNumber],
    queryFn: () => getDeviceConfig(serialNumber),
    staleTime: 60_000, // Config doesn't change frequently
    enabled: !!serialNumber,
  });
}

/**
 * Hook to update device configuration
 */
export function useUpdateDeviceConfig() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      serialNumber,
      config,
    }: {
      serialNumber: string;
      config: Partial<DeviceConfig>;
    }) => updateDeviceConfig(serialNumber, config),
    onSuccess: (_, { serialNumber }) => {
      queryClient.invalidateQueries({ queryKey: ['config', serialNumber] });
    },
  });
}

/**
 * Hook to update fleet configuration
 */
export function useUpdateFleetConfig() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      fleetUid,
      config,
    }: {
      fleetUid: string;
      config: Partial<DeviceConfig>;
    }) => updateFleetConfig(fleetUid, config),
    onSuccess: () => {
      // Invalidate all config queries since fleet config affects all devices
      queryClient.invalidateQueries({ queryKey: ['config'] });
    },
  });
}
