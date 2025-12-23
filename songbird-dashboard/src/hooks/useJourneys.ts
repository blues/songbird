/**
 * Journey hooks using TanStack Query
 */

import { useQuery } from '@tanstack/react-query';
import { getJourneys, getJourneyDetail, getLocationHistoryFull } from '@/api/journeys';

/**
 * Hook to fetch all journeys for a device
 */
export function useJourneys(
  deviceUid: string,
  status?: 'active' | 'completed',
  limit: number = 50
) {
  return useQuery({
    queryKey: ['journeys', deviceUid, status, limit],
    queryFn: () => getJourneys(deviceUid, status, limit),
    refetchInterval: 30_000, // Poll every 30 seconds
    staleTime: 15_000,
    enabled: !!deviceUid,
  });
}

/**
 * Hook to fetch a specific journey with all its points
 */
export function useJourneyDetail(
  deviceUid: string,
  journeyId: number | null
) {
  return useQuery({
    queryKey: ['journey', deviceUid, journeyId],
    queryFn: () => getJourneyDetail(deviceUid, journeyId!),
    refetchInterval: 30_000, // Poll every 30 seconds for active journeys
    staleTime: 15_000,
    enabled: !!deviceUid && journeyId !== null,
  });
}

/**
 * Hook to fetch location history from all sources
 */
export function useLocationHistoryFull(
  deviceUid: string,
  hours: number = 24,
  source?: 'gps' | 'cell' | 'triangulation'
) {
  return useQuery({
    queryKey: ['locations', deviceUid, hours, source],
    queryFn: () => getLocationHistoryFull(deviceUid, hours, source),
    refetchInterval: 30_000,
    staleTime: 15_000,
    enabled: !!deviceUid,
  });
}

/**
 * Hook to get the most recent journey
 */
export function useLatestJourney(deviceUid: string) {
  const { data, ...rest } = useJourneys(deviceUid, undefined, 1);

  return {
    ...rest,
    data: data?.journeys?.[0] || null,
  };
}
