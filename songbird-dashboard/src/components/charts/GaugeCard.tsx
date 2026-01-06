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
    <Card className={cn('overflow-hidden w-full min-w-0', className)}>
      <CardHeader className="flex flex-row items-center justify-between pb-2 px-2 sm:px-4 lg:px-6">
        <CardTitle className="text-xs sm:text-sm font-medium text-muted-foreground truncate pr-1">
          {title}
        </CardTitle>
        <div className="text-muted-foreground flex-shrink-0">{icon}</div>
      </CardHeader>
      <CardContent className="px-2 sm:px-4 lg:px-6 pb-3">
        <div className="flex items-center justify-between gap-2">
          <div className={cn('text-4xl sm:text-3xl lg:text-4xl font-bold', statusColors[status])}>
            {value}
            {unit && <span className="text-lg sm:text-base lg:text-xl ml-1">{unit}</span>}
          </div>
          {sparklineData && sparklineData.length >= 2 && (
            <div className="flex-shrink-0 w-32 sm:w-24">
              {renderSparkline()}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
