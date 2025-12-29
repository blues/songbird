import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';

interface GaugeCardProps {
  title: string;
  value: string | number;
  unit?: string;
  icon: React.ReactNode;
  trend?: 'up' | 'down' | 'stable';
  status?: 'normal' | 'warning' | 'critical';
  sparklineData?: number[];
  className?: string;
}

export function GaugeCard({
  title,
  value,
  unit,
  icon,
  status = 'normal',
  sparklineData,
  className,
}: GaugeCardProps) {
  const statusColors = {
    normal: 'text-foreground',
    warning: 'text-yellow-500',
    critical: 'text-red-500',
  };

  // Simple sparkline SVG
  const renderSparkline = () => {
    if (!sparklineData || sparklineData.length < 2) return null;

    const width = 100;
    const height = 30;
    const min = Math.min(...sparklineData);
    const max = Math.max(...sparklineData);
    const range = max - min || 1;

    const points = sparklineData
      .map((v, i) => {
        const x = (i / (sparklineData.length - 1)) * width;
        const y = height - ((v - min) / range) * height;
        return `${x},${y}`;
      })
      .join(' ');

    return (
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-8 mt-2">
        <polyline
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          points={points}
          className="text-muted-foreground/50"
        />
      </svg>
    );
  };

  return (
    <Card className={cn('overflow-hidden', className)}>
      <CardHeader className="flex flex-row items-center justify-between pb-2 px-3 sm:px-6">
        <CardTitle className="text-xs sm:text-sm font-medium text-muted-foreground truncate">
          {title}
        </CardTitle>
        <div className="text-muted-foreground flex-shrink-0">{icon}</div>
      </CardHeader>
      <CardContent className="px-3 sm:px-6">
        <div className={cn('text-2xl sm:text-3xl font-bold', statusColors[status])}>
          {value}
          {unit && <span className="text-sm sm:text-lg ml-0.5 sm:ml-1">{unit}</span>}
        </div>
        {renderSparkline()}
      </CardContent>
    </Card>
  );
}
