import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./client', () => ({
  apiGet: vi.fn().mockResolvedValue({}),
  apiPost: vi.fn().mockResolvedValue({}),
  apiPut: vi.fn().mockResolvedValue({}),
  apiDelete: vi.fn().mockResolvedValue({}),
}));

import { apiGet, apiPost, apiPut, apiDelete } from './client';
import {
  getUsers,
  getUser,
  getGroups,
  inviteUser,
  updateUserGroups,
  updateUserDevice,
  getUnassignedDevices,
  deleteUser,
  confirmUser,
} from './users';

beforeEach(() => {
  vi.mocked(apiGet).mockReset().mockResolvedValue({});
  vi.mocked(apiPost).mockReset().mockResolvedValue({});
  vi.mocked(apiPut).mockReset().mockResolvedValue({});
  vi.mocked(apiDelete).mockReset().mockResolvedValue({});
});

describe('getUsers', () => {
  it('calls apiGet with no params when includeDevices is false', async () => {
    await getUsers();
    expect(apiGet).toHaveBeenCalledWith('/v1/users', undefined);
  });

  it('calls apiGet with include_devices param when true', async () => {
    await getUsers(true);
    expect(apiGet).toHaveBeenCalledWith('/v1/users', { include_devices: 'true' });
  });

  it('returns the users array from the response', async () => {
    const mockUsers = [{ id: '1', name: 'Alice' }];
    vi.mocked(apiGet).mockResolvedValue({ users: mockUsers });
    const result = await getUsers();
    expect(result).toEqual(mockUsers);
  });
});

describe('getUser', () => {
  it('calls apiGet with user ID', async () => {
    await getUser('user-123');
    expect(apiGet).toHaveBeenCalledWith('/v1/users/user-123');
  });
});

describe('getGroups', () => {
  it('calls apiGet and returns the groups array', async () => {
    const mockGroups = [{ name: 'Admin', description: 'Full access' }];
    vi.mocked(apiGet).mockResolvedValue({ groups: mockGroups });
    const result = await getGroups();
    expect(apiGet).toHaveBeenCalledWith('/v1/users/groups');
    expect(result).toEqual(mockGroups);
  });
});

describe('inviteUser', () => {
  it('calls apiPost with user invitation data', async () => {
    const request = { email: 'test@example.com', name: 'Test', group: 'Admin' as const };
    await inviteUser(request);
    expect(apiPost).toHaveBeenCalledWith('/v1/users', request);
  });
});

describe('updateUserGroups', () => {
  it('calls apiPut with user ID and groups', async () => {
    await updateUserGroups('user-123', ['Admin', 'Sales'] as any);
    expect(apiPut).toHaveBeenCalledWith('/v1/users/user-123/groups', {
      groups: ['Admin', 'Sales'],
    });
  });
});

describe('updateUserDevice', () => {
  it('calls apiPut with user ID and device UID', async () => {
    await updateUserDevice('user-123', 'dev:456');
    expect(apiPut).toHaveBeenCalledWith('/v1/users/user-123/device', {
      device_uid: 'dev:456',
    });
  });

  it('calls apiPut with null device UID to unassign', async () => {
    await updateUserDevice('user-123', null);
    expect(apiPut).toHaveBeenCalledWith('/v1/users/user-123/device', {
      device_uid: null,
    });
  });
});

describe('getUnassignedDevices', () => {
  it('calls apiGet and returns the devices array', async () => {
    const mockDevices = [{ device_uid: 'dev:1', serial_number: 'sb01' }];
    vi.mocked(apiGet).mockResolvedValue({ devices: mockDevices });
    const result = await getUnassignedDevices();
    expect(apiGet).toHaveBeenCalledWith('/v1/devices/unassigned');
    expect(result).toEqual(mockDevices);
  });
});

describe('deleteUser', () => {
  it('calls apiDelete with user ID', async () => {
    await deleteUser('user-123');
    expect(apiDelete).toHaveBeenCalledWith('/v1/users/user-123');
  });
});

describe('confirmUser', () => {
  it('calls apiPost with user ID confirm endpoint', async () => {
    await confirmUser('user-123');
    expect(apiPost).toHaveBeenCalledWith('/v1/users/user-123/confirm');
  });
});
