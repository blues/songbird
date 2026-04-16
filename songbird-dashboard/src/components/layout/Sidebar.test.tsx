import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Sidebar } from './Sidebar';

vi.mock('@/hooks/useFeatureFlags', () => ({
  useFeatureFlags: vi.fn(() => ({ analytics: false })),
}));

vi.mock('@/hooks/useMyDevice', () => ({
  useMyDevice: vi.fn(() => ({ serialNumber: null, isLoading: false })),
}));

import { useFeatureFlags } from '@/hooks/useFeatureFlags';
import { useMyDevice } from '@/hooks/useMyDevice';

function renderSidebar() {
  return render(
    <MemoryRouter>
      <Sidebar />
    </MemoryRouter>
  );
}

describe('Sidebar', () => {
  it('renders core nav items', () => {
    renderSidebar();
    expect(screen.getByText('Dashboard')).toBeInTheDocument();
    expect(screen.getByText('Devices')).toBeInTheDocument();
    expect(screen.getByText('Fleet Map')).toBeInTheDocument();
    expect(screen.getByText('Alerts')).toBeInTheDocument();
    expect(screen.getByText('Commands')).toBeInTheDocument();
    expect(screen.getByText('Settings')).toBeInTheDocument();
  });

  it('does not show Analytics when feature flag is off', () => {
    renderSidebar();
    expect(screen.queryByText('Analytics')).not.toBeInTheDocument();
  });

  it('shows Analytics when feature flag is on', () => {
    vi.mocked(useFeatureFlags).mockReturnValue({ analytics: true } as any);
    renderSidebar();
    expect(screen.getByText('Analytics')).toBeInTheDocument();
    vi.mocked(useFeatureFlags).mockReturnValue({ analytics: false } as any);
  });

  it('does not show My Device when no device assigned', () => {
    renderSidebar();
    expect(screen.queryByText('My Device')).not.toBeInTheDocument();
  });

  it('shows My Device when useMyDevice returns a serialNumber', () => {
    vi.mocked(useMyDevice).mockReturnValue({ serialNumber: 'songbird01-bds', isLoading: false } as any);
    renderSidebar();
    expect(screen.getByText('My Device')).toBeInTheDocument();
    vi.mocked(useMyDevice).mockReturnValue({ serialNumber: null, isLoading: false } as any);
  });

  it('shows version footer "Songbird v1.0.0"', () => {
    renderSidebar();
    expect(screen.getByText('Songbird v1.0.0')).toBeInTheDocument();
  });
});
