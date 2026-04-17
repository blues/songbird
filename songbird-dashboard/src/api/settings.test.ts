import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./client', () => ({
  apiGet: vi.fn().mockResolvedValue({}),
  apiPost: vi.fn().mockResolvedValue({}),
  apiPut: vi.fn().mockResolvedValue({}),
  apiPatch: vi.fn().mockResolvedValue({}),
  apiDelete: vi.fn().mockResolvedValue({}),
  apiFetch: vi.fn().mockResolvedValue({}),
  getApiBaseUrl: vi.fn().mockReturnValue('https://api.test.com'),
}));

import { apiGet, apiPut } from './client';
import { getFleetDefaults, getAllFleetDefaults, updateFleetDefaults } from './settings';

beforeEach(() => {
  vi.mocked(apiGet).mockReset().mockResolvedValue({});
  vi.mocked(apiPut).mockReset().mockResolvedValue({});
});

describe('settings API', () => {
  describe('getFleetDefaults', () => {
    it('calls apiGet with the correct endpoint', async () => {
      await getFleetDefaults('fleet:12345');
      expect(apiGet).toHaveBeenCalledWith('/v1/settings/fleet-defaults/fleet:12345');
    });

    it('returns the full response object', async () => {
      const mockResponse = {
        fleet_uid: 'fleet:12345',
        config: { mode: 'demo' },
        schema: {},
      };
      vi.mocked(apiGet).mockResolvedValue(mockResponse);
      const result = await getFleetDefaults('fleet:12345');
      expect(result).toEqual(mockResponse);
    });
  });

  describe('getAllFleetDefaults', () => {
    it('calls apiGet with the correct endpoint', async () => {
      vi.mocked(apiGet).mockResolvedValue({ fleet_defaults: [] });
      await getAllFleetDefaults();
      expect(apiGet).toHaveBeenCalledWith('/v1/settings/fleet-defaults');
    });

    it('returns the fleet_defaults array from the response', async () => {
      const fleetDefaults = [
        { fleet_uid: 'fleet:1', mode: 'demo' },
        { fleet_uid: 'fleet:2', mode: 'transit' },
      ];
      vi.mocked(apiGet).mockResolvedValue({ fleet_defaults: fleetDefaults });
      const result = await getAllFleetDefaults();
      expect(result).toEqual(fleetDefaults);
    });
  });

  describe('updateFleetDefaults', () => {
    it('calls apiPut with correct endpoint and config', async () => {
      const config = { mode: 'storage' };
      await updateFleetDefaults('fleet:12345', config);
      expect(apiPut).toHaveBeenCalledWith('/v1/settings/fleet-defaults/fleet:12345', config);
    });

    it('returns the response from apiPut', async () => {
      const mockResponse = { fleet_uid: 'fleet:12345', mode: 'storage' };
      vi.mocked(apiPut).mockResolvedValue(mockResponse);
      const result = await updateFleetDefaults('fleet:12345', { mode: 'storage' });
      expect(result).toEqual(mockResponse);
    });
  });
});
