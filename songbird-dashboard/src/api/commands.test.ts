import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./client', () => ({
  apiGet: vi.fn().mockResolvedValue({}),
  apiPost: vi.fn().mockResolvedValue({}),
  apiDelete: vi.fn().mockResolvedValue({}),
}));

import { apiGet, apiPost, apiDelete } from './client';
import {
  getAllCommands,
  getCommands,
  sendCommand,
  sendPing,
  sendLocate,
  sendPlayMelody,
  sendTestAudio,
  sendSetVolume,
  sendUnlock,
  deleteCommand,
} from './commands';

beforeEach(() => {
  vi.mocked(apiGet).mockReset().mockResolvedValue({});
  vi.mocked(apiPost).mockReset().mockResolvedValue({});
  vi.mocked(apiDelete).mockReset().mockResolvedValue({});
});

describe('getAllCommands', () => {
  it('calls apiGet with /v1/commands and no params when no deviceUid', async () => {
    await getAllCommands();
    expect(apiGet).toHaveBeenCalledWith('/v1/commands', undefined);
  });

  it('calls apiGet with device_uid param when provided', async () => {
    await getAllCommands('dev:123');
    expect(apiGet).toHaveBeenCalledWith('/v1/commands', { device_uid: 'dev:123' });
  });
});

describe('getCommands', () => {
  it('calls apiGet with the device commands endpoint', async () => {
    await getCommands('sb01');
    expect(apiGet).toHaveBeenCalledWith('/v1/devices/sb01/commands');
  });
});

describe('sendCommand', () => {
  it('calls apiPost with cmd and params', async () => {
    await sendCommand('sb01', 'ping', { foo: 'bar' });
    expect(apiPost).toHaveBeenCalledWith('/v1/devices/sb01/commands', {
      cmd: 'ping',
      params: { foo: 'bar' },
    });
  });

  it('calls apiPost with undefined params when not provided', async () => {
    await sendCommand('sb01', 'ping');
    expect(apiPost).toHaveBeenCalledWith('/v1/devices/sb01/commands', {
      cmd: 'ping',
      params: undefined,
    });
  });
});

describe('sendPing', () => {
  it('sends a ping command via sendCommand', async () => {
    await sendPing('sb01');
    expect(apiPost).toHaveBeenCalledWith('/v1/devices/sb01/commands', {
      cmd: 'ping',
      params: undefined,
    });
  });
});

describe('sendLocate', () => {
  it('sends a locate command with default duration', async () => {
    await sendLocate('sb01');
    expect(apiPost).toHaveBeenCalledWith('/v1/devices/sb01/commands', {
      cmd: 'locate',
      params: { duration_sec: 30 },
    });
  });

  it('sends a locate command with custom duration', async () => {
    await sendLocate('sb01', 60);
    expect(apiPost).toHaveBeenCalledWith('/v1/devices/sb01/commands', {
      cmd: 'locate',
      params: { duration_sec: 60 },
    });
  });
});

describe('sendPlayMelody', () => {
  it('sends a play_melody command', async () => {
    await sendPlayMelody('sb01', 'happy_birthday');
    expect(apiPost).toHaveBeenCalledWith('/v1/devices/sb01/commands', {
      cmd: 'play_melody',
      params: { melody: 'happy_birthday' },
    });
  });
});

describe('sendTestAudio', () => {
  it('sends a test_audio command with frequency and duration', async () => {
    await sendTestAudio('sb01', 440, 1000);
    expect(apiPost).toHaveBeenCalledWith('/v1/devices/sb01/commands', {
      cmd: 'test_audio',
      params: { frequency: 440, duration_ms: 1000 },
    });
  });
});

describe('sendSetVolume', () => {
  it('sends a set_volume command', async () => {
    await sendSetVolume('sb01', 75);
    expect(apiPost).toHaveBeenCalledWith('/v1/devices/sb01/commands', {
      cmd: 'set_volume',
      params: { volume: 75 },
    });
  });
});

describe('sendUnlock', () => {
  it('sends an unlock command with default lock type', async () => {
    await sendUnlock('sb01');
    expect(apiPost).toHaveBeenCalledWith('/v1/devices/sb01/commands', {
      cmd: 'unlock',
      params: { lock_type: 'all' },
    });
  });

  it('sends an unlock command with specific lock type', async () => {
    await sendUnlock('sb01', 'transit');
    expect(apiPost).toHaveBeenCalledWith('/v1/devices/sb01/commands', {
      cmd: 'unlock',
      params: { lock_type: 'transit' },
    });
  });
});

describe('deleteCommand', () => {
  it('calls apiDelete with command ID and device_uid query param', async () => {
    await deleteCommand('cmd-123', 'dev:456');
    expect(apiDelete).toHaveBeenCalledWith('/v1/commands/cmd-123?device_uid=dev%3A456');
  });
});
