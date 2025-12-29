/**
 * Journeys API
 */

import { apiGet, apiPost, apiDelete } from './client';
import type { JourneysResponse, JourneyDetailResponse, LocationHistoryResponse, MapMatchResponse } from '@/types';

/**
 * Get all journeys for a device
 */
export async function getJourneys(
  serialNumber: string,
  status?: 'active' | 'completed',
  limit: number = 50
): Promise<JourneysResponse> {
  const params: Record<string, any> = { limit };
  if (status) {
    params.status = status;
  }
  return apiGet<JourneysResponse>(`/v1/devices/${serialNumber}/journeys`, params);
}

/**
 * Get a specific journey with all its location points
 */
export async function getJourneyDetail(
  serialNumber: string,
  journeyId: number
): Promise<JourneyDetailResponse> {
  return apiGet<JourneyDetailResponse>(`/v1/devices/${serialNumber}/journeys/${journeyId}`);
}

/**
 * Trigger map matching for a journey
 * Returns the matched route snapped to roads
 */
export async function matchJourney(
  serialNumber: string,
  journeyId: number
): Promise<MapMatchResponse> {
  return apiPost<MapMatchResponse>(`/v1/devices/${serialNumber}/journeys/${journeyId}/match`);
}

/**
 * Get location history for a device (all location sources)
 */
export async function getLocationHistoryFull(
  serialNumber: string,
  hours: number = 24,
  source?: 'gps' | 'cell' | 'triangulation',
  limit: number = 1000
): Promise<LocationHistoryResponse> {
  const params: Record<string, any> = { hours, limit };
  if (source) {
    params.source = source;
  }
  return apiGet<LocationHistoryResponse>(`/v1/devices/${serialNumber}/locations`, params);
}

/**
 * Delete a journey and all its location points (admin/owner only)
 */
export async function deleteJourney(
  serialNumber: string,
  journeyId: number
): Promise<{ message: string; journey_id: number; points_deleted: number }> {
  return apiDelete(`/v1/devices/${serialNumber}/journeys/${journeyId}`);
}
