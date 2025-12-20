/**
 * Settings API
 *
 * Fleet defaults and settings management.
 */

import { apiGet, apiPut } from './client';
import type { FleetDefaults } from '@/types';

interface FleetDefaultsResponse {
  fleet_uid: string;
  config: Partial<FleetDefaults>;
  schema: Record<string, { type: string; min?: number; max?: number; values?: string[] }>;
  updated_at?: number;
  updated_by?: string;
}

interface AllFleetDefaultsResponse {
  fleet_defaults: FleetDefaults[];
}

export async function getFleetDefaults(fleetUid: string): Promise<FleetDefaultsResponse> {
  return apiGet<FleetDefaultsResponse>(`/v1/settings/fleet-defaults/${fleetUid}`);
}

export async function getAllFleetDefaults(): Promise<FleetDefaults[]> {
  const response = await apiGet<AllFleetDefaultsResponse>('/v1/settings/fleet-defaults');
  return response.fleet_defaults;
}

export async function updateFleetDefaults(
  fleetUid: string,
  config: Partial<FleetDefaults>
): Promise<FleetDefaults> {
  return apiPut<FleetDefaults>(`/v1/settings/fleet-defaults/${fleetUid}`, config);
}
