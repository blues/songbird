import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./client', () => ({
  apiGet: vi.fn().mockResolvedValue({}),
  apiPost: vi.fn().mockResolvedValue({}),
  apiPatch: vi.fn().mockResolvedValue({}),
  apiFetch: vi.fn().mockResolvedValue({}),
}));

import { apiGet, apiPatch, apiPost, apiFetch } from './client';
import { getDevices, getDevice, updateDevice, mergeDevices, getPublicDevice } from './devices';

beforeEach(() => {
  vi.mocked(apiGet).mockReset().mockResolvedValue({});
  vi.mocked(apiPost).mockReset().mockResolvedValue({});
  vi.mocked(apiPatch).mockReset().mockResolvedValue({});
  vi.mocked(apiFetch).mockReset().mockResolvedValue({});
});

describe('getDevices', () => {
  it('calls apiGet with /v1/devices and no params when no fleetUid', async () => {
    await getDevices();
    expect(apiGet).toHaveBeenCalledWith('/v1/devices', undefined);
  });

  it('calls apiGet with fleet_uid param when fleetUid provided', async () => {
    await getDevices('fleet-123');
    expect(apiGet).toHaveBeenCalledWith('/v1/devices', { fleet_uid: 'fleet-123' });
  });
});

describe('getDevice', () => {
  it('calls apiGet with the correct device endpoint', async () => {
    await getDevice('songbird01-bds');
    expect(apiGet).toHaveBeenCalledWith('/v1/devices/songbird01-bds');
  });
});

describe('updateDevice', () => {
  it('calls apiPatch with serial number and updates', async () => {
    const updates = { name: 'New Name' };
    await updateDevice('songbird01-bds', updates);
    expect(apiPatch).toHaveBeenCalledWith('/v1/devices/songbird01-bds', updates);
  });

  it('passes partial updates correctly', async () => {
    const updates = { assigned_to: 'user-456', fleet_uid: 'fleet-789' };
    await updateDevice('sb02', updates);
    expect(apiPatch).toHaveBeenCalledWith('/v1/devices/sb02', updates);
  });
});

describe('mergeDevices', () => {
  it('calls apiPost with source and target serial numbers', async () => {
    await mergeDevices('source-sn', 'target-sn');
    expect(apiPost).toHaveBeenCalledWith('/v1/devices/merge', {
      source_serial_number: 'source-sn',
      target_serial_number: 'target-sn',
    });
  });
});

describe('getPublicDevice', () => {
  it('calls apiFetch with skipAuth and GET method', async () => {
    await getPublicDevice('songbird01-bds');
    expect(apiFetch).toHaveBeenCalledWith('/v1/public/devices/songbird01-bds', {
      method: 'GET',
      skipAuth: true,
    });
  });
});
