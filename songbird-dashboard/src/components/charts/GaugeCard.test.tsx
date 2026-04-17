import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { GaugeCard } from './GaugeCard';

describe('GaugeCard', () => {
  it('renders title, value, and unit', () => {
    render(<GaugeCard title="Temperature" value={72} unit="°F" icon={<span>icon</span>} />);
    expect(screen.getByText('Temperature')).toBeInTheDocument();
    expect(screen.getByText('72')).toBeInTheDocument();
    expect(screen.getByText('°F')).toBeInTheDocument();
  });

  it('renders icon', () => {
    render(<GaugeCard title="Temp" value={72} icon={<span data-testid="test-icon">IC</span>} />);
    expect(screen.getByTestId('test-icon')).toBeInTheDocument();
  });

  it('applies warning color class for warning status', () => {
    render(<GaugeCard title="Temp" value={90} icon={<span>icon</span>} status="warning" />);
    const valueEl = screen.getByText('90');
    expect(valueEl.closest('div')).toHaveClass('text-yellow-500');
  });

  it('applies critical color class for critical status', () => {
    render(<GaugeCard title="Temp" value={120} icon={<span>icon</span>} status="critical" />);
    const valueEl = screen.getByText('120');
    expect(valueEl.closest('div')).toHaveClass('text-red-500');
  });

  it('renders sparkline SVG when sparklineData has 2+ points', () => {
    const { container } = render(
      <GaugeCard title="Temp" value={72} icon={<span>icon</span>} sparklineData={[10, 20, 30]} />
    );
    expect(container.querySelector('svg')).toBeInTheDocument();
    expect(container.querySelector('polyline')).toBeInTheDocument();
  });

  it('does not render sparkline when data has fewer than 2 points', () => {
    const { container } = render(
      <GaugeCard title="Temp" value={72} icon={<span>icon</span>} sparklineData={[10]} />
    );
    expect(container.querySelector('svg')).not.toBeInTheDocument();
  });

  it('applies custom className', () => {
    const { container } = render(
      <GaugeCard title="Temp" value={72} icon={<span>icon</span>} className="my-class" />
    );
    expect(container.firstChild).toHaveClass('my-class');
  });
});
