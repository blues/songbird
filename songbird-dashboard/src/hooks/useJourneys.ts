/**
 * Journey hooks using TanStack Query
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getJourneys, getJourneyDetail, getLocationHistoryFull, matchJourney, deleteJourney } from '@/api/journeys';

/**
 * Hook to fetch all journeys for a device
 */
export function useJourneys(
  serialNumber: string,
  status?: 'active' | 'completed',
  limit: number = 50
) {
  return useQuery({
    queryKey: ['journeys', serialNumber, status, limit],
    queryFn: () => getJourneys(serialNumber, status, limit),
    refetchInterval: 30_000, // Poll every 30 seconds
    staleTime: 15_000,
    enabled: !!serialNumber,
  });
}

/**
 * Hook to fetch a specific journey with all its points
 */
export function useJourneyDetail(
  serialNumber: string,
  journeyId: number | null
) {
  return useQuery({
    queryKey: ['journey', serialNumber, journeyId],
    queryFn: () => getJourneyDetail(serialNumber, journeyId!),
    refetchInterval: 30_000, // Poll every 30 seconds for active journeys
    staleTime: 15_000,
    enabled: !!serialNumber && journeyId !== null,
  });
}

/**
 * Hook to fetch location history from all sources
 */
export function useLocationHistoryFull(
  serialNumber: string,
  hours: number = 24,
  source?: 'gps' | 'cell' | 'triangulation'
) {
  return useQuery({
    queryKey: ['locations', serialNumber, hours, source],
    queryFn: () => getLocationHistoryFull(serialNumber, hours, source),
    refetchInterval: 30_000,
    staleTime: 15_000,
    enabled: !!serialNumber,
  });
}

/**
 * Hook to get the most recent journey
 */
export function useLatestJourney(serialNumber: string) {
  const { data, ...rest } = useJourneys(serialNumber, undefined, 1);

  return {
    ...rest,
    data: data?.journeys?.[0] || null,
  };
}

/**
 * Hook to trigger map matching for a journey
 * Returns snapped-to-road route from Mapbox Map Matching API
 */
export function useMapMatch(serialNumber: string, journeyId: number | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => {
      if (!journeyId) throw new Error('Journey ID required');
      return matchJourney(serialNumber, journeyId);
    },
    onSuccess: () => {
      // Invalidate the journey detail query to refetch with matched_route
      queryClient.invalidateQueries({ queryKey: ['journey', serialNumber, journeyId] });
    },
  });
}

/**
 * Hook to delete a journey (admin/owner only)
 * Deletes the journey and all associated location points
 */
export function useDeleteJourney() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ serialNumber, journeyId }: { serialNumber: string; journeyId: number }) =>
      deleteJourney(serialNumber, journeyId),
    onSuccess: (_, { serialNumber }) => {
      // Invalidate journeys list to refetch
      queryClient.invalidateQueries({ queryKey: ['journeys', serialNumber] });
      // Also invalidate location history since points were deleted
      queryClient.invalidateQueries({ queryKey: ['locations', serialNumber] });
    },
  });
}
