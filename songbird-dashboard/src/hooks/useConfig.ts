/**
 * Config hooks using TanStack Query
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getDeviceConfig, updateDeviceConfig, updateFleetConfig } from '@/api/config';
import type { DeviceConfig } from '@/types';

/**
 * Hook to fetch device configuration
 */
export function useDeviceConfig(deviceUid: string) {
  return useQuery({
    queryKey: ['config', deviceUid],
    queryFn: () => getDeviceConfig(deviceUid),
    staleTime: 60_000, // Config doesn't change frequently
    enabled: !!deviceUid,
  });
}

/**
 * Hook to update device configuration
 */
export function useUpdateDeviceConfig() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      deviceUid,
      config,
    }: {
      deviceUid: string;
      config: Partial<DeviceConfig>;
    }) => updateDeviceConfig(deviceUid, config),
    onSuccess: (_, { deviceUid }) => {
      queryClient.invalidateQueries({ queryKey: ['config', deviceUid] });
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
