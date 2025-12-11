/**
 * Telemetry API
 */

import { apiGet } from './client';
import type { TelemetryResponse, LocationResponse } from '@/types';

/**
 * Get telemetry data for a device
 */
export async function getTelemetry(
  deviceUid: string,
  hours: number = 24,
  limit: number = 1000
): Promise<TelemetryResponse> {
  return apiGet<TelemetryResponse>(`/v1/devices/${deviceUid}/telemetry`, {
    hours,
    limit,
  });
}

/**
 * Get location history for a device
 */
export async function getLocationHistory(
  deviceUid: string,
  hours: number = 24,
  limit: number = 1000
): Promise<LocationResponse> {
  return apiGet<LocationResponse>(`/v1/devices/${deviceUid}/location`, {
    hours,
    limit,
  });
}
