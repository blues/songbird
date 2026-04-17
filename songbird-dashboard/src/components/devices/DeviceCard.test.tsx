import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { DeviceCard } from './DeviceCard';
import type { Device } from '@/types';

vi.mock('@/contexts/PreferencesContext', () => ({
  usePreferences: vi.fn(() => ({
    preferences: { temp_unit: 'celsius' },
    isLoading: false,
  })),
}));

function renderCard(device: Partial<Device>, alertCount?: number) {
  const defaults: Device = {
    device_uid: 'dev:1234',
    serial_number: 'songbird01-test',
    status: 'online',
    mode: 'demo',
    ...device,
  } as Device;

  return render(
    <MemoryRouter>
      <DeviceCard device={defaults} alertCount={alertCount} />
    </MemoryRouter>
  );
}

describe('DeviceCard', () => {
  it('renders device name when provided', () => {
    renderCard({ name: 'My Songbird' });
    expect(screen.getByText('My Songbird')).toBeInTheDocument();
  });

  it('falls back to serial_number when no name', () => {
    renderCard({ name: undefined, serial_number: 'songbird01-test' });
    expect(screen.getByText('songbird01-test')).toBeInTheDocument();
  });

  it('links to correct device detail page', () => {
    renderCard({ serial_number: 'songbird02-abc' });
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', '/devices/songbird02-abc');
  });

  it('shows temperature in Celsius', () => {
    renderCard({ temperature: 23.456 });
    expect(screen.getByText('23.5°C')).toBeInTheDocument();
  });

  it('shows humidity percentage', () => {
    renderCard({ humidity: 55.123 });
    expect(screen.getByText('55.1%')).toBeInTheDocument();
  });

  it('shows battery percentage', () => {
    // voltage 3.6 => ((3.6 - 3.0) / 1.2) * 100 = 50%
    renderCard({ voltage: 3.6 });
    expect(screen.getByText('50%')).toBeInTheDocument();
  });

  it('shows "No location" when no coordinates', () => {
    renderCard({ latitude: undefined, longitude: undefined });
    expect(screen.getByText('No location')).toBeInTheDocument();
  });

  it('shows location name when available', () => {
    renderCard({
      latitude: 40.7128,
      longitude: -74.006,
      location_name: 'New York, NY',
    });
    expect(screen.getByText('New York, NY')).toBeInTheDocument();
  });

  it('shows alert count badge when alertCount > 0', () => {
    renderCard({}, 3);
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('does not show alert badge when alertCount is 0', () => {
    renderCard({}, 0);
    // The alert count text "0" should not be present
    const badges = screen.queryByText('0');
    // 0% battery could show "0" so let's be more specific
    expect(screen.queryByText('0', { selector: '.gap-1' })).not.toBeInTheDocument();
  });

  it('shows mode badge', () => {
    renderCard({ mode: 'demo' });
    expect(screen.getByText('Demo')).toBeInTheDocument();
  });

  it('shows lock icon when transit_locked', () => {
    renderCard({ transit_locked: true, mode: 'transit' });
    // The badge should have the lock styling (amber background)
    const badge = screen.getByText('Transit').closest('[class*="bg-amber"]');
    expect(badge).toBeInTheDocument();
  });

  it('shows pending mode badge when pending_mode differs from mode', () => {
    renderCard({ mode: 'demo', pending_mode: 'transit' });
    expect(screen.getByText('Transit')).toBeInTheDocument();
    expect(screen.getByText('Demo')).toBeInTheDocument();
  });
});
