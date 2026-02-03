/**
 * Users API
 *
 * User management for admins.
 */

import { apiGet, apiPost, apiPut, apiDelete } from './client';
import type { UserInfo, UserGroup } from '@/types';

interface UsersResponse {
  users: UserInfo[];
}

interface GroupsResponse {
  groups: { name: string; description: string }[];
}

interface InviteUserRequest {
  email: string;
  name: string;
  group: UserGroup;
  device_uids?: string[];
}

export async function getUsers(includeDevices = false): Promise<UserInfo[]> {
  const params = includeDevices ? { include_devices: 'true' } : undefined;
  const response = await apiGet<UsersResponse>('/v1/users', params);
  return response.users;
}

export async function getUser(userId: string): Promise<UserInfo> {
  return apiGet<UserInfo>(`/v1/users/${userId}`);
}

export async function getGroups(): Promise<{ name: string; description: string }[]> {
  const response = await apiGet<GroupsResponse>('/v1/users/groups');
  return response.groups;
}

export async function inviteUser(request: InviteUserRequest): Promise<UserInfo> {
  return apiPost<UserInfo>('/v1/users', request);
}

export async function updateUserGroups(userId: string, groups: UserGroup[]): Promise<void> {
  await apiPut(`/v1/users/${userId}/groups`, { groups });
}

export async function updateUserDevices(userId: string, deviceUids: string[]): Promise<void> {
  await apiPut(`/v1/users/${userId}/devices`, { device_uids: deviceUids });
}

// Single device assignment (each user can only have one device)
export async function updateUserDevice(userId: string, deviceUid: string | null): Promise<void> {
  await apiPut(`/v1/users/${userId}/device`, { device_uid: deviceUid });
}

interface UnassignedDevice {
  device_uid: string;
  serial_number: string;
  name?: string;
}

interface UnassignedDevicesResponse {
  devices: UnassignedDevice[];
}

export async function getUnassignedDevices(): Promise<UnassignedDevice[]> {
  const response = await apiGet<UnassignedDevicesResponse>('/v1/devices/unassigned');
  return response.devices;
}

export async function deleteUser(userId: string): Promise<void> {
  await apiDelete(`/v1/users/${userId}`);
}

export async function confirmUser(userId: string): Promise<void> {
  await apiPost(`/v1/users/${userId}/confirm`);
}
