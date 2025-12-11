import { cn } from '@/lib/utils';
import type { DeviceStatus as DeviceStatusType } from '@/types';

interface DeviceStatusProps {
  status: DeviceStatusType;
  className?: string;
  showLabel?: boolean;
}

export function DeviceStatus({ status, className, showLabel = true }: DeviceStatusProps) {
  const statusConfig = {
    online: {
      color: 'bg-green-500',
      label: 'Online',
      pulse: true,
    },
    offline: {
      color: 'bg-red-500',
      label: 'Offline',
      pulse: false,
    },
    unknown: {
      color: 'bg-gray-400',
      label: 'Unknown',
      pulse: false,
    },
  };

  const config = statusConfig[status];

  return (
    <div className={cn('flex items-center gap-2', className)}>
      <span
        className={cn(
          'h-2.5 w-2.5 rounded-full',
          config.color,
          config.pulse && 'animate-pulse-slow'
        )}
      />
      {showLabel && (
        <span className="text-sm text-muted-foreground">{config.label}</span>
      )}
    </div>
  );
}
