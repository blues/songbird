/**
 * Command hooks using TanStack Query
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  getAllCommands,
  getCommands,
  sendPing,
  sendLocate,
  sendPlayMelody,
  sendTestAudio,
  sendSetVolume,
  deleteCommand,
} from '@/api/commands';

/**
 * Hook to fetch all commands across devices (optionally filtered by device)
 */
export function useAllCommands(deviceUid?: string) {
  return useQuery({
    queryKey: ['allCommands', deviceUid],
    queryFn: () => getAllCommands(deviceUid),
    refetchInterval: 10_000, // Poll frequently for command updates
    staleTime: 5_000,
  });
}

/**
 * Hook to fetch command history for a specific device
 */
export function useCommands(serialNumber: string) {
  return useQuery({
    queryKey: ['commands', serialNumber],
    queryFn: () => getCommands(serialNumber),
    refetchInterval: 10_000, // Poll frequently for command updates
    staleTime: 5_000,
    enabled: !!serialNumber,
  });
}

/**
 * Hook to send a ping command
 */
export function useSendPing() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (serialNumber: string) => sendPing(serialNumber),
    onSuccess: (_, serialNumber) => {
      queryClient.invalidateQueries({ queryKey: ['commands', serialNumber] });
      queryClient.invalidateQueries({ queryKey: ['allCommands'] });
    },
  });
}

/**
 * Hook to send a locate command
 */
export function useSendLocate() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ serialNumber, durationSec = 30 }: { serialNumber: string; durationSec?: number }) =>
      sendLocate(serialNumber, durationSec),
    onSuccess: (_, { serialNumber }) => {
      queryClient.invalidateQueries({ queryKey: ['commands', serialNumber] });
      queryClient.invalidateQueries({ queryKey: ['allCommands'] });
    },
  });
}

/**
 * Hook to send a play melody command
 */
export function useSendPlayMelody() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ serialNumber, melody }: { serialNumber: string; melody: string }) =>
      sendPlayMelody(serialNumber, melody),
    onSuccess: (_, { serialNumber }) => {
      queryClient.invalidateQueries({ queryKey: ['commands', serialNumber] });
      queryClient.invalidateQueries({ queryKey: ['allCommands'] });
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
      serialNumber,
      frequency,
      durationMs,
    }: {
      serialNumber: string;
      frequency: number;
      durationMs: number;
    }) => sendTestAudio(serialNumber, frequency, durationMs),
    onSuccess: (_, { serialNumber }) => {
      queryClient.invalidateQueries({ queryKey: ['commands', serialNumber] });
      queryClient.invalidateQueries({ queryKey: ['allCommands'] });
    },
  });
}

/**
 * Hook to send a set volume command
 */
export function useSendSetVolume() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ serialNumber, volume }: { serialNumber: string; volume: number }) =>
      sendSetVolume(serialNumber, volume),
    onSuccess: (_, { serialNumber }) => {
      queryClient.invalidateQueries({ queryKey: ['commands', serialNumber] });
      queryClient.invalidateQueries({ queryKey: ['allCommands'] });
    },
  });
}

/**
 * Hook to delete a command
 */
export function useDeleteCommand() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ commandId, serialNumber }: { commandId: string; serialNumber: string }) =>
      deleteCommand(commandId, serialNumber),
    onSuccess: (_, { serialNumber }) => {
      queryClient.invalidateQueries({ queryKey: ['commands', serialNumber] });
      queryClient.invalidateQueries({ queryKey: ['allCommands'] });
    },
  });
}
