/**
 * Activity feed hook using TanStack Query
 */

import { useQuery } from '@tanstack/react-query';
import { getActivity } from '@/api/activity';

/**
 * Hook to fetch recent activity feed
 */
export function useActivity(hours: number = 24, limit: number = 50) {
  return useQuery({
    queryKey: ['activity', hours, limit],
    queryFn: () => getActivity(hours, limit),
    refetchInterval: 30_000, // Poll every 30 seconds
    staleTime: 15_000,
  });
}
