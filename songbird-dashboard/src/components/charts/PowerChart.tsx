import {
  ResponsiveContainer,
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Cell,
  ReferenceLine,
} from 'recharts';
import { format, parseISO, differenceInMinutes } from 'date-fns';
import { Battery, Clock, Zap, TrendingDown } from 'lucide-react';
import type { PowerPoint } from '@/types';

interface PowerChartProps {
  data: PowerPoint[];
}

interface ConsumptionDataPoint {
  timestamp: number;
  delta: number;
  rate: number;
  time: string;
}

export function PowerChart({ data }: PowerChartProps) {
  // Transform data for chart - reverse to show chronological order
  const chartData = [...data].reverse().map((point) => ({
    ...point,
    timestamp: parseISO(point.time).getTime(),
  }));

  // Calculate consumption deltas and rates
  const consumptionData: ConsumptionDataPoint[] = [];
  for (let i = 1; i < chartData.length; i++) {
    const prev = chartData[i - 1];
    const curr = chartData[i];
    if (prev.milliamp_hours !== undefined && curr.milliamp_hours !== undefined) {
      const delta = curr.milliamp_hours - prev.milliamp_hours;
      const timeDiffHours = (curr.timestamp - prev.timestamp) / (1000 * 60 * 60);
      const rate = timeDiffHours > 0 ? delta / timeDiffHours : 0;
      consumptionData.push({
        timestamp: curr.timestamp,
        delta: Math.max(0, delta), // Consumption should be positive
        rate: Math.max(0, rate),
        time: curr.time,
      });
    }
  }

  // Calculate summary stats
  const hasMilliampHours = chartData.some((d) => d.milliamp_hours !== undefined);
  const mAhValues = chartData
    .filter((d) => d.milliamp_hours !== undefined)
    .map((d) => d.milliamp_hours!);

  const totalConsumed = mAhValues.length >= 2
    ? Math.max(0, mAhValues[mAhValues.length - 1] - mAhValues[0])
    : 0;

  const timeSpanMinutes = chartData.length >= 2
    ? differenceInMinutes(
        new Date(chartData[chartData.length - 1].timestamp),
        new Date(chartData[0].timestamp)
      )
    : 0;

  const avgRate = timeSpanMinutes > 0
    ? (totalConsumed / timeSpanMinutes) * 60
    : 0;

  const formatXAxis = (timestamp: number) => {
    return format(new Date(timestamp), 'HH:mm');
  };

  const formatTooltip = (timestamp: number) => {
    return format(new Date(timestamp), 'MMM d, HH:mm:ss');
  };

  const tooltipStyle = {
    backgroundColor: 'hsl(var(--popover))',
    border: '1px solid hsl(var(--border))',
    borderRadius: '8px',
  };

  // Check which data is available
  const hasVoltage = chartData.some((d) => d.voltage !== undefined);

  // Format time span for display
  const formatTimeSpan = (minutes: number) => {
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    if (hours < 24) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
    const days = Math.floor(hours / 24);
    const remainingHours = hours % 24;
    return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`;
  };

  const chartHeight = 160;

  return (
    <div className="space-y-4">
      {/* Info note about power monitoring */}
      <p className="text-xs text-muted-foreground italic">
        Power monitoring is only performed when the device is battery powered and not plugged in or charging over USB.
      </p>

      {/* Energy Consumption Summary Card */}
      {hasMilliampHours && (
        <div className="rounded-lg border bg-card p-4">
          <h4 className="text-sm font-medium mb-3 text-blue-500 flex items-center gap-2">
            <Battery className="h-4 w-4" />
            Energy Consumption Summary
          </h4>
          <div className="grid grid-cols-3 gap-4">
            <div className="flex flex-col">
              <div className="flex items-center gap-1.5 text-muted-foreground text-xs mb-1">
                <Zap className="h-3 w-3" />
                Total Used
              </div>
              <span className="text-2xl font-semibold text-blue-500">
                {totalConsumed.toFixed(2)}
              </span>
              <span className="text-xs text-muted-foreground">mAh</span>
            </div>
            <div className="flex flex-col">
              <div className="flex items-center gap-1.5 text-muted-foreground text-xs mb-1">
                <Clock className="h-3 w-3" />
                Time Period
              </div>
              <span className="text-2xl font-semibold">
                {formatTimeSpan(timeSpanMinutes)}
              </span>
              <span className="text-xs text-muted-foreground">duration</span>
            </div>
            <div className="flex flex-col">
              <div className="flex items-center gap-1.5 text-muted-foreground text-xs mb-1">
                <TrendingDown className="h-3 w-3" />
                Avg Rate
              </div>
              <span className="text-2xl font-semibold text-amber-500">
                {avgRate.toFixed(2)}
              </span>
              <span className="text-xs text-muted-foreground">mAh/hour</span>
            </div>
          </div>
        </div>
      )}

      {/* Step/Waterfall Chart - Consumption Deltas */}
      {hasMilliampHours && consumptionData.length > 0 && (
        <div>
          <h4 className="text-sm font-medium mb-2 text-blue-500">
            Consumption Steps (mAh per interval)
          </h4>
          <ResponsiveContainer width="100%" height={chartHeight}>
            <BarChart data={consumptionData} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-muted" vertical={false} />
              <XAxis
                dataKey="timestamp"
                tickFormatter={formatXAxis}
                className="text-xs"
                stroke="currentColor"
              />
              <YAxis
                domain={[0, 'auto']}
                tickFormatter={(v) => v.toFixed(2)}
                className="text-xs"
                stroke="#3b82f6"
                width={45}
              />
              <Tooltip
                labelFormatter={formatTooltip}
                contentStyle={tooltipStyle}
                formatter={(value: number) => [`${value.toFixed(3)} mAh`, 'Consumed']}
              />
              <ReferenceLine y={0} stroke="currentColor" />
              <Bar dataKey="delta" name="Consumption" radius={[2, 2, 0, 0]}>
                {consumptionData.map((entry, index) => (
                  <Cell
                    key={`cell-${index}`}
                    fill={entry.delta > avgRate / 60 * 1.5 ? '#f59e0b' : '#3b82f6'}
                    fillOpacity={0.8}
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Consumption Rate Chart - mAh/hour over time */}
      {hasMilliampHours && consumptionData.length > 0 && (
        <div>
          <h4 className="text-sm font-medium mb-2 text-amber-500">
            Consumption Rate (mAh/hour)
          </h4>
          <ResponsiveContainer width="100%" height={chartHeight}>
            <LineChart data={consumptionData} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
              <XAxis
                dataKey="timestamp"
                tickFormatter={formatXAxis}
                className="text-xs"
                stroke="currentColor"
              />
              <YAxis
                domain={[0, 'auto']}
                tickFormatter={(v) => v.toFixed(1)}
                className="text-xs"
                stroke="#f59e0b"
                width={45}
              />
              <Tooltip
                labelFormatter={formatTooltip}
                contentStyle={tooltipStyle}
                formatter={(value: number) => [`${value.toFixed(2)} mAh/hr`, 'Rate']}
              />
              <ReferenceLine
                y={avgRate}
                stroke="#f59e0b"
                strokeDasharray="5 5"
                label={{ value: 'Avg', position: 'right', fill: '#f59e0b', fontSize: 10 }}
              />
              <Line
                type="monotone"
                dataKey="rate"
                name="Rate (mAh/hr)"
                stroke="#f59e0b"
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4 }}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Voltage Chart */}
      {hasVoltage && (
        <div>
          <h4 className="text-sm font-medium mb-2 text-green-500">Battery Voltage</h4>
          <ResponsiveContainer width="100%" height={chartHeight}>
            <LineChart data={chartData} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
              <XAxis
                dataKey="timestamp"
                tickFormatter={formatXAxis}
                className="text-xs"
                stroke="currentColor"
              />
              <YAxis
                domain={['auto', 'auto']}
                tickFormatter={(v) => `${v.toFixed(1)}V`}
                className="text-xs"
                stroke="#22c55e"
                width={50}
              />
              <Tooltip labelFormatter={formatTooltip} contentStyle={tooltipStyle} />
              <Line
                type="monotone"
                dataKey="voltage"
                name="Voltage (V)"
                stroke="#22c55e"
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4 }}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {!hasVoltage && !hasMilliampHours && (
        <div className="h-[100px] flex items-center justify-center">
          <span className="text-muted-foreground">No power data available</span>
        </div>
      )}
    </div>
  );
}
