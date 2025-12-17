/**
 * Telemetry hooks using TanStack Query
 */

import { useQuery } from '@tanstack/react-query';
import { getTelemetry, getLocationHistory, getPowerHistory } from '@/api/telemetry';

/**
 * Hook to fetch telemetry data
 */
export function useTelemetry(deviceUid: string, hours: number = 24) {
  return useQuery({
    queryKey: ['telemetry', deviceUid, hours],
    queryFn: () => getTelemetry(deviceUid, hours),
    refetchInterval: 30_000, // Poll every 30 seconds
    staleTime: 15_000,
    enabled: !!deviceUid,
  });
}

/**
 * Hook to fetch location history
 */
export function useLocationHistory(deviceUid: string, hours: number = 24) {
  return useQuery({
    queryKey: ['location', deviceUid, hours],
    queryFn: () => getLocationHistory(deviceUid, hours),
    refetchInterval: 30_000, // Poll every 30 seconds
    staleTime: 15_000,
    enabled: !!deviceUid,
  });
}

/**
 * Hook to get latest telemetry values
 */
export function useLatestTelemetry(deviceUid: string) {
  const { data, ...rest } = useTelemetry(deviceUid, 1);

  const latest = data?.telemetry?.[0];

  return {
    ...rest,
    data: latest ? {
      temperature: latest.temperature,
      humidity: latest.humidity,
      pressure: latest.pressure,
      voltage: latest.voltage,
      time: latest.time,
    } : undefined,
  };
}

/**
 * Hook to fetch Mojo power monitoring history
 */
export function usePowerHistory(deviceUid: string, hours: number = 24) {
  return useQuery({
    queryKey: ['power', deviceUid, hours],
    queryFn: () => getPowerHistory(deviceUid, hours),
    refetchInterval: 60_000, // Poll every 60 seconds (power data updates less frequently)
    staleTime: 30_000,
    enabled: !!deviceUid,
  });
}
