/**
 * Alerts hooks using TanStack Query
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getAlerts, getAlert, acknowledgeAlert, acknowledgeAllAlerts } from '@/api/alerts';

/**
 * Hook to fetch all alerts
 */
export function useAlerts(params?: {
  serial_number?: string;
  acknowledged?: boolean;
  limit?: number;
}) {
  return useQuery({
    queryKey: ['alerts', params],
    queryFn: () => getAlerts(params),
    refetchInterval: 30_000, // Refresh every 30 seconds
  });
}

/**
 * Hook to fetch active (unacknowledged) alerts only
 */
export function useActiveAlerts() {
  return useQuery({
    queryKey: ['alerts', { acknowledged: false }],
    queryFn: () => getAlerts({ acknowledged: false }),
    refetchInterval: 30_000,
  });
}

/**
 * Hook to fetch alerts for a specific device
 */
export function useDeviceAlerts(serialNumber: string) {
  return useQuery({
    queryKey: ['alerts', { serial_number: serialNumber }],
    queryFn: () => getAlerts({ serial_number: serialNumber }),
    enabled: !!serialNumber,
    refetchInterval: 30_000,
  });
}

/**
 * Hook to fetch a single alert
 */
export function useAlert(alertId: string) {
  return useQuery({
    queryKey: ['alert', alertId],
    queryFn: () => getAlert(alertId),
    enabled: !!alertId,
  });
}

/**
 * Hook to acknowledge an alert
 */
export function useAcknowledgeAlert() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ alertId, acknowledgedBy }: { alertId: string; acknowledgedBy?: string }) =>
      acknowledgeAlert(alertId, acknowledgedBy),
    onSuccess: () => {
      // Invalidate all alert queries to refresh the data
      queryClient.invalidateQueries({ queryKey: ['alerts'] });
    },
  });
}

/**
 * Hook to acknowledge multiple alerts at once
 */
export function useBulkAcknowledgeAlerts() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ alertIds, acknowledgedBy }: { alertIds: string[]; acknowledgedBy?: string }) =>
      acknowledgeAllAlerts(alertIds, acknowledgedBy),
    onSuccess: () => {
      // Invalidate all alert queries to refresh the data
      queryClient.invalidateQueries({ queryKey: ['alerts'] });
    },
  });
}
