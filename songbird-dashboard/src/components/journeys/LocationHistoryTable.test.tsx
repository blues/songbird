import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { LocationHistoryTable } from './LocationHistoryTable';
import type { LocationHistoryPoint, LocationSource } from '@/types';

vi.mock('@/utils/formatters', () => ({
  formatRelativeTime: vi.fn(() => '2 min ago'),
}));

const mockLocation: LocationHistoryPoint = {
  lat: 40.7128,
  lon: -74.006,
  time: '2025-01-15T10:00:00Z',
  source: 'gps' as LocationSource,
  location_name: 'New York',
  velocity: 13.89,
  bearing: 180,
};

describe('LocationHistoryTable', () => {
  it('shows "Loading locations..." when isLoading', () => {
    render(<LocationHistoryTable locations={[]} isLoading />);
    expect(screen.getByText('Loading locations...')).toBeInTheDocument();
  });

  it('shows "No location history" when locations is empty', () => {
    render(<LocationHistoryTable locations={[]} />);
    expect(screen.getByText('No location history')).toBeInTheDocument();
  });

  it('renders location with coordinates', () => {
    render(<LocationHistoryTable locations={[mockLocation]} />);
    expect(screen.getByText('40.712800, -74.006000')).toBeInTheDocument();
  });

  it('shows location name when available', () => {
    render(<LocationHistoryTable locations={[mockLocation]} />);
    expect(screen.getByText('New York')).toBeInTheDocument();
  });

  it('shows GPS badge for GPS source', () => {
    render(<LocationHistoryTable locations={[mockLocation]} />);
    expect(screen.getByText('GPS')).toBeInTheDocument();
  });

  it('displays location count text', () => {
    render(<LocationHistoryTable locations={[mockLocation]} />);
    expect(screen.getByText('1 location')).toBeInTheDocument();
  });

  it('calls onLocationClick when location is clicked', () => {
    const onClick = vi.fn();

    render(
      <LocationHistoryTable locations={[mockLocation]} onLocationClick={onClick} />
    );

    fireEvent.click(screen.getByText('40.712800, -74.006000').closest('button')!);
    expect(onClick).toHaveBeenCalledWith(mockLocation);
  });
});
