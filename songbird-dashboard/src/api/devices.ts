/**
 * Devices API
 */

import { apiGet, apiPatch, apiPost } from './client';
import type { Device, DevicesResponse } from '@/types';

interface MergeDevicesRequest {
  source_serial_number: string;
  target_serial_number: string;
}

interface MergeDevicesResponse {
  message: string;
  target_serial_number: string;
  target_device_uid: string;
  merged_device_uids: string[];
  deleted_serial_number: string;
  deleted_device_uid: string;
}

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

/**
 * Merge two devices (Admin only)
 * The source device's data will be merged into the target device
 */
export async function mergeDevices(
  sourceSerialNumber: string,
  targetSerialNumber: string
): Promise<MergeDevicesResponse> {
  return apiPost<MergeDevicesResponse>('/v1/devices/merge', {
    source_serial_number: sourceSerialNumber,
    target_serial_number: targetSerialNumber,
  } as MergeDevicesRequest);
}
