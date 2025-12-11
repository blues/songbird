/**
 * Config API
 */

import { apiGet, apiPut } from './client';
import type { ConfigResponse, DeviceConfig } from '@/types';

/**
 * Get device configuration
 */
export async function getDeviceConfig(deviceUid: string): Promise<ConfigResponse> {
  return apiGet<ConfigResponse>(`/v1/devices/${deviceUid}/config`);
}

/**
 * Update device configuration
 */
export async function updateDeviceConfig(
  deviceUid: string,
  config: Partial<DeviceConfig>
): Promise<ConfigResponse> {
  return apiPut<ConfigResponse>(`/v1/devices/${deviceUid}/config`, config);
}

/**
 * Update fleet configuration
 */
export async function updateFleetConfig(
  fleetUid: string,
  config: Partial<DeviceConfig>
): Promise<ConfigResponse> {
  return apiPut<ConfigResponse>(`/v1/fleets/${fleetUid}/config`, config);
}
