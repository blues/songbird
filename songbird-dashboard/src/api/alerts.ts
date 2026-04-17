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
  return apiGet<AlertsResponse>('/v1/alerts', params as Record<string, string | number | boolean>);
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
