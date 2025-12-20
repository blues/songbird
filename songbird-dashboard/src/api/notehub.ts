/**
 * Notehub API
 *
 * Notehub connection status and fleet information.
 */

import { apiGet } from './client';
import type { NotehubStatus, NotehubFleet } from '@/types';

export async function getNotehubStatus(): Promise<NotehubStatus> {
  return apiGet<NotehubStatus>('/v1/notehub/status');
}

export async function getNotehubFleets(): Promise<NotehubFleet[]> {
  const response = await apiGet<{ fleets: NotehubFleet[] }>('/v1/notehub/fleets');
  return response.fleets;
}
