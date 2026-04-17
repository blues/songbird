import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// Must define ResizeObserver before importing the component
beforeAll(() => {
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

const mockUseDeviceConfig = vi.fn();
const mockUseIsAdmin = vi.fn();
const mockUseUserProfile = vi.fn();

vi.mock('@/hooks/useConfig', () => ({
  useDeviceConfig: (...args: unknown[]) => mockUseDeviceConfig(...args),
  useUpdateDeviceConfig: vi.fn(() => ({
    mutate: vi.fn(),
    isPending: false,
  })),
  useSetDeviceWifi: vi.fn(() => ({
    mutate: vi.fn(),
    isPending: false,
    isError: false,
  })),
}));

vi.mock('@/hooks/useAuth', () => ({
  useIsAdmin: () => mockUseIsAdmin(),
}));

vi.mock('@/hooks/useUserProfile', () => ({
  useUserProfile: () => mockUseUserProfile(),
}));

vi.mock('@/contexts/PreferencesContext', () => ({
  usePreferences: vi.fn(() => ({
    preferences: { temp_unit: 'celsius' },
    isLoading: false,
  })),
}));

vi.mock('@/utils/formatters', () => ({
  formatMode: vi.fn((mode: string) => mode.charAt(0).toUpperCase() + mode.slice(1)),
}));

// Lazy import so mocks are established first
const { ConfigPanel } = await import('./ConfigPanel');

const defaultConfigData = {
  data: {
    config: {
      mode: 'demo',
      gps_interval_min: 5,
      sync_interval_min: 15,
      temp_alert_high_c: 35,
      temp_alert_low_c: 0,
      humidity_alert_high: 80,
      humidity_alert_low: 20,
      audio_enabled: true,
      audio_volume: 50,
      motion_sensitivity: 'medium',
    },
  },
  isLoading: false,
};

function renderPanel(props: Record<string, unknown> = {}) {
  const defaults = {
    serialNumber: 'sb01',
    ...props,
  };
  return render(<ConfigPanel {...defaults} />);
}

describe('ConfigPanel', () => {
  beforeEach(() => {
    mockUseDeviceConfig.mockReturnValue(defaultConfigData);
    mockUseIsAdmin.mockReturnValue({ isAdmin: true });
    mockUseUserProfile.mockReturnValue({ data: { email: 'admin@test.com' } });
  });

  it('renders "Device Configuration" title', () => {
    renderPanel();
    expect(screen.getByText('Device Configuration')).toBeInTheDocument();
  });

  it('shows "Loading configuration..." when isLoading', () => {
    mockUseDeviceConfig.mockReturnValueOnce({ data: null, isLoading: true });
    renderPanel();
    expect(screen.getByText('Loading configuration...')).toBeInTheDocument();
  });

  it('shows operating mode selector', () => {
    renderPanel();
    expect(screen.getByText('Operating Mode')).toBeInTheDocument();
  });

  it('shows alert threshold section', () => {
    renderPanel();
    expect(screen.getByText('Alert Thresholds')).toBeInTheDocument();
  });

  it('shows audio settings section', () => {
    renderPanel();
    expect(screen.getByText('Audio Settings')).toBeInTheDocument();
  });

  it('shows Apply button when user is admin', () => {
    renderPanel();
    expect(screen.getByRole('button', { name: /apply changes/i })).toBeInTheDocument();
  });

  it('shows read-only notice when user is not admin and not device owner', () => {
    mockUseIsAdmin.mockReturnValue({ isAdmin: false });
    mockUseUserProfile.mockReturnValue({ data: { email: 'other@test.com' } });
    renderPanel({ assignedTo: 'owner@test.com' });
    expect(
      screen.getByText(/you can view this configuration but only the device owner or an admin can make changes/i)
    ).toBeInTheDocument();
  });
});
