/**
 * Journeys API
 */

import { apiGet, apiPost } from './client';
import type { JourneysResponse, JourneyDetailResponse, LocationHistoryResponse, MapMatchResponse } from '@/types';

/**
 * Get all journeys for a device
 */
export async function getJourneys(
  deviceUid: string,
  status?: 'active' | 'completed',
  limit: number = 50
): Promise<JourneysResponse> {
  const params: Record<string, any> = { limit };
  if (status) {
    params.status = status;
  }
  return apiGet<JourneysResponse>(`/v1/devices/${deviceUid}/journeys`, params);
}

/**
 * Get a specific journey with all its location points
 */
export async function getJourneyDetail(
  deviceUid: string,
  journeyId: number
): Promise<JourneyDetailResponse> {
  return apiGet<JourneyDetailResponse>(`/v1/devices/${deviceUid}/journeys/${journeyId}`);
}

/**
 * Trigger map matching for a journey
 * Returns the matched route snapped to roads
 */
export async function matchJourney(
  deviceUid: string,
  journeyId: number
): Promise<MapMatchResponse> {
  return apiPost<MapMatchResponse>(`/v1/devices/${deviceUid}/journeys/${journeyId}/match`);
}

/**
 * Get location history for a device (all location sources)
 */
export async function getLocationHistoryFull(
  deviceUid: string,
  hours: number = 24,
  source?: 'gps' | 'cell' | 'triangulation',
  limit: number = 1000
): Promise<LocationHistoryResponse> {
  const params: Record<string, any> = { hours, limit };
  if (source) {
    params.source = source;
  }
  return apiGet<LocationHistoryResponse>(`/v1/devices/${deviceUid}/locations`, params);
}
