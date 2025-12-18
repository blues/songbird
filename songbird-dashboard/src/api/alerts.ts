/**
 * Alerts API
 */

import { apiGet, apiPost } from './client';
import type { Alert } from '@/types';

interface AlertsResponse {
  alerts: Alert[];
  count: number;
  active_count: number;
}

/**
 * Get all alerts
 */
export async function getAlerts(params?: {
  device_uid?: string;
  acknowledged?: boolean;
  limit?: number;
}): Promise<AlertsResponse> {
  const searchParams = new URLSearchParams();
  if (params?.device_uid) searchParams.set('device_uid', params.device_uid);
  if (params?.acknowledged !== undefined) searchParams.set('acknowledged', String(params.acknowledged));
  if (params?.limit) searchParams.set('limit', String(params.limit));

  const query = searchParams.toString();
  return apiGet<AlertsResponse>(`/v1/alerts${query ? `?${query}` : ''}`);
}

/**
 * Get a single alert
 */
export async function getAlert(alertId: string): Promise<Alert> {
  return apiGet<Alert>(`/v1/alerts/${alertId}`);
}

/**
 * Acknowledge an alert
 */
export async function acknowledgeAlert(
  alertId: string,
  acknowledgedBy?: string
): Promise<Alert> {
  return apiPost<Alert>(`/v1/alerts/${alertId}/acknowledge`, {
    acknowledged_by: acknowledgedBy,
  });
}
