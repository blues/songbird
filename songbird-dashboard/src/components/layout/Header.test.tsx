import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Header } from './Header';

vi.mock('@/hooks/useUserProfile', () => ({
  useUserProfile: vi.fn(() => ({ data: null, isLoading: false })),
}));

vi.mock('./MobileNav', () => ({
  MobileNav: () => <div data-testid="mobile-nav" />,
}));

vi.mock('@/components/profile/ProfileDialog', () => ({
  ProfileDialog: () => null,
}));

const defaultUser = { username: 'jdoe', email: 'jdoe@example.com' };

function renderHeader(props: Partial<Parameters<typeof Header>[0]> = {}) {
  return render(
    <MemoryRouter>
      <Header user={defaultUser} {...props} />
    </MemoryRouter>
  );
}

describe('Header', () => {
  it('renders Songbird logo text', () => {
    renderHeader();
    expect(screen.getByText('Songbird')).toBeInTheDocument();
  });

  it('shows alert count badge when alertCount > 0', () => {
    renderHeader({ alertCount: 3 });
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('does not show alert badge when alertCount is 0', () => {
    renderHeader({ alertCount: 0 });
    // The bell icon exists but no badge number
    expect(screen.queryByText('0')).not.toBeInTheDocument();
  });

  it('shows user display name and email', () => {
    renderHeader();
    // username is used as display name when profile.name is null
    expect(screen.getByText('jdoe')).toBeInTheDocument();
    expect(screen.getByText('jdoe@example.com')).toBeInTheDocument();
  });

  it('shows fleet selector when fleets are provided', () => {
    renderHeader({
      fleets: [{ fleet_uid: 'fleet-1', name: 'Fleet Alpha' }],
      selectedFleet: 'fleet-1',
    });
    expect(screen.getByRole('combobox')).toBeInTheDocument();
  });

  it('does not show fleet selector when no fleets', () => {
    renderHeader({ fleets: [] });
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });
});
