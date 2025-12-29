/**
 * Config API
 */

import { apiGet, apiPut } from './client';
import type { ConfigResponse, DeviceConfig } from '@/types';

/**
 * Get device configuration
 */
export async function getDeviceConfig(serialNumber: string): Promise<ConfigResponse> {
  return apiGet<ConfigResponse>(`/v1/devices/${serialNumber}/config`);
}

/**
 * Update device configuration
 */
export async function updateDeviceConfig(
  serialNumber: string,
  config: Partial<DeviceConfig>
): Promise<ConfigResponse> {
  return apiPut<ConfigResponse>(`/v1/devices/${serialNumber}/config`, config);
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
