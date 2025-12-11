/**
 * Command hooks using TanStack Query
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  getCommands,
  sendPing,
  sendLocate,
  sendPlayMelody,
  sendTestAudio,
  sendSetVolume,
} from '@/api/commands';

/**
 * Hook to fetch command history
 */
export function useCommands(deviceUid: string) {
  return useQuery({
    queryKey: ['commands', deviceUid],
    queryFn: () => getCommands(deviceUid),
    refetchInterval: 10_000, // Poll frequently for command updates
    staleTime: 5_000,
    enabled: !!deviceUid,
  });
}

/**
 * Hook to send a ping command
 */
export function useSendPing() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (deviceUid: string) => sendPing(deviceUid),
    onSuccess: (_, deviceUid) => {
      queryClient.invalidateQueries({ queryKey: ['commands', deviceUid] });
    },
  });
}

/**
 * Hook to send a locate command
 */
export function useSendLocate() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ deviceUid, durationSec = 30 }: { deviceUid: string; durationSec?: number }) =>
      sendLocate(deviceUid, durationSec),
    onSuccess: (_, { deviceUid }) => {
      queryClient.invalidateQueries({ queryKey: ['commands', deviceUid] });
    },
  });
}

/**
 * Hook to send a play melody command
 */
export function useSendPlayMelody() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ deviceUid, melody }: { deviceUid: string; melody: string }) =>
      sendPlayMelody(deviceUid, melody),
    onSuccess: (_, { deviceUid }) => {
      queryClient.invalidateQueries({ queryKey: ['commands', deviceUid] });
    },
  });
}

/**
 * Hook to send a test audio command
 */
export function useSendTestAudio() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      deviceUid,
      frequency,
      durationMs,
    }: {
      deviceUid: string;
      frequency: number;
      durationMs: number;
    }) => sendTestAudio(deviceUid, frequency, durationMs),
    onSuccess: (_, { deviceUid }) => {
      queryClient.invalidateQueries({ queryKey: ['commands', deviceUid] });
    },
  });
}

/**
 * Hook to send a set volume command
 */
export function useSendSetVolume() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ deviceUid, volume }: { deviceUid: string; volume: number }) =>
      sendSetVolume(deviceUid, volume),
    onSuccess: (_, { deviceUid }) => {
      queryClient.invalidateQueries({ queryKey: ['commands', deviceUid] });
    },
  });
}
