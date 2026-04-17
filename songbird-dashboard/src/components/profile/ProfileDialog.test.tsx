import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ProfileDialog } from './ProfileDialog';

vi.mock('@/hooks/useUserProfile', () => ({
  useUserProfile: vi.fn(() => ({
    data: { name: 'Test User', email: 'test@example.com' },
  })),
  useUpdateDisplayName: vi.fn(() => ({
    mutateAsync: vi.fn(),
    isPending: false,
  })),
}));

function renderDialog(props: Partial<Parameters<typeof ProfileDialog>[0]> = {}) {
  const defaultProps = {
    open: true,
    onOpenChange: vi.fn(),
  };
  return { ...render(<ProfileDialog {...defaultProps} {...props} />), onOpenChange: defaultProps.onOpenChange };
}

describe('ProfileDialog', () => {
  it('renders "Edit Profile" title when open', () => {
    renderDialog();
    expect(screen.getByText('Edit Profile')).toBeInTheDocument();
  });

  it('shows display name input pre-filled with profile name', () => {
    renderDialog();
    const input = screen.getByPlaceholderText('Enter your name');
    expect(input).toHaveValue('Test User');
  });

  it('shows email from profile', () => {
    renderDialog();
    expect(screen.getByText('test@example.com')).toBeInTheDocument();
  });

  it('Cancel button calls onOpenChange(false)', () => {
    const { onOpenChange } = renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('Save button is disabled when name input is empty', () => {
    renderDialog();
    const input = screen.getByPlaceholderText('Enter your name');
    fireEvent.change(input, { target: { value: '' } });
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });
});
