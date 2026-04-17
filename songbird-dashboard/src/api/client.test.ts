import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import {
  initializeApi,
  getApiBaseUrl,
  apiFetch,
  apiGet,
  apiPost,
  apiPut,
  apiPatch,
  apiDelete,
} from './client';

vi.mock('aws-amplify/auth', () => ({
  fetchAuthSession: vi.fn().mockResolvedValue({
    tokens: {
      idToken: {
        toString: () => 'test-token',
      },
    },
  }),
}));

describe('API Client', () => {
  let mockFetch: Mock;

  beforeEach(async () => {
    vi.clearAllMocks();

    mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: 'test' }),
    });
    vi.stubGlobal('fetch', mockFetch);

    await initializeApi('https://api.test.com');
  });

  describe('initializeApi', () => {
    it('strips trailing slash from URL', async () => {
      await initializeApi('https://api.test.com/');
      expect(getApiBaseUrl()).toBe('https://api.test.com');
    });
  });

  describe('getApiBaseUrl', () => {
    it('returns the set URL', () => {
      expect(getApiBaseUrl()).toBe('https://api.test.com');
    });
  });

  describe('apiFetch', () => {
    it('adds Authorization header from Amplify session', async () => {
      await apiFetch('/test');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.test.com/test',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer test-token',
          }),
        }),
      );
    });

    it('does NOT add Authorization header when skipAuth is true', async () => {
      await apiFetch('/test', { skipAuth: true });

      const callHeaders = mockFetch.mock.calls[0][1].headers;
      expect(callHeaders).not.toHaveProperty('Authorization');
    });

    it('handles auth session error gracefully without adding token', async () => {
      const { fetchAuthSession } = await import('aws-amplify/auth');
      (fetchAuthSession as Mock).mockRejectedValueOnce(new Error('Not authenticated'));

      await apiFetch('/test');

      const callHeaders = mockFetch.mock.calls[0][1].headers;
      expect(callHeaders).not.toHaveProperty('Authorization');
    });

    it('builds correct full URL from base + endpoint', async () => {
      await apiFetch('/devices/123');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.test.com/devices/123',
        expect.any(Object),
      );
    });

    it('throws on non-ok response with error message from body', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: () => Promise.resolve({ error: 'Bad request data' }),
      });

      await expect(apiFetch('/test')).rejects.toThrow('Bad request data');
    });

    it('throws with fallback message when error body is not JSON', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: () => Promise.reject(new Error('not json')),
      });

      await expect(apiFetch('/test')).rejects.toThrow('Request failed');
    });
  });

  describe('apiGet', () => {
    it('sends GET request', async () => {
      await apiGet('/devices');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.test.com/devices',
        expect.objectContaining({ method: 'GET' }),
      );
    });

    it('appends query params to the URL', async () => {
      await apiGet('/devices', { status: 'active', limit: 10 });

      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain('status=active');
      expect(calledUrl).toContain('limit=10');
    });

    it('skips undefined and null params', async () => {
      await apiGet('/devices', {
        status: 'active',
        name: undefined as unknown as string,
        tag: null as unknown as string,
      });

      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain('status=active');
      expect(calledUrl).not.toContain('name');
      expect(calledUrl).not.toContain('tag');
    });
  });

  describe('apiPost', () => {
    it('sends POST with JSON body', async () => {
      const payload = { name: 'device1' };
      await apiPost('/devices', payload);

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.test.com/devices',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify(payload),
        }),
      );
    });

    it('sends POST without body when data is undefined', async () => {
      await apiPost('/devices');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.test.com/devices',
        expect.objectContaining({
          method: 'POST',
          body: undefined,
        }),
      );
    });
  });

  describe('apiPut', () => {
    it('sends PUT request with JSON body', async () => {
      const payload = { name: 'updated' };
      await apiPut('/devices/1', payload);

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.test.com/devices/1',
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify(payload),
        }),
      );
    });
  });

  describe('apiPatch', () => {
    it('sends PATCH request with JSON body', async () => {
      const payload = { status: 'inactive' };
      await apiPatch('/devices/1', payload);

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.test.com/devices/1',
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify(payload),
        }),
      );
    });
  });

  describe('apiDelete', () => {
    it('sends DELETE request', async () => {
      await apiDelete('/devices/1');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.test.com/devices/1',
        expect.objectContaining({ method: 'DELETE' }),
      );
    });
  });
});
