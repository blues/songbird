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

import { apiGet } from './client';
import { getActivity } from './activity';

beforeEach(() => {
  vi.mocked(apiGet).mockReset().mockResolvedValue({});
});

describe('activity API', () => {
  describe('getActivity', () => {
    it('calls apiGet with default hours and limit', async () => {
      await getActivity();
      expect(apiGet).toHaveBeenCalledWith('/v1/activity', { hours: 24, limit: 50 });
    });

    it('calls apiGet with custom hours and limit', async () => {
      await getActivity(48, 100);
      expect(apiGet).toHaveBeenCalledWith('/v1/activity', { hours: 48, limit: 100 });
    });

    it('calls apiGet with custom hours and default limit', async () => {
      await getActivity(12);
      expect(apiGet).toHaveBeenCalledWith('/v1/activity', { hours: 12, limit: 50 });
    });

    it('returns the response from apiGet', async () => {
      const mockResponse = {
        hours: 24,
        count: 2,
        activities: [
          { type: 'device_online', timestamp: 1234567890 },
          { type: 'alert_triggered', timestamp: 1234567800 },
        ],
      };
      vi.mocked(apiGet).mockResolvedValue(mockResponse);
      const result = await getActivity();
      expect(result).toEqual(mockResponse);
    });
  });
});
