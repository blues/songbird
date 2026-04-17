import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type ReactNode } from 'react';
import {
  useAllCommands,
  useCommands,
  useSendPing,
  useSendLocate,
  useSendUnlock,
  useDeleteCommand,
} from './useCommands';

vi.mock('@/api/commands', () => ({
  getAllCommands: vi.fn(),
  getCommands: vi.fn(),
  sendPing: vi.fn(),
  sendLocate: vi.fn(),
  sendPlayMelody: vi.fn(),
  sendTestAudio: vi.fn(),
  sendSetVolume: vi.fn(),
  sendUnlock: vi.fn(),
  deleteCommand: vi.fn(),
}));

import {
  getAllCommands,
  getCommands,
  sendPing,
  sendLocate,
  sendUnlock,
  deleteCommand,
} from '@/api/commands';

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

describe('useAllCommands', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls getAllCommands with no deviceUid', async () => {
    const mockData = { commands: [], total: 0 };
    vi.mocked(getAllCommands).mockResolvedValue(mockData as any);

    const { result } = renderHook(() => useAllCommands(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(getAllCommands).toHaveBeenCalledWith(undefined);
    expect(result.current.data).toEqual(mockData);
  });

  it('passes deviceUid to getAllCommands', async () => {
    vi.mocked(getAllCommands).mockResolvedValue({ commands: [], total: 0 } as any);

    const { result } = renderHook(() => useAllCommands('dev:123'), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(getAllCommands).toHaveBeenCalledWith('dev:123');
  });
});

describe('useCommands', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls getCommands with serialNumber', async () => {
    const mockData = { device_uid: 'dev:123', commands: [] };
    vi.mocked(getCommands).mockResolvedValue(mockData as any);

    const { result } = renderHook(() => useCommands('sb01'), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(getCommands).toHaveBeenCalledWith('sb01');
  });

  it('is disabled when serialNumber is empty', async () => {
    const { result } = renderHook(() => useCommands(''), {
      wrapper: createWrapper(),
    });

    expect(result.current.fetchStatus).toBe('idle');
    expect(getCommands).not.toHaveBeenCalled();
  });
});

describe('useSendPing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls sendPing with serialNumber', async () => {
    vi.mocked(sendPing).mockResolvedValue({} as any);

    const { result } = renderHook(() => useSendPing(), {
      wrapper: createWrapper(),
    });

    await result.current.mutateAsync('sb01');

    expect(sendPing).toHaveBeenCalledWith('sb01');
  });
});

describe('useSendLocate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls sendLocate with serialNumber and durationSec', async () => {
    vi.mocked(sendLocate).mockResolvedValue({} as any);

    const { result } = renderHook(() => useSendLocate(), {
      wrapper: createWrapper(),
    });

    await result.current.mutateAsync({ serialNumber: 'sb01', durationSec: 60 });

    expect(sendLocate).toHaveBeenCalledWith('sb01', 60);
  });
});

describe('useSendUnlock', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls sendUnlock with serialNumber and lockType', async () => {
    vi.mocked(sendUnlock).mockResolvedValue({} as any);

    const { result } = renderHook(() => useSendUnlock(), {
      wrapper: createWrapper(),
    });

    await result.current.mutateAsync({ serialNumber: 'sb01', lockType: 'transit' });

    expect(sendUnlock).toHaveBeenCalledWith('sb01', 'transit');
  });
});

describe('useDeleteCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls deleteCommand with commandId and serialNumber', async () => {
    vi.mocked(deleteCommand).mockResolvedValue({ message: 'ok', command_id: 'cmd-1' });

    const { result } = renderHook(() => useDeleteCommand(), {
      wrapper: createWrapper(),
    });

    await result.current.mutateAsync({ commandId: 'cmd-1', serialNumber: 'sb01' });

    expect(deleteCommand).toHaveBeenCalledWith('cmd-1', 'sb01');
  });
});
