import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { StatsCards } from './StatsCards';
import type { DashboardStats } from '@/types';

const mockStats: DashboardStats = {
  total_devices: 10,
  online_devices: 7,
  offline_devices: 3,
  active_alerts: 2,
  low_battery_count: 1,
};

describe('StatsCards', () => {
  it('renders all 5 stat cards with correct labels', () => {
    render(<StatsCards stats={mockStats} />);
    expect(screen.getByText('Total Devices')).toBeInTheDocument();
    expect(screen.getByText('Online')).toBeInTheDocument();
    expect(screen.getByText('Offline')).toBeInTheDocument();
    expect(screen.getByText('Active Alerts')).toBeInTheDocument();
    expect(screen.getByText('Low Battery')).toBeInTheDocument();
  });

  it('displays correct values from stats prop', () => {
    render(<StatsCards stats={mockStats} />);
    expect(screen.getByText('10')).toBeInTheDocument();
    expect(screen.getByText('7')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument();
  });

  it('calls onCardClick with correct card type when clicked', () => {
    const handleClick = vi.fn();
    render(<StatsCards stats={mockStats} onCardClick={handleClick} />);

    fireEvent.click(screen.getByText('Total Devices'));
    expect(handleClick).toHaveBeenCalledWith('total');

    fireEvent.click(screen.getByText('Online'));
    expect(handleClick).toHaveBeenCalledWith('online');

    fireEvent.click(screen.getByText('Active Alerts'));
    expect(handleClick).toHaveBeenCalledWith('alerts');
  });

  it('does not add cursor-pointer class when onCardClick is not provided', () => {
    const { container } = render(<StatsCards stats={mockStats} />);
    const cards = container.querySelectorAll('[class*="cursor-pointer"]');
    expect(cards).toHaveLength(0);
  });
});
