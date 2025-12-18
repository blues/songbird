/**
 * Activity Feed API
 */

import { apiGet } from './client';
import type { ActivityItem } from '@/types';

export interface ActivityResponse {
  hours: number;
  count: number;
  activities: ActivityItem[];
}

/**
 * Get recent activity feed across all devices
 */
export async function getActivity(
  hours: number = 24,
  limit: number = 50
): Promise<ActivityResponse> {
  return apiGet<ActivityResponse>('/v1/activity', {
    hours,
    limit,
  });
}
