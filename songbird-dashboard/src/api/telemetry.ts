/**
 * Telemetry API
 */

import { apiGet } from './client';
import type { TelemetryResponse, LocationResponse, PowerResponse, HealthResponse } from '@/types';

/**
 * Get telemetry data for a device
 */
export async function getTelemetry(
  serialNumber: string,
  hours: number = 24,
  limit: number = 1000
): Promise<TelemetryResponse> {
  return apiGet<TelemetryResponse>(`/v1/devices/${serialNumber}/telemetry`, {
    hours,
    limit,
  });
}

/**
 * Get location history for a device
 */
export async function getLocationHistory(
  serialNumber: string,
  hours: number = 24,
  limit: number = 1000
): Promise<LocationResponse> {
  return apiGet<LocationResponse>(`/v1/devices/${serialNumber}/location`, {
    hours,
    limit,
  });
}

/**
 * Get Mojo power monitoring history for a device
 */
export async function getPowerHistory(
  serialNumber: string,
  hours: number = 24,
  limit: number = 1000
): Promise<PowerResponse> {
  return apiGet<PowerResponse>(`/v1/devices/${serialNumber}/power`, {
    hours,
    limit,
  });
}

/**
 * Get health event history for a device (_health.qo)
 */
export async function getHealthHistory(
  serialNumber: string,
  hours: number = 168, // Default to 7 days for health events
  limit: number = 100
): Promise<HealthResponse> {
  return apiGet<HealthResponse>(`/v1/devices/${serialNumber}/health`, {
    hours,
    limit,
  });
}
