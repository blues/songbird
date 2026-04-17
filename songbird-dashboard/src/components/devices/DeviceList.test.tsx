import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DeviceList } from './DeviceList';
import type { Device } from '@/types';

vi.mock('./DeviceCard', () => ({
  DeviceCard: ({ device, alertCount }: any) => (
    <div data-testid={`device-${device.device_uid}`}>
      {device.name || device.serial_number} alerts:{alertCount}
    </div>
  ),
}));

function makeDevice(overrides: Partial<Device> = {}): Device {
  return {
    device_uid: 'dev:001',
    serial_number: 'songbird01',
    status: 'online',
    mode: 'demo',
    ...overrides,
  } as Device;
}

describe('DeviceList', () => {
  it('renders loading skeletons when loading=true', () => {
    const { container } = render(
      <DeviceList devices={[]} loading={true} />
    );
    const skeletons = container.querySelectorAll('.animate-pulse');
    expect(skeletons.length).toBe(6);
  });

  it('shows "No devices found" when devices array is empty', () => {
    render(<DeviceList devices={[]} />);
    expect(screen.getByText('No devices found')).toBeInTheDocument();
  });

  it('renders DeviceCard for each device', () => {
    const devices = [
      makeDevice({ device_uid: 'dev:001', name: 'Alpha' }),
      makeDevice({ device_uid: 'dev:002', name: 'Beta' }),
      makeDevice({ device_uid: 'dev:003', name: 'Gamma' }),
    ];

    render(<DeviceList devices={devices} />);

    expect(screen.getByTestId('device-dev:001')).toBeInTheDocument();
    expect(screen.getByTestId('device-dev:002')).toBeInTheDocument();
    expect(screen.getByTestId('device-dev:003')).toBeInTheDocument();
  });

  it('passes alertCount to DeviceCard from alertsByDevice map', () => {
    const devices = [
      makeDevice({ device_uid: 'dev:001', name: 'Alpha' }),
      makeDevice({ device_uid: 'dev:002', name: 'Beta' }),
    ];
    const alertsByDevice = { 'dev:001': 5, 'dev:002': 0 };

    render(<DeviceList devices={devices} alertsByDevice={alertsByDevice} />);

    expect(screen.getByTestId('device-dev:001')).toHaveTextContent('alerts:5');
    expect(screen.getByTestId('device-dev:002')).toHaveTextContent('alerts:0');
  });

  it('default sort is by last_seen descending', () => {
    const devices = [
      makeDevice({ device_uid: 'dev:001', name: 'Oldest', last_seen: '2024-01-01T00:00:00Z' }),
      makeDevice({ device_uid: 'dev:002', name: 'Newest', last_seen: '2024-06-01T00:00:00Z' }),
      makeDevice({ device_uid: 'dev:003', name: 'Middle', last_seen: '2024-03-01T00:00:00Z' }),
    ];

    render(<DeviceList devices={devices} />);

    const cards = screen.getAllByTestId(/^device-/);
    expect(cards[0]).toHaveTextContent('Newest');
    expect(cards[1]).toHaveTextContent('Middle');
    expect(cards[2]).toHaveTextContent('Oldest');
  });
});
