/**
 * Users Hooks
 *
 * React Query hooks for user management.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getUsers, getUser, getGroups, inviteUser, updateUserGroups, updateUserDevices, updateUserDevice, getUnassignedDevices, deleteUser, confirmUser } from '@/api/users';
import type { UserGroup } from '@/types';

export function useUsers(includeDevices = false) {
  return useQuery({
    queryKey: ['users', includeDevices],
    queryFn: () => getUsers(includeDevices),
    staleTime: 30_000,
  });
}

export function useUser(userId: string) {
  return useQuery({
    queryKey: ['user', userId],
    queryFn: () => getUser(userId),
    enabled: !!userId,
    staleTime: 30_000,
  });
}

export function useGroups() {
  return useQuery({
    queryKey: ['userGroups'],
    queryFn: getGroups,
    staleTime: 5 * 60_000, // 5 minutes - groups rarely change
  });
}

export function useInviteUser() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: inviteUser,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
    },
  });
}

export function useUpdateUserGroups() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ userId, groups }: { userId: string; groups: UserGroup[] }) =>
      updateUserGroups(userId, groups),
    onSuccess: (_, { userId }) => {
      queryClient.invalidateQueries({ queryKey: ['user', userId] });
      queryClient.invalidateQueries({ queryKey: ['users'] });
    },
  });
}

export function useUpdateUserDevices() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ userId, deviceUids }: { userId: string; deviceUids: string[] }) =>
      updateUserDevices(userId, deviceUids),
    onSuccess: (_, { userId }) => {
      queryClient.invalidateQueries({ queryKey: ['user', userId] });
      queryClient.invalidateQueries({ queryKey: ['users'] });
      queryClient.invalidateQueries({ queryKey: ['devices'] });
    },
  });
}

// Single device assignment (each user can only have one device)
export function useUpdateUserDevice() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ userId, deviceUid }: { userId: string; deviceUid: string | null }) =>
      updateUserDevice(userId, deviceUid),
    onSuccess: (_, { userId }) => {
      queryClient.invalidateQueries({ queryKey: ['user', userId] });
      queryClient.invalidateQueries({ queryKey: ['users'] });
      queryClient.invalidateQueries({ queryKey: ['devices'] });
      queryClient.invalidateQueries({ queryKey: ['unassignedDevices'] });
    },
  });
}

export function useUnassignedDevices() {
  return useQuery({
    queryKey: ['unassignedDevices'],
    queryFn: getUnassignedDevices,
    staleTime: 30_000,
  });
}

export function useDeleteUser() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (userId: string) => deleteUser(userId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
      queryClient.invalidateQueries({ queryKey: ['devices'] });
      queryClient.invalidateQueries({ queryKey: ['unassignedDevices'] });
    },
  });
}

export function useConfirmUser() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (userId: string) => confirmUser(userId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
    },
  });
}
