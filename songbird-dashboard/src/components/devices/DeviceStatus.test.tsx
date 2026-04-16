import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DeviceStatus } from './DeviceStatus';

describe('DeviceStatus', () => {
  it('renders "Online" label for online status', () => {
    render(<DeviceStatus status="online" />);
    expect(screen.getByText('Online')).toBeInTheDocument();
  });

  it('renders "Offline" label for offline status', () => {
    render(<DeviceStatus status="offline" />);
    expect(screen.getByText('Offline')).toBeInTheDocument();
  });

  it('renders "Unknown" label for unknown status', () => {
    render(<DeviceStatus status="unknown" />);
    expect(screen.getByText('Unknown')).toBeInTheDocument();
  });

  it('hides label when showLabel=false', () => {
    render(<DeviceStatus status="online" showLabel={false} />);
    expect(screen.queryByText('Online')).not.toBeInTheDocument();
  });

  it('shows label by default (showLabel defaults to true)', () => {
    render(<DeviceStatus status="offline" />);
    expect(screen.getByText('Offline')).toBeInTheDocument();
  });

  it('applies custom className', () => {
    const { container } = render(<DeviceStatus status="online" className="my-custom-class" />);
    expect(container.firstChild).toHaveClass('my-custom-class');
  });
});
