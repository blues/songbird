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

import { apiGet, apiPost } from './client';
import { getHostFirmware, queueFirmwareUpdate, cancelFirmwareUpdate, getDfuStatus } from './firmware';

beforeEach(() => {
  vi.mocked(apiGet).mockReset().mockResolvedValue({});
  vi.mocked(apiPost).mockReset().mockResolvedValue({});
});

describe('firmware API', () => {
  describe('getHostFirmware', () => {
    it('calls apiGet with the correct endpoint', async () => {
      vi.mocked(apiGet).mockResolvedValue({ firmware: [] });
      await getHostFirmware();
      expect(apiGet).toHaveBeenCalledWith('/v1/firmware');
    });

    it('returns the firmware array from the response', async () => {
      const firmware = [
        { version: '1.0.0', filename: 'fw-1.0.0.bin' },
        { version: '1.1.0', filename: 'fw-1.1.0.bin' },
      ];
      vi.mocked(apiGet).mockResolvedValue({ firmware });
      const result = await getHostFirmware();
      expect(result).toEqual(firmware);
    });
  });

  describe('queueFirmwareUpdate', () => {
    it('calls apiPost with correct endpoint and request body', async () => {
      const request = { version: '1.1.0', fleetUID: 'fleet:12345' };
      await queueFirmwareUpdate(request);
      expect(apiPost).toHaveBeenCalledWith('/v1/firmware/update', request);
    });

    it('returns the response from apiPost', async () => {
      const mockResponse = { message: 'Firmware update queued' };
      vi.mocked(apiPost).mockResolvedValue(mockResponse);
      const result = await queueFirmwareUpdate({ version: '1.1.0' } as any);
      expect(result).toEqual(mockResponse);
    });
  });

  describe('cancelFirmwareUpdate', () => {
    it('calls apiPost with correct endpoint and both parameters', async () => {
      await cancelFirmwareUpdate('fleet:12345', 'dev:abc');
      expect(apiPost).toHaveBeenCalledWith('/v1/firmware/cancel', {
        fleetUID: 'fleet:12345',
        deviceUID: 'dev:abc',
      });
    });

    it('calls apiPost with undefined parameters when not provided', async () => {
      await cancelFirmwareUpdate();
      expect(apiPost).toHaveBeenCalledWith('/v1/firmware/cancel', {
        fleetUID: undefined,
        deviceUID: undefined,
      });
    });

    it('calls apiPost with only fleetUID when deviceUID is omitted', async () => {
      await cancelFirmwareUpdate('fleet:12345');
      expect(apiPost).toHaveBeenCalledWith('/v1/firmware/cancel', {
        fleetUID: 'fleet:12345',
        deviceUID: undefined,
      });
    });

    it('returns the response from apiPost', async () => {
      const mockResponse = { message: 'Firmware update cancelled' };
      vi.mocked(apiPost).mockResolvedValue(mockResponse);
      const result = await cancelFirmwareUpdate('fleet:12345');
      expect(result).toEqual(mockResponse);
    });
  });

  describe('getDfuStatus', () => {
    it('calls apiGet with the correct endpoint', async () => {
      await getDfuStatus();
      expect(apiGet).toHaveBeenCalledWith('/v1/firmware/status');
    });

    it('returns the response from apiGet', async () => {
      const mockStatus = { pending: 2, completed: 5 };
      vi.mocked(apiGet).mockResolvedValue(mockStatus);
      const result = await getDfuStatus();
      expect(result).toEqual(mockStatus);
    });
  });
});
