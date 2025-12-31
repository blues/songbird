/**
 * Firmware Hooks
 *
 * React Query hooks for host firmware management.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  getHostFirmware,
  queueFirmwareUpdate,
  cancelFirmwareUpdate,
  getDfuStatus,
} from '@/api/firmware';
import type { FirmwareUpdateRequest } from '@/types';

/**
 * Hook to fetch available host firmware
 */
export function useHostFirmware() {
  return useQuery({
    queryKey: ['hostFirmware'],
    queryFn: getHostFirmware,
    staleTime: 5 * 60_000, // 5 minutes - firmware list doesn't change often
  });
}

/**
 * Hook to fetch current DFU status
 */
export function useDfuStatus(enabled = true) {
  return useQuery({
    queryKey: ['dfuStatus'],
    queryFn: getDfuStatus,
    refetchInterval: 10_000, // Poll every 10 seconds
    staleTime: 5_000,
    enabled,
  });
}

/**
 * Hook to queue a firmware update
 */
export function useQueueFirmwareUpdate() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (request: FirmwareUpdateRequest) => queueFirmwareUpdate(request),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['dfuStatus'] });
    },
  });
}

/**
 * Hook to cancel firmware updates
 */
export function useCancelFirmwareUpdate() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ fleetUID, deviceUID }: { fleetUID?: string; deviceUID?: string } = {}) =>
      cancelFirmwareUpdate(fleetUID, deviceUID),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['dfuStatus'] });
    },
  });
}
