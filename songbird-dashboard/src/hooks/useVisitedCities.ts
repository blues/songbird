/**
 * Visited Cities hook using TanStack Query
 */

import { useQuery } from '@tanstack/react-query';
import { getVisitedCities } from '@/api/visitedCities';

/**
 * Hook to fetch all unique cities visited by a device
 * Aggregates location history to city level
 */
export function useVisitedCities(
  serialNumber: string,
  from?: string,
  to?: string
) {
  return useQuery({
    queryKey: ['visited-cities', serialNumber, from, to],
    queryFn: () => getVisitedCities(serialNumber, from, to),
    staleTime: 60_000, // Cache for 1 minute (historical data doesn't change often)
    enabled: !!serialNumber,
  });
}
