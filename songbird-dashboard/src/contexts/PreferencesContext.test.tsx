import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PreferencesProvider, usePreferences } from './PreferencesContext';

vi.mock('@/hooks/useUserProfile', () => ({
  useUserProfile: vi.fn(),
}));

import { useUserProfile } from '@/hooks/useUserProfile';

const mockedUseUserProfile = vi.mocked(useUserProfile);

function TestConsumer() {
  const { preferences, isLoading } = usePreferences();
  return (
    <div>
      <span data-testid="temp-unit">{preferences.temp_unit}</span>
      <span data-testid="time-format">{preferences.time_format}</span>
      <span data-testid="default-time-range">{preferences.default_time_range}</span>
      <span data-testid="map-style">{preferences.map_style}</span>
      <span data-testid="distance-unit">{preferences.distance_unit}</span>
      <span data-testid="loading">{String(isLoading)}</span>
    </div>
  );
}

describe('PreferencesContext', () => {
  it('provides default preferences when profile is loading', () => {
    mockedUseUserProfile.mockReturnValue({
      data: undefined,
      isLoading: true,
    } as any);

    render(
      <PreferencesProvider>
        <TestConsumer />
      </PreferencesProvider>
    );

    expect(screen.getByTestId('temp-unit')).toHaveTextContent('celsius');
    expect(screen.getByTestId('time-format')).toHaveTextContent('24h');
    expect(screen.getByTestId('default-time-range')).toHaveTextContent('24');
    expect(screen.getByTestId('map-style')).toHaveTextContent('street');
    expect(screen.getByTestId('distance-unit')).toHaveTextContent('km');
    expect(screen.getByTestId('loading')).toHaveTextContent('true');
  });

  it('provides profile preferences when loaded', () => {
    mockedUseUserProfile.mockReturnValue({
      data: {
        preferences: {
          temp_unit: 'fahrenheit',
          time_format: '12h',
          default_time_range: '48',
          map_style: 'satellite',
          distance_unit: 'mi',
        },
      },
      isLoading: false,
    } as any);

    render(
      <PreferencesProvider>
        <TestConsumer />
      </PreferencesProvider>
    );

    expect(screen.getByTestId('temp-unit')).toHaveTextContent('fahrenheit');
    expect(screen.getByTestId('time-format')).toHaveTextContent('12h');
    expect(screen.getByTestId('default-time-range')).toHaveTextContent('48');
    expect(screen.getByTestId('map-style')).toHaveTextContent('satellite');
    expect(screen.getByTestId('distance-unit')).toHaveTextContent('mi');
    expect(screen.getByTestId('loading')).toHaveTextContent('false');
  });

  it('returns defaults when usePreferences is used outside provider', () => {
    render(<TestConsumer />);

    expect(screen.getByTestId('temp-unit')).toHaveTextContent('celsius');
    expect(screen.getByTestId('time-format')).toHaveTextContent('24h');
    expect(screen.getByTestId('default-time-range')).toHaveTextContent('24');
    expect(screen.getByTestId('map-style')).toHaveTextContent('street');
    expect(screen.getByTestId('distance-unit')).toHaveTextContent('km');
    expect(screen.getByTestId('loading')).toHaveTextContent('true');
  });
});
