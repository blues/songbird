/**
 * Devices API
 */

import { apiGet, apiPatch } from './client';
import type { Device, DevicesResponse } from '@/types';

/**
 * Get all devices
 */
export async function getDevices(fleetUid?: string): Promise<DevicesResponse> {
  const params = fleetUid ? { fleet_uid: fleetUid } : undefined;
  return apiGet<DevicesResponse>('/v1/devices', params);
}

/**
 * Get a single device by serial number
 */
export async function getDevice(serialNumber: string): Promise<Device> {
  return apiGet<Device>(`/v1/devices/${serialNumber}`);
}

/**
 * Update device metadata
 */
export async function updateDevice(
  serialNumber: string,
  updates: Partial<Pick<Device, 'name' | 'assigned_to' | 'fleet_uid'>>
): Promise<Device> {
  return apiPatch<Device>(`/v1/devices/${serialNumber}`, updates);
}
