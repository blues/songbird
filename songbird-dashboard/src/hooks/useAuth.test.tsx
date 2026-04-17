import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import {
  useIsAdmin,
  useUserGroups,
  useCanSendCommands,
  useCurrentUserEmail,
  useCanUnlockDevice,
  usePostHogIdentify,
} from './useAuth';

vi.mock('aws-amplify/auth', () => ({
  fetchAuthSession: vi.fn(),
}));

vi.mock('posthog-js', () => ({
  default: { identify: vi.fn() },
}));

import { fetchAuthSession } from 'aws-amplify/auth';
import posthog from 'posthog-js';

function createWrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, retryDelay: 0, gcTime: 0 } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

function mockSession(groups: string[], email = 'user@test.com', sub = 'user-123') {
  vi.mocked(fetchAuthSession).mockResolvedValue({
    tokens: {
      idToken: {
        payload: {
          'cognito:groups': groups,
          email,
          sub,
        },
        toString: () => 'mock-token',
      },
    },
  } as any);
}

describe('useIsAdmin', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns true when groups include Admin', async () => {
    mockSession(['Admin', 'Sales']);

    const { result } = renderHook(() => useIsAdmin(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.isAdmin).toBe(true);
  });

  it('returns false when groups do not include Admin', async () => {
    mockSession(['Sales']);

    const { result } = renderHook(() => useIsAdmin(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.isAdmin).toBe(false);
  });

  it('returns false when session fails', async () => {
    vi.mocked(fetchAuthSession).mockRejectedValue(new Error('Not authenticated'));

    const { result } = renderHook(() => useIsAdmin(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.isAdmin).toBe(false);
  });
});

describe('useUserGroups', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns groups from session', async () => {
    mockSession(['Admin', 'Sales']);

    const { result } = renderHook(() => useUserGroups(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.groups).toEqual(['Admin', 'Sales']);
  });

  it('returns empty array when session fails', async () => {
    vi.mocked(fetchAuthSession).mockRejectedValue(new Error('fail'));

    const { result } = renderHook(() => useUserGroups(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.groups).toEqual([]);
  });
});

describe('useCanSendCommands', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns false for Viewer-only user', async () => {
    mockSession(['Viewer']);

    const { result } = renderHook(() => useCanSendCommands(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.canSend).toBe(false);
  });

  it('returns true for Admin', async () => {
    mockSession(['Admin']);

    const { result } = renderHook(() => useCanSendCommands(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.canSend).toBe(true);
  });

  it('returns true for Sales', async () => {
    mockSession(['Sales']);

    const { result } = renderHook(() => useCanSendCommands(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.canSend).toBe(true);
  });

  it('returns false when no groups', async () => {
    mockSession([]);

    const { result } = renderHook(() => useCanSendCommands(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.canSend).toBe(false);
  });
});

describe('useCurrentUserEmail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns email from session', async () => {
    mockSession(['Admin'], 'admin@test.com');

    const { result } = renderHook(() => useCurrentUserEmail(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.email).toBe('admin@test.com');
  });

  it('returns null when session fails', async () => {
    vi.mocked(fetchAuthSession).mockRejectedValue(new Error('fail'));

    const { result } = renderHook(() => useCurrentUserEmail(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.email).toBeNull();
  });
});

describe('useCanUnlockDevice', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns true for admin regardless of assignedTo', async () => {
    mockSession(['Admin'], 'admin@test.com');

    const { result } = renderHook(() => useCanUnlockDevice('other@test.com'), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.canUnlock).toBe(true);
  });

  it('returns true when user is the device owner', async () => {
    mockSession(['Sales'], 'owner@test.com');

    const { result } = renderHook(() => useCanUnlockDevice('owner@test.com'), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.canUnlock).toBe(true);
  });

  it('returns false when user is not admin and not the owner', async () => {
    mockSession(['Sales'], 'other@test.com');

    const { result } = renderHook(() => useCanUnlockDevice('owner@test.com'), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.canUnlock).toBe(false);
  });
});

describe('usePostHogIdentify', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls posthog.identify with user info', async () => {
    mockSession(['Admin'], 'admin@test.com', 'sub-123');

    renderHook(() => usePostHogIdentify(), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(posthog.identify).toHaveBeenCalledWith('sub-123', {
        email: 'admin@test.com',
        name: undefined,
        group: 'Admin',
        groups: ['Admin'],
      });
    });
  });
});
