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
  serial_number?: string;
  acknowledged?: boolean;
  limit?: number;
}): Promise<AlertsResponse> {
  const searchParams = new URLSearchParams();
  if (params?.serial_number) searchParams.set('serial_number', params.serial_number);
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

interface BulkAcknowledgeResponse {
  acknowledged: number;
  failed: number;
  total: number;
}

/**
 * Acknowledge multiple alerts at once
 */
export async function acknowledgeAllAlerts(
  alertIds: string[],
  acknowledgedBy?: string
): Promise<BulkAcknowledgeResponse> {
  return apiPost<BulkAcknowledgeResponse>('/v1/alerts/acknowledge-all', {
    alert_ids: alertIds,
    acknowledged_by: acknowledgedBy,
  });
}
