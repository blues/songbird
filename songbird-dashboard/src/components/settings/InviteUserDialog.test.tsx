import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { InviteUserDialog } from './InviteUserDialog';

vi.mock('@/hooks/useUsers', () => ({
  useInviteUser: vi.fn(() => ({
    mutateAsync: vi.fn(),
    isPending: false,
  })),
  useUnassignedDevices: vi.fn(() => ({
    data: [
      { device_uid: 'dev1', name: 'Songbird 01', serial_number: 'sb01' },
    ],
    isLoading: false,
  })),
}));

function renderDialog(open = true) {
  const onOpenChange = vi.fn();
  return render(
    <InviteUserDialog open={open} onOpenChange={onOpenChange} />
  );
}

describe('InviteUserDialog', () => {
  it('renders "Invite New User" title when open', () => {
    renderDialog();
    expect(screen.getByText('Invite New User')).toBeInTheDocument();
  });

  it('shows Email and Full Name input fields', () => {
    renderDialog();
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/full name/i)).toBeInTheDocument();
  });

  it('shows role selector with Viewer as default', () => {
    renderDialog();
    // The Role label is rendered but Radix Select doesn't use a standard form control
    expect(screen.getByText(/role/i)).toBeInTheDocument();
    // Viewer is the default selected value shown in the trigger
    expect(screen.getByText('Viewer')).toBeInTheDocument();
  });

  it('shows Cancel and "Send Invitation" buttons', () => {
    renderDialog();
    expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /send invitation/i })).toBeInTheDocument();
  });

  it('shows device assignment dropdown', () => {
    renderDialog();
    expect(screen.getByText(/assign device/i)).toBeInTheDocument();
  });
});
