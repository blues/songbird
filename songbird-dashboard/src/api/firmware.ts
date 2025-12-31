/**
 * Firmware API
 *
 * Host firmware management operations.
 */

import { apiGet, apiPost } from './client';
import type {
  HostFirmware,
  HostFirmwareResponse,
  FirmwareUpdateRequest,
  DfuStatus,
} from '@/types';

/**
 * Get list of available host firmware
 */
export async function getHostFirmware(): Promise<HostFirmware[]> {
  const response = await apiGet<HostFirmwareResponse>('/v1/firmware');
  return response.firmware;
}

/**
 * Queue a firmware update
 */
export async function queueFirmwareUpdate(
  request: FirmwareUpdateRequest
): Promise<{ message: string }> {
  return apiPost<{ message: string }>('/v1/firmware/update', request);
}

/**
 * Cancel pending firmware updates
 */
export async function cancelFirmwareUpdate(
  fleetUID?: string,
  deviceUID?: string
): Promise<{ message: string }> {
  return apiPost<{ message: string }>('/v1/firmware/cancel', { fleetUID, deviceUID });
}

/**
 * Get DFU status for all devices
 */
export async function getDfuStatus(): Promise<DfuStatus> {
  return apiGet<DfuStatus>('/v1/firmware/status');
}
