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
 * Get a single device by UID
 */
export async function getDevice(deviceUid: string): Promise<Device> {
  return apiGet<Device>(`/v1/devices/${deviceUid}`);
}

/**
 * Update device metadata
 */
export async function updateDevice(
  deviceUid: string,
  updates: Partial<Pick<Device, 'name' | 'assigned_to' | 'fleet_uid'>>
): Promise<Device> {
  return apiPatch<Device>(`/v1/devices/${deviceUid}`, updates);
}
