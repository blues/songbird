import { Cpu, Wifi, WifiOff, AlertTriangle, BatteryLow } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import type { DashboardStats } from '@/types';

export type StatsCardType = 'total' | 'online' | 'offline' | 'alerts' | 'lowBattery';

interface StatsCardsProps {
  stats: DashboardStats;
  onCardClick?: (cardType: StatsCardType) => void;
}

export function StatsCards({ stats, onCardClick }: StatsCardsProps) {
  const cards: Array<{
    label: string;
    value: number;
    icon: typeof Cpu;
    color: string;
    type: StatsCardType;
  }> = [
    {
      label: 'Total Devices',
      value: stats.total_devices,
      icon: Cpu,
      color: 'text-blue-500',
      type: 'total',
    },
    {
      label: 'Online',
      value: stats.online_devices,
      icon: Wifi,
      color: 'text-green-500',
      type: 'online',
    },
    {
      label: 'Offline',
      value: stats.offline_devices,
      icon: WifiOff,
      color: 'text-red-500',
      type: 'offline',
    },
    {
      label: 'Active Alerts',
      value: stats.active_alerts,
      icon: AlertTriangle,
      color: 'text-yellow-500',
      type: 'alerts',
    },
    {
      label: 'Low Battery',
      value: stats.low_battery_count,
      icon: BatteryLow,
      color: 'text-orange-500',
      type: 'lowBattery',
    },
  ];

  return (
    <div className="grid gap-4 grid-cols-2 md:grid-cols-3 lg:grid-cols-5">
      {cards.map((card) => (
        <Card
          key={card.label}
          className={onCardClick ? 'cursor-pointer hover:bg-muted/50 transition-colors' : ''}
          onClick={() => onCardClick?.(card.type)}
        >
          <CardContent className="pt-6">
            <div className="flex flex-col items-center text-center">
              <card.icon className={`h-8 w-8 mb-2 ${card.color}`} />
              <div className="text-3xl font-bold">{card.value}</div>
              <div className="text-sm text-muted-foreground">{card.label}</div>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
