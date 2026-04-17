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
import { getDeviceConfig, updateDeviceConfig, updateFleetConfig, setDeviceWifi } from './config';

beforeEach(() => {
  vi.mocked(apiGet).mockReset().mockResolvedValue({});
  vi.mocked(apiPut).mockReset().mockResolvedValue({});
});

describe('config API', () => {
  describe('getDeviceConfig', () => {
    it('calls apiGet with the correct endpoint', async () => {
      await getDeviceConfig('songbird01-bds');
      expect(apiGet).toHaveBeenCalledWith('/v1/devices/songbird01-bds/config');
    });

    it('returns the response from apiGet', async () => {
      const mockConfig = { mode: 'demo', alert_temp_high: 35 };
      vi.mocked(apiGet).mockResolvedValue(mockConfig);
      const result = await getDeviceConfig('songbird01-bds');
      expect(result).toEqual(mockConfig);
    });
  });

  describe('updateDeviceConfig', () => {
    it('calls apiPut with correct endpoint and config', async () => {
      const config = { mode: 'transit' };
      await updateDeviceConfig('songbird01-bds', config);
      expect(apiPut).toHaveBeenCalledWith('/v1/devices/songbird01-bds/config', config);
    });

    it('returns the response from apiPut', async () => {
      const mockResponse = { mode: 'transit' };
      vi.mocked(apiPut).mockResolvedValue(mockResponse);
      const result = await updateDeviceConfig('songbird01-bds', { mode: 'transit' });
      expect(result).toEqual(mockResponse);
    });
  });

  describe('updateFleetConfig', () => {
    it('calls apiPut with correct endpoint and config', async () => {
      const config = { alert_temp_high: 40 };
      await updateFleetConfig('fleet:12345', config);
      expect(apiPut).toHaveBeenCalledWith('/v1/fleets/fleet:12345/config', config);
    });

    it('returns the response from apiPut', async () => {
      const mockResponse = { alert_temp_high: 40 };
      vi.mocked(apiPut).mockResolvedValue(mockResponse);
      const result = await updateFleetConfig('fleet:12345', { alert_temp_high: 40 });
      expect(result).toEqual(mockResponse);
    });
  });

  describe('setDeviceWifi', () => {
    it('calls apiPut with correct endpoint, ssid, and password', async () => {
      await setDeviceWifi('songbird01-bds', 'MyNetwork', 'secret123');
      expect(apiPut).toHaveBeenCalledWith('/v1/devices/songbird01-bds/wifi', {
        ssid: 'MyNetwork',
        password: 'secret123',
      });
    });

    it('returns the response from apiPut', async () => {
      const mockResponse = { success: true, message: 'Wi-Fi credentials set' };
      vi.mocked(apiPut).mockResolvedValue(mockResponse);
      const result = await setDeviceWifi('songbird01-bds', 'MyNetwork', 'secret123');
      expect(result).toEqual(mockResponse);
    });
  });
});
