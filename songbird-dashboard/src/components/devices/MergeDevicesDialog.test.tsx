import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MergeDevicesDialog } from './MergeDevicesDialog';
import type { Device } from '@/types';

const mockMutateAsync = vi.fn();

vi.mock('@/hooks/useDevices', () => ({
  useMergeDevices: vi.fn(() => ({
    mutateAsync: mockMutateAsync,
    isPending: false,
    isError: false,
    error: null,
  })),
}));

vi.mock('@/utils/formatters', () => ({
  formatRelativeTime: vi.fn(() => '5 minutes ago'),
}));

const devices: Device[] = [
  {
    device_uid: 'dev:001',
    serial_number: 'sb01',
    name: 'Songbird 01',
    status: 'online',
    mode: 'demo',
    last_seen: '2026-01-01T00:00:00Z',
  } as Device,
  {
    device_uid: 'dev:002',
    serial_number: 'sb02',
    name: 'Songbird 02',
    status: 'offline',
    mode: 'storage',
    last_seen: '2026-01-02T00:00:00Z',
  } as Device,
];

function renderDialog(open = true) {
  const onOpenChange = vi.fn();
  return render(
    <MergeDevicesDialog
      open={open}
      onOpenChange={onOpenChange}
      devices={devices}
    />
  );
}

describe('MergeDevicesDialog', () => {
  it('renders "Merge Devices" title when open', () => {
    renderDialog();
    expect(screen.getByText('Merge Devices')).toBeInTheDocument();
  });

  it('shows source and target device selectors', () => {
    renderDialog();
    expect(screen.getByText('Source Device (will be deleted)')).toBeInTheDocument();
    expect(screen.getByText('Target Device (will keep history)')).toBeInTheDocument();
  });

  it('Continue button is disabled when no devices are selected', () => {
    renderDialog();
    const continueBtn = screen.getByRole('button', { name: /continue/i });
    expect(continueBtn).toBeDisabled();
  });

  it('shows Cancel button', () => {
    renderDialog();
    expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument();
  });

  it('shows description about merging', () => {
    renderDialog();
    expect(
      screen.getByText(/merge two devices into one/i)
    ).toBeInTheDocument();
  });
});
