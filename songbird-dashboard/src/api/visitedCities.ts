/**
 * Visited Cities API
 */

import { apiGet } from './client';
import type { VisitedCitiesResponse } from '@/types';

/**
 * Get all unique cities visited by a device
 * Aggregates location history to city level
 */
export async function getVisitedCities(
  serialNumber: string,
  from?: string,
  to?: string
): Promise<VisitedCitiesResponse> {
  const params: Record<string, string> = {};
  if (from) {
    params.from = from;
  }
  if (to) {
    params.to = to;
  }
  return apiGet<VisitedCitiesResponse>(`/v1/devices/${serialNumber}/visited-cities`, params);
}
