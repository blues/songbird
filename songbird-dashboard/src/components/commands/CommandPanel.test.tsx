import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CommandPanel } from './CommandPanel';
import type { Command } from '@/types';

const mockPingMutate = vi.fn();
const mockLocateMutate = vi.fn();
const mockMelodyMutate = vi.fn();
const mockUnlockMutate = vi.fn();

vi.mock('@/hooks/useCommands', () => ({
  useSendPing: vi.fn(() => ({ mutate: mockPingMutate, isPending: false })),
  useSendLocate: vi.fn(() => ({ mutate: mockLocateMutate, isPending: false })),
  useSendPlayMelody: vi.fn(() => ({ mutate: mockMelodyMutate, isPending: false })),
  useSendUnlock: vi.fn(() => ({ mutate: mockUnlockMutate, isPending: false })),
}));

vi.mock('@/hooks/useAuth', () => ({
  useCanUnlockDevice: vi.fn(() => ({ canUnlock: false })),
}));

vi.mock('@/utils/formatters', () => ({
  formatRelativeTime: vi.fn(() => '2 minutes ago'),
}));

// Radix UI Slider uses ResizeObserver which is not available in jsdom
globalThis.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

beforeEach(() => {
  mockPingMutate.mockClear();
  mockLocateMutate.mockClear();
  mockMelodyMutate.mockClear();
  mockUnlockMutate.mockClear();
});

describe('CommandPanel', () => {
  const defaultProps = {
    serialNumber: 'songbird01-bds',
    audioEnabled: true,
  };

  it('renders "Command & Control" title', () => {
    render(<CommandPanel {...defaultProps} />);
    expect(screen.getByText('Command & Control')).toBeInTheDocument();
  });

  it('ping button calls mutate with serialNumber on click', () => {
    render(<CommandPanel {...defaultProps} />);

    const pingButton = screen.getByRole('button', { name: /ping/i });
    fireEvent.click(pingButton);
    expect(mockPingMutate).toHaveBeenCalledWith('songbird01-bds');
  });

  it('ping button is disabled when audioEnabled is false', () => {
    render(<CommandPanel {...defaultProps} audioEnabled={false} />);
    const pingButton = screen.getByRole('button', { name: /ping/i });
    expect(pingButton).toBeDisabled();
  });

  it('shows audio disabled notice when audioEnabled is false', () => {
    render(<CommandPanel {...defaultProps} audioEnabled={false} />);
    expect(screen.getByText('Audio is disabled on this device')).toBeInTheDocument();
  });

  it('does not show lock override section when device is not locked', () => {
    render(<CommandPanel {...defaultProps} />);
    expect(screen.queryByText('Device Lock Override')).not.toBeInTheDocument();
  });

  it('shows lock override when device is locked and canUnlock is true', async () => {
    const { useCanUnlockDevice } = await import('@/hooks/useAuth');
    vi.mocked(useCanUnlockDevice).mockReturnValue({ canUnlock: true });

    render(
      <CommandPanel
        {...defaultProps}
        transitLocked={true}
        assignedTo="user@test.com"
      />
    );
    expect(screen.getByText('Device Lock Override')).toBeInTheDocument();
  });

  it('displays last command with status "ok"', () => {
    const lastCommand: Command = {
      command_id: 'cmd-1',
      device_uid: 'dev:123',
      cmd: 'ping',
      status: 'ok',
      created_at: Date.now(),
    };
    render(<CommandPanel {...defaultProps} lastCommand={lastCommand} />);
    expect(screen.getByText('✓ OK')).toBeInTheDocument();
  });

  it('displays last command with status "queued"', () => {
    const lastCommand: Command = {
      command_id: 'cmd-2',
      device_uid: 'dev:123',
      cmd: 'ping',
      status: 'queued',
      created_at: Date.now(),
    };
    render(<CommandPanel {...defaultProps} lastCommand={lastCommand} />);
    expect(screen.getByText('⏳ Queued')).toBeInTheDocument();
  });

  it('displays last command with status "error"', () => {
    const lastCommand: Command = {
      command_id: 'cmd-3',
      device_uid: 'dev:123',
      cmd: 'ping',
      status: 'error',
      created_at: Date.now(),
    };
    render(<CommandPanel {...defaultProps} lastCommand={lastCommand} />);
    expect(screen.getByText('✗ Error')).toBeInTheDocument();
  });
});
