/**
 * Settings Hooks
 *
 * React Query hooks for fleet defaults management.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getFleetDefaults, getAllFleetDefaults, updateFleetDefaults } from '@/api/settings';
import { getNotehubFleets } from '@/api/notehub';
import type { FleetDefaults } from '@/types';

export function useFleetDefaults(fleetUid?: string) {
  return useQuery({
    queryKey: ['fleetDefaults', fleetUid],
    queryFn: () => getFleetDefaults(fleetUid!),
    enabled: !!fleetUid,
    staleTime: 60_000,
  });
}

export function useAllFleetDefaults() {
  return useQuery({
    queryKey: ['allFleetDefaults'],
    queryFn: getAllFleetDefaults,
    staleTime: 60_000,
  });
}

export function useUpdateFleetDefaults() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ fleetUid, config }: { fleetUid: string; config: Partial<FleetDefaults> }) =>
      updateFleetDefaults(fleetUid, config),
    onSuccess: (_, { fleetUid }) => {
      queryClient.invalidateQueries({ queryKey: ['fleetDefaults', fleetUid] });
      queryClient.invalidateQueries({ queryKey: ['allFleetDefaults'] });
    },
  });
}

export function useNotehubFleets() {
  return useQuery({
    queryKey: ['notehubFleets'],
    queryFn: getNotehubFleets,
    staleTime: 5 * 60_000, // 5 minutes
  });
}
